import { boundedBytes } from "./http";

/**
 * Verified, immutable terrain/assets only. Callers supply a trusted digest and
 * exact decoded HTTP body length, never a player response or mutable manifest.
 * Accepted paths end in objects/<sha>.<ext>, regions/<sha>.bsm.zst,
 * heights/<sha>.i16.zst or assets/<sha>.png (including deployment prefixes).
 * Query strings, fragments, URL credentials and redirects are refused.
 *
 * Schema v1 stores immutable Blob bodies and an LRU sequence. Every read verifies
 * the body again. All bookkeeping shares one readwrite transaction across tabs
 * and workers; no crypto/network await occurs inside an IndexedDB transaction.
 * The byte budget covers payloads, not browser database overhead. The separate
 * entry cap bounds metadata. This is independent of renderer RAM/GPU budgets.
 * No StorageManager.persist() call or permission prompt is made.
 */
const DATABASE = "bedrock-surface-immutable-objects";
const SCHEMA = 1;
const DEFAULT_BYTES = 256 * 1024 * 1024;
const OBJECT_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 2048;
const STORAGE_TIMEOUT_MS = 2000;
const STORAGE_RETRY_MS = 30000;

export interface VerifiedObjectRequest {
  url: string;
  sha256: string;
  bytes: number;
  /** Per-object network/decode limit; at most 64 MiB, unrelated to disk cap. */
  maxBytes?: number;
  signal?: AbortSignal;
  /** false bypasses disk reads, writes and LRU updates for this request. */
  cache?: boolean;
}

export interface ObjectCacheOptions {
  maxBytes: number;
  enabled: boolean;
}

export interface ObjectCacheStats extends ObjectCacheOptions {
  available: boolean;
  /** null when storage cannot be inspected, rather than a misleading zero. */
  bytes: number | null;
  entries: number | null;
  maxEntries: number;
  /** The following counters are local to this page/worker module instance. */
  hits: number;
  misses: number;
  writes: number;
  evictions: number;
  corruptions: number;
  skippedWrites: number;
  storageErrors: number;
  pendingWrites: number;
}

interface State extends ObjectCacheOptions {
  bytes: number;
  entries: number;
  clock: number;
  generation: number;
}

interface StoredObject {
  sha256: string;
  bytes: number;
  used: number;
  revision: string;
  body: Blob;
}

interface Transaction<T> {
  state: State;
  objects: IDBObjectStore;
  read<V>(request: IDBRequest<V>, then: (value: V) => void): void;
  finish(value: T): void;
}

let connection: IDBDatabase | undefined;
let opening: Promise<IDBDatabase | undefined> | undefined;
let retryAfter = 0;
let localGeneration = 0;
let writing = false;
let policy: ObjectCacheOptions = { maxBytes: DEFAULT_BYTES, enabled: true };
const counters = {
  hits: 0,
  misses: 0,
  writes: 0,
  evictions: 0,
  corruptions: 0,
  skippedWrites: 0,
  storageErrors: 0,
};

function defaults(): State {
  return { ...policy, bytes: 0, entries: 0, clock: 0, generation: 0 };
}

function storageFailed() {
  counters.storageErrors++;
  retryAfter = Date.now() + STORAGE_RETRY_MS;
  connection?.close();
  connection = undefined;
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) reject(signal.reason);
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

