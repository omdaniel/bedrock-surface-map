import {
  readVerifiedObject,
  type VerifiedObjectRequest,
} from "../object-cache";
import type { ObjectRef } from "../types";
import { LocalWorldStore } from "./local-store";
import {
  localAsset,
  MAX_INDEX_BYTES,
  parseNode,
  type LodManifest,
  type NodeRef,
} from "./protocol";

export interface LocalDatasetState {
  status: "syncing" | "ready" | "error";
  objects: number;
  bytes: number;
  revision: number;
  error: string;
  persistent: boolean;
}

/** Complete, camera-independent synchronization of immutable surface objects.
 * Rendering only reads this store. Completed subtree proofs avoid traversing
 * unchanged branches on live revisions; no view or zoom enters this class.
 */
export class LocalDataset {
  readonly store: LocalWorldStore;
  readonly base: URL;
  state: LocalDatasetState = {
    status: "syncing",
    objects: 0,
    bytes: 0,
    revision: 0,
    error: "",
    persistent: false,
  };
  private latest?: LodManifest;
  private running = false;
  private disposed = false;
  private controller = new AbortController();
  private listeners = new Set<() => void>();
  private retryTimer?: ReturnType<typeof setTimeout>;
  private failures = 0;
  private progressAt = 0;
  private proofEpoch = 0;

  constructor(
    readonly url: URL,
    readonly maxBytes = 4 * 1024 ** 3,
  ) {
    this.base = new URL(".", url);
    this.store = new LocalWorldStore(url.href, maxBytes);
  }

  private changed() {
    for (const listener of this.listeners) listener();
    window.dispatchEvent(new Event("surface-local-status"));
  }

  private request(
    ref: ObjectRef,
    signal?: AbortSignal,
    maxBytes = 2 * 1024 * 1024,
  ): VerifiedObjectRequest {
    return {
      url: localAsset(ref.url, this.base),
      sha256: ref.sha256,
      bytes: ref.bytes,
      maxBytes,
      signal,
    };
  }

  ensure(root: LodManifest) {
    if (this.disposed) return;
    const same =
      this.latest && JSON.stringify(this.latest) === JSON.stringify(root);
    this.latest = root;
    if (same && (this.running || this.state.status === "ready")) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    void this.run();
  }

  /** No network fallback. Missing data waits for the independent synchronizer. */
  async object(
    ref: ObjectRef,
    signal?: AbortSignal,
    maxBytes = 2 * 1024 * 1024,
  ): Promise<ArrayBuffer> {
    const request = this.request(ref, signal, maxBytes);
    for (;;) {
      signal?.throwIfAborted();
      if (this.disposed) throw Error("Local map is closed");
      const version = this.progressAt;
      const bytes = await this.store.read(request);
      if (bytes) return bytes;
      if (this.state.status === "error") throw Error(this.state.error);
      if (this.state.status === "ready") {
        // Storage was cleared or a stored body failed verification. Reconcile
        // the complete dataset, rather than turning camera requests into fetches.
        this.proofEpoch++;
        this.state.status = "syncing";
        void this.run();
      }
      if (version !== this.progressAt) continue;
      await this.wait(signal);
    }
  }

  async complete(root: LodManifest, signal?: AbortSignal) {
    this.ensure(root);
    while (
      this.state.status !== "ready" ||
      this.state.revision !== root.revision
    ) {
      signal?.throwIfAborted();
      if (this.state.status === "error") throw Error(this.state.error);
      await this.wait(signal);
    }
  }

  private wait(signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      const done = () => {
        cleanup();
        resolve();
      };
      const abort = () => {
        cleanup();
        reject(signal?.reason);
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.delete(done);
        signal?.removeEventListener("abort", abort);
      };
      const timer = setTimeout(done, 250);
      this.listeners.add(done);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  private async acquire(ref: ObjectRef, maxBytes = 2 * 1024 * 1024) {
    const request = this.request(ref, this.controller.signal, maxBytes);
    const known = await this.store.read(request);
    if (known) return known;
    const bytes = await readVerifiedObject({
      ...request,
      signal: AbortSignal.any([
        this.controller.signal,
        AbortSignal.timeout(15000),
      ]),
      cache: false,
    });
    await this.store.put(request, bytes);
    this.state.objects++;
    this.state.bytes += bytes.byteLength;
    this.progressAt++;
    this.changed();
    return bytes;
  }

  private async node(ref: NodeRef) {
    return parseNode(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await this.acquire(ref.index, MAX_INDEX_BYTES),
        ),
      ),
      ref.key,
      this.base,
    );
  }

  private async subtree(ref: NodeRef, epoch: number): Promise<void> {
    this.controller.signal.throwIfAborted();
    const key = `complete:${epoch}:${ref.index.sha256}`;
    if (await this.store.metadata<boolean>(key)) return;
    const node = await this.node(ref);
    // At most two bounded response/Blob buffers exist at once. A depth-first
    // walk retains only ancestor references, not a world-sized work queue.
    await Promise.all([this.acquire(node.data), this.acquire(node.height)]);
    for (const child of node.children) await this.subtree(child, epoch);
    await this.store.setMetadata(key, true);
  }

  private async run() {
    if (this.running || this.disposed || !this.latest) return;
    this.running = true;
    this.state.status = "syncing";
    this.state.error = "";
    this.changed();
    try {
      const stats = await this.store.stats();
      this.state.bytes = stats.bytes;
      this.state.objects = stats.entries;
      try {
        if (navigator.storage?.persisted) {
          this.state.persistent = await navigator.storage.persisted();
          if (!this.state.persistent && navigator.storage.persist)
            this.state.persistent = await navigator.storage.persist();
        }
      } catch {
        /* Best-effort storage still supports a complete local map. */
      }
      for (;;) {
        const root: LodManifest = this.latest!;
        const epoch = this.proofEpoch;
        await this.acquire(root.atlas, 32 * 1024 * 1024);
        for (const page of root.catalog)
          await this.acquire(page, MAX_INDEX_BYTES);
        // Every root is renderable before filling descendant detail. The order
        // is deterministic and independent of where the user looks.
        for (const ref of root.roots) {
          const node = await this.node(ref);
          await Promise.all([
            this.acquire(node.data),
            this.acquire(node.height),
          ]);
        }
        for (const ref of root.roots) await this.subtree(ref, epoch);
        await this.store.setMetadata("root", root);
        this.state.revision = root.revision;
        if (root === this.latest && epoch === this.proofEpoch) break;
      }
      const final = await this.store.stats();
      this.state.bytes = final.bytes;
      this.state.objects = final.entries;
      this.state.status = "ready";
      this.failures = 0;
    } catch (error) {
      if (!this.disposed) {
        this.state.status = "error";
        this.state.error = `Local map download incomplete: ${String(error)}`;
        this.retryTimer = setTimeout(
          () => void this.run(),
          Math.min(30000, 1000 * 2 ** Math.min(5, this.failures++)),
        );
      }
    } finally {
      this.running = false;
      this.progressAt++;
      this.changed();
    }
  }

  dispose() {
    this.disposed = true;
    this.controller.abort();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.changed();
  }
}
