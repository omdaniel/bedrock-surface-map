import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setImmediate as tick } from "node:timers/promises";
import test from "node:test";
import { LodDecoder } from "../web/src/lod/decoder.ts";
import {
  decodeChunkPatch,
  prepareUpdate,
  surfacePicking,
  type ChunkRef,
  type DecodeObject,
} from "../web/src/lod/decoder-data.ts";
import { DecoderDownloads } from "../web/src/lod/decoder-transport.ts";
import type { DecodeResult } from "../web/src/lod/decoder.worker.ts";
import type { LodNode } from "../web/src/lod/protocol.ts";

const base = new URL("http://127.0.0.1:5195/maps/synthetic/lod.json");
const ref = (url = "objects/test", bytes = 16) => ({
  url,
  bytes,
  sha256: "a".repeat(64),
});
function fixture(x = -1, z = -1): LodNode {
  return {
    key: { level: 0, x, z },
    data: ref("objects/detail"),
    height: ref("objects/height"),
    children: [],
    chunks: Array.from({ length: 64 }, (_, i) => ({
      ...ref(`objects/chunk-${i}`),
      cx: x * 8 + (i % 8),
      cz: z * 8 + Math.floor(i / 8),
    })),
  };
}

test("update plans fetch only selected existing chunks and the new height", () => {
  const node = fixture();
  const chunks = [node.chunks![63], node.chunks![0]];
  const plan = prepareUpdate(node, chunks, base, 64);
  assert.equal(plan.updateKind, "chunks");
  assert.equal(plan.surface, undefined);
  assert.deepEqual(
    plan.chunks!.map(({ cx, cz }) => [cx, cz]),
    [
      [-1, -1],
      [-8, -8],
    ],
  );
  assert.deepEqual(
    plan.chunks!.map(({ ref }) => ref.url),
    chunks.map((c) => c.url),
  );
  assert.equal(plan.height.url, new URL(node.height.url, base).href);
  chunks[0].url = "objects/mutated";
  assert.equal(plan.chunks![0].ref.url, "objects/chunk-63");
  const full = prepareUpdate(node, null, base, 64);
  assert.equal(full.updateKind, "surface");
  assert.equal(full.surface!.ref.url, node.data.url);
  assert.equal(full.chunks, undefined);
  const summary = {
    ...node,
    key: { level: 1, x: -1, z: -1 },
    chunks: undefined,
  };
  assert.equal(prepareUpdate(summary, null, base, 64).updateKind, "surface");
  assert.throws(() => prepareUpdate(summary, [], base, 64), /update chunks/);
});

test("chunk preflight rejects invalid lists, identities, coordinates and material counts", () => {
  const node = fixture();
  const c = node.chunks![0];
  for (const chunks of [
    [],
    Array(65).fill(c),
    [c, c],
    [{ ...c, cx: -9 }],
    [{ ...c, cx: -1.5 }],
    [{ ...c, sha256: "b".repeat(64) }],
    [{ ...c, url: "objects/other" }],
    [{ ...c, bytes: c.bytes + 1 }],
  ]) {
    assert.throws(() => prepareUpdate(node, chunks, base, 64));
  }
  for (const materials of [0, -1, NaN, Infinity, 1.5, 65537])
    assert.throws(
      () => prepareUpdate(node, [c], base, materials),
      /material count/,
    );
  for (const key of [
    { level: 0, x: -0.5, z: 0 },
    { level: 17, x: 0, z: 0 },
  ])
    assert.throws(() => prepareUpdate({ ...node, key }, null, base, 64));
  assert.throws(
    () => prepareUpdate({ ...node, chunks: [c, c] }, [c], base, 64),
    /duplicate chunk/,
  );
});

