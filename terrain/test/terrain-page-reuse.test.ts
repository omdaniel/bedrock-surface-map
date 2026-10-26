import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test, { type TestContext } from "node:test";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import type { LiveRoot } from "../../web/src/terrain.ts";
import type {
  DecodeRequest,
  Material,
  ObjectRef,
} from "../../web/src/types.ts";

// Node's type stripping does not handle the client's constructor properties.
const terrainUrl = new URL("../../web/src/terrain.ts", import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === terrainUrl && specifier.startsWith("./"))
      return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === terrainUrl)
      return {
        format: "module",
        shortCircuit: true,
        source: transpileModule(readFileSync(new URL(url), "utf8"), {
          compilerOptions: {
            target: ScriptTarget.ES2022,
            module: ModuleKind.ESNext,
          },
        }).outputText,
      };
    return next(url, context);
  },
});
const { TerrainClient } = await import("../../web/src/terrain.ts");

function object(id: number, extension = "zst"): ObjectRef {
  const sha256 = id.toString(16).padStart(64, "0");
  return { sha256, bytes: 32, url: `objects/${sha256}.${extension}` };
}

function fixture(t: TestContext, ids = [1, 1], columns = ids.length) {
  const bounds = [
    -256,
    -256,
    (columns - 1) * 256,
    (Math.ceil(ids.length / columns) - 1) * 256,
  ];
  let root: LiveRoot = {
    format_version: 2,
    rules_version: 1,
    world_id: "test-world",
    generation: "test-generation",
    revision: 1,
    name: "Synthetic shared heights",
    bounds,
    spawn: [0, 0, 0],
    source_sha256: "a".repeat(64),
    catalog: object(10000, "json"),
    atlas: object(10001, "png"),
    height_range: [-64, 128],
    regions: ids.map((id, i) => ({
      rx: (i % columns) - 1,
      rz: Math.floor(i / columns) - 1,
      index: object(20000 + i, "json"),
      surface: object(30000 + i),
      heights: object(id),
      columns: 65536,
    })),
  };
  const materials: Material[] = [
    {
      key: "stone",
      name: "stone",
      texture: "stone",
      tint: 0,
      approximate: false,
      uv: [0, 0, 1, 1],
      average: [1, 1, 1, 1],
    },
  ];
  const decoded = new Map<string, Float32Array>();
  const decode = t.mock.fn(async (request: Omit<DecodeRequest, "id">) => {
    assert.equal(request.kind, "heights");
    assert.equal(request.columns, 65536);
    assert.equal(request.width, 256);
    assert.ok([1, 2, 4].includes(request.stride!));
    const height = parseInt(request.sha256.slice(-4), 16);
    const values = Float32Array.from(
      { length: (256 / request.stride!) ** 2 },
      (_, i) => (i === 0 ? -1e6 : i === 1 ? -2.25 : height + (i % 16) / 16),
    );
    decoded.set(request.sha256, values);
    return values;
  });
  const pollRoot = t.mock.fn(async () => root);
  const client = new TerrainClient(
    new URL("https://terrain.example/live/manifest.json"),
    root,
    decode,
    pollRoot,
  );
  t.mock.method(
    client,
    "asset",
    (path: string) => new URL(path, client.base).href,
  );
  const checked = t.mock.method(
    client,
    "checked",
    async <T>(ref: ObjectRef): Promise<T> => {
      assert.equal(ref.sha256, root.catalog.sha256);
      return materials as T;
    },
  );
  t.mock.method(globalThis, "fetch", () => {
    throw Error("Unexpected network request");
  });
  return {
    client,
    decode,
    decoded,
    checked,
    pollRoot,
    prepare: (stride = 4, poll = false) =>
      client.prepare(
        new Map(),
        {
          left: bounds[0] + 8,
          top: bounds[1] + 8,
          right: bounds[2] - 8,
          bottom: bounds[3] - 8,
        },
        90,
        poll,
        256 * 1024 * 1024,
        stride,
      ),
    setHeights(next: number[]) {
      assert.equal(next.length, root.regions.length);
      root = {
        ...root,
        revision: root.revision + 1,
        regions: root.regions.map((r, i) => ({
          ...r,
          heights: object(next[i]),
        })),
      };
    },
  };
}

test("1024 regions with identical heights decode once and share one compact page", async (t) => {
  const f = fixture(t, Array(1024).fill(1), 32);
  const update = await f.prepare();
  assert.equal(f.decode.mock.callCount(), 1);
  assert.equal(f.client.bytesReceived, 32);
  assert.equal(update.pages.size, 1024);
  assert.equal(new Set(update.pages.values()).size, 1);
  assert.equal(update.pages.get("-1,-1")!.data.length, 4096);
  assert.equal(update.heights!.length, 2048 ** 2);
  assert.equal(update.heights![2], 1.125);
  assert.equal(update.heights![64 + 2], 1.125);
  assert.equal(update.heightPatches.length, 0);
  f.client.commit(update);
  assert.equal(f.client.memoryBytes, 1024 * 4096 * 2);
});