async function database(): Promise<IDBDatabase | undefined> {
  if (Date.now() < retryAfter) return undefined;
  if (connection) return connection;
  if (opening) return opening;
  opening = new Promise<IDBDatabase | undefined>((resolve) => {
    let finished = false;
    const fail = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      storageFailed();
      resolve(undefined);
    };
    const timer = setTimeout(fail, STORAGE_TIMEOUT_MS);
    try {
      const request = indexedDB.open(DATABASE, SCHEMA);
      request.onblocked = fail;
      request.onerror = fail;
      request.onupgradeneeded = () => {
        if (finished) {
          request.transaction?.abort();
          return;
        }
        try {
          const db = request.result;
          db.createObjectStore("objects", { keyPath: "sha256" }).createIndex(
            "used",
            "used",
          );
          db.createObjectStore("meta").put(defaults(), "state");
        } catch {
          request.transaction?.abort();
          fail();
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
        connection = db;
        db.onversionchange = () => {
          db.close();
          if (connection === db) connection = undefined;
        };
        db.onclose = () => {
          if (connection === db) connection = undefined;
        };
        resolve(db);
      };
    } catch {
      fail();
    }
  });
  try {
    return await opening;
  } finally {
    opening = undefined;
  }
}

async function transact<T>(
  mode: IDBTransactionMode,
  operation: (context: Transaction<T>) => void,
  signal?: AbortSignal,
): Promise<T | undefined> {
  signal?.throwIfAborted();
  const db = await abortable(database(), signal);
  if (!db) return undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(["objects", "meta"], mode);
      let result: T;
      let state: State;
      let failed = false;
      const clean = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      const fail = (error: unknown) => {
        if (failed) return;
        failed = true;
        clean();
        try {
          tx.abort();
        } catch {
          // It may already have completed or been aborted by the browser.
        }
        reject(error);
      };
      const abort = () => fail(signal?.reason);
      const timer = setTimeout(
        () => fail(Error("Object cache storage timed out")),
        STORAGE_TIMEOUT_MS,
      );
      const read = <V>(request: IDBRequest<V>, then: (value: V) => void) => {
        request.onsuccess = () => {
          if (failed) return;
          try {
            then(request.result);
          } catch (error) {
            fail(error);
          }
        };
      };
      tx.oncomplete = () => {
        clean();
        policy = { maxBytes: state.maxBytes, enabled: state.enabled };
        resolve(result);
      };
      tx.onabort = () => fail(tx.error ?? Error("Object cache aborted"));
      // Failed requests abort the transaction by default. Suppress only bubbling
      // error events, never preventDefault (which would permit a partial commit).
      tx.onerror = (event) => event.stopPropagation();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      read(tx.objectStore("meta").get("state"), (stored: State | undefined) => {
        state = stored ?? defaults();
        operation({
          state,
          objects: tx.objectStore("objects"),
          read,
          finish(value) {
            result = value;
            if (mode === "readwrite")
              tx.objectStore("meta").put(state, "state");
          },
        });
      });
    });
  } catch {
    signal?.throwIfAborted();
    storageFailed();
    return undefined;
  }
}

function trim<T>(context: Transaction<T>, done: (evicted: number) => void) {
  const { state, objects, read } = context;
  let evicted = 0;
  if (state.bytes <= state.maxBytes && state.entries <= MAX_ENTRIES) {
    done(0);
    return;
  }
  read(objects.index("used").openCursor(), (cursor) => {
    if (state.bytes <= state.maxBytes && state.entries <= MAX_ENTRIES) {
      done(evicted);
      return;
    }
    if (!cursor) throw Error("Object cache accounting mismatch");
    state.bytes -= (cursor.value as StoredObject).bytes;
    state.entries--;
    cursor.delete();
    evicted++;
    cursor.continue();
  });
}

function recount<T>(context: Transaction<T>, done: (evicted: number) => void) {
  const { state, objects, read } = context;
  state.bytes = 0;
  state.entries = 0;
  // Corrupt metadata cannot be trusted as a subtraction from the byte budget.
  // Inspect Blob handles, not payload copies, to repair accounting atomically.
  read(objects.openCursor(), (cursor) => {
    if (!cursor) {
      trim(context, done);
      return;
    }
    const object = cursor.value as StoredObject;
    if (
      !(object.body instanceof Blob) ||
      object.bytes !== object.body.size ||
      object.bytes <= 0 ||
      object.bytes > OBJECT_BYTES ||
      !Number.isSafeInteger(object.used)
    ) {
      cursor.delete();
    } else {
      state.bytes += object.bytes;
      state.entries++;
    }
    cursor.continue();
  });
}

