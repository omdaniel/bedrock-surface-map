import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_INDEX_BYTES,
  MAX_TILE_BYTES,
  catalogPagesForMask,
  parseCatalog,
  parseKey,
  parseManifest,
  parseNode,
  parseNodeRef,
  parseRef,
} from "../web/src/lod/protocol.ts";
import type { TileKey } from "../web/src/lod/protocol.ts";

const BASE = new URL("https://map.example.test/synthetic/");
const HASH = "a".repeat(64);
const WORLD_LIMIT = 8_388_608;

test("material dependency masks select pages across word and page boundaries", () => {
  const ranges = [
    [0, 31],
    [31, 225],
    [256, 256],
    [512, 1],
  ];
  const pages = ranges.map(([start, count]) => ({ ...ref(), start, count }));
  const mask = new Uint32Array(Math.ceil(513 / 32));
  assert.deepEqual(catalogPagesForMask(mask, pages), []);
  for (const id of [0, 31, 32, 255, 256, 511, 512]) {
    mask.fill(0);
    mask[id >>> 5] |= 1 << (id & 31);
    assert.deepEqual(catalogPagesForMask(mask, pages), [
      pages.findIndex(
        (page) => page.start <= id && id < page.start + page.count,
      ),
    ]);
  }
  mask.fill(0xffffffff);
  assert.deepEqual(catalogPagesForMask(mask, pages), [0, 1, 2, 3]);
  assert.throws(() => catalogPagesForMask(new Uint32Array(1), pages));
});

test("a full catalog uses a bounded 8192-byte material dependency bitset", () => {
  const pages = Array.from({ length: 256 }, (_, index) => ({
    ...ref(),
    start: index * 256,
    count: 256,
  }));
  const mask = new Uint32Array(2048);
  mask[2047] = 0x80000000;
  assert.deepEqual(catalogPagesForMask(mask, pages), [255]);
  assert.equal(mask.byteLength, 8192);
});

function ref(url = `objects/${HASH}.bin`, bytes = 128) {
  return { url, sha256: HASH, bytes };
}

function nodeRef(key: TileKey) {
  return { key, index: ref(`nodes/${HASH}.json`) };
}

// Matches the flattened ObjectRef/CatalogPageRef layout serialized by surface-core.
function manifest() {
  return {
    kind: "surface-lod",
    format_version: 1,
    name: "Synthetic protocol world",
    bounds: [-256, -256, 256, 256],
    spawn: [0, 64, 0],
    source_sha256: "b".repeat(64),
    generation: "synthetic-generation",
    world_id: "synthetic-world",
    revision: 1,
    appearance_version: "1",
    height_range: [-1024, 5120],
    atlas: ref(`assets/${HASH}.png`),
    material_count: 3,
    catalog: [
      { ...ref(`catalog/${HASH}.json`), start: 0, count: 2 },
      { ...ref(`catalog/${"c".repeat(64)}.json`), start: 2, count: 1 },
    ],
    roots: [
      nodeRef({ level: 1, x: -1, z: -1 }),
      nodeRef({ level: 1, x: 0, z: -1 }),
      nodeRef({ level: 1, x: -1, z: 0 }),
      nodeRef({ level: 1, x: 0, z: 0 }),
    ],
  };
}

function branch() {
  return {
    key: { level: 1, x: -1, z: -1 },
    data: ref(),
    height: ref(`heights/${HASH}.bin`),
    children: [
      nodeRef({ level: 0, x: -2, z: -2 }),
      nodeRef({ level: 0, x: -1, z: -2 }),
      nodeRef({ level: 0, x: -2, z: -1 }),
      nodeRef({ level: 0, x: -1, z: -1 }),
    ],
  };
}

function leaf() {
  return {
    key: { level: 0, x: -1, z: -1 },
    data: ref(),
    height: ref(`heights/${HASH}.bin`),
    children: [],
    chunks: [{ ...ref(`chunks/${HASH}.bin`), cx: -8, cz: -1 }],
  };
}

function material(tint = 0) {
  return {
    key: '["synthetic:stone",{}]',
    name: "Synthetic Stone",
    texture: "synthetic_stone",
    tint,
    approximate: false,
    uv: [0, 0, 0.25, 0.25],
    average: [0.5, 0.5, 0.5, 1],
  };
}

