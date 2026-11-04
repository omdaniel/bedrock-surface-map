import { boundedBytes } from "./http";
import { LocalMapStore } from "./local-store";
import { ObjectIntegrityError, validateObjectRef } from "./object-integrity";
import type { ObjectRef } from "./types";

export type { ObjectRef } from "./types";
export interface LocalMapState {
  phase: "idle" | "preparing" | "ready" | "error" | "disposed";
  /** Verified local compressed bytes in the latest prepare attempt. */
  bytes: number;
  /** Total unique hashes in that attempt, with completed counting commits/reuse. */
  count: number;
  completed: number;
  error: string | null;
}
export type LocalMapRead = Omit<ObjectRef, "bytes"> & { bytes?: number };

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // Most inventory entries will never have a viewport reader attached.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
interface Entry {
  ref: ObjectRef;
  urls: Set<string>;
  ready: ReturnType<typeof deferred>;
}

/**
 * One flat, complete compressed publication. Only prepare performs HTTP (two
 * workers, independent of the camera). read never fetches or repairs: it waits
 * for its inventory entry, then verifies a fresh bounded local copy. No decoded
 * bodies or publication-sized buffers are retained. Atlases without trusted
 * hashes, manifests, raw worlds and live feeds are outside this module.
 *
 * Call prepare again after a failure to explicitly retry; committed progress is
 * reused. Overlapping prepares are rejected. The previous publication remains
 * readable until the following changed publication completes, allowing callers
 * to commit their root after prepare resolves. GC drains already queued reads.
 * The byte cap includes current, previous and incoming files during an update;
 * insufficient headroom fails without evicting anything.
 *
 * Each instance holds a shared Web Lock for its entire lifetime. Joining and GC
 * use a second exclusive gate. GC runs only when the gate-protected lock query
 * finds this instance alone, so a new tab cannot join between checking and
 * deleting. Multiple instances/tabs, absent Web Locks, or a failed lock query
 * mean no GC. A changed publication or reload may collect. Identical ready
 * inventories are an in-memory no-op, including GC. dispose/page close releases
 * the lease; there are no expiring leases, graphs, trees or publication proofs.
 */
export class LocalMapDataset {
  private readonly store: LocalMapStore;
  private readonly lifetime = new AbortController();
  private readonly held = deferred();
  private readonly lease: Promise<void>;
  private leaseTask?: Promise<void>;
  private readonly gate: string;
  private readonly activeLock: string;
  private current = new Map<string, Entry>();
  private previous = new Map<string, Entry>();
  private pending?: Map<string, Entry>;
  private preparing?: Promise<void>;
  private reading: Promise<void> = Promise.resolve();
  private closing?: Promise<void>;
  private snapshot: LocalMapState = {
    phase: "idle",
    bytes: 0,
    count: 0,
    completed: 0,
    error: null,
  };

  constructor(
    identity: string,
    private readonly maxBytes: number,
    private readonly onState?: (state: LocalMapState) => void,
  ) {
    this.store = new LocalMapStore(identity, maxBytes);
    const name = `bedrock-surface-local-map:${encodeURIComponent(identity)}`;
    this.gate = `${name}:gate`;
    this.activeLock = `${name}:active`;
    this.lease = this.join();
    void this.lease.catch(() => {});
  }

  get state(): LocalMapState {
    return { ...this.snapshot };
  }

  private update(state: Partial<LocalMapState>) {
    this.snapshot = { ...this.snapshot, ...state };
    // An observer cannot turn a committed write into a failed publication.
    try {
      this.onState?.(this.state);
    } catch (error) {
      console.error("Local map state observer failed", error);
    }
  }

  private async join() {
    if (!navigator.locks) return;
    await navigator.locks.request(
      this.gate,
      { signal: this.lifetime.signal },
      async () => {
        const acquired = deferred();
        const task = navigator.locks
          .request(
            this.activeLock,
            { mode: "shared", signal: this.lifetime.signal },
            () => {
              acquired.resolve();
              return this.held.promise;
            },
          )
          .then(() => {});
        this.leaseTask = task;
        void task.catch(acquired.reject);
        await acquired.promise;
      },
    );
  }

  prepare(refs: readonly ObjectRef[]): Promise<void> {
    if (this.lifetime.signal.aborted)
      return Promise.reject(this.lifetime.signal.reason);
    if (this.preparing)
      return Promise.reject(
        new DOMException(
          "Local map prepare is already running",
          "InvalidStateError",
        ),
      );
    const inventory = new Map<string, Omit<Entry, "ready">>();
    try {
      if (!Array.isArray(refs))
        throw new TypeError("Expected a flat object inventory");
      let bytes = 0;
      for (const supplied of refs) {
        const ref = {
          url: supplied.url,
          sha256: supplied.sha256,
          bytes: supplied.bytes,
        };
        validateObjectRef(ref);
        const previous = inventory.get(ref.sha256);
        if (previous) {
          if (previous.ref.bytes !== ref.bytes)
            throw new ObjectIntegrityError(
              "Conflicting sizes for the same local object hash",
            );
          previous.urls.add(ref.url);
        } else {
          bytes += ref.bytes;
          if (!Number.isSafeInteger(bytes) || bytes > this.maxBytes)
            throw new DOMException(
              "Local map publication exceeds byte quota",
              "QuotaExceededError",
            );
          inventory.set(ref.sha256, {
            ref,
            urls: new Set([ref.url]),
          });
        }
      }
    } catch (error) {
      this.update({ phase: "error", error: String(error) });
      return Promise.reject(error);
    }
    const unchanged =
      inventory.size === this.current.size &&
      [...inventory].every(([hash, entry]) => {
        const previous = this.current.get(hash);
        return (
          previous?.ref.bytes === entry.ref.bytes &&
          previous.urls.size === entry.urls.size &&
          [...entry.urls].every((url) => previous.urls.has(url))
        );
      });
    if (this.snapshot.phase === "ready" && unchanged) return Promise.resolve();
    const entries = new Map(
      [...inventory].map(([hash, entry]) => [
        hash,
        { ...entry, ready: deferred() },
      ]),
    );
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
    this.pending = entries;
    // Install the promise before notifying observers, which may call read/prepare.
    const task = Promise.resolve()
      .then(() => this.download(entries, controller, signal, unchanged))
      .catch((error: unknown) => {
        controller.abort(error);
        for (const entry of entries.values()) entry.ready.reject(error);
        if (!this.lifetime.signal.aborted)
          this.update({ phase: "error", error: String(error) });
        throw error;
      })
      .finally(() => {
        this.pending = undefined;
        this.preparing = undefined;
      });
    this.preparing = task;
    this.update({
      phase: "preparing",
      bytes: 0,
      count: entries.size,
      completed: 0,
      error: null,
    });
    return task;
  }

