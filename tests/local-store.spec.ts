import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import type { LocalWorldStore } from "../web/src/lod/local-store";
import type { VerifiedObjectRequest } from "../web/src/object-cache";

declare global {
  interface Window {
    localWorld: LocalWorldStore;
    localWorldModule: typeof import("../web/src/lod/local-store");
  }
}

const databaseName = (id: string) =>
  "bedrock-surface-local-world:" + encodeURIComponent(id);
function fixture(text: string): VerifiedObjectRequest {
  const sha256 = createHash("sha256").update(text).digest("hex");
  return {
    url: `/terrain/objects/${sha256}.bin`,
    sha256,
    bytes: Buffer.byteLength(text),
  };
}

async function setup(
  page: Page,
  id = "https://example.test/world/lod.json",
  maxBytes?: number,
) {
  await page.route("**/local-store-test.html", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Local world tests</title>",
    }),
  );
  await page.goto("/local-store-test.html");
  await page.evaluate(
    async ({ id, maxBytes }) => {
      const path = "/src/lod/local-store.ts";
      window.localWorldModule = await import(path);
      window.localWorld = new window.localWorldModule.LocalWorldStore(
        id,
        maxBytes,
      );
    },
    { id, maxBytes },
  );
}

async function put(page: Page, text: string) {
  return page.evaluate(
    ({ request, text }) =>
      window.localWorld.put(request, new TextEncoder().encode(text).buffer),
    { request: fixture(text), text },
  );
}

async function read(page: Page, request: VerifiedObjectRequest) {
  return page.evaluate(async (request) => {
    const buffer = await window.localWorld.read(request);
    return buffer === undefined ? undefined : new TextDecoder().decode(buffer);
  }, request);
}

test("committed objects survive reload, never fetch, and ignore the optional cache flag", async ({
  page,
}) => {
  const request = fixture("local terrain");
  let network = 0;
  await page.route("**/terrain/objects/*", (route) => {
    network++;
    return route.abort();
  });
  await setup(page);
  expect(await read(page, request)).toBeUndefined();
  await put(page, "local terrain");
  await put(page, "local terrain");
  expect(await page.evaluate(() => window.localWorld.stats())).toEqual({
    bytes: request.bytes,
    entries: 1,
  });
  expect(await read(page, { ...request, cache: false })).toBe("local terrain");
  await setup(page);
  expect(await read(page, request)).toBe("local terrain");
  expect(await read(page, fixture("uncached terrain"))).toBeUndefined();
  expect(network).toBe(0);
});

test("put snapshots caller buffers and read cannot expose mutable storage", async ({
  page,
}) => {
  await setup(page);
  const result = await page.evaluate(async (request) => {
    const buffer = new TextEncoder().encode("snapshot").buffer;
    const writing = window.localWorld.put(request, buffer);
    new Uint8Array(buffer).fill(0);
    structuredClone(buffer, { transfer: [buffer] });
    await writing;
    const first = (await window.localWorld.read(request))!;
    const text = new TextDecoder().decode(first);
    new Uint8Array(first).fill(0);
    structuredClone(first, { transfer: [first] });
    return {
      text,
      again: new TextDecoder().decode(await window.localWorld.read(request)),
    };
  }, fixture("snapshot"));
  expect(result).toEqual({ text: "snapshot", again: "snapshot" });
});

