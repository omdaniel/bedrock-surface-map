import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import type { VerifiedObjectRequest } from "../web/src/object-cache";

declare global {
  interface Window {
    objectCache: typeof import("../web/src/object-cache");
  }
}

const DATABASE = "bedrock-surface-immutable-objects";

function object(text: string): VerifiedObjectRequest {
  const sha256 = createHash("sha256").update(text).digest("hex");
  return {
    url: `/terrain/objects/${sha256}.bin`,
    sha256,
    bytes: Buffer.byteLength(text),
  };
}

async function setup(page: Page) {
  await page.route("**/object-cache-test.html", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Object cache tests</title>",
    }),
  );
  await page.goto("/object-cache-test.html");
  await page.evaluate(async () => {
    const path = "/src/object-cache.ts";
    window.objectCache = await import(path);
  });
}

async function read(page: Page, request: VerifiedObjectRequest) {
  return page.evaluate(
    async (request) =>
      new TextDecoder().decode(
        await window.objectCache.readVerifiedObject(request),
      ),
    request,
  );
}

async function stats(page: Page) {
  return page.evaluate(() => window.objectCache.objectCacheStats());
}

test("verified bodies survive reload, deduplicate by hash and use default same-origin credentials", async ({
  page,
  context,
}) => {
  const text = "immutable terrain";
  const request = object(text);
  let requests = 0;
  await context.addCookies([
    {
      name: "viewer",
      value: "synthetic-test-cookie",
      url: "http://127.0.0.1:5173".replace(
        ":5173",
        `:${process.env.SURFACE_TEST_PORT ?? 5173}`,
      ),
    },
  ]);
  await page.route("**/objects/*.bin", async (route) => {
    requests++;
    expect((await route.request().allHeaders()).cookie).toContain(
      "viewer=synthetic-test-cookie",
    );
    await route.fulfill({ body: text });
  });
  await setup(page);
  expect(await stats(page)).toMatchObject({
    available: true,
    maxBytes: 256 * 1024 * 1024,
    maxEntries: 2048,
    bytes: 0,
  });
  expect(await read(page, request)).toBe(text);
  expect(
    await read(page, {
      ...request,
      url: request.url.replace("/terrain/", "/other-terrain/"),
    }),
  ).toBe(text);
  expect(requests).toBe(1);
  expect(await stats(page)).toMatchObject({
    entries: 1,
    bytes: request.bytes,
    hits: 1,
    writes: 1,
  });
  await page.reload();
  await page.evaluate(async () => {
    const path = "/src/object-cache.ts";
    window.objectCache = await import(path);
  });
  await context.setOffline(true);
  expect(await read(page, request)).toBe(text);
  expect(requests).toBe(1);
  expect(await stats(page)).toMatchObject({ hits: 1, writes: 0, entries: 1 });
});

test("rejects unsafe URLs, mutable feeds and invalid bounds before fetch or storage", async ({
  page,
}) => {
  await setup(page);
  const request = object("validation");
  const result = await page.evaluate(async (base) => {
    const original = window.fetch;
    let fetches = 0;
    window.fetch = async () => {
      fetches++;
      throw Error("unexpected fetch");
    };
    const overrides: Partial<VerifiedObjectRequest>[] = [
      { url: "https://outside.invalid" + base.url },
      { url: `http://name:secret@${location.host}${base.url}` },
      { url: base.url + "?token=secret" },
      { url: base.url + "#secret" },
      { url: base.url + "?" },
      { url: base.url + "#" },
      { url: base.url.replace("objects/", "objects/%") },
      { url: "/api/v1/worlds/test/players" },
      { url: "/terrain/manifest.json" },
      { url: `/players/objects/${base.sha256}.bin` },
      { url: `/objects/${"f".repeat(64)}.bin` },
      { url: "data:application/octet-stream,validation" },
      { sha256: "invalid" },
      { sha256: base.sha256.toUpperCase() },
      { bytes: 0 },
      { bytes: -1 },
      { bytes: 1.1 },
      { bytes: Number.NaN },
      { bytes: Number.MAX_SAFE_INTEGER + 1 },
      { bytes: 64 * 1024 * 1024 + 1 },
      { maxBytes: 1 },
      { maxBytes: -1 },
      { maxBytes: Infinity },
      { maxBytes: 64 * 1024 * 1024 + 1 },
    ];
    const rejected: boolean[] = [];
    try {
      for (const override of overrides) {
        try {
          await window.objectCache.readVerifiedObject({ ...base, ...override });
          rejected.push(false);
        } catch {
          rejected.push(true);
        }
      }
    } finally {
      window.fetch = original;
    }
    return { rejected, fetches, databases: await indexedDB.databases() };
  }, request);
  expect(result.rejected.every(Boolean)).toBe(true);
  expect(result.fetches).toBe(0);
  expect(result.databases).toEqual([]);
});