  private async download(
    entries: Map<string, Entry>,
    controller: AbortController,
    signal: AbortSignal,
    unchanged: boolean,
  ) {
    await this.lease;
    signal.throwIfAborted();
    // A smaller cap on reload must not silently accept an over-budget database.
    if ((await this.store.stats()).bytes > this.maxBytes)
      throw new DOMException(
        "Local map stored bytes exceed quota",
        "QuotaExceededError",
      );
    const queue = entries.values();
    const worker = async () => {
      try {
        for (;;) {
          signal.throwIfAborted();
          const next = queue.next();
          if (next.done) return;
          const entry = next.value;
          const ref = { ...entry.ref, signal };
          let present = false;
          try {
            present = (await this.store.read(ref)) !== undefined;
          } catch (error) {
            // Corruption is repaired only here, never by a viewport read.
            if (!(error instanceof ObjectIntegrityError)) throw error;
          }
          if (!present) {
            const response = await fetch(ref.url, {
              signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
              redirect: "error",
              cache: "no-store",
              credentials: "same-origin",
            });
            if (!response.ok)
              throw Error(`Local map download HTTP ${response.status}`);
            const bytes = await boundedBytes(response, ref.bytes);
            await this.store.put(ref, bytes.buffer);
          }
          signal.throwIfAborted();
          entry.ready.resolve();
          this.update({
            bytes: this.snapshot.bytes + ref.bytes,
            completed: this.snapshot.completed + 1,
          });
        }
      } catch (error) {
        controller.abort(error);
        throw error;
      }
    };
    const results = await Promise.allSettled([worker(), worker()]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    signal.throwIfAborted();
    if (!unchanged) this.previous = this.current;
    this.current = entries;
    // Reads accepted before the swap may still reference an older publication.
    // Their ready callbacks enqueue before this await resumes. New reads can
    // only select the current/previous/pending inventories, all protected below.
    await this.reading;
    await this.collect(entries, signal);
    signal.throwIfAborted();
    this.update({ phase: "ready", error: null });
  }

  private async collect(entries: Map<string, Entry>, signal: AbortSignal) {
    if (!navigator.locks) return;
    await navigator.locks.request(this.gate, { signal }, async () => {
      let locks: LockManagerSnapshot;
      try {
        locks = await navigator.locks.query();
      } catch {
        return; // Without proof of exclusivity, retain all objects.
      }
      if (
        locks.held?.filter((lock) => lock.name === this.activeLock).length !== 1
      )
        return;
      let after: string | undefined;
      do {
        signal.throwIfAborted();
        const page = await this.store.listHashes(after);
        signal.throwIfAborted();
        await this.store.removeHashes(
          page.hashes.filter(
            (hash) => !entries.has(hash) && !this.previous.has(hash),
          ),
        );
        after = page.next;
      } while (after !== undefined);
    });
  }

  read(request: LocalMapRead): Promise<ArrayBuffer> {
    if (this.lifetime.signal.aborted)
      return Promise.reject(this.lifetime.signal.reason);
    request = { ...request };
    const entry = [this.pending, this.current, this.previous]
      .map((inventory) => inventory?.get(request.sha256))
      .find((candidate) => candidate?.urls.has(request.url));
    if (
      !entry ||
      (request.bytes !== undefined && request.bytes !== entry.ref.bytes)
    )
      return Promise.reject(
        new Error("Object is not in the supplied local publication"),
      );
    // Waiting does not start, reprioritize, or occupy a download worker. Only
    // local materialization is serialized, and the chain retains no buffers.
    const result = entry.ready.promise.then(() => {
      const read = this.reading.then(async () => {
        this.lifetime.signal.throwIfAborted();
        await this.lease;
        const bytes = await this.store.read({
          ...entry.ref,
          signal: this.lifetime.signal,
        });
        if (!bytes)
          throw Error(
            "Local map object is missing; explicitly prepare to repair",
          );
        return bytes;
      });
      this.reading = read.then(
        () => {},
        () => {},
      );
      return read;
    });
    return result.catch((error: unknown) => {
      if (!this.lifetime.signal.aborted && !this.preparing)
        this.update({ phase: "error", error: String(error) });
      throw error;
    });
  }

  /** Abort downloads/queued reads; drain operations before releasing the lease. */
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.lifetime.abort(
      new DOMException("Local map dataset disposed", "AbortError"),
    );
    this.update({ phase: "disposed" });
    this.closing = (async () => {
      await Promise.allSettled([this.lease, this.preparing, this.reading]);
      this.store.dispose();
      this.held.resolve();
      await this.leaseTask?.catch(() => {});
      this.current.clear();
      this.previous.clear();
    })();
    return this.closing;
  }
}