test("preflight enforces object security and the exact 2 MiB chunk plus height bound", () => {
  const node = fixture(-65536, 65535);
  node.chunks!.forEach((chunk) => {
    chunk.bytes = 32768;
  });
  node.height.bytes = 2 * 1024 * 1024;
  const plan = prepareUpdate(node, node.chunks!, base, 65536);
  assert.equal(
    plan.chunks!.reduce((sum, chunk) => sum + chunk.ref.bytes, 0),
    2 * 1024 * 1024,
  );
  assert.equal(plan.height.ref.bytes, 2 * 1024 * 1024);
  node.chunks![0].bytes++;
  assert.throws(
    () => prepareUpdate(node, node.chunks!, base, 64),
    /asset size/,
  );
  for (const url of [
    "https://evil.invalid/object",
    "../escape",
    "object?secret",
    "a".repeat(513),
  ]) {
    const bad = { ...fixture(), height: ref(url) };
    assert.throws(() => prepareUpdate(bad, bad.chunks!, base, 64), /asset URL/);
  }
  for (const bytes of [0, -1, NaN, 1.5, 2 * 1024 * 1024 + 1])
    assert.throws(() =>
      prepareUpdate(
        { ...fixture(), height: ref("objects/height", bytes) },
        null,
        base,
        64,
      ),
    );
});

function detailWords(cells: number, height: number, material: number) {
  const words = new Uint32Array(cells * 8);
  for (let i = 0; i < cells; i++)
    words.set([height, material, 0xffabcdef, 31, 0, 63, -16, 1], i * 8);
  return words;
}

test("chunk patches preserve signed coordinates, row order, pick fields and material mask", () => {
  const chunks = [
    { cx: -1, cz: -8 },
    { cx: -8, cz: -1 },
  ];
  const inputs = [detailWords(256, -32, 1), detailWords(256, 100, 33)];
  inputs[0][7] = 0;
  inputs[0][15] = 2;
  inputs[0][8 * 255] = -1024;
  const patch = decodeChunkPatch(chunks, 64, (i) => inputs[i]);
  assert.deepEqual([...patch.coordinates], [-1, -8, -8, -1]);
  assert.equal(patch.words.length, 2048 * 2);
  assert.equal(patch.pick.length, 512 * 2);
  assert.deepEqual([...patch.words.subarray(2048)], [...inputs[1]]);
  assert.deepEqual(
    [...patch.pick.subarray(0, 6)],
    [-32768, 1, -32768, 1, -32, 1],
  );
  assert.equal(patch.pick[510], -1024);
  assert.deepEqual([...patch.pick.subarray(512, 514)], [100, 33]);
  assert.deepEqual([...patch.materialMask!], [0x80000002, 0x80000002]);
  const loaded = surfacePicking(patch.words, "detail", 64, 512);
  assert.deepEqual(patch.pick, loaded.pick);
  assert.deepEqual(patch.materialMask, loaded.materialMask);
});

test("summary picking retains packed mean/min, max and flags; decoded output sizes are bounded", () => {
  const words = new Uint32Array([0, 0, 0, 0xffe0fff0, 0x1234ffd0, 0xabcd4321]);
  const result = surfacePicking(words, "summary", 1, 1);
  assert.deepEqual([...result.pick], [0xffe0fff0 | 0, 0xabcdffd0 | 0]);
  assert.equal(result.materialMask, undefined);
  assert.throws(
    () => surfacePicking(new Uint32Array(7), "detail", 64, 1),
    /size/,
  );
  assert.throws(
    () => surfacePicking(new Uint32Array(), "detail", 64, 0),
    /size/,
  );
  assert.throws(
    () => surfacePicking(detailWords(1, 16, 64), "detail", 64, 1),
    /material/,
  );
  assert.throws(
    () => decodeChunkPatch([], 64, () => new Uint32Array()),
    /chunks/,
  );
  assert.throws(
    () =>
      decodeChunkPatch(
        Array(65).fill({ cx: 0, cz: 0 }),
        64,
        () => new Uint32Array(),
      ),
    /chunks/,
  );
  assert.throws(
    () => decodeChunkPatch([{ cx: 0, cz: 0 }], 64, () => new Uint32Array(2047)),
    /chunk size/,
  );
  const max = decodeChunkPatch(fixture().chunks!, 64, () =>
    detailWords(256, 16, 1),
  );
  assert.equal(max.words.byteLength, 524288);
  assert.equal(max.pick.byteLength, 131072);
  assert.equal(max.coordinates.byteLength, 512);
});