test("bounds decoded streams and verifies exact length/hash before caching", async ({
  page,
}) => {
  await setup(page);
  const request = object("correct");
  const result = await page.evaluate(async (request) => {
    const original = window.fetch;
    let canceled = false;
    const failures: string[] = [];
    try {
      for (const body of ["wrong!!", "short", "too many decoded bytes"]) {
        window.fetch = async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(body));
                // Leave the oversized stream open to prove boundedBytes cancels it.
                if (body.length <= request.bytes) controller.close();
              },
              cancel() {
                canceled = true;
              },
            }),
            { headers: { "content-length": "1", "content-encoding": "gzip" } },
          );
        try {
          await window.objectCache.readVerifiedObject(request);
          failures.push("accepted");
        } catch (error) {
          failures.push(String(error));
        }
      }
    } finally {
      window.fetch = original;
    }
    return {
      failures,
      canceled,
      stats: await window.objectCache.objectCacheStats(),
    };
  }, request);
  expect(result.failures.slice(0, 2)).toEqual([
    "Error: Immutable object size or SHA-256 mismatch",
    "Error: Immutable object size or SHA-256 mismatch",
  ]);
  expect(result.failures[2]).toContain("exceeds size limit");
  expect(result.canceled).toBe(true);
  expect(result.stats).toMatchObject({ bytes: 0, entries: 0, writes: 0 });
});

test("corrupt persisted bodies are evicted and refetched, including oversized blobs", async ({
  page,
}) => {
  const text = "terrain fixture";
  const request = object(text);
  let requests = 0;
  await page.route("**/objects/*.bin", (route) => {
    requests++;
    return route.fulfill({ body: text });
  });
  await setup(page);
  await read(page, request);
  for (const [size, declared] of [
    [request.bytes, request.bytes],
    [request.bytes + 1, request.bytes],
    [request.bytes, Number.MAX_SAFE_INTEGER],
  ]) {
    await page.evaluate(
      async ({ name, sha256, size, declared }) => {
        await new Promise<void>((resolve, reject) => {
          const open = indexedDB.open(name, 1);
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction("objects", "readwrite");
            const store = tx.objectStore("objects");
            const get = store.get(sha256);
            get.onsuccess = () =>
              store.put({
                ...get.result,
                bytes: declared,
                body: new Blob([new Uint8Array(size)]),
              });
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onabort = () => {
              db.close();
              reject(tx.error);
            };
          };
        });
      },
      { name: DATABASE, sha256: request.sha256, size, declared },
    );
    expect(await read(page, request)).toBe(text);
    expect(await stats(page)).toMatchObject({
      bytes: request.bytes,
      entries: 1,
    });
  }
  expect(requests).toBe(4);
  expect(await stats(page)).toMatchObject({
    corruptions: 3,
    writes: 4,
    hits: 0,
  });
});

