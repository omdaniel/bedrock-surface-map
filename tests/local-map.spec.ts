import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { zstdCompressSync } from "node:zlib";
import type {
  LocalMapDataset,
  LocalMapState,
  ObjectRef,
} from "../web/src/local-map";
import type { LocalMapStore } from "../web/src/local-store";

declare global {
  interface Window {
    flatMap: {
      Dataset: typeof LocalMapDataset;
      Store: typeof LocalMapStore;
      dataset: LocalMapDataset;
      refs: ObjectRef[];
      states: LocalMapState[];
      pending?: Promise<string>;
      reader?: Promise<number[]>;
      finished?: boolean;
      readFinished?: boolean;
      blocked?: boolean;
      release?: () => void;
    };
  }
}

function object(text: string, kind: "zst" | "json" | "png" = "zst") {
  const body =
    kind === "zst" ? zstdCompressSync(Buffer.from(text)) : Buffer.from(text);
  const sha256 = createHash("sha256").update(body).digest("hex");
  return {
    body,
    ref: { url: `/objects/${sha256}.${kind}`, sha256, bytes: body.length },
  };
}
type Fixture = ReturnType<typeof object>;

async function open(
  page: Page,
  objects: Fixture[],
  id = "flat",
  cap = 1024 * 1024,
) {
  await page.route("**/local-map-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Local map test</title>",
    }),
  );
  await page.goto("/local-map-test");
  await load(page, objects, id, cap);
}

async function load(page: Page, objects: Fixture[], id: string, cap: number) {
  await page.evaluate(
    async ({ refs, id, cap }) => {
      const module = "/src/local-map.ts",
        storeModule = "/src/local-store.ts";
      const { LocalMapDataset } = (await import(
        module
      )) as typeof import("../web/src/local-map");
      const { LocalMapStore } = (await import(
        storeModule
      )) as typeof import("../web/src/local-store");
      const states: LocalMapState[] = [];
      window.flatMap = {
        Dataset: LocalMapDataset,
        Store: LocalMapStore,
        dataset: new LocalMapDataset(id, cap, (state) => states.push(state)),
        refs: refs.map((ref) => ({
          ...ref,
          url: new URL(ref.url, location.href).href,
        })),
        states,
      };
    },
    { refs: objects.map((o) => o.ref), id, cap },
  );
}

async function serve(page: Page, objects: Fixture[]) {
  const hits: string[] = [];
  await page.route("**/objects/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    hits.push(path);
    const item = objects.find((o) => o.ref.url === path);
    if (!item) return route.abort();
    await route.fulfill({
      body: item.body,
      contentType: "application/octet-stream",
    });
  });
  return hits;
}

async function stats(page: Page, id = "flat") {
  return page.evaluate(async (id) => {
    const store = new window.flatMap.Store(id, 1024 * 1024);
    try {
      return await store.stats();
    } finally {
      store.dispose();
    }
  }, id);
}

test("whole inventory downloads without readers; reads stay local offline and after reload", async ({
  page,
  context,
}) => {
  const objects = [
    object("region"),
    object("height"),
    object('{"materials":[]}', "json"),
    object("atlas bytes", "png"),
  ];
  const hits = await serve(page, objects);
  await open(page, objects);
  await page.evaluate(() =>
    window.flatMap.dataset.prepare(window.flatMap.refs),
  );
  expect(hits).toHaveLength(4);
  expect(await page.evaluate(() => window.flatMap.dataset.state)).toEqual({
    phase: "ready",
    bytes: objects.reduce((sum, o) => sum + o.body.length, 0),
    count: 4,
    completed: 4,
    error: null,
  });
  await context.setOffline(true);
  const local = await page.evaluate(async () => {
    window.fetch = async () => {
      throw Error("read attempted HTTP");
    };
    return Promise.all(
      window.flatMap.refs.map(async ({ url, sha256 }) =>
        Array.from(
          new Uint8Array(await window.flatMap.dataset.read({ url, sha256 })),
        ),
      ),
    );
  });
  expect(local).toEqual(objects.map((o) => [...o.body]));
  await context.setOffline(false);
  await page.route("**/objects/*", (route) => {
    hits.push("forbidden");
    return route.abort();
  });
  await page.reload();
  await load(page, objects, "flat", 1024 * 1024);
  await page.evaluate(() =>
    window.flatMap.dataset.prepare(window.flatMap.refs),
  );
  expect(hits).toHaveLength(4);
  expect((await stats(page)).entries).toBe(4);
});