function object(bytes = new Uint8Array([1, 2, 3])): DecodeObject {
  return {
    url: new URL("objects/test", base).href,
    ref: {
      ...ref("objects/test", bytes.length),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}

test("object download concurrency is globally two even across overlapping jobs", async () => {
  let active = 0,
    peak = 0,
    calls = 0;
  const downloads = new DecoderDownloads(async function (
    this: unknown,
    _url,
    init,
  ) {
    assert.equal(this, globalThis, "worker fetch requires its global receiver");
    assert.equal(init?.redirect, "error");
    calls++;
    active++;
    peak = Math.max(peak, active);
    return new Response(
      new ReadableStream({
        start(controller) {
          setImmediate(() => {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.close();
            active--;
          });
        },
      }),
    );
  });
  const [a, b] = await Promise.all([
    downloads.readAll(Array(65).fill(object()), new AbortController()),
    downloads.readAll([object(), object()], new AbortController()),
  ]);
  assert.equal(peak, 2);
  assert.equal(active, 0);
  assert.equal(calls, 67);
  assert.equal(a.length, 65);
  assert.equal(b.length, 2);
});

test("failed transfers abort siblings and wait for them to drain before acknowledging", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const controller = new AbortController();
  let calls = 0,
    done = false;
  const downloads = new DecoderDownloads(async (_url, init) => {
    if (++calls === 1) return new Response(null, { status: 503 });
    await gate;
    assert.equal(init!.signal!.aborted, true);
    throw init!.signal!.reason;
  });
  const pending = downloads.readAll([object(), object(), object()], controller);
  const check = assert.rejects(pending, /HTTP 503/);
  void pending.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  await tick();
  assert.equal(controller.signal.aborted, true);
  assert.equal(done, false);
  assert.equal(calls, 2);
  release();
  await check;
  assert.equal(done, true);
});

test("cancelled queued jobs never fetch, and active cancellation waits for the reader", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const downloads = new DecoderDownloads(async () => {
    calls++;
    await gate;
    return new Response(new Uint8Array([1, 2, 3]));
  });
  const active = new AbortController(),
    queued = new AbortController();
  const a = downloads.readAll([object(), object()], active);
  const b = downloads.readAll([object(), object()], queued);
  const checks = [
    assert.rejects(a, { name: "AbortError" }),
    assert.rejects(b, { name: "AbortError" }),
  ];
  let done = false;
  void a.catch(() => {
    done = true;
  });
  active.abort();
  queued.abort();
  await tick();
  assert.equal(done, false);
  release();
  await Promise.all(checks);
  assert.equal(calls, 2);
});

test("transport rejects length, checksum and size violations and cancels bodies", async () => {
  const cases = [
    {
      body: [1, 2, 3],
      headers: { "content-length": "4" },
      error: /length mismatch/,
    },
    { body: [1, 2, 3, 4], error: /exceeds declared/ },
    { body: [1, 2], error: /Truncated/ },
    { body: [1, 2, 4], error: /checksum/ },
  ];
  for (const value of cases) {
    const downloads = new DecoderDownloads(
      async () =>
        new Response(new Uint8Array(value.body), { headers: value.headers }),
    );
    await assert.rejects(
      downloads.readAll([object()], new AbortController()),
      value.error,
    );
  }
  let cancelled = false;
  const downloads = new DecoderDownloads(
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-length": "4" } },
      ),
  );
  await assert.rejects(
    downloads.readAll([object()], new AbortController()),
    /length mismatch/,
  );
  assert.equal(cancelled, true);
  let called = false;
  const invalid = new DecoderDownloads(async () => {
    called = true;
    return new Response();
  });
  for (const size of [0, -1, NaN, 1.5, 2097153])
    await assert.rejects(
      invalid.readAll(
        [{ ...object(), ref: ref("objects/test", size) }],
        new AbortController(),
      ),
      /size limit/,
    );
  assert.equal(called, false);
});

