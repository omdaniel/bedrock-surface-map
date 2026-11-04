import {
  ObjectIntegrityError,
  validateObjectRef,
  verifyObjectBytes,
  type LocalObjectRequest,
} from "./object-integrity";

const DATABASE_PREFIX = "bedrock-surface-local-map:";
const SCHEMA = 1;
const STORAGE_TIMEOUT_MS = 5000;
const PAGE_SIZE = 256;
const STORES = ["objects", "charges", "state"];

interface Usage {
  bytes: number;
  entries: number;
}

interface StoredObject {
  body: Blob;
}

interface Transaction<T> {
  store(name: string): IDBObjectStore;
  read<V>(request: IDBRequest<V>, then: (value: V) => void): void;
  finish(value: T): void;
}

function hash(value: string) {
  if (!/^[a-f0-9]{64}$/.test(value))
    throw new TypeError("Invalid local map object hash");
}

function usage(value: Usage | undefined): Usage {
  if (!value) throw Error("Local map accounting is missing");
  const result = value;
  if (
    !Number.isSafeInteger(result.bytes) ||
    result.bytes < 0 ||
    !Number.isSafeInteger(result.entries) ||
    result.entries < 0
  )
    throw Error("Local map accounting is corrupt");
  return result;
}

function charge(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0)
    throw Error("Local map object accounting is corrupt");
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
      reject(new DOMException("Local map storage timed out", "TimeoutError"));
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
 * Strict, persistent, local-only Blob storage, adapted from the strict store at
 * d8ffefa. No HTTP, memory fallback, entry cap, eviction or corruption deletion.
 * Payload quota/accounting and writes commit atomically across tabs. The quota
 * excludes IndexedDB overhead; native quota failures also propagate. An update
 * needs space for old plus new objects until the dataset can safely collect.
 * Reads verify one bounded Blob; puts snapshot caller bytes before any await.
 * Collection is explicit and must be protected by the dataset's Web Locks.
 */
export class LocalMapStore {
  private connection?: IDBDatabase;
  private opening?: Promise<IDBDatabase>;
  private disposed = false;
  private readonly name: string;

  constructor(
    id: string,
    private readonly maxBytes: number,
  ) {
    if (typeof id !== "string" || !id || id.length > 4096)
      throw new TypeError("Local map ID must contain 1..4096 characters");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
      throw new RangeError("Invalid local map byte quota");
    this.name = DATABASE_PREFIX + encodeURIComponent(id);
  }

  private async database(): Promise<IDBDatabase> {
    if (this.disposed)
      throw new DOMException("Local map store disposed", "InvalidStateError");
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
              "Local map database open timed out",
              "TimeoutError",
            ),
          ),
        STORAGE_TIMEOUT_MS,
      );
      try {
        const request = indexedDB.open(this.name, SCHEMA);
        request.onerror = () =>
          fail(request.error ?? Error("Local map database unavailable"));
        request.onblocked = () =>
          fail(
            new DOMException(
              "Local map database upgrade is blocked",
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
          if (finished || this.disposed) {
            db.close();
            fail(
              new DOMException("Local map store disposed", "InvalidStateError"),
            );
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
    if (this.disposed)
      throw new DOMException("Local map store disposed", "InvalidStateError");
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
            new DOMException("Local map transaction timed out", "TimeoutError"),
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
            new DOMException("Local map transaction aborted", "AbortError"),
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

  async read(request: LocalObjectRequest): Promise<ArrayBuffer | undefined> {
    request = { ...request };
    request.signal?.throwIfAborted();
    validateObjectRef(request);
    const stored = await this.transaction<StoredObject | undefined>(
      ["objects"],
      "readonly",
      ({ store, read, finish }) =>
        read(store("objects").get(request.sha256), finish),
      request.signal,
    );
    request.signal?.throwIfAborted();
    if (stored === undefined) return undefined;
    // Reject size before materializing a damaged/oversized stored Blob.
    if (!(stored?.body instanceof Blob) || stored.body.size !== request.bytes)
      throw new ObjectIntegrityError("Local map stored object size mismatch");
    const buffer = await waitFor(stored.body.arrayBuffer(), request.signal);
    await verifyObjectBytes(buffer, request);
    return buffer;
  }

  async put(request: LocalObjectRequest, buffer: ArrayBuffer): Promise<void> {
    request = { ...request };
    request.signal?.throwIfAborted();
    validateObjectRef(request);
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== request.bytes)
      throw Error("Local map object size mismatch");
    buffer = buffer.slice(0);
    await verifyObjectBytes(buffer, request);
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
                throw Error("Local map accounting is corrupt");
              const total = state.bytes - previous + request.bytes;
              if (!Number.isSafeInteger(total) || total < 0)
                throw Error("Local map accounting is corrupt");
              if (total > this.maxBytes)
                throw new DOMException(
                  "Local map byte quota exceeded",
                  "QuotaExceededError",
                );
              // Blob creation happens only in an active shared write transaction,
              // never in an additional background queue. Re-put also repairs an
              // existing corrupt body without double-charging its payload.
              store("objects").put(
                {
                  body: new Blob([buffer]),
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
      throw new RangeError("Local map inventory page limit must be 1..256");
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
        "Local map removal batch must contain at most 256 hashes",
      );
    hashes.forEach(hash);
    await this.remove([...new Set(hashes)]);
  }

  private async remove(hashes: string[]): Promise<void> {
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
            remove();
          };
          next();
        });
      },
    );
  }

  /** The owner first aborts/drains its operations, then closes the connection. */
  dispose(): void {
    this.disposed = true;
    this.connection?.close();
    this.connection = undefined;
  }
}