/**
 * Persist origin-wide settings and trim immediately. Last committed config wins
 * across tabs/workers. Disabling retains existing entries (clear separately).
 * Returns false on unavailable storage; reads still fall back to the network.
 */
export async function configureObjectCache(
  options: ObjectCacheOptions,
): Promise<boolean> {
  options = { ...options };
  if (
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 0 ||
    typeof options.enabled !== "boolean"
  )
    throw Error("Invalid object cache configuration");
  localGeneration++;
  policy = { ...options };
  const evicted = await transact<number>("readwrite", (context) => {
    Object.assign(context.state, options);
    context.state.generation++;
    trim(context, context.finish);
  });
  counters.evictions += evicted ?? 0;
  return evicted !== undefined;
}

/** Clear bodies atomically; invalidate pre-clear writes in every tab/worker. */
export async function clearObjectCache(): Promise<boolean> {
  localGeneration++;
  const cleared = await transact<boolean>("readwrite", (context) => {
    context.objects.clear();
    context.state.bytes = 0;
    context.state.entries = 0;
    context.state.generation++;
    context.finish(true);
  });
  return cleared ?? false;
}

/** Shared disk snapshot plus local counters; never throws for storage failures. */
export async function objectCacheStats(): Promise<ObjectCacheStats> {
  const state = await transact<State>("readonly", ({ state, finish }) =>
    finish(state),
  );
  return {
    ...policy,
    available: state !== undefined,
    bytes: state?.bytes ?? null,
    entries: state?.entries ?? null,
    maxEntries: MAX_ENTRIES,
    ...counters,
    pendingWrites: Number(writing),
  };
}

function validate(request: VerifiedObjectRequest): URL {
  const limit = request.maxBytes ?? OBJECT_BYTES;
  if (
    !/^[a-f0-9]{64}$/.test(request.sha256) ||
    !Number.isSafeInteger(request.bytes) ||
    request.bytes <= 0 ||
    !Number.isSafeInteger(limit) ||
    limit <= 0 ||
    limit > OBJECT_BYTES ||
    request.bytes > limit
  )
    throw Error("Invalid immutable object digest or size");
  if (
    typeof request.url !== "string" ||
    /[\\%?#\s\u0000-\u001f\u007f]/.test(request.url)
  )
    throw Error("Invalid immutable object URL");
  const url = new URL(request.url, globalThis.location.href);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.origin !== globalThis.location.origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !new RegExp(
      `/(?:objects/${request.sha256}\\.(?:zst|json|png|bin)|regions/${request.sha256}\\.bsm\\.zst|heights/${request.sha256}\\.i16\\.zst|assets/${request.sha256}\\.png)$`,
    ).test(url.pathname) ||
    /\/(?:players|tracking)(?:\/|$)/i.test(url.pathname)
  )
    throw Error("Expected a same-origin immutable terrain or asset URL");
  return url;
}

async function verified(
  buffer: ArrayBuffer,
  request: VerifiedObjectRequest,
): Promise<boolean> {
  request.signal?.throwIfAborted();
  if (buffer.byteLength !== request.bytes) return false;
  const digest = await abortable(
    crypto.subtle.digest("SHA-256", buffer),
    request.signal,
  );
  const actual = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return actual === request.sha256;
}

