import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { zstdCompressSync } from "node:zlib";
import type { LocalMapStore } from "../web/src/local-store";
import type { ObjectRef } from "../web/src/types";

declare global {
  interface Window {
    flatStore: {
      Store: typeof LocalMapStore;
      store: LocalMapStore;
      items: { ref: ObjectRef; buffer: ArrayBuffer }[];
    };
  }
}

async function open(page: Page, cap = 1024) {
  const items = ["one", "two"].map((text) => {
    const body = zstdCompressSync(Buffer.from(text));
    const sha256 = createHash("sha256").update(body).digest("hex");
    return {
      ref: { url: `/objects/${sha256}.zst`, sha256, bytes: body.length },
      bytes: [...body],
    };
  });
  await page.route("**/local-store-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Local store test</title>",
    }),
  );
  await page.goto("/local-store-test");
  await page.evaluate(
    async ({ items, cap }) => {
      const path = "/src/local-store.ts";
      const { LocalMapStore } = (await import(
        path
      )) as typeof import("../web/src/local-store");
      window.flatStore = {
        Store: LocalMapStore,
        store: new LocalMapStore("store", cap),
        items: items.map(({ ref, bytes }) => ({
          ref: { ...ref, url: new URL(ref.url, location.href).href },
          buffer: new Uint8Array(bytes).buffer,
        })),
      };
      window.fetch = async () => {
        throw Error("Store must never fetch");
      };
    },
    { items, cap },
  );
  return items;
}

test("snapshots put input, returns independent verified reads and persists across instances", async ({
  page,
}) => {
  const items = await open(page);
  const result = await page.evaluate(async () => {
    const {
      store,
      Store,
      items: [item],
    } = window.flatStore;
    const pending = store.put(item.ref, item.buffer);
    new Uint8Array(item.buffer).fill(0);
    await pending;
    const read = await store.read(item.ref);
    const original = [...new Uint8Array(read!)];
    new Uint8Array(read!).fill(0);
    store.dispose();
    const other = new Store("store", 1024);
    try {
      return {
        original,
        persisted: [...new Uint8Array((await other.read(item.ref))!)],
        stats: await other.stats(),
      };
    } finally {
      other.dispose();
    }
  });
  expect(result.original).toEqual(items[0].bytes);
  expect(result.persisted).toEqual(items[0].bytes);
  expect(result.stats).toEqual({ bytes: items[0].ref.bytes, entries: 1 });
});

test("shared quota is atomic across concurrent writers, with no eviction or double charge", async ({
  page,
}) => {
  const items = await open(page, 12);
  expect(items[0].ref.bytes).toBe(12);
  const result = await page.evaluate(async () => {
    const { store, Store, items } = window.flatStore;
    const other = new Store("store", items[0].ref.bytes);
    try {
      const writes = await Promise.allSettled([
        store.put(items[0].ref, items[0].buffer),
        other.put(items[1].ref, items[1].buffer),
      ]);
      const winner = writes.findIndex((write) => write.status === "fulfilled");
      const item = items[winner];
      await other.put(item.ref, item.buffer);
      const before = await store.stats();
      const bodies = await Promise.all(
        items.map(
          async ({ ref }) => (await store.read(ref))?.byteLength ?? null,
        ),
      );
      await store.removeHashes([item.ref.sha256, item.ref.sha256]);
      await store.removeHashes([item.ref.sha256]);
      return {
        writes: writes.map((write) =>
          write.status === "rejected" ? String(write.reason) : "ok",
        ),
        before,
        bodies,
        after: await store.stats(),
      };
    } finally {
      other.dispose();
    }
  });
  expect(result.writes.filter((write) => write === "ok")).toHaveLength(1);
  expect(result.writes.find((write) => write !== "ok")).toContain(
    "QuotaExceededError",
  );
  expect(result.before).toEqual({ entries: 1, bytes: 12 });
  expect(result.bodies.sort()).toEqual([12, null]);
  expect(result.after).toEqual({ entries: 0, bytes: 0 });
});

test("native quota failure aborts body/accounting together and is recoverable", async ({
  page,
}) => {
  await open(page);
  const result = await page.evaluate(async () => {
    const {
      store,
      items: [old, next],
    } = window.flatStore;
    await store.put(old.ref, old.buffer);
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === "state")
        throw new DOMException("Synthetic browser quota", "QuotaExceededError");
      return put.apply(this, args);
    };
    let error: string;
    try {
      error = await store
        .put(next.ref, next.buffer)
        .then(() => "unexpected", String);
    } finally {
      IDBObjectStore.prototype.put = put;
    }
    const before = await store.stats();
    const missing = (await store.read(next.ref)) === undefined;
    await store.put(next.ref, next.buffer);
    return { error, before, missing, after: await store.stats() };
  });
  expect(result.error).toContain("QuotaExceededError");
  expect(result.before).toEqual({ entries: 1, bytes: 12 });
  expect(result.missing).toBe(true);
  expect(result.after).toEqual({ entries: 2, bytes: 24 });
});