test("unsafe references, incorrect lengths and hashes fail before storage", async ({
  page,
}) => {
  await setup(page);
  const result = await page.evaluate(async (request) => {
    const good = new TextEncoder().encode("valid").buffer;
    const failures: string[] = [];
    for (const override of [
      { url: "https://other.invalid" + request.url },
      { url: `http://secret:password@${location.host}${request.url}` },
      { url: request.url + "?secret=value" },
      { url: "/terrain/manifest.json" },
      { url: "/api/v1/worlds/world/players" },
      { bytes: 0 },
      { bytes: 64 * 1024 * 1024 + 1 },
      { maxBytes: 1 },
      { sha256: "not-a-digest" },
    ]) {
      for (const operation of ["read", "put"] as const) {
        try {
          if (operation === "read")
            await window.localWorld.read({ ...request, ...override });
          else await window.localWorld.put({ ...request, ...override }, good);
          failures.push("accepted");
        } catch {
          failures.push("rejected");
        }
      }
    }
    for (const buffer of [
      new ArrayBuffer(1),
      new TextEncoder().encode("wrong").buffer,
    ]) {
      try {
        await window.localWorld.put(request, buffer);
        failures.push("accepted");
      } catch {
        failures.push("rejected");
      }
    }
    return { failures, databases: await indexedDB.databases() };
  }, fixture("valid"));
  expect(result.failures).toHaveLength(20);
  expect(result.failures.every((value) => value === "rejected")).toBe(true);
  expect(result.databases).toEqual([]);
});

test("namespaces isolate objects, metadata, pagination and clear", async ({
  page,
}) => {
  await setup(page);
  const result = await page.evaluate(async (request) => {
    const { LocalWorldStore } = window.localWorldModule;
    const a = new LocalWorldStore("https://host.test/a/lod.json?q=a/b");
    const b = new LocalWorldStore("https://host.test/a/lod.json?q=a%2Fb");
    const bytes = new TextEncoder().encode("shared").buffer;
    await a.put(request, bytes);
    const missingInB = (await b.read(request)) === undefined;
    await b.put(request, bytes);
    await a.setMetadata("manifest", { revision: 1 });
    await b.setMetadata("manifest", { revision: 2 });
    await a.clear();
    return {
      missingInB,
      a: await a.stats(),
      b: await b.stats(),
      aMetadata: await a.metadata("manifest"),
      bMetadata: await b.metadata("manifest"),
      aHashes: await a.listHashes(),
      bHashes: await b.listHashes(),
      bText: new TextDecoder().decode(await b.read(request)),
    };
  }, fixture("shared"));
  expect(result).toEqual({
    missingInB: true,
    a: { bytes: 0, entries: 0 },
    b: { bytes: 6, entries: 1 },
    aMetadata: undefined,
    bMetadata: { revision: 2 },
    aHashes: { hashes: [] },
    bHashes: { hashes: [fixture("shared").sha256] },
    bText: "shared",
  });
});

test("concurrent cross-tab puts all commit without skipping or double charging duplicates", async ({
  page,
  context,
}) => {
  const second = await context.newPage();
  await setup(page, "parallel");
  await setup(second, "parallel");
  const items = Array.from({ length: 48 }, (_, i) => ({
    text: `tile-${i}`,
    request: fixture(`tile-${i}`),
  }));
  const batch = (
    page: Page,
    items: { text: string; request: VerifiedObjectRequest }[],
  ) =>
    page.evaluate(async (items) => {
      await Promise.all(
        items.map(({ request, text }) =>
          window.localWorld.put(request, new TextEncoder().encode(text).buffer),
        ),
      );
    }, items);
  await Promise.all([batch(page, items), batch(second, items)]);
  expect(await page.evaluate(() => window.localWorld.stats())).toEqual({
    bytes: items.reduce((sum, i) => sum + i.request.bytes, 0),
    entries: items.length,
  });
  expect(await second.evaluate(() => window.localWorld.listHashes())).toEqual({
    hashes: items.map((i) => i.request.sha256).sort(),
  });
  for (const item of [items[0], items[47]])
    expect(await read(second, item.request)).toBe(item.text);
});