test("disk LRU honors hits, byte resizing, disabled mode and per-request bypass", async ({
  page,
}) => {
  const fixtures = ["aaaa", "bbbb", "cccc"].map(object);
  let requests = 0;
  await page.route("**/objects/*.bin", (route) => {
    requests++;
    const index = fixtures.findIndex((value) =>
      route.request().url().endsWith(value.url),
    );
    return route.fulfill({ body: ["aaaa", "bbbb", "cccc"][index] });
  });
  await setup(page);
  expect(
    await page.evaluate(() =>
      window.objectCache.configureObjectCache({ maxBytes: 8, enabled: true }),
    ),
  ).toBe(true);
  await read(page, fixtures[0]);
  await read(page, fixtures[1]);
  await read(page, fixtures[0]); // A is newer than B.
  await read(page, fixtures[2]); // B is evicted.
  await read(page, fixtures[0]);
  expect(requests).toBe(3);
  await read(page, fixtures[1]);
  expect(requests).toBe(4);
  expect(await stats(page)).toMatchObject({
    bytes: 8,
    entries: 2,
    evictions: 2,
  });
  await page.evaluate(() =>
    window.objectCache.configureObjectCache({ maxBytes: 4, enabled: true }),
  );
  expect(await stats(page)).toMatchObject({
    bytes: 4,
    entries: 1,
    evictions: 3,
  });
  await read(page, { ...fixtures[1], cache: false });
  expect(requests).toBe(5);
  await page.evaluate(() =>
    window.objectCache.configureObjectCache({ maxBytes: 4, enabled: false }),
  );
  await read(page, fixtures[1]);
  expect(requests).toBe(6);
  await page.evaluate(() =>
    window.objectCache.configureObjectCache({ maxBytes: 4, enabled: true }),
  );
  await read(page, fixtures[1]);
  expect(requests).toBe(6);
  await page.evaluate(() =>
    window.objectCache.configureObjectCache({ maxBytes: 0, enabled: true }),
  );
  await read(page, fixtures[1]);
  expect(await stats(page)).toMatchObject({
    bytes: 0,
    entries: 0,
    maxBytes: 0,
  });
});

test("entry cap evicts metadata even when the byte budget has room", async ({
  page,
}) => {
  await setup(page);
  const maximum = (await stats(page)).maxEntries;
  // Seed tiny entries in the real schema to exercise the count bound without
  // thousands of network round trips. Only the newly fetched object is read.
  await page.evaluate(
    async ({ name, maximum }) => {
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open(name, 1);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(["objects", "meta"], "readwrite");
          for (let i = 0; i < maximum; i++)
            tx.objectStore("objects").put({
              sha256: i.toString(16).padStart(64, "0"),
              bytes: 1,
              used: i + 1,
              revision: `fixture-${i}`,
              body: new Blob(["x"]),
            });
          const get = tx.objectStore("meta").get("state");
          get.onsuccess = () =>
            tx.objectStore("meta").put(
              {
                ...get.result,
                bytes: maximum,
                entries: maximum,
                clock: maximum,
              },
              "state",
            );
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
        };
        open.onerror = () => reject(open.error);
      });
    },
    { name: DATABASE, maximum },
  );
  await page.route("**/objects/*.bin", (route) =>
    route.fulfill({ body: "new object" }),
  );
  await read(page, object("new object"));
  expect(await stats(page)).toMatchObject({
    entries: maximum,
    bytes: maximum - 1 + 10,
    evictions: 1,
  });
});

test("cross-tab writes share accounting and policy, and clear invalidates pending network writes", async ({
  page,
  context,
}) => {
  const second = await context.newPage();
  const fixtures = ["1111", "2222", "3333", "4444"].map(object);
  await context.route("**/objects/*.bin", (route) => {
    const index = fixtures.findIndex((value) =>
      route.request().url().endsWith(value.url),
    );
    return route.fulfill({ body: ["1111", "2222", "3333", "4444"][index] });
  });
  await setup(page);
  await setup(second);
  await page.evaluate(() =>
    window.objectCache.configureObjectCache({ maxBytes: 8, enabled: true }),
  );
  await Promise.all([read(page, fixtures[0]), read(second, fixtures[1])]);
  expect(await stats(page)).toMatchObject({ bytes: 8, entries: 2 });
  await Promise.all([read(page, fixtures[2]), read(second, fixtures[3])]);
  expect(await stats(second)).toMatchObject({
    bytes: 8,
    entries: 2,
    maxBytes: 8,
  });
  await page.evaluate(() =>
    window.objectCache.configureObjectCache({ maxBytes: 8, enabled: false }),
  );
  await read(second, fixtures[0]);
  expect(await stats(second)).toMatchObject({ enabled: false, writes: 2 });
  await page.evaluate(() =>
    window.objectCache.configureObjectCache({ maxBytes: 8, enabled: true }),
  );

  let started!: () => void;
  let release!: () => void;
  const seen = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delayed = object("later");
  await context.route(`**/objects/${delayed.sha256}.bin`, async (route) => {
    started();
    await gate;
    await route.fulfill({ body: "later" });
  });
  const pending = read(second, delayed);
  await seen;
  expect(await page.evaluate(() => window.objectCache.clearObjectCache())).toBe(
    true,
  );
  release();
  expect(await pending).toBe("later");
  expect(await stats(second)).toMatchObject({ bytes: 0, entries: 0 });
});

