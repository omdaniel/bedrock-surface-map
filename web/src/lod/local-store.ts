import {
  validateVerifiedObjectRequest,
  verifyObjectBytes,
  type VerifiedObjectRequest,
} from "../object-cache";

export type { VerifiedObjectRequest } from "../object-cache";

const DATABASE_PREFIX = "bedrock-surface-local-world:";
const SCHEMA = 1;
const STORAGE_TIMEOUT_MS = 5000;
const METADATA_BYTES = 64 * 1024;
const PAGE_SIZE = 256;
const STORES = ["objects", "charges", "metadata", "state"];

interface Usage {
  bytes: number;
  entries: number;
}

interface StoredObject {
  body: Blob;
  revision: string;
}

interface Transaction<T> {
  store(name: string): IDBObjectStore;
  read<V>(request: IDBRequest<V>, then: (value: V) => void): void;
  finish(value: T): void;
}

function hash(value: string) {
  if (!/^[a-f0-9]{64}$/.test(value))
    throw new TypeError("Invalid local world object hash");
}

function metadataKey(key: string) {
  if (typeof key !== "string" || !key || key.length > 1024)
    throw new TypeError(
      "Local world metadata keys must contain 1..1024 characters",
    );
}

function usage(value: Usage | undefined): Usage {
  if (!value) throw Error("Local world accounting is missing");
  const result = value;
  if (
    !Number.isSafeInteger(result.bytes) ||
    result.bytes < 0 ||
    !Number.isSafeInteger(result.entries) ||
    result.entries < 0
  )
    throw Error("Local world accounting is corrupt");
  return result;
}

function charge(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0)
    throw Error("Local world object accounting is corrupt");
  return Number(value);
}

/** Bounded waits, with no polling, deferred work queue or swallowed rejection. */
function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const clean = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      clean();
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      clean();
      reject(new DOMException("Local world storage timed out", "TimeoutError"));
    }, STORAGE_TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        clean();
        if (signal?.aborted) reject(signal.reason);
        else resolve(value);
      },
      (error: unknown) => {
        clean();
        reject(error);
      },
    );
    if (signal?.aborted) abort();
  });
}

/**
 * Strict local-only immutable storage; schema v1, one database per dataset ID
 * (normally the full manifest URL). It never fetches, prompts for persistence,
 * skips writes, expires entries or evicts to make room. A successful put means
 * its verified immutable Blob and accounting transaction have committed.
 *
 * The quota counts payload bytes, excluding browser/metadata overhead. Each
 * writer applies its constructor's cap to the atomic shared namespace total;
 * callers sharing a dataset should use the same cap. Metadata uses JSON round
 * trips, with a 64 KiB UTF-8 limit per value. No full inventory is materialized.
 *
 * Concurrent callers await their own operation; there is no background buffer
 * queue. Bulk synchronization should bound its own concurrency. put snapshots
 * its input before awaiting, so caller mutation/transfer cannot change storage.
 * Read/write signals are honored; request.cache is deliberately ignored because
 * explicit local operations are not the optional opportunistic object cache.
 */
export class LocalWorldStore {
  private connection?: IDBDatabase;
  private opening?: Promise<IDBDatabase>;
  private readonly name: string;

  constructor(
    id: string,
    private readonly maxBytes = 4 * 1024 ** 3,
  ) {
    if (typeof id !== "string" || !id || id.length > 4096)
      throw new TypeError("Local world ID must contain 1..4096 characters");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
      throw new RangeError("Invalid local world byte quota");
    this.name = DATABASE_PREFIX + encodeURIComponent(id);
  }

  private async database(): Promise<IDBDatabase> {
    if (this.connection) return this.connection;
    if (this.opening) return this.opening;
    this.opening = new Promise<IDBDatabase>((resolve, reject) => {
      let finished = false;
      const fail = (error: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        reject(error);
      };
      const timer = setTimeout(
        () =>
          fail(
            new DOMException(
              "Local world database open timed out",
              "TimeoutError",
            ),
          ),
        STORAGE_TIMEOUT_MS,
      );
      try {
        const request = indexedDB.open(this.name, SCHEMA);
        request.onerror = () =>
          fail(request.error ?? Error("Local world database unavailable"));
        request.onblocked = () =>
          fail(
            new DOMException(
              "Local world database upgrade is blocked",
              "InvalidStateError",
            ),
          );
        request.onupgradeneeded = () => {
          if (finished) {
            request.transaction?.abort();
            return;
          }
          try {
            const db = request.result;
            for (const name of STORES) db.createObjectStore(name);
            request
              .transaction!.objectStore("state")
              .put({ bytes: 0, entries: 0 }, "usage");
          } catch (error) {
            request.transaction?.abort();
            fail(error);
          }
        };
        request.onsuccess = () => {
          const db = request.result;
          if (finished) {
            db.close();
            return;
          }
          finished = true;
          clearTimeout(timer);
          this.connection = db;
          const close = () => {
            db.close();
            if (this.connection === db) this.connection = undefined;
          };
          db.onversionchange = close;
          db.onclose = close;
          resolve(db);
        };
      } catch (error) {
        fail(error);
      }
    });
    try {
      return await this.opening;
    } finally {
      this.opening = undefined;
    }
  }