test("namespace quota is atomic across tabs and never evicts successful objects", async ({
  page,
  context,
}) => {
  const second = await context.newPage();
  await setup(page, "quota", 40);
  await setup(second, "quota", 40);
  const items = Array.from({ length: 32 }, (_, i) => {
    const text = String(i).padStart(2, "0");
    return { text, request: fixture(text) };
  });
  const batch = (
    page: Page,
    items: { text: string; request: VerifiedObjectRequest }[],
  ) =>
    page.evaluate(
      async (items) =>
        Promise.all(
          items.map(async ({ text, request }) => {
            try {
              await window.localWorld.put(
                request,
                new TextEncoder().encode(text).buffer,
              );
              return { text, committed: true };
            } catch (error) {
              return { text, committed: false, error: (error as Error).name };
            }
          }),
        ),
      items,
    );
  const outcomes = (
    await Promise.all([
      batch(page, items.slice(0, 16)),
      batch(second, items.slice(16)),
    ])
  ).flat();
  expect(outcomes.filter((v) => v.committed)).toHaveLength(20);
  expect(
    outcomes
      .filter((v) => !v.committed)
      .every((v) => v.error === "QuotaExceededError"),
  ).toBe(true);
  expect(await page.evaluate(() => window.localWorld.stats())).toEqual({
    bytes: 40,
    entries: 20,
  });
  for (const item of outcomes)
    expect(await read(page, fixture(item.text))).toBe(
      item.committed ? item.text : undefined,
    );
  const saved = outcomes.find((v) => v.committed)!;
  await put(page, saved.text);
  expect(await page.evaluate(() => window.localWorld.stats())).toEqual({
    bytes: 40,
    entries: 20,
  });
});

test("over 2048 real committed entries survive reload and use bounded key-only GC pages", async ({
  page,
}) => {
  await setup(page, "large-inventory");
  const count = 2112;
  const expected = await page.evaluate(async (count) => {
    const hashes: string[] = [];
    for (let offset = 0; offset < count; offset += 32) {
      await Promise.all(
        Array.from({ length: Math.min(32, count - offset) }, async (_, j) => {
          const index = offset + j;
          const buffer = new Uint8Array([index & 255, index >>> 8, 7, 42])
            .buffer;
          const sha256 = Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)),
            (v) => v.toString(16).padStart(2, "0"),
          ).join("");
          await window.localWorld.put(
            { url: `/objects/${sha256}.bin`, sha256, bytes: 4 },
            buffer,
          );
          hashes.push(sha256);
        }),
      );
    }
    return hashes.sort();
  }, count);
  await setup(page, "large-inventory");
  const result = await page.evaluate(async () => {
    const store = window.localWorld;
    const before = await store.stats();
    const all: string[] = [];
    const sizes: number[] = [];
    let after: string | undefined;
    const get = IDBObjectStore.prototype.get;
    const getAll = IDBObjectStore.prototype.getAll;
    const cursor = IDBObjectStore.prototype.openCursor;
    const forbidden = () => {
      throw Error("Inventory must read only keys");
    };
    IDBObjectStore.prototype.get = forbidden;
    IDBObjectStore.prototype.getAll = forbidden;
    IDBObjectStore.prototype.openCursor = forbidden;
    try {
      do {
        const page = await store.listHashes(after);
        all.push(...page.hashes);
        sizes.push(page.hashes.length);
        if (page.next !== undefined && page.next !== page.hashes.at(-1))
          throw Error("Invalid continuation");
        after = page.next;
      } while (after !== undefined);
    } finally {
      IDBObjectStore.prototype.get = get;
      IDBObjectStore.prototype.getAll = getAll;
      IDBObjectStore.prototype.openCursor = cursor;
    }
    const small = await store.listHashes(all[0], 3);
    const last = all.at(-1)!;
    const body = await store.read({
      url: `/objects/${last}.bin`,
      sha256: last,
      bytes: 4,
    });
    await store.removeHashes(all.slice(0, 256));
    await store.removeHashes([all[0], all[0]]);
    return {
      before,
      all,
      sizes,
      small,
      bodyBytes: body?.byteLength,
      after: await store.stats(),
      firstRemaining: await store.listHashes(undefined, 1),
    };
  });
  expect(result.before).toEqual({ bytes: count * 4, entries: count });
  expect(result.all).toEqual(expected);
  expect(result.sizes).toEqual([...Array(8).fill(256), 64]);
  expect(result.small).toEqual({
    hashes: expected.slice(1, 4),
    next: expected[3],
  });
  expect(result.bodyBytes).toBe(4);
  expect(result.after).toEqual({
    bytes: (count - 256) * 4,
    entries: count - 256,
  });
  expect(result.firstRemaining).toEqual({
    hashes: [expected[256]],
    next: expected[256],
  });
});