test("unchanged polls use only memory, deduplicate hashes and still verify every read", async ({
  page,
}) => {
  const objects = [object("one"), object("two")];
  const hits = await serve(page, objects);
  await open(page, objects);
  const result = await page.evaluate(async () => {
    const { dataset, refs } = window.flatMap;
    await dataset.prepare([...refs, refs[0]]);
    const transaction = IDBDatabase.prototype.transaction;
    const digest = crypto.subtle.digest;
    let transactions = 0,
      hashes = 0;
    IDBDatabase.prototype.transaction = function (...args) {
      transactions++;
      return transaction.apply(this, args);
    };
    crypto.subtle.digest = function (...args) {
      hashes++;
      return digest.apply(this, args);
    };
    try {
      for (let i = 0; i < 10; i++) await dataset.prepare([...refs].reverse());
      const polls = { transactions, hashes };
      await dataset.read(refs[0]);
      await dataset.read(refs[0]);
      return { polls, hashes, state: dataset.state };
    } finally {
      IDBDatabase.prototype.transaction = transaction;
      crypto.subtle.digest = digest;
    }
  });
  expect(result.polls).toEqual({ transactions: 0, hashes: 0 });
  expect(result.hashes).toBe(2);
  expect(result.state.completed).toBe(2);
  expect(hits).toHaveLength(2);
});

test("two downloads maximum; a queued read waits without fetching or steering the queue", async ({
  page,
}) => {
  const objects = Array.from({ length: 5 }, (_, i) => object(`region ${i}`));
  const arrivals: string[] = [];
  const releases: (() => void)[] = [];
  let active = 0,
    maximum = 0;
  await page.route("**/objects/*", async (route) => {
    active++;
    maximum = Math.max(maximum, active);
    const path = new URL(route.request().url()).pathname;
    arrivals.push(path);
    await new Promise<void>((resolve) => releases.push(resolve));
    active--;
    await route.fulfill({
      body: objects.find((o) => o.ref.url === path)!.body,
    });
  });
  await open(page, objects);
  await page.evaluate(() => {
    const t = window.flatMap;
    t.pending = t.dataset.prepare(t.refs).then(() => {
      t.finished = true;
      return "ok";
    }, String);
    t.reader = t.dataset.read(t.refs[4]).then((bytes) => {
      t.readFinished = true;
      return [...new Uint8Array(bytes)];
    });
  });
  await expect.poll(() => arrivals.length).toBe(2);
  expect(
    await page.evaluate(() => ({
      finished: !!window.flatMap.finished,
      reader: !!window.flatMap.readFinished,
    })),
  ).toEqual({ finished: false, reader: false });
  expect(new Set(arrivals)).toEqual(
    new Set(objects.slice(0, 2).map((o) => o.ref.url)),
  );
  expect(
    await page.evaluate(() =>
      window.flatMap.dataset
        .prepare(window.flatMap.refs)
        .then(() => "unexpected", String),
    ),
  ).toContain("already running");
  releases.splice(0).forEach((release) => release());
  await expect.poll(() => arrivals.length).toBe(4);
  releases.splice(0).forEach((release) => release());
  await expect.poll(() => arrivals.length).toBe(5);
  releases.splice(0).forEach((release) => release());
  expect(await page.evaluate(() => window.flatMap.pending)).toBe("ok");
  expect(await page.evaluate(() => window.flatMap.reader)).toEqual([
    ...objects[4].body,
  ]);
  expect(maximum).toBe(2);
  expect(arrivals).toHaveLength(5);
});