test("rejects invalid references, wrong bodies and oversized stored Blobs without materialization", async ({
  page,
}) => {
  await open(page);
  const result = await page.evaluate(async () => {
    const {
      store,
      items: [item],
    } = window.flatStore;
    const invalid = [
      { ...item.ref, url: "/objects/raw.mcworld" },
      { ...item.ref, url: `${location.origin}/worlds/secret.ldb` },
      { ...item.ref, url: `${item.ref.url}?token=private` },
      {
        ...item.ref,
        url: item.ref.url.replace(location.origin, "https://example.invalid"),
      },
      { ...item.ref, bytes: 32 * 1024 * 1024 + 1 },
      { ...item.ref, sha256: "bad" },
    ];
    const errors = await Promise.all(
      invalid.map((ref) =>
        store.put(ref, item.buffer).then(() => "unexpected", String),
      ),
    );
    errors.push(
      await store
        .put(item.ref, item.buffer.slice(1))
        .then(() => "unexpected", String),
    );
    errors.push(
      await store
        .put(item.ref, new ArrayBuffer(item.ref.bytes))
        .then(() => "unexpected", String),
    );
    await store.put(item.ref, item.buffer);
    const request = indexedDB.open("bedrock-surface-local-map:store");
    const db = await new Promise<IDBDatabase>((resolve) => {
      request.onsuccess = () => resolve(request.result);
    });
    const tx = db.transaction("objects", "readwrite");
    tx.objectStore("objects").put(
      { body: new Blob([new Uint8Array(1024)]) },
      item.ref.sha256,
    );
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
    });
    db.close();
    const arrayBuffer = Blob.prototype.arrayBuffer;
    let materializations = 0;
    Blob.prototype.arrayBuffer = function () {
      materializations++;
      return arrayBuffer.call(this);
    };
    try {
      errors.push(await store.read(item.ref).then(() => "unexpected", String));
    } finally {
      Blob.prototype.arrayBuffer = arrayBuffer;
    }
    return { errors, materializations, stats: await store.stats() };
  });
  expect(result.errors).toHaveLength(9);
  expect(result.errors).not.toContain("unexpected");
  expect(result.materializations).toBe(0);
  expect(result.stats).toEqual({ entries: 1, bytes: 12 });
});

test("unavailable storage and corrupt accounting fail closed, with no reset or fallback", async ({
  page,
}) => {
  await open(page);
  const result = await page.evaluate(async () => {
    const {
      store,
      Store,
      items: [item],
    } = window.flatStore;
    const open = indexedDB.open;
    indexedDB.open = () => {
      throw new DOMException("Synthetic storage denied", "SecurityError");
    };
    const denied = new Store("denied", 1024);
    let error: string;
    try {
      error = await denied
        .put(item.ref, item.buffer)
        .then(() => "unexpected", String);
    } finally {
      indexedDB.open = open;
      denied.dispose();
    }
    await store.put(item.ref, item.buffer);
    const request = indexedDB.open("bedrock-surface-local-map:store");
    const db = await new Promise<IDBDatabase>((resolve) => {
      request.onsuccess = () => resolve(request.result);
    });
    const tx = db.transaction("state", "readwrite");
    tx.objectStore("state").put({ bytes: -1, entries: 1 }, "usage");
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
    });
    db.close();
    return {
      error,
      accounting: await store
        .put(item.ref, item.buffer)
        .then(() => "unexpected", String),
      read: [...new Uint8Array((await store.read(item.ref))!)],
    };
  });
  expect(result.error).toContain("SecurityError");
  expect(result.accounting).toContain("accounting is corrupt");
  expect(result.read).toHaveLength(12);
});

test("aborted writes and disposed stores cannot leave partial entries", async ({
  page,
}) => {
  await open(page);
  const result = await page.evaluate(async () => {
    const {
      store,
      items: [item],
    } = window.flatStore;
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    const error = await store
      .put({ ...item.ref, signal: controller.signal }, item.buffer)
      .then(() => "unexpected", String);
    const before = await store.stats();
    store.dispose();
    return {
      error,
      before,
      disposed: await store
        .put(item.ref, item.buffer)
        .then(() => "unexpected", String),
    };
  });
  expect(result.error).toContain("AbortError");
  expect(result.before).toEqual({ entries: 0, bytes: 0 });
  expect(result.disposed).toContain("disposed");
});