test("dedicated workers read the same persisted objects and can clear them", async ({
  page,
  context,
}) => {
  const request = object("worker terrain");
  let requests = 0;
  await context.route("**/objects/*.bin", (route) => {
    requests++;
    return route.fulfill({ body: "worker terrain" });
  });
  await context.route("**/object-cache-worker.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `import { readVerifiedObject, objectCacheStats, clearObjectCache } from "/src/object-cache.ts";
      self.onmessage = async ({data}) => {
        try {
          const buffer = await readVerifiedObject(data);
          const stats = await objectCacheStats();
          const cleared = await clearObjectCache();
          self.postMessage({text: new TextDecoder().decode(buffer), stats, cleared});
        } catch(error) { self.postMessage({error: String(error)}); }
      };`,
    }),
  );
  await setup(page);
  await read(page, request);
  const result = await page.evaluate(
    (request) =>
      new Promise((resolve, reject) => {
        const worker = new Worker("/object-cache-worker.js", {
          type: "module",
        });
        worker.onmessage = ({ data }) => {
          worker.terminate();
          resolve(data);
        };
        worker.onerror = (error) => {
          worker.terminate();
          reject(Error(error.message));
        };
        worker.postMessage(request);
      }),
    request,
  );
  expect(result).toMatchObject({
    text: "worker terrain",
    cleared: true,
    stats: { hits: 1, writes: 0, entries: 1 },
  });
  expect(requests).toBe(1);
  expect(await stats(page)).toMatchObject({ bytes: 0, entries: 0 });
});

test("cancellation before fetch, during fetch and while hashing a cache hit never returns or stores a body", async ({
  page,
}) => {
  const request = object("abort fixture");
  await page.route("**/objects/*.bin", (route) =>
    route.fulfill({ body: "abort fixture" }),
  );
  await setup(page);
  const before = await page.evaluate(async (request) => {
    try {
      await window.objectCache.readVerifiedObject({
        ...request,
        signal: AbortSignal.abort(),
      });
      return "accepted";
    } catch (error) {
      return (error as Error).name;
    }
  }, request);
  expect(before).toBe("AbortError");
  expect(await stats(page)).toMatchObject({ entries: 0, misses: 0 });
  const during = await page.evaluate(async (request) => {
    const controller = new AbortController();
    const original = window.fetch;
    window.fetch = (input, init) => {
      const pending = original(input, init);
      controller.abort();
      return pending;
    };
    try {
      await window.objectCache.readVerifiedObject({
        ...request,
        signal: controller.signal,
      });
      return "accepted";
    } catch (error) {
      return (error as Error).name;
    } finally {
      window.fetch = original;
    }
  }, request);
  expect(during).toBe("AbortError");
  expect(await stats(page)).toMatchObject({ entries: 0 });
  await read(page, request);
  const hashing = await page.evaluate(async (request) => {
    const controller = new AbortController();
    const original = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = async (algorithm, data) => {
      const result = await original(algorithm, data);
      controller.abort();
      return result;
    };
    try {
      await window.objectCache.readVerifiedObject({
        ...request,
        signal: controller.signal,
      });
      return "accepted";
    } catch (error) {
      return (error as Error).name;
    } finally {
      crypto.subtle.digest = original;
    }
  }, request);
  expect(hashing).toBe("AbortError");
  expect(await stats(page)).toMatchObject({
    entries: 1,
    corruptions: 0,
    hits: 0,
    writes: 1,
  });
});

test("denied storage degrades to verified network reads", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "indexedDB", {
      get() {
        throw new DOMException("denied", "SecurityError");
      },
    });
  });
  await setup(page);
  await page.route("**/objects/*.bin", (route) =>
    route.fulfill({ body: "denied" }),
  );
  expect(await read(page, object("denied"))).toBe("denied");
  expect(
    await page.evaluate(() =>
      window.objectCache.configureObjectCache({ maxBytes: 8, enabled: false }),
    ),
  ).toBe(false);
  expect(await page.evaluate(() => window.objectCache.clearObjectCache())).toBe(
    false,
  );
  expect(await stats(page)).toMatchObject({
    available: false,
    bytes: null,
    entries: null,
    storageErrors: 1,
  });
});

test("quota errors roll back eviction/accounting and do not fail verified reads", async ({
  page,
}) => {
  const original = object("old!");
  const next = object("new!");
  await page.route("**/objects/*.bin", (route) =>
    route.fulfill({
      body: route.request().url().endsWith(original.url) ? "old!" : "new!",
    }),
  );
  await setup(page);
  await page.evaluate(() =>
    window.objectCache.configureObjectCache({ maxBytes: 4, enabled: true }),
  );
  await read(page, original);
  const result = await page.evaluate(
    async ({ request, name }) => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value, key) {
        // Fail the final metadata write after insertion and LRU deletion have
        // already been issued, proving that the entire transaction rolls back.
        if (this.name === "meta" && value.clock === 2)
          throw new DOMException("synthetic quota", "QuotaExceededError");
        return key === undefined
          ? put.call(this, value)
          : put.call(this, value, key);
      };
      let text: string;
      try {
        text = new TextDecoder().decode(
          await window.objectCache.readVerifiedObject(request),
        );
      } finally {
        IDBObjectStore.prototype.put = put;
      }
      const persisted = await new Promise<{ bytes: number; entries: number }>(
        (resolve, reject) => {
          const open = indexedDB.open(name, 1);
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction("meta", "readonly");
            const get = tx.objectStore("meta").get("state");
            get.onsuccess = () => resolve(get.result);
            tx.oncomplete = () => db.close();
          };
          open.onerror = () => reject(open.error);
        },
      );
      return {
        text,
        persisted,
        stats: await window.objectCache.objectCacheStats(),
      };
    },
    { request: next, name: DATABASE },
  );
  expect(result).toMatchObject({
    text: "new!",
    persisted: { bytes: 4, entries: 1 },
    stats: { available: false, storageErrors: 1, pendingWrites: 0 },
  });
  expect(await read(page, next)).toBe("new!");
});

test("concurrent verified downloads do not queue cache write copies, and returned buffers are independent", async ({
  page,
}) => {
  await setup(page);
  const result = await page.evaluate(async () => {
    const count = 12;
    const source = new TextEncoder().encode("write copies");
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const sha256 = Array.from(
      new Uint8Array(await digest("SHA-256", source)),
      (v) => v.toString(16).padStart(2, "0"),
    ).join("");
    const request = {
      url: `/objects/${sha256}.bin`,
      sha256,
      bytes: source.length,
    };
    const originalFetch = window.fetch;
    window.fetch = async () => new Response(source);
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    crypto.subtle.digest = async (algorithm, data) => {
      const result = await digest(algorithm, data);
      if (++arrived === count) release();
      await gate;
      return result;
    };
    try {
      const results = await Promise.all(
        Array.from({ length: count }, () =>
          window.objectCache.readVerifiedObject(request),
        ),
      );
      const snapshot = await window.objectCache.objectCacheStats();
      crypto.subtle.digest = digest;
      // Neither caller mutation nor transfer may corrupt the immutable Blob.
      new Uint8Array(results[0]).fill(0);
      structuredClone(results[1], { transfer: [results[1]] });
      const after = new TextDecoder().decode(
        await window.objectCache.readVerifiedObject(request),
      );
      return { snapshot, after, distinct: new Set(results).size };
    } finally {
      window.fetch = originalFetch;
      crypto.subtle.digest = digest;
    }
  });
  expect(result.snapshot).toMatchObject({
    entries: 1,
    writes: 1,
    skippedWrites: 11,
    pendingWrites: 0,
  });
  expect(result.after).toBe("write copies");
  expect(result.distinct).toBe(12);
});

test("redirects and HTTP errors never populate the persistent cache", async ({
  page,
}) => {
  await setup(page);
  const request = object("redirect");
  let redirected = 0;
  await page.route("**/forbidden-target", (route) => {
    redirected++;
    return route.fulfill({ body: "redirect" });
  });
  await page.route("**/objects/*.bin", (route) =>
    route.fulfill({ status: 302, headers: { location: "/forbidden-target" } }),
  );
  await expect(read(page, request)).rejects.toThrow();
  expect(redirected).toBe(0);
  await page.unroute("**/objects/*.bin");
  await page.route("**/objects/*.bin", (route) =>
    route.fulfill({ status: 401, body: "synthetic unauthorized" }),
  );
  await expect(read(page, request)).rejects.toThrow("HTTP 401");
  expect(await stats(page)).toMatchObject({ bytes: 0, entries: 0, writes: 0 });
});

test("a newer schema closes this connection and falls back without deleting newer data", async ({
  page,
}) => {
  await setup(page);
  const request = object("version change");
  let requests = 0;
  await page.route("**/objects/*.bin", (route) => {
    requests++;
    return route.fulfill({ body: "version change" });
  });
  await read(page, request);
  await page.evaluate(async (name) => {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(name, 2);
      open.onsuccess = () => {
        open.result.close();
        resolve();
      };
      open.onerror = () => reject(open.error);
    });
  }, DATABASE);
  expect(await read(page, request)).toBe("version change");
  expect(requests).toBe(2);
  expect(await stats(page)).toMatchObject({
    available: false,
    storageErrors: 1,
  });
  expect(
    await page.evaluate(
      async (name) =>
        (await indexedDB.databases()).find((db) => db.name === name)?.version,
      DATABASE,
    ),
  ).toBe(2);
});

test("an open blocked behind another tab's delete times out and serves verified network data", async ({
  page,
}) => {
  await setup(page);
  await page.route("**/objects/*.bin", (route) =>
    route.fulfill({ body: "blocked" }),
  );
  const result = await page.evaluate(
    async ({ name, request }) => {
      const held = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open(name, 1);
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      // Keep this unrelated tab's connection open so deletion blocks subsequent
      // open requests. The module must not wait indefinitely behind that request.
      const remove = indexedDB.deleteDatabase(name);
      await new Promise<void>((resolve) => {
        remove.onblocked = () => resolve();
      });
      const started = performance.now();
      try {
        const text = new TextDecoder().decode(
          await window.objectCache.readVerifiedObject(request),
        );
        return {
          text,
          elapsed: performance.now() - started,
          stats: await window.objectCache.objectCacheStats(),
        };
      } finally {
        const deleted = new Promise<void>((resolve) => {
          remove.onsuccess = () => resolve();
        });
        held.close();
        await deleted;
      }
    },
    { name: DATABASE, request: object("blocked") },
  );
  expect(result.text).toBe("blocked");
  expect(result.elapsed).toBeGreaterThanOrEqual(1800);
  expect(result.elapsed).toBeLessThan(10000);
  expect(result.stats).toMatchObject({
    available: false,
    storageErrors: 1,
    entries: null,
  });
});

test("legacy hashed terrain/assets are accepted and cache:false never opens IndexedDB", async ({
  page,
}) => {
  await setup(page);
  const result = await page.evaluate(async () => {
    const body = new TextEncoder().encode("synthetic asset");
    const sha256 = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", body)),
      (v) => v.toString(16).padStart(2, "0"),
    ).join("");
    const original = window.fetch;
    const calls: {
      credentials?: RequestCredentials;
      mode?: RequestMode;
      redirect?: RequestRedirect;
    }[] = [];
    window.fetch = async (_url, init) => {
      calls.push({
        credentials: init?.credentials,
        mode: init?.mode,
        redirect: init?.redirect,
      });
      return new Response(body);
    };
    try {
      for (const tail of [
        `objects/${sha256}.json`,
        `regions/${sha256}.bsm.zst`,
        `heights/${sha256}.i16.zst`,
        `assets/${sha256}.png`,
      ]) {
        await window.objectCache.readVerifiedObject({
          url: `/maps/test/${tail}`,
          sha256,
          bytes: body.byteLength,
          maxBytes: body.byteLength,
          cache: false,
        });
      }
      return { databases: await indexedDB.databases(), calls };
    } finally {
      window.fetch = original;
    }
  });
  expect(result.databases).toEqual([]);
  expect(result.calls).toHaveLength(4);
  for (const call of result.calls)
    expect(call).toEqual({
      credentials: undefined,
      mode: "same-origin",
      redirect: "error",
    });
});