for (const failure of ["short", "long", "hash", "http", "redirect"] as const) {
  test(`rejects ${failure} download, retains old publication, and retries explicitly`, async ({
    page,
  }) => {
    const objects = [object("old"), object("new")];
    const hits = await serve(page, objects);
    await open(page, objects);
    await page.evaluate(() =>
      window.flatMap.dataset.prepare([window.flatMap.refs[0]]),
    );
    let broken = true;
    await page.route(`**${objects[1].ref.url}`, async (route) => {
      if (!broken) return route.fulfill({ body: objects[1].body });
      if (failure === "http") return route.fulfill({ status: 503 });
      if (failure === "redirect")
        return route.fulfill({
          status: 302,
          headers: { location: objects[0].ref.url },
        });
      const body =
        failure === "short"
          ? objects[1].body.subarray(1)
          : failure === "long"
            ? Buffer.concat([objects[1].body, Buffer.from([0])])
            : Buffer.alloc(objects[1].body.length);
      await route.fulfill({ body });
    });
    const error = await page.evaluate(() =>
      window.flatMap.dataset
        .prepare([window.flatMap.refs[1]])
        .then(() => "unexpected", String),
    );
    expect(error).not.toBe("unexpected");
    expect((await stats(page)).entries).toBe(1);
    expect(await page.evaluate(() => window.flatMap.dataset.state.phase)).toBe(
      "error",
    );
    expect(
      await page.evaluate(async () => [
        ...new Uint8Array(
          await window.flatMap.dataset.read(window.flatMap.refs[0]),
        ),
      ]),
    ).toEqual([...objects[0].body]);
    broken = false;
    await page.evaluate(() =>
      window.flatMap.dataset.prepare([window.flatMap.refs[1]]),
    );
    expect(await stats(page)).toEqual({
      entries: 2,
      bytes: objects[0].body.length + objects[1].body.length,
    });
    expect(hits).toHaveLength(1);
  });
}

test("quota needs update headroom, does not drop data, and recovers with a larger explicit cap", async ({
  page,
}) => {
  const objects = [object("old"), object("new")];
  await serve(page, objects);
  await open(page, objects, "flat", objects[0].body.length);
  await page.evaluate(() =>
    window.flatMap.dataset.prepare([window.flatMap.refs[0]]),
  );
  expect(
    await page.evaluate(() =>
      window.flatMap.dataset
        .prepare([window.flatMap.refs[1]])
        .then(() => "unexpected", String),
    ),
  ).toContain("quota");
  expect(await stats(page)).toEqual({
    entries: 1,
    bytes: objects[0].body.length,
  });
  await page.evaluate(async () => {
    await window.flatMap.dataset.dispose();
    window.flatMap.dataset = new window.flatMap.Dataset("flat", 1024);
    await window.flatMap.dataset.prepare([window.flatMap.refs[1]]);
  });
  expect(await stats(page)).toEqual({
    entries: 1,
    bytes: objects[1].body.length,
  });
});

test("missing/corrupt stored data fails locally and only explicit prepare repairs it", async ({
  page,
}) => {
  const objects = [object("valid")];
  const hits = await serve(page, objects);
  await open(page, objects);
  await page.evaluate(() =>
    window.flatMap.dataset.prepare(window.flatMap.refs),
  );
  for (const damage of ["hash", "size", "missing"]) {
    await page.evaluate(async (damage) => {
      const request = indexedDB.open("bedrock-surface-local-map:flat");
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const tx = db.transaction("objects", "readwrite");
        const ref = window.flatMap.refs[0];
        if (damage === "missing") tx.objectStore("objects").delete(ref.sha256);
        else
          tx.objectStore("objects").put(
            {
              body: new Blob([
                new Uint8Array(damage === "size" ? ref.bytes + 1 : ref.bytes),
              ]),
            },
            ref.sha256,
          );
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    }, damage);
    const before = hits.length;
    expect(
      await page.evaluate(() =>
        window.flatMap.dataset
          .read(window.flatMap.refs[0])
          .then(() => "unexpected", String),
      ),
    ).toMatch(/mismatch|missing/);
    expect(hits).toHaveLength(before);
    expect(await page.evaluate(() => window.flatMap.dataset.state.phase)).toBe(
      "error",
    );
    await page.evaluate(() =>
      window.flatMap.dataset.prepare(window.flatMap.refs),
    );
    expect(hits).toHaveLength(before + 1);
    expect(await stats(page)).toEqual({
      entries: 1,
      bytes: objects[0].body.length,
    });
  }
});