test("one changed shared object emits a patch for each region without copying its floats", async (t) => {
  const f = fixture(t);
  f.client.commit(await f.prepare());
  const previous = f.client.pages;
  f.setHeights([2, 2]);
  const update = await f.prepare(4, true);
  assert.equal(f.decode.mock.callCount(), 2);
  assert.equal(f.client.bytesReceived, 64);
  assert.equal(update.heights, undefined);
  assert.deepEqual(
    update.heightPatches.map(({ rx, rz }) => [rx, rz]),
    [
      [-1, -1],
      [0, -1],
    ],
  );
  assert.equal(update.heightPatches[0].values, update.heightPatches[1].values);
  assert.equal(update.heightPatches[0].values, f.decoded.get(object(2).sha256));
  assert.equal(update.pages.get("-1,-1"), update.pages.get("0,-1"));
  assert.equal(f.client.pages, previous);
  f.client.commit(update);
  const unchanged = await f.prepare();
  assert.equal(f.decode.mock.callCount(), 2);
  assert.equal(unchanged.heights, undefined);
  assert.equal(unchanged.heightPatches.length, 0);
});

test("committed content from another region supplies all changed patches without decoding", async (t) => {
  const f = fixture(t, [1, 1, 2]);
  f.client.commit(await f.prepare());
  const reused = f.client.pages.get("1,-1");
  f.setHeights([2, 2, 2]);
  const update = await f.prepare(4, true);
  assert.equal(f.decode.mock.callCount(), 2);
  assert.equal(f.client.bytesReceived, 64);
  assert.deepEqual(
    update.heightPatches.map(({ rx, rz }) => [rx, rz]),
    [
      [-1, -1],
      [0, -1],
    ],
  );
  assert.equal(new Set(update.pages.values()).size, 1);
  assert.equal(update.pages.get("-1,-1"), reused);
  const values = update.heightPatches[0].values;
  assert.equal(values, update.heightPatches[1].values);
  assert.equal(values.length, 4096);
  assert.equal(values[0], -1e6);
  assert.equal(values[1], -2.25);
  assert.equal(values[2], 2.125);
});

test("each stride transition decodes once at the new resolution and rebuilds heights", async (t) => {
  const f = fixture(t);
  for (const [i, stride] of [4, 2, 1, 4].entries()) {
    const previous = f.client.pages.get("-1,-1");
    const committedStride = f.client.stride;
    const update = await f.prepare(stride);
    assert.equal(f.decode.mock.callCount(), i + 1);
    assert.equal(f.decode.mock.calls[i].arguments[0].stride, stride);
    assert.equal(f.client.stride, committedStride);
    assert.notEqual(update.pages.get("-1,-1"), previous);
    assert.equal(update.pages.get("-1,-1")!.data.length, (256 / stride) ** 2);
    assert.equal(update.pages.get("-1,-1"), update.pages.get("0,-1"));
    assert.equal(update.heights!.length, (512 * 256) / stride ** 2);
    assert.equal(update.heightPatches.length, 0);
    f.client.commit(update);
    const unchanged = await f.prepare(stride);
    assert.equal(f.decode.mock.callCount(), i + 1);
    assert.equal(unchanged.heightPatches.length, 0);
    assert.equal(unchanged.heights, undefined);
  }
});

test("different height hashes decode independently while repeated hashes reuse pages", async (t) => {
  const f = fixture(t, [1, 2, 1, 2]);
  const initial = await f.prepare();
  assert.equal(f.decode.mock.callCount(), 2);
  assert.equal(new Set(initial.pages.values()).size, 2);
  f.client.commit(initial);
  f.setHeights([3, 4, 3, 4]);
  const update = await f.prepare(4, true);
  assert.equal(f.decode.mock.callCount(), 4);
  assert.equal(update.heightPatches.length, 4);
  assert.equal(update.heightPatches[0].values, update.heightPatches[2].values);
  assert.equal(update.heightPatches[1].values, update.heightPatches[3].values);
  assert.notEqual(
    update.heightPatches[0].values,
    update.heightPatches[1].values,
  );
});

test("uncommitted prepares do not populate a persistent content cache", async (t) => {
  const f = fixture(t);
  await f.prepare();
  await f.prepare();
  assert.equal(f.decode.mock.callCount(), 2);
  assert.equal(f.client.pages.size, 0);
});

test("content no longer in committed pages is decoded again when it returns", async (t) => {
  const f = fixture(t);
  f.client.commit(await f.prepare());
  f.setHeights([2, 2]);
  f.client.commit(await f.prepare(4, true));
  f.setHeights([1, 1]);
  const update = await f.prepare(4, true);
  assert.equal(f.decode.mock.callCount(), 3);
  assert.equal(update.heightPatches.length, 2);
});

test("invalid stride rejects before polling, catalog access or decoding", async (t) => {
  const f = fixture(t);
  for (const stride of [0, -1, 3, 8, NaN, Infinity])
    await assert.rejects(f.prepare(stride, true), /Invalid terrain stride/);
  assert.equal(f.pollRoot.mock.callCount(), 0);
  assert.equal(f.checked.mock.callCount(), 0);
  assert.equal(f.decode.mock.callCount(), 0);
});