test("manifest parses synthetic core metadata with flattened catalog and root references", () => {
  const value = manifest();
  const before = structuredClone(value);
  const parsed = parseManifest(value, BASE);
  assert.deepEqual(parsed, before);
  assert.deepEqual(value, before);
  assert.equal(parsed.catalog[1].start, 2);
  assert.equal(parsed.roots[0].key.x, -1);
  const { world_id: _worldId, ...offline } = manifest();
  assert.equal(parseManifest(offline, BASE).world_id, undefined);
});

test("manifest rejects nonobjects and incorrect format discriminators", () => {
  for (const value of [null, [], 1, true, "manifest"])
    assert.throws(() => parseManifest(value, BASE));
  for (const patch of [
    { kind: "surface" },
    { kind: undefined },
    { format_version: "1" },
    { format_version: 0 },
    { format_version: 2 },
  ])
    assert.throws(() => parseManifest({ ...manifest(), ...patch }, BASE));
});

test("manifest identity fields and revisions reject invalid types, sizes and precision", () => {
  for (const field of ["name", "generation", "appearance_version", "world_id"])
    for (const value of [null, 17, true, "", "x".repeat(2048)])
      assert.throws(
        () => parseManifest({ ...manifest(), [field]: value }, BASE),
        `${field}: ${String(value).slice(0, 30)}`,
      );
  for (const revision of [
    -1,
    0.5,
    "1",
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.throws(() => parseManifest({ ...manifest(), revision }, BASE));
  for (const revision of [0, Number.MAX_SAFE_INTEGER])
    assert.equal(
      parseManifest({ ...manifest(), revision }, BASE).revision,
      revision,
    );
});

test("manifest source fingerprint requires exactly 64 lowercase hexadecimal characters", () => {
  for (const source_sha256 of [
    "",
    "a".repeat(63),
    "a".repeat(65),
    "A".repeat(64),
    "g".repeat(64),
    null,
    42,
  ])
    assert.throws(
      () => parseManifest({ ...manifest(), source_sha256 }, BASE),
      /fingerprint/,
    );
  const source_sha256 = "0123456789abcdef".repeat(4);
  assert.equal(
    parseManifest({ ...manifest(), source_sha256 }, BASE).source_sha256,
    source_sha256,
  );
});

test("manifest bounds reject fractions, overflows, inverted and empty rectangles", () => {
  for (const bounds of [
    null,
    [],
    [-256, -256, 256],
    [-256, -256, 256, 256, 0],
    [-255.5, -256, 256, 256],
    ["-256", -256, 256, 256],
    [-WORLD_LIMIT - 1, -256, 256, 256],
    [-256, -256, WORLD_LIMIT + 1, 256],
    [0, 0, 0, 128],
    [0, 128, 128, 0],
    [NaN, 0, 128, 128],
    [0, 0, Infinity, 128],
  ])
    assert.throws(
      () => parseManifest({ ...manifest(), bounds }, BASE),
      /bounds/,
    );
});

test("manifest supports the full coordinate range with four L16 roots", () => {
  const value = manifest();
  value.bounds = [-WORLD_LIMIT, -WORLD_LIMIT, WORLD_LIMIT, WORLD_LIMIT];
  value.roots = value.roots.map((root) => ({
    ...root,
    key: { ...root.key, level: 16 },
  }));
  assert.deepEqual(parseManifest(value, BASE).bounds, value.bounds);
  assert.ok(
    parseManifest(value, BASE).roots.every((root) => root.key.level === 16),
  );
});

test("manifest supports partial dataset edges with the exact containing root set", () => {
  const value = manifest();
  value.bounds = [-3, -5, 257, 400];
  value.roots = value.roots.map((root) => ({
    ...root,
    key: { ...root.key, level: 2 },
  }));
  assert.deepEqual(parseManifest(value, BASE).bounds, [-3, -5, 257, 400]);
  assert.throws(
    () => parseManifest({ ...value, roots: manifest().roots }, BASE),
    /root/,
  );
  const edge = {
    ...manifest(),
    bounds: [WORLD_LIMIT - 1, WORLD_LIMIT - 1, WORLD_LIMIT, WORLD_LIMIT],
    roots: [nodeRef({ level: 0, x: 65_535, z: 65_535 })],
  };
  assert.deepEqual(parseManifest(edge, BASE).roots, edge.roots);
});

test("manifest validates spawn shape and finite coordinates", () => {
  for (const spawn of [
    null,
    [],
    [0, 64],
    [0, 64, 0, 0],
    ["0", 64, 0],
    [0, NaN, 0],
    [0, 64, Infinity],
  ])
    assert.throws(() => parseManifest({ ...manifest(), spawn }, BASE), /spawn/);
});

test("global encoded height range is ordered and supports a flat world", () => {
  for (const height_range of [
    null,
    [],
    [0],
    [0, 0, 0],
    [-32769, 0],
    [0, 32768],
    [16, 0],
    [0.5, 16],
    [0, "16"],
    [0, NaN],
  ])
    assert.throws(
      () => parseManifest({ ...manifest(), height_range }, BASE),
      /height range/,
    );
  assert.deepEqual(
    parseManifest({ ...manifest(), height_range: [-16, -16] }, BASE)
      .height_range,
    [-16, -16],
  );
});

test("catalog page ranges must start at zero, remain contiguous and cover every material", () => {
  const value = manifest();
  for (const catalog of [
    null,
    [],
    {},
    [{ ...value.catalog[0], start: 1 }],
    [value.catalog[0], { ...value.catalog[1], start: 1 }],
    [value.catalog[0], { ...value.catalog[1], start: 3 }],
    [{ ...value.catalog[0], count: 0 }],
    [{ ...value.catalog[0], count: 257 }],
    [{ ...value.catalog[0], count: -1 }],
    [{ ...value.catalog[0], count: 1.5 }],
    [{ ...value.catalog[0], count: "3" }],
    [{ ...value.catalog[0], start: "0", count: 3 }],
    [value.catalog[0]],
    Array(257).fill(value.catalog[0]),
  ])
    assert.throws(() => parseManifest({ ...value, catalog }, BASE));
  for (const material_count of [0, -1, 65_537, 1.5, "3", NaN])
    assert.throws(
      () => parseManifest({ ...value, material_count }, BASE),
      /material count/,
    );
});

test("catalog accepts all 65,536 materials through 256 bounded pages", () => {
  const value = manifest();
  value.material_count = 65_536;
  value.catalog = Array.from({ length: 256 }, (_, i) => ({
    ...ref(`catalog/page-${i}.json`),
    start: i * 256,
    count: 256,
  }));
  const parsed = parseManifest(value, BASE);
  assert.equal(parsed.catalog.length, 256);
  assert.equal(parsed.catalog[255].start + parsed.catalog[255].count, 65_536);
});

test("manifest rejects empty, oversized, duplicate or mixed-level root arrays", () => {
  const value = manifest();
  for (const roots of [
    null,
    [],
    {},
    Array(5).fill(value.roots[0]),
    [value.roots[0], value.roots[0]],
    [value.roots[0], nodeRef({ level: 0, x: 0, z: 0 })],
  ])
    assert.throws(() => parseManifest({ ...value, roots }, BASE));
});

test("manifest roots must match the minimal covering forest, not only be distinct", () => {
  const value = manifest();
  for (const roots of [
    value.roots.slice(1),
    value.roots.map((root, i) =>
      i === 0 ? nodeRef({ level: 1, x: -2, z: -1 }) : root,
    ),
    value.roots.map((root) => nodeRef({ ...root.key, level: 2 })),
  ])
    assert.throws(() => parseManifest({ ...value, roots }, BASE), /root/);
});

test("manifest rejects unsupported appearance versions before rendering", () => {
  assert.throws(
    () => parseManifest({ ...manifest(), appearance_version: "2" }, BASE),
    /appearance|version|format/,
  );
});

test("object references reject other origins, schemes, credentials, queries and fragments", () => {
  for (const url of [
    "https://other.example.test/tile.bin",
    "//other.example.test/tile.bin",
    "http://map.example.test/tile.bin",
    "https://map.example.test:444/tile.bin",
    "https://user:password@map.example.test/tile.bin",
    "file:///tmp/tile.bin",
    "data:application/octet-stream,abc",
    "javascript:alert(1)",
    "objects/tile.bin?secret=synthetic",
    "objects/tile.bin#fragment",
  ])
    assert.throws(() => parseRef(ref(url), BASE), url);
});

test("all manifest and node reference slots apply origin and declared-byte checks", () => {
  const bad = ref("https://other.example.test/file.bin");
  for (const patch of [
    { atlas: bad },
    { catalog: [{ ...bad, start: 0, count: 3 }] },
    { roots: [{ ...manifest().roots[0], index: bad }] },
  ])
    assert.throws(() => parseManifest({ ...manifest(), ...patch }, BASE));
  const value = branch();
  for (const patch of [
    { data: bad },
    { height: bad },
    { children: [{ ...value.children[0], index: bad }] },
  ])
    assert.throws(() => parseNode({ ...value, ...patch }, value.key, BASE));
  const detail = leaf();
  assert.throws(() =>
    parseNode(
      { ...detail, chunks: [{ ...bad, cx: -8, cz: -1 }] },
      detail.key,
      BASE,
    ),
  );
});

test("reference URL, digest and declared body lengths are bounded before fetching", () => {
  for (const url of ["", "a".repeat(2048), 1, null])
    assert.throws(() => parseRef({ ...ref(), url }, BASE));
  for (const sha256 of [
    "",
    "a".repeat(63),
    "a".repeat(65),
    "A".repeat(64),
    "z".repeat(64),
    1,
    null,
  ])
    assert.throws(() => parseRef({ ...ref(), sha256 }, BASE), /hash/);
  for (const bytes of [
    0,
    -1,
    0.5,
    "128",
    NaN,
    Infinity,
    MAX_TILE_BYTES + 1,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.throws(() => parseRef({ ...ref(), bytes }, BASE), /size/);
  assert.equal(
    parseRef(ref(undefined, MAX_TILE_BYTES), BASE).bytes,
    MAX_TILE_BYTES,
  );
  assert.equal(
    parseNodeRef(
      { key: { level: 0, x: 0, z: 0 }, index: ref(undefined, MAX_INDEX_BYTES) },
      BASE,
    ).index.bytes,
    MAX_INDEX_BYTES,
  );
  assert.throws(
    () =>
      parseNodeRef(
        {
          key: { level: 0, x: 0, z: 0 },
          index: ref(undefined, MAX_INDEX_BYTES + 1),
        },
        BASE,
      ),
    /size/,
  );
  assert.throws(
    () =>
      parseManifest(
        { ...manifest(), atlas: ref(undefined, 64 * 1024 * 1024 + 1) },
        BASE,
      ),
    /size/,
  );
});

test("reference paths follow the canonical local artifact path schema used by core", () => {
  for (const url of [
    "../outside.bin",
    "objects/../tile.bin",
    "objects//tile.bin",
    "objects/./tile.bin",
    "objects/%2e%2e/tile.bin",
    "objects\\tile.bin",
    "/outside.bin",
  ])
    assert.throws(() => parseRef(ref(url), BASE), `noncanonical path: ${url}`);
});

test("keys reject negative fractional or corrupted coordinates and enforce bounds at each level", () => {
  for (const key of [
    null,
    [],
    {},
    { level: -1, x: 0, z: 0 },
    { level: 17, x: 0, z: 0 },
    { level: 0.5, x: 0, z: 0 },
    { level: "0", x: 0, z: 0 },
    { level: 0, x: -0.5, z: 0 },
    { level: 0, x: 0, z: -1.5 },
    { level: 0, x: "-1", z: 0 },
    { level: 0, x: NaN, z: 0 },
    { level: 0, x: -65_537, z: 0 },
    { level: 0, x: 65_536, z: 0 },
    { level: 0, x: 0, z: Infinity },
    { level: 16, x: 1, z: 0 },
    { level: 16, x: 0, z: -2 },
  ])
    assert.throws(() => parseKey(key));
  for (const key of [
    { level: 0, x: -65_536, z: 65_535 },
    { level: 16, x: -1, z: 0 },
  ])
    assert.deepEqual(parseKey(key), key);
});

test("node identity is bound to the requested key and rejects malformed parents", () => {
  const value = branch();
  assert.deepEqual(parseNode(value, value.key, BASE), value);
  assert.throws(
    () => parseNode(value, { ...value.key, x: 0 }, BASE),
    /identity/,
  );
  for (const key of [
    null,
    {},
    { ...value.key, x: -1.5 },
    { ...value.key, level: 17 },
  ])
    assert.throws(() => parseNode({ ...value, key }, value.key, BASE));
  for (const key of [
    { level: 0, x: 0, z: -1 },
    { level: 0, x: -3, z: -1 },
    { level: 0, x: -1, z: -3 },
    { level: 1, x: -1, z: -1 },
  ])
    assert.throws(
      () => parseNode({ ...value, children: [nodeRef(key)] }, value.key, BASE),
      /child identity/,
    );
});

test("child references are bounded, unique and limited to nonleaf nodes", () => {
  const value = branch();
  for (const children of [
    null,
    {},
    Array(5).fill(value.children[0]),
    [value.children[0], value.children[0]],
  ])
    assert.throws(() => parseNode({ ...value, children }, value.key, BASE));
  const detail = leaf();
  assert.throws(
    () =>
      parseNode({ ...detail, children: [value.children[0]] }, detail.key, BASE),
    /children/,
  );
  assert.equal(
    parseNode({ ...value, children: [value.children[0]] }, value.key, BASE)
      .children.length,
    1,
  );
});

test("detail chunk references use floor ancestry for negative coordinates", () => {
  const value = leaf();
  value.chunks = Array.from({ length: 64 }, (_, i) => ({
    ...ref(),
    cx: -8 + (i % 8),
    cz: -8 + Math.floor(i / 8),
  }));
  const parsed = parseNode(value, value.key, BASE);
  assert.equal(parsed.chunks?.length, 64);
  assert.deepEqual(parsed.chunks?.[63], { ...ref(), cx: -1, cz: -1 });
});

test("chunk references reject nonintegers, duplicates, unrelated cells and oversized arrays", () => {
  const value = leaf();
  for (const chunk of [
    { ...ref(), cx: -9, cz: -1 },
    { ...ref(), cx: 0, cz: -1 },
    { ...ref(), cx: -8, cz: 0 },
    { ...ref(), cx: -7.5, cz: -1 },
    { ...ref(), cx: "-8", cz: -1 },
    { ...ref(), cx: -8, cz: NaN },
    { ...ref(), cx: -524_289, cz: -1 },
  ])
    assert.throws(() =>
      parseNode({ ...value, chunks: [chunk] }, value.key, BASE),
    );
  for (const chunks of [
    null,
    {},
    Array(65).fill(value.chunks[0]),
    [value.chunks[0], value.chunks[0]],
  ])
    assert.throws(() => parseNode({ ...value, chunks }, value.key, BASE));
  const coarse = branch();
  assert.throws(
    () => parseNode({ ...coarse, chunks: value.chunks }, coarse.key, BASE),
    /chunk/,
  );
});

test("node payload and height declarations cannot exceed bounded tile transport", () => {
  const value = branch();
  for (const field of ["data", "height"])
    for (const data of [null, {}, ref(undefined, MAX_TILE_BYTES + 1)])
      assert.throws(() =>
        parseNode({ ...value, [field]: data }, value.key, BASE),
      );
  assert.throws(() => parseNodeRef({ key: value.key, index: null }, BASE));
});

test("catalog pages preserve synthetic material values and enforce requested count", () => {
  const value = [material(), material(1), material(2)];
  assert.deepEqual(parseCatalog(value, 3), value);
  for (const input of [
    null,
    {},
    "catalog",
    [material()],
    [material(), material()],
  ])
    assert.throws(() => parseCatalog(input, 3), /length/);
  assert.throws(() => parseCatalog([null], 1));
});

test("material descriptors reject wrong string, tint and approximation types", () => {
  for (const field of ["key", "name", "texture"])
    for (const value of [null, [], 1, "", "x".repeat(8192)])
      assert.throws(() => parseCatalog([{ ...material(), [field]: value }], 1));
  for (const tint of [-1, 0.5, 4, "1", NaN, null])
    assert.throws(() => parseCatalog([{ ...material(), tint }], 1));
  for (const approximate of [null, 0, 1, "false", undefined])
    assert.throws(() => parseCatalog([{ ...material(), approximate }], 1));
});

test("material UV and average vectors contain exactly four finite normalized numbers", () => {
  for (const field of ["uv", "average"])
    for (const value of [
      null,
      [],
      [0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, -0.1],
      [0, 0, 0, 1.1],
      [0, 0, 0, NaN],
      [0, 0, 0, Infinity],
      [0, 0, 0, "1"],
    ])
      assert.throws(() => parseCatalog([{ ...material(), [field]: value }], 1));
});

test("catalog accepts tint 3 as permitted by the core material schema", () => {
  assert.equal(parseCatalog([material(3)], 1)[0].tint, 3);
});

test("catalog UV rectangles must fit inside the atlas", () => {
  for (const uv of [
    [0.75, 0, 0.5, 0.25],
    [0, 0.75, 0.25, 0.5],
  ])
    assert.throws(() => parseCatalog([{ ...material(), uv }], 1), /material/);
  assert.deepEqual(
    parseCatalog([{ ...material(), uv: [0.75, 0.75, 0.25, 0.25] }], 1)[0].uv,
    [0.75, 0.75, 0.25, 0.25],
  );
});