test("GC waits for the entire new publication and conservatively protects another tab", async ({
  page,
  context,
}) => {
  const objects = [object("old"), object("new"), object("newer")];
  await serve(page, objects);
  await open(page, objects);
  await page.evaluate(() =>
    window.flatMap.dataset.prepare([window.flatMap.refs[0]]),
  );
  const other = await context.newPage();
  await serve(other, objects);
  await open(other, objects);
  await other.evaluate(() =>
    window.flatMap.dataset.prepare([window.flatMap.refs[0]]),
  );
  let release!: () => void;
  let arrived = false;
  await page.route(`**${objects[1].ref.url}`, async (route) => {
    arrived = true;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({ body: objects[1].body });
  });
  await page.evaluate(() => {
    window.flatMap.pending = window.flatMap.dataset
      .prepare([window.flatMap.refs[1]])
      .then(() => "ok", String);
  });
  await expect.poll(() => arrived).toBe(true);
  expect((await stats(page)).entries).toBe(1);
  release();
  expect(await page.evaluate(() => window.flatMap.pending)).toBe("ok");
  expect((await stats(page)).entries).toBe(2);
  expect(
    await other.evaluate(async () => [
      ...new Uint8Array(
        await window.flatMap.dataset.read(window.flatMap.refs[0]),
      ),
    ]),
  ).toEqual([...objects[0].body]);
  await other.close();
  await page.evaluate(() =>
    window.flatMap.dataset.prepare([window.flatMap.refs[2]]),
  );
  expect(await stats(page)).toEqual({
    entries: 2,
    bytes: objects[1].body.length + objects[2].body.length,
  });
});

test("without Web Locks GC is disabled and publication still persists", async ({
  page,
}) => {
  const objects = [object("old"), object("new")];
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "locks", { value: undefined }),
  );
  await serve(page, objects);
  await open(page, objects);
  await page.evaluate(async () => {
    await window.flatMap.dataset.prepare([window.flatMap.refs[0]]);
    await window.flatMap.dataset.prepare([window.flatMap.refs[1]]);
  });
  expect((await stats(page)).entries).toBe(2);
});

test("previous publication stays readable after prepare; GC drains already queued older reads", async ({
  page,
}) => {
  const objects = [object("old"), object("new"), object("third")];
  const hits = await serve(page, objects);
  await open(page, objects);
  await page.evaluate(async () => {
    const { dataset, refs } = window.flatMap;
    await dataset.prepare([refs[0]]);
    await dataset.prepare([refs[1]]);
  });
  expect(
    await page.evaluate(async () => [
      ...new Uint8Array(
        await window.flatMap.dataset.read(window.flatMap.refs[0]),
      ),
    ]),
  ).toEqual([...objects[0].body]);
  await page.evaluate(() => {
    const t = window.flatMap;
    const arrayBuffer = Blob.prototype.arrayBuffer;
    let first = true;
    Blob.prototype.arrayBuffer = async function () {
      if (first) {
        first = false;
        t.blocked = true;
        await new Promise<void>((resolve) => {
          t.release = resolve;
        });
      }
      return arrayBuffer.call(this);
    };
    // Both reads are accepted while the old publication is still previous.
    t.reader = Promise.all([
      t.dataset.read(t.refs[0]),
      t.dataset.read(t.refs[0]),
    ])
      .then((buffers) =>
        buffers.flatMap((buffer) => [...new Uint8Array(buffer)]),
      )
      .finally(() => {
        Blob.prototype.arrayBuffer = arrayBuffer;
      });
  });
  await expect
    .poll(() => page.evaluate(() => window.flatMap.blocked))
    .toBe(true);
  await page.evaluate(() => {
    const t = window.flatMap;
    t.pending = t.dataset.prepare([t.refs[2]]).then(() => {
      t.finished = true;
      return "ok";
    }, String);
  });
  await expect
    .poll(() => page.evaluate(() => window.flatMap.dataset.state.completed))
    .toBe(1);
  expect(await page.evaluate(() => !!window.flatMap.finished)).toBe(false);
  expect((await stats(page)).entries).toBe(3);
  await page.evaluate(() => window.flatMap.release!());
  expect(await page.evaluate(() => window.flatMap.reader)).toEqual([
    ...objects[0].body,
    ...objects[0].body,
  ]);
  expect(await page.evaluate(() => window.flatMap.pending)).toBe("ok");
  expect((await stats(page)).entries).toBe(2);
  expect(
    await page.evaluate(() =>
      window.flatMap.dataset
        .read(window.flatMap.refs[0])
        .then(() => "unexpected", String),
    ),
  ).toContain("not in the supplied local publication");
  expect(hits).toHaveLength(3);
});