  private async transaction<T>(
    stores: string[],
    mode: IDBTransactionMode,
    operation: (context: Transaction<T>) => void,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const db = await waitFor(this.database(), signal);
    signal?.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result: T;
      let finished = false;
      const clean = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      const fail = (error: unknown) => {
        if (finished) return;
        finished = true;
        clean();
        try {
          tx.abort();
        } catch {
          /* Already settled by the browser. */
        }
        reject(error);
      };
      const abort = () => fail(signal?.reason);
      const timer = setTimeout(
        () =>
          fail(
            new DOMException(
              "Local world transaction timed out",
              "TimeoutError",
            ),
          ),
        STORAGE_TIMEOUT_MS,
      );
      tx.oncomplete = () => {
        if (finished) return;
        finished = true;
        clean();
        resolve(result);
      };
      tx.onabort = () =>
        fail(
          tx.error ??
            new DOMException("Local world transaction aborted", "AbortError"),
        );
      tx.onerror = (event) => event.stopPropagation();
      signal?.addEventListener("abort", abort, { once: true });
      const read = <V>(request: IDBRequest<V>, then: (value: V) => void) => {
        request.onsuccess = () => {
          if (finished) return;
          try {
            then(request.result);
          } catch (error) {
            fail(error);
          }
        };
      };
      try {
        signal?.throwIfAborted();
        operation({
          store: (name) => tx.objectStore(name),
          read,
          finish: (value) => {
            result = value;
          },
        });
      } catch (error) {
        fail(error);
      }
    });
  }

  async read(request: VerifiedObjectRequest): Promise<ArrayBuffer | undefined> {
    request = { ...request };
    request.signal?.throwIfAborted();
    validateVerifiedObjectRequest(request);
    const stored = await this.transaction<StoredObject | undefined>(
      ["objects"],
      "readonly",
      ({ store, read, finish }) =>
        read(store("objects").get(request.sha256), finish),
      request.signal,
    );
    request.signal?.throwIfAborted();
    if (stored === undefined) return undefined;
    if (stored?.body instanceof Blob && stored.body.size === request.bytes) {
      // Storage access errors propagate; only a size/hash mismatch is treated as
      // corruption. Check size before materializing a potentially corrupt Blob.
      const buffer = await waitFor(stored.body.arrayBuffer(), request.signal);
      if (await verifyObjectBytes(buffer, request)) {
        request.signal?.throwIfAborted();
        return buffer;
      }
    }
    // Compare the stored revision, so a slow corruption reader cannot delete a
    // newer, verified repair committed by another tab in the meantime.
    await this.remove([request.sha256], stored?.revision, request.signal, true);
    return undefined;
  }

  async put(
    request: VerifiedObjectRequest,
    buffer: ArrayBuffer,
  ): Promise<void> {
    request = { ...request };
    request.signal?.throwIfAborted();
    validateVerifiedObjectRequest(request);
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== request.bytes)
      throw Error("Local world object size mismatch");
    buffer = buffer.slice(0);
    if (!(await verifyObjectBytes(buffer, request)))
      throw Error("Local world object SHA-256 mismatch");
    await this.transaction<void>(
      ["objects", "charges", "state"],
      "readwrite",
      ({ store, read, finish }) => {
        read(store("state").get("usage"), (stored: Usage | undefined) => {
          const state = usage(stored);
          read(
            store("charges").get(request.sha256),
            (old: number | undefined) => {
              const previous = old === undefined ? 0 : charge(old);
              if (
                previous > state.bytes ||
                (old !== undefined && state.entries === 0)
              )
                throw Error("Local world accounting is corrupt");
              const total = state.bytes - previous + request.bytes;
              if (!Number.isSafeInteger(total) || total < 0)
                throw Error("Local world accounting is corrupt");
              if (total > this.maxBytes)
                throw new DOMException(
                  "Local world byte quota exceeded",
                  "QuotaExceededError",
                );
              // Blob creation happens only in an active shared write transaction,
              // never in an additional background queue. Re-put also repairs an
              // existing corrupt body without double-charging its payload.
              store("objects").put(
                {
                  body: new Blob([buffer]),
                  revision: crypto.randomUUID(),
                } satisfies StoredObject,
                request.sha256,
              );
              store("charges").put(request.bytes, request.sha256);
              store("state").put(
                {
                  bytes: total,
                  entries: state.entries + Number(old === undefined),
                },
                "usage",
              );
              finish(undefined);
            },
          );
        });
      },
      request.signal,
    );
  }

  async metadata<T>(key: string): Promise<T | undefined> {
    metadataKey(key);
    const text = await this.transaction<string | undefined>(
      ["metadata"],
      "readonly",
      ({ store, read, finish }) => read(store("metadata").get(key), finish),
    );
    if (text === undefined) return undefined;
    if (
      typeof text !== "string" ||
      new TextEncoder().encode(text).byteLength > METADATA_BYTES
    )
      throw Error("Local world metadata is corrupt");
    return JSON.parse(text) as T;
  }

  async setMetadata(key: string, value: unknown): Promise<void> {
    metadataKey(key);
    const text = JSON.stringify(value);
    if (text === undefined)
      throw new TypeError("Local world metadata must be JSON serializable");
    if (new TextEncoder().encode(text).byteLength > METADATA_BYTES)
      throw new RangeError("Local world metadata exceeds 64 KiB");
    await this.transaction<void>(
      ["metadata"],
      "readwrite",
      ({ store, finish }) => {
        store("metadata").put(text, key);
        finish(undefined);
      },
    );
  }

  async stats(): Promise<Usage> {
    return this.transaction<Usage>(
      ["state"],
      "readonly",
      ({ store, read, finish }) => {
        read(store("state").get("usage"), (stored: Usage | undefined) =>
          finish(usage(stored)),
        );
      },
    );
  }

  /** Atomic namespace clear, including caller metadata; other datasets survive. */
  async clear(): Promise<void> {
    await this.transaction<void>(STORES, "readwrite", ({ store, finish }) => {
      for (const name of STORES) store(name).clear();
      store("state").put({ bytes: 0, entries: 0 }, "usage");
      finish(undefined);
    });
  }

  /**
   * Key-only pagination (no Blob reads), lexicographically after the cursor.
   * next is the last returned hash only when another page exists. Pages are
   * individually atomic, not a snapshot across concurrent mutation; GC callers
   * must coordinate publication changes. Limits are 1..256.
   */
  async listHashes(
    after?: string,
    limit = PAGE_SIZE,
  ): Promise<{ hashes: string[]; next?: string }> {
    if (after !== undefined) hash(after);
    if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_SIZE)
      throw new RangeError("Local world inventory page limit must be 1..256");
    return this.transaction(
      ["objects"],
      "readonly",
      ({ store, read, finish }) => {
        const hashes: string[] = [];
        read(
          store("objects").openKeyCursor(
            after === undefined
              ? undefined
              : IDBKeyRange.lowerBound(after, true),
          ),
          (cursor) => {
            if (!cursor) {
              finish({ hashes });
              return;
            }
            if (hashes.length === limit) {
              finish({ hashes, next: hashes.at(-1) });
              return;
            }
            hashes.push(String(cursor.primaryKey));
            cursor.continue();
          },
        );
      },
    );
  }

  /** Atomic, idempotent GC batch. At most 256 input hashes per call. */
  async removeHashes(hashes: string[]): Promise<void> {
    if (!Array.isArray(hashes) || hashes.length > PAGE_SIZE)
      throw new RangeError(
        "Local world removal batch must contain at most 256 hashes",
      );
    hashes.forEach(hash);
    await this.remove([...new Set(hashes)]);
  }

  private async remove(
    hashes: string[],
    revision?: string,
    signal?: AbortSignal,
    conditional = false,
  ): Promise<void> {
    if (!hashes.length) return;
    await this.transaction<void>(
      ["objects", "charges", "state"],
      "readwrite",
      ({ store, read, finish }) => {
        read(store("state").get("usage"), (stored: Usage | undefined) => {
          const state = usage(stored);
          let index = 0;
          const next = () => {
            if (index === hashes.length) {
              store("state").put(state, "usage");
              finish(undefined);
              return;
            }
            const key = hashes[index++];
            const remove = () =>
              read(store("charges").get(key), (bytes: number | undefined) => {
                if (bytes !== undefined) {
                  state.bytes -= charge(bytes);
                  state.entries--;
                  usage(state);
                }
                store("objects").delete(key);
                store("charges").delete(key);
                next();
              });
            if (conditional)
              read(
                store("objects").get(key),
                (current: StoredObject | undefined) => {
                  if (current !== undefined && current?.revision === revision)
                    remove();
                  else next();
                },
              );
            else remove();
          };
          next();
        });
      },
      signal,
    );
  }
}