test("corrupt bodies are removed with accurate accounting", async ({
  page,
}) => {
  await setup(page, "corrupt");
  await put(page, "keep");
  const request = fixture("corrupt");
  for (const size of [request.bytes, request.bytes + 10]) {
    await put(page, "corrupt");
    await page.evaluate(
      async ({ name, request, size }) => {
        await new Promise<void>((resolve, reject) => {
          const open = indexedDB.open(name, 1);
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction("objects", "readwrite");
            const store = tx.objectStore("objects");
            const get = store.get(request.sha256);
            get.onsuccess = () =>
              store.put(
                { ...get.result, body: new Blob([new Uint8Array(size)]) },
                request.sha256,
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
      { name: databaseName("corrupt"), request, size },
    );
    expect(await read(page, request)).toBeUndefined();
    expect(await page.evaluate(() => window.localWorld.stats())).toEqual({
      bytes: 4,
      entries: 1,
    });
    expect(await read(page, fixture("keep"))).toBe("keep");
  }
  await put(page, "corrupt");
  expect(await read(page, request)).toBe("corrupt");
});

test("JSON metadata enforces the 64 KiB UTF-8 limit without altering old values", async ({
  page,
}) => {
  await setup(page, "metadata", 0);
  const result = await page.evaluate(async () => {
    const store = window.localWorld;
    const input = { revision: 2, hashes: ["a", "b"], complete: false };
    const writing = store.setMetadata("manifest", input);
    input.revision = 99;
    await writing;
    const value = await store.metadata("manifest");
    const exact = "é".repeat(32767);
    await store.setMetadata("boundary", exact);
    const errors: string[] = [];
    for (const invalid of [exact + "é", undefined, 1n]) {
      try {
        await store.setMetadata("manifest", invalid);
        errors.push("accepted");
      } catch (error) {
        errors.push((error as Error).name);
      }
    }
    return {
      value,
      boundary: (await store.metadata<string>("boundary"))?.length,
      missing: await store.metadata("missing"),
      errors,
      still: await store.metadata("manifest"),
      stats: await store.stats(),
    };
  });
  expect(result.value).toEqual({
    revision: 2,
    hashes: ["a", "b"],
    complete: false,
  });
  expect(result.still).toEqual(result.value);
  expect(result.boundary).toBe(32767);
  expect(result.errors).toEqual(["RangeError", "TypeError", "TypeError"]);
  expect(result.missing).toBeUndefined();
  expect(result.stats).toEqual({ bytes: 0, entries: 0 });
});

test("transaction failures throw and roll back bodies and accounting together", async ({
  page,
}) => {
  await setup(page, "storage-failure");
  await put(page, "old");
  const result = await page.evaluate(async (request) => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (this.name === "state")
        throw new DOMException(
          "Synthetic quota after object writes",
          "QuotaExceededError",
        );
      return key === undefined
        ? put.call(this, value)
        : put.call(this, value, key);
    };
    let error = "accepted";
    try {
      await window.localWorld.put(
        request,
        new TextEncoder().encode("new").buffer,
      );
    } catch (e) {
      error = (e as Error).name;
    } finally {
      IDBObjectStore.prototype.put = put;
    }
    return {
      error,
      stats: await window.localWorld.stats(),
      read: await window.localWorld.read(request),
      hashes: await window.localWorld.listHashes(),
    };
  }, fixture("new"));
  expect(result).toEqual({
    error: "QuotaExceededError",
    stats: { bytes: 3, entries: 1 },
    read: undefined,
    hashes: { hashes: [fixture("old").sha256] },
  });
});

test("denied storage throws for reads, writes, metadata, inventory and clear", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, "indexedDB", {
      get() {
        throw new DOMException("denied", "SecurityError");
      },
    }),
  );
  await setup(page);
  const errors = await page.evaluate(async (request) => {
    const store = window.localWorld;
    const operations = [
      () => store.read(request),
      () => store.put(request, new TextEncoder().encode("denied").buffer),
      () => store.metadata("a"),
      () => store.setMetadata("a", {}),
      () => store.stats(),
      () => store.listHashes(),
      () => store.removeHashes([request.sha256]),
      () => store.clear(),
    ];
    const errors: string[] = [];
    for (const operation of operations) {
      try {
        await operation();
        errors.push("accepted");
      } catch (error) {
        errors.push((error as Error).name);
      }
    }
    return errors;
  }, fixture("denied"));
  expect(errors).toEqual(Array(8).fill("SecurityError"));
});