test("dispose aborts a download and waiting read and releases locks", async ({
  page,
}) => {
  const objects = [object("pending")];
  let arrived = false;
  await page.route("**/objects/*", () => {
    arrived = true;
  });
  await open(page, objects);
  await page.evaluate(() => {
    const t = window.flatMap;
    t.pending = Promise.allSettled([
      t.dataset.prepare(t.refs),
      t.dataset.read(t.refs[0]),
    ]).then((results) => results.map((r) => r.status).join(","));
  });
  await expect.poll(() => arrived).toBe(true);
  await page.evaluate(() => window.flatMap.dataset.dispose());
  expect(await page.evaluate(() => window.flatMap.pending)).toBe(
    "rejected,rejected",
  );
  expect(await page.evaluate(() => window.flatMap.dataset.state.phase)).toBe(
    "disposed",
  );
  expect(
    await page.evaluate(
      async () =>
        (await navigator.locks.query()).held?.filter((lock) =>
          lock.name?.startsWith("bedrock-surface-local-map:"),
        ).length,
    ),
  ).toBe(0);
});

test("more than 4096 tiny objects persist without entry eviction and unchanged polls stay cheap", async ({
  page,
}) => {
  test.setTimeout(180000);
  const objects = Array.from({ length: 4100 }, (_, i) => object(`tiny ${i}`));
  const byPath = new Map(objects.map((o) => [o.ref.url, o]));
  let hits = 0;
  await page.route("**/objects/*", (route) => {
    hits++;
    return route.fulfill({
      body: byPath.get(new URL(route.request().url()).pathname)!.body,
    });
  });
  await open(page, objects);
  await page.evaluate(() =>
    window.flatMap.dataset.prepare(window.flatMap.refs),
  );
  expect(hits).toBe(4100);
  expect(await stats(page)).toEqual({
    entries: 4100,
    bytes: objects.reduce((sum, o) => sum + o.body.length, 0),
  });
  const result = await page.evaluate(async () => {
    const { dataset, refs } = window.flatMap;
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = () => {
      throw Error("unchanged inventory touched IndexedDB");
    };
    try {
      await dataset.prepare(refs);
    } finally {
      IDBObjectStore.prototype.get = get;
    }
    window.fetch = async () => {
      throw Error("offline read attempted HTTP");
    };
    const first = await dataset.read(refs[0]),
      last = await dataset.read(refs.at(-1)!);
    return {
      first: [...new Uint8Array(first)],
      last: [...new Uint8Array(last)],
    };
  });
  expect(result.first).toEqual([...objects[0].body]);
  expect(result.last).toEqual([...objects.at(-1)!.body]);
  // Keep the immediately previous inventory, then prune across multiple pages
  // on the following changed publication. This is flat transition protection.
  await page.evaluate(() =>
    window.flatMap.dataset.prepare([window.flatMap.refs[0]]),
  );
  expect((await stats(page)).entries).toBe(4100);
  await page.evaluate(() => window.flatMap.dataset.prepare([]));
  expect(await stats(page)).toEqual({
    entries: 1,
    bytes: objects[0].body.length,
  });
  expect(hits).toBe(4100);
});
