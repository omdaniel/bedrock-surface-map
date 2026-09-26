import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertLiveRevision,
  catalogAppendPages,
  changedChunks,
  chunkStamp,
  patchPicking,
} from "../web/src/lod/live.ts";
import { LodRootSource, readBytes } from "../web/src/lod/root-source.ts";
import {
  parseManifest,
  type LodManifest,
  type LodNode,
} from "../web/src/lod/protocol.ts";

const url = new URL("https://example.test/map/lod.json");
const ref = (letter = "a") => ({
  url: `objects/${letter.repeat(64)}.bin`,
  sha256: letter.repeat(64),
  bytes: 128,
});
const chunk = (cx: number, cz: number, hash = "a") => ({
  cx,
  cz,
  ...ref(hash),
});
const node = (chunks = [chunk(-8, -1), chunk(-1, -8)]): LodNode => ({
  key: { level: 0, x: -1, z: -1 },
  data: ref(),
  height: ref(),
  children: [],
  chunks,
});
function root(): LodManifest {
  return parseManifest(
    {
      kind: "surface-lod",
      format_version: 1,
      name: "Synthetic",
      bounds: [-128, -128, 0, 0],
      spawn: [-64, 64, -64],
      source_sha256: "a".repeat(64),
      generation: "test-generation",
      world_id: "test-world",
      revision: 1,
      appearance_version: "1",
      height_range: [0, 2048],
      atlas: ref(),
      material_count: 2,
      catalog: [{ ...ref(), start: 0, count: 2 }],
      roots: [{ key: node().key, index: ref() }],
    },
    new URL(".", url),
  );
}

test("resident revision stamps preserve signed coordinates and unsigned hashes compactly", () => {
  const before = node([chunk(-8, -1, "f"), chunk(-1, -8, "b")]);
  const stamp = chunkStamp(before.chunks);
  assert.equal(stamp.byteLength, 80);
  const after = node([
    chunk(-1, -8, "c"),
    chunk(-8, -1, "f"),
    chunk(-2, -2, "e"),
  ]);
  assert.deepEqual(changedChunks(stamp, after), [
    after.chunks![0],
    after.chunks![2],
  ]);
  assert.equal(changedChunks(stamp, node([before.chunks![0]])), null);
  assert.equal(changedChunks(stamp, before), null);
  assert.equal(changedChunks(new Int32Array(), after), null);
});

test("picking patches replace complete negative-coordinate chunks only after validation", () => {
  const pick = new Int32Array(128 * 128 * 2).fill(9);
  const values = new Int32Array(1024).fill(4);
  values.fill(7, 512);
  patchPicking(pick, node().key, new Int32Array([-8, -1, -1, -8]), values);
  assert.equal(pick[112 * 128 * 2], 4);
  assert.equal(pick[112 * 2], 7);
  assert.equal(pick[0], 9);
  const saved = pick.slice();
  for (const coords of [
    [-8, -1, 0, -1],
    [-8, -1, -8, -1],
  ]) {
    assert.throws(() =>
      patchPicking(pick, node().key, new Int32Array(coords), values),
    );
    assert.deepEqual(pick, saved);
  }
});

test("live identity and catalog epochs reject regression and distinguish append-only pages", () => {
  const before = root();
  for (const patch of [
    { revision: 0 },
    { world_id: "other" },
    { generation: "other" },
  ])
    assert.throws(() => assertLiveRevision(before, { ...before, ...patch }));
  assert.doesNotThrow(() =>
    assertLiveRevision(before, { ...before, revision: 2 }),
  );
  assert.deepEqual(catalogAppendPages(before, before), []);
  assert.equal(
    catalogAppendPages(before, { ...before, atlas: ref("b") }),
    null,
  );
  assert.equal(
    catalogAppendPages(before, {
      ...before,
      catalog: [{ ...before.catalog[0], ...ref("b") }],
    }),
    null,
  );
  const after = {
    ...before,
    material_count: 3,
    catalog: [{ ...before.catalog[0], count: 3, ...ref("c") }],
  };
  assert.deepEqual(catalogAppendPages(before, after), [
    { before: before.catalog[0], after: after.catalog[0] },
  ]);
});

test("bounded HTTP reads reject errors, excess data and truncated declared objects", async () => {
  await assert.rejects(
    readBytes(new Response("bad", { status: 503 }), 16),
    /HTTP 503/,
  );
  await assert.rejects(readBytes(new Response("abc"), 2), /reservation/);
  await assert.rejects(
    readBytes(new Response("abc", { headers: { "Content-Length": "99" } }), 16),
    /length limit/,
  );
  await assert.rejects(readBytes(new Response("abc"), 4, 4), /Truncated/);
  assert.equal(
    new TextDecoder().decode(await readBytes(new Response("ok"), 16)),
    "ok",
  );
});

async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.ok(predicate(), "asynchronous source did not settle");
}

test("root polling revalidates, serializes admission, retains failures and suspends hidden reads", async () => {
  const original = globalThis.fetch;
  let reply: () => Promise<Response> = async () =>
    Response.json(root(), { headers: { ETag: '"1"' } });
  let requests = 0,
    reservations = 0,
    released = 0;
  let headers: HeadersInit | undefined;
  const accepted: number[] = [];
  let unblock: (() => void) | undefined;
  globalThis.fetch = async (_input, options) => {
    requests++;
    headers = options?.headers;
    return reply();
  };
  const source = new LodRootSource(
    url,
    root(),
    async (next) => {
      accepted.push(next.revision);
      if (next.revision === 2)
        await new Promise<void>((resolve) => {
          unblock = resolve;
        });
    },
    () => {
      reservations++;
      return true;
    },
    () => {
      released++;
    },
    () => {},
  );
  try {
    source.refresh();
    await until(() => released === 1);
    assert.deepEqual(accepted, []);
    reply = async () => new Response(null, { status: 304 });
    source.refresh();
    await until(() => released === 2);
    assert.equal(new Headers(headers).get("If-None-Match"), '"1"');
    reply = async () => Response.json({ ...root(), revision: 2 });
    source.refresh();
    await until(() => Boolean(unblock));
    source.refresh();
    assert.equal(requests, 3);
    source.visibility(false);
    unblock!();
    await until(() => released === 3);
    source.refresh();
    assert.equal(requests, 3);
    reply = async () => Response.json({ ...root(), revision: 0 });
    source.visibility(true);
    await until(() => released === 4);
    assert.equal(source.state, "delayed");
    assert.match(source.error!, /backwards/);
    reply = async () => Response.json({ ...root(), revision: 3 });
    source.refresh();
    await until(() => released === 5);
    assert.deepEqual(accepted, [2, 3]);
    assert.equal(source.state, "live");
    assert.equal(reservations, released);
  } finally {
    source.destroy();
    globalThis.fetch = original;
  }
});