class FakeWorker {
  static last: FakeWorker;
  onmessage!: (event: { data: DecodeResult }) => void;
  onerror!: (event: { message: string }) => void;
  messages: { type: string; id: number }[] = [];
  terminated = false;
  failPost = false;
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(message: { type: string; id: number }) {
    if (this.failPost) throw Error("dispatch failed");
    this.messages.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  reply(id: number, extra: Partial<DecodeResult> = {}) {
    this.onmessage({ data: { id, wasmBytes: 1024, decodeMs: 2, ...extra } });
  }
}

test("decoder keeps cancelled reservations until acknowledgement and rejects stale success", async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: FakeWorker,
  });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "Worker", descriptor);
    else Reflect.deleteProperty(globalThis, "Worker");
  });
  const decoder = new LodDecoder();
  t.after(() => decoder.destroy());
  const worker = FakeWorker.last;
  const node = fixture();
  const abort = new AbortController();
  const first = decoder.update(
    node,
    node.chunks!.slice(0, 2),
    base,
    64,
    abort.signal,
  );
  const second = decoder.load(
    node.height,
    node.key,
    "height",
    base,
    64,
    new AbortController().signal,
  );
  const firstCheck = assert.rejects(first, { name: "AbortError" });
  let settled = false;
  void first.catch(() => {
    settled = true;
  });
  abort.abort();
  await tick();
  assert.equal(settled, false);
  assert.deepEqual(
    worker.messages.map(({ type }) => type),
    ["update", "load", "cancel"],
  );
  assert.throws(
    () => decoder.update(node, null, base, 64, new AbortController().signal),
    /concurrency/,
  );
  worker.reply(1, { updateKind: "chunks", words: new Uint32Array(4096) });
  await firstCheck;
  const third = decoder.update(
    node,
    null,
    base,
    64,
    new AbortController().signal,
  );
  worker.reply(3, { updateKind: "surface", heightWords: new Uint32Array(8) });
  assert.equal((await third).updateKind, "surface");
  worker.reply(2, { words: new Uint32Array([7]) });
  assert.equal((await second).words![0], 7);
  assert.equal(decoder.decodeMs, 6);
  assert.equal(decoder.wasmBytes, 1024);
});

test("invalid updates dispatch nothing; dispatch failure and worker death release slots safely", async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: FakeWorker,
  });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "Worker", descriptor);
    else Reflect.deleteProperty(globalThis, "Worker");
  });
  const decoder = new LodDecoder(),
    worker = FakeWorker.last,
    node = fixture();
  t.after(() => decoder.destroy());
  const signal = new AbortController().signal;
  assert.throws(() => decoder.update(node, [], base, 64, signal));
  assert.throws(
    () => decoder.update(node, null, base, 64, AbortSignal.abort()),
    { name: "AbortError" },
  );
  assert.equal(worker.messages.length, 0);
  worker.failPost = true;
  await assert.rejects(
    decoder.update(node, null, base, 64, signal),
    /dispatch failed/,
  );
  worker.failPost = false;
  const a = decoder.update(node, null, base, 64, signal);
  const b = decoder.update(node, null, base, 64, signal);
  const checks = [
    assert.rejects(a, /worker died/),
    assert.rejects(b, /worker died/),
  ];
  worker.onerror({ message: "worker died" });
  await Promise.all(checks);
  assert.equal(worker.terminated, true);
  assert.throws(() => decoder.update(node, null, base, 64, signal), /stopped/);
});