async function save(
  buffer: ArrayBuffer,
  request: VerifiedObjectRequest,
  generation: number,
  local: number,
) {
  // No promise chain or queue retaining response buffers. At most one cache
  // write/Blob copy per realm; cross-realm puts run only in the active shared
  // readwrite transaction. Return only after commit, so callers may transfer or
  // mutate their ArrayBuffer without modifying the stored immutable Blob.
  if (writing || local !== localGeneration) {
    counters.skippedWrites++;
    return;
  }
  writing = true;
  try {
    const result = await transact<{ wrote: boolean; evicted: number }>(
      "readwrite",
      (context) => {
        const { state, objects, read, finish } = context;
        if (
          !state.enabled ||
          state.generation !== generation ||
          local !== localGeneration ||
          request.bytes > state.maxBytes
        ) {
          finish({ wrote: false, evicted: 0 });
          return;
        }
        read(objects.get(request.sha256), (old: StoredObject | undefined) => {
          if (old) {
            finish({ wrote: false, evicted: 0 });
            return;
          }
          const stored: StoredObject = {
            sha256: request.sha256,
            bytes: buffer.byteLength,
            used: ++state.clock,
            revision: crypto.randomUUID(),
            body: new Blob([buffer]),
          };
          objects.put(stored);
          state.bytes += stored.bytes;
          state.entries++;
          trim(context, (evicted) => finish({ wrote: true, evicted }));
        });
      },
      request.signal,
    );
    if (result?.wrote) counters.writes++;
    else counters.skippedWrites++;
    counters.evictions += result?.evicted ?? 0;
  } finally {
    writing = false;
  }
}

export async function readVerifiedObject(
  request: VerifiedObjectRequest,
): Promise<ArrayBuffer> {
  request = { ...request };
  request.signal?.throwIfAborted();
  const url = validate(request);
  const local = localGeneration;
  const cached =
    request.cache === false
      ? undefined
      : await transact<{ generation: number; object?: StoredObject }>(
          "readwrite",
          ({ state, objects, read, finish }) => {
            if (!state.enabled || request.bytes > state.maxBytes) {
              finish({ generation: state.generation });
              return;
            }
            read(objects.get(request.sha256), (object?: StoredObject) => {
              if (object) {
                object.used = ++state.clock;
                objects.put(object);
              }
              finish({ generation: state.generation, object });
            });
          },
          request.signal,
        );
  if (cached?.object) {
    const object = cached.object;
    let buffer: ArrayBuffer | undefined;
    try {
      // Blob size is checked before materialization, including corrupted rows.
      if (
        object.bytes === request.bytes &&
        object.body instanceof Blob &&
        object.body.size === request.bytes
      ) {
        buffer = await abortable(object.body.arrayBuffer(), request.signal);
        if (!(await verified(buffer, request))) buffer = undefined;
      }
    } catch {
      request.signal?.throwIfAborted();
    }
    if (buffer && local === localGeneration) {
      counters.hits++;
      request.signal?.throwIfAborted();
      return buffer;
    }
    if (!buffer) {
      counters.corruptions++;
      const evicted = await transact<number>(
        "readwrite",
        (context) => {
          const { objects, read, finish } = context;
          read(objects.get(request.sha256), (current?: StoredObject) => {
            // A different tab may already have repaired/replaced the object.
            if (current?.revision === object.revision) {
              objects.delete(request.sha256);
              recount(context, finish);
            } else {
              finish(0);
            }
          });
        },
        request.signal,
      );
      counters.evictions += evicted ?? 0;
    }
  }
  counters.misses++;
  request.signal?.throwIfAborted();
  // Leave credentials at the browser default (same-origin). Do not add headers
  // or carry auth in URLs. Refuse redirects before any cross-origin request.
  const response = await fetch(url.href, {
    signal: request.signal,
    mode: "same-origin",
    redirect: "error",
    cache: "no-store",
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw Error(`Immutable object HTTP ${response.status}`);
  }
  // Bound the actual decoded stream by the declaration, regardless of a lying,
  // absent, or compressed Content-Length. Never allocate from that header.
  const buffer = (await boundedBytes(response, request.bytes)).buffer;
  if (!(await verified(buffer, request)))
    throw Error("Immutable object size or SHA-256 mismatch");
  if (cached && request.cache !== false)
    await save(buffer, request, cached.generation, local);
  request.signal?.throwIfAborted();
  return buffer;
}