test("cancellation rejects a blocked write and timeout prevents a late commit", async ({
  page,
}) => {
  await setup(page, "timeouts");
  await page.evaluate(() => window.localWorld.stats());
  const result = await page.evaluate(
    async ({ name, request }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open(name, 1);
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      let hold = true;
      const tx = db.transaction("state", "readwrite");
      const spin = () => {
        const r = tx.objectStore("state").get("usage");
        r.onsuccess = () => {
          if (hold) spin();
        };
      };
      spin();
      const released = new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      const errors: string[] = [];
      try {
        const canceled = new AbortController();
        const first = window.localWorld.put(
          { ...request, signal: canceled.signal },
          new TextEncoder().encode("blocked").buffer,
        );
        setTimeout(() => canceled.abort(), 30);
        try {
          await first;
          errors.push("accepted");
        } catch (error) {
          errors.push((error as Error).name);
        }
        try {
          await window.localWorld.put(
            request,
            new TextEncoder().encode("blocked").buffer,
          );
          errors.push("accepted");
        } catch (error) {
          errors.push((error as Error).name);
        }
      } finally {
        hold = false;
        await released;
        db.close();
      }
      return {
        errors,
        stats: await window.localWorld.stats(),
        data: await window.localWorld.read(request),
      };
    },
    { name: databaseName("timeouts"), request: fixture("blocked") },
  );
  expect(result).toEqual({
    errors: ["AbortError", "TimeoutError"],
    stats: { bytes: 0, entries: 0 },
    data: undefined,
  });
});

test("dedicated workers share strict persisted storage with the page", async ({
  page,
  context,
}) => {
  await context.route("**/local-store-worker.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `
    import { LocalWorldStore } from "/src/lod/local-store.ts";
    self.onmessage = async ({data}) => {
      try {
        const store = new LocalWorldStore(data.id);
        const before = new TextDecoder().decode(await store.read(data.previous));
        await store.put(data.request, new TextEncoder().encode(data.text).buffer);
        await store.setMetadata("worker", {ok:true});
        self.postMessage({before, stats:await store.stats(), hashes:await store.listHashes()});
      } catch(error) { self.postMessage({error:String(error)}); }
    };
  `,
    }),
  );
  await setup(page, "worker");
  await put(page, "page");
  const result = await page.evaluate(
    (data) =>
      new Promise((resolve, reject) => {
        const worker = new Worker("/local-store-worker.js", { type: "module" });
        worker.onmessage = ({ data }) => {
          worker.terminate();
          resolve(data);
        };
        worker.onerror = (error) => {
          worker.terminate();
          reject(Error(error.message));
        };
        worker.postMessage(data);
      }),
    {
      id: "worker",
      previous: fixture("page"),
      request: fixture("worker"),
      text: "worker",
    },
  );
  expect(result).toEqual({
    before: "page",
    stats: { bytes: 10, entries: 2 },
    hashes: {
      hashes: [fixture("page").sha256, fixture("worker").sha256].sort(),
    },
  });
  expect(await read(page, fixture("worker"))).toBe("worker");
  expect(
    await page.evaluate(() => window.localWorld.metadata("worker")),
  ).toEqual({ ok: true });
});

test("GC and inventory reject oversized batches and invalid cursors without mutation", async ({
  page,
}) => {
  await setup(page);
  await put(page, "kept");
  const result = await page.evaluate(async (request) => {
    const store = window.localWorld;
    const operations = [
      () => store.removeHashes(Array(257).fill(request.sha256)),
      () => store.removeHashes([request.sha256, "bad"]),
      () => store.listHashes(undefined, 257),
      () => store.listHashes(undefined, 0),
      () => store.listHashes("bad"),
    ];
    const errors: string[] = [];
    for (const operation of operations) {
      try {
        await operation();
        errors.push("accepted");
      } catch (error) {
        errors.push((error as Error).name);
      }
    }
    return { errors, stats: await store.stats() };
  }, fixture("kept"));
  expect(result).toEqual({
    errors: [
      "RangeError",
      "TypeError",
      "RangeError",
      "RangeError",
      "TypeError",
    ],
    stats: { bytes: 4, entries: 1 },
  });
});

test("a slow corruption read cannot delete a concurrently committed repair", async ({
  page,
}) => {
  await setup(page, "repair-race");
  await put(page, "repair");
  const result = await page.evaluate(
    async ({ name, request }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open(name, 1);
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("objects", "readwrite");
        const store = tx.objectStore("objects");
        const get = store.get(request.sha256);
        get.onsuccess = () =>
          store.put(
            { ...get.result, body: new Blob([new Uint8Array(request.bytes)]) },
            request.sha256,
          );
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      db.close();
      let started!: () => void;
      let release!: () => void;
      const seen = new Promise<void>((resolve) => {
        started = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      crypto.subtle.digest = async (algorithm, data) => {
        const result = await digest(algorithm, data);
        if (new Uint8Array(data as ArrayBuffer)[0] === 0) {
          started();
          await gate;
        }
        return result;
      };
      let missing = false;
      try {
        const reading = window.localWorld.read(request);
        await seen;
        const other = new window.localWorldModule.LocalWorldStore(
          "repair-race",
        );
        await other.put(request, new TextEncoder().encode("repair").buffer);
        release();
        missing = (await reading) === undefined;
      } finally {
        release();
        crypto.subtle.digest = digest;
      }
      return {
        missing,
        value: new TextDecoder().decode(await window.localWorld.read(request)),
        stats: await window.localWorld.stats(),
      };
    },
    { name: databaseName("repair-race"), request: fixture("repair") },
  );
  expect(result).toEqual({
    missing: true,
    value: "repair",
    stats: { bytes: 6, entries: 1 },
  });
});

test("missing accounting fails truthfully and explicit clear recovers the namespace", async ({
  page,
}) => {
  await setup(page, "missing-accounting");
  await put(page, "stored");
  const result = await page.evaluate(async (name) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(name, 1);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("state", "readwrite");
      tx.objectStore("state").delete("usage");
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    db.close();
    let error = "accepted";
    try {
      await window.localWorld.stats();
    } catch (e) {
      error = String(e);
    }
    await window.localWorld.clear();
    return {
      error,
      stats: await window.localWorld.stats(),
      hashes: await window.localWorld.listHashes(),
    };
  }, databaseName("missing-accounting"));
  expect(result.error).toContain("accounting is missing");
  expect(result.stats).toEqual({ bytes: 0, entries: 0 });
  expect(result.hashes).toEqual({ hashes: [] });
});
