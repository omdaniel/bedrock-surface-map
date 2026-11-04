import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import {
  buildDrawCut,
  pickDrawTile as pickDrawCut,
  type DrawCutOptions,
  type DrawTile,
} from "../web/src/lod/cut.ts";
import type { TileKey } from "../web/src/lod/protocol.ts";
import {
  intersection,
  rootForest,
  tileBounds,
  tileId,
  type Bounds,
} from "../web/src/lod/selection.ts";

const key = (level: number, x = 0, z = 0): TileKey => ({ level, x, z });
const area = (box: Bounds) => (box[2] - box[0]) * (box[3] - box[1]);
const inside = (box: readonly number[], x: number, z: number) =>
  box[0] <= x && x < box[2] && box[1] <= z && z < box[3];
const rounded = (box: readonly number[]): Bounds => [
  Math.floor(box[0]),
  Math.floor(box[1]),
  Math.ceil(box[2]),
  Math.ceil(box[3]),
];

function checked(options: DrawCutOptions): DrawTile[] {
  const cut = buildDrawCut(options);
  const raw = intersection(
    options.worldBounds ?? options.viewport,
    options.viewport,
  );
  const visible = raw && rounded(raw);
  for (let i = 0; i < cut.length; i++) {
    const entry = cut[i];
    assert.ok(visible);
    assert.ok(area(entry.clip) > 0);
    assert.ok(entry.clip.every(Number.isInteger));
    assert.deepEqual(intersection(entry.clip, visible), entry.clip);
    assert.deepEqual(
      intersection(entry.clip, tileBounds(entry.key)),
      entry.clip,
    );
    for (let j = i + 1; j < cut.length; j++)
      assert.equal(
        intersection(entry.clip, cut[j].clip),
        null,
        "overlapping draws",
      );
    const x = (entry.clip[0] + entry.clip[2]) / 2;
    const z = (entry.clip[1] + entry.clip[3]) / 2;
    assert.equal(
      pickDrawCut(cut, x, z),
      entry,
      "picking returns the actual entry",
    );
  }
  assert.ok(
    cut.length <= 4 * (options.ready.length + (options.absent?.length ?? 0)),
  );
  return cut;
}

test("controller positional API rounds view scissors outward and returns undefined for misses", () => {
  const root = key(2);
  const view: Bounds = [0.5, 1.25, 127.25, 200.5];
  const cut = buildDrawCut([root], [root], view, 0);
  assert.deepEqual(cut, [{ key: root, clip: [0, 1, 128, 201] }]);
  assert.equal(pickDrawCut(cut, 0, 1), cut[0]);
  assert.equal(pickDrawCut(cut, 128, 1), undefined);
  assert.deepEqual(buildDrawCut([root], [root], [0.5, 1, 0.5, 100], 0), []);
});

test("one ready descendant clips ancestor fallback into disjoint strips", () => {
  const root = key(3);
  const child = key(0, 3, 4);
  const worldBounds = tileBounds(root);
  const cut = checked({
    roots: [root],
    ready: [root, child],
    worldBounds,
    viewport: worldBounds,
    targetLevel: 0,
  });
  assert.equal(cut.length, 5);
  assert.equal(
    cut.reduce((sum, entry) => sum + area(entry.clip), 0),
    area(worldBounds),
  );
  assert.deepEqual(
    cut.find((entry) => tileId(entry.key) === tileId(child))?.clip,
    tileBounds(child),
  );
  assert.deepEqual(pickDrawCut(cut, 400, 600)?.key, child);
  for (const [x, z] of [
    [383, 600],
    [512, 600],
    [400, 511],
    [400, 640],
  ])
    assert.deepEqual(pickDrawCut(cut, x, z)?.key, root);
});

test("the nearest ready ancestor fills gaps between arbitrary missing hierarchy levels", () => {
  const root = key(4);
  const middle = key(2, 1, 1);
  const detail = key(0, 5, 6);
  const sibling = key(1, 6, 1);
  const worldBounds = tileBounds(root);
  const cut = checked({
    roots: [root],
    ready: [detail, root, sibling, middle],
    worldBounds,
    viewport: worldBounds,
    targetLevel: 0,
  });
  assert.deepEqual(pickDrawCut(cut, 700, 800)?.key, detail);
  assert.deepEqual(pickDrawCut(cut, 600, 600)?.key, middle);
  assert.deepEqual(pickDrawCut(cut, 1600, 300)?.key, sibling);
  assert.deepEqual(pickDrawCut(cut, 1200, 1200)?.key, root);
  assert.equal(
    cut.reduce((sum, entry) => sum + area(entry.clip), 0),
    area(worldBounds),
  );
});

test("target level ignores finer residents while preserving pinned root coverage", () => {
  const root = key(3);
  const coarse = key(2);
  const medium = key(1);
  const fine = key(0);
  const options: DrawCutOptions = {
    roots: [root],
    ready: [root, coarse, medium, fine],
    worldBounds: tileBounds(root),
    viewport: tileBounds(root),
    targetLevel: 1,
  };
  const cut = checked(options);
  assert.deepEqual(pickDrawCut(cut, 20, 20)?.key, medium);
  assert.deepEqual(pickDrawCut(cut, 300, 300)?.key, coarse);
  assert.deepEqual(pickDrawCut(cut, 600, 600)?.key, root);
  assert.ok(cut.every((entry) => entry.key.level >= 1));
  assert.deepEqual(checked({ ...options, targetLevel: 16 }), [
    { key: root, clip: tileBounds(root) },
  ]);
});

test("a missing child is ancestor fallback until explicitly declared absent", () => {
  const root = key(2);
  const child = key(1);
  const missing = key(1, 1, 0);
  const options: DrawCutOptions = {
    roots: [root],
    ready: [root, child],
    worldBounds: tileBounds(root),
    viewport: tileBounds(root),
    targetLevel: 0,
  };
  assert.deepEqual(pickDrawCut(checked(options), 300, 10)?.key, root);
  const cut = checked({ ...options, absent: [missing] });
  assert.equal(pickDrawCut(cut, 300, 10), undefined);
  assert.deepEqual(pickDrawCut(cut, 300, 300)?.key, root);
  assert.equal(
    cut.reduce((sum, entry) => sum + area(entry.clip), 0),
    area(tileBounds(root)) - area(tileBounds(missing)),
  );
});

test("explicit absence wins over identical or descendant residents and may be finer than target", () => {
  const root = key(3);
  const hole = key(1, 1, 1);
  const stale = key(0, 2, 2);
  const options: DrawCutOptions = {
    roots: [root],
    ready: [stale, hole, root],
    absent: [hole],
    worldBounds: tileBounds(root),
    viewport: tileBounds(root),
    targetLevel: 0,
  };
  assert.equal(pickDrawCut(checked(options), 300, 300), undefined);
  const coarse = checked({ ...options, targetLevel: 3 });
  assert.equal(pickDrawCut(coarse, 300, 300), undefined);
  assert.deepEqual(pickDrawCut(coarse, 200, 200)?.key, root);
  assert.deepEqual(checked({ ...options, absent: [root, hole] }), []);
});

test("roots define coverage but an unavailable root is never invented as a draw source", () => {
  const root = key(2);
  const child = key(0, 1, 2);
  const options: DrawCutOptions = {
    roots: [root],
    ready: [child],
    worldBounds: tileBounds(root),
    viewport: tileBounds(root),
    targetLevel: 0,
  };
  assert.deepEqual(checked(options), [{ key: child, clip: tileBounds(child) }]);
  assert.equal(pickDrawCut(buildDrawCut(options), 10, 10), undefined);
  assert.deepEqual(checked({ ...options, ready: [] }), []);
  assert.deepEqual(checked({ ...options, roots: [] }), []);
});

test("four signed roots handle sparse negative-coordinate descendants without seams", () => {
  const worldBounds: Bounds = [-900, -700, 800, 1000];
  const roots = rootForest(worldBounds);
  assert.equal(roots.length, 4);
  const ready = [
    ...roots,
    key(0, -7, -5),
    key(1, -1, -1),
    key(0, -1, -1),
    key(0, 0, 0),
    key(2, 1, 1),
  ];
  const cut = checked({
    roots,
    ready,
    worldBounds,
    viewport: [-1000, -1000, 1200, 1200],
    targetLevel: 0,
  });
  assert.deepEqual(pickDrawCut(cut, -850, -600)?.key, key(0, -7, -5));
  assert.deepEqual(pickDrawCut(cut, -200, -200)?.key, key(1, -1, -1));
  assert.deepEqual(pickDrawCut(cut, -0.1, -0.1)?.key, key(0, -1, -1));
  assert.deepEqual(pickDrawCut(cut, 0, 0)?.key, key(0));
  assert.equal(
    cut.reduce((sum, entry) => sum + area(entry.clip), 0),
    area(worldBounds),
  );
});

test("viewport edges round outward to integer half-open scissors within world and source bounds", () => {
  const worldBounds: Bounds = [-3, -5, 257, 400];
  const roots = rootForest(worldBounds);
  const viewport: Bounds = [-2.5, -10, 200.25, 300.5];
  const visible = rounded(intersection(worldBounds, viewport)!);
  const cut = checked({
    roots,
    ready: [...roots, key(0), key(0, 1, 1)],
    worldBounds,
    viewport,
    targetLevel: 0,
  });
  assert.equal(
    cut.reduce((sum, entry) => sum + area(entry.clip), 0),
    area(visible),
  );
  assert.ok(pickDrawCut(cut, -2.5, -5));
  assert.ok(pickDrawCut(cut, -3, 0));
  assert.ok(pickDrawCut(cut, 200.25, 0));
  assert.ok(pickDrawCut(cut, 0, 300.5));
  assert.equal(pickDrawCut(cut, -3.001, 0), undefined);
  assert.equal(pickDrawCut(cut, 201, 0), undefined);
  assert.equal(pickDrawCut(cut, 0, 301), undefined);
  assert.deepEqual(pickDrawCut(cut, 127.999, 127.999)?.key, key(0));
  assert.deepEqual(pickDrawCut(cut, 128, 128)?.key, key(0, 1, 1));
  for (const coordinate of [NaN, Infinity, -Infinity]) {
    assert.equal(pickDrawCut(cut, coordinate, 0), undefined);
    assert.equal(pickDrawCut(cut, 0, coordinate), undefined);
  }
});

test("disjoint mixed-level roots, duplicates and out-of-forest ready tiles are deterministic", () => {
  const roots = [key(0, -1, -1), key(2), key(1, 2, 0)];
  const ready = [
    ...roots,
    key(0, 1, 1),
    key(0, 1, 1),
    key(0, 4, 1),
    key(0, 200, 200),
    key(3),
  ];
  const options: DrawCutOptions = {
    roots,
    ready,
    worldBounds: [-1024, -1024, 1024, 1024],
    viewport: [-1000, -1000, 1000, 1000],
    targetLevel: 0,
  };
  const before = structuredClone(options);
  const cut = checked(options);
  assert.deepEqual(options, before);
  assert.deepEqual(
    cut,
    checked({
      ...options,
      roots: [...roots].reverse(),
      ready: [...ready].reverse(),
    }),
  );
  assert.equal(pickDrawCut(cut, -500, -500), undefined);
  assert.deepEqual(pickDrawCut(cut, -1, -1)?.key, roots[0]);
  assert.deepEqual(pickDrawCut(cut, 550, 150)?.key, key(0, 4, 1));
  cut[0].key.x = 99;
  assert.deepEqual(options, before, "returned keys are independent snapshots");
});

test("views outside the world or forest and empty half-open views return no draws", () => {
  const options: DrawCutOptions = {
    roots: [key(2)],
    ready: [key(2)],
    worldBounds: [-1024, -1024, 1024, 1024],
    viewport: [0, 0, 128, 128],
    targetLevel: 0,
  };
  for (const viewport of [
    [1e12, 1e12, 1e12 + 1e6, 1e12 + 1e6],
    [-1e12, -1e12, -1e12 + 1e6, -1e12 + 1e6],
    [1024, 0, 2048, 128],
    [-800, -800, -700, -700],
    [0, 0, 0, 128],
    [0, 0, 128, 0],
  ])
    assert.deepEqual(checked({ ...options, viewport }), []);
});

test("rejects invalid geometry and unbounded input lists", () => {
  const options: DrawCutOptions = {
    roots: [key(2)],
    ready: [key(2)],
    worldBounds: [0, 0, 512, 512],
    viewport: [0, 0, 512, 512],
    targetLevel: 0,
  };
  for (const targetLevel of [-1, 0.5, 17, NaN])
    assert.throws(() => buildDrawCut({ ...options, targetLevel }), /level/);
  for (const viewport of [
    [0, 0, 1],
    [0, 0, Infinity, 1],
    [1, 1, 0, 0],
  ])
    assert.throws(() => buildDrawCut({ ...options, viewport }), /bounds/);
  assert.throws(
    () => buildDrawCut({ ...options, roots: Array(5).fill(key(2)) }),
    /four/,
  );
  assert.throws(
    () => buildDrawCut({ ...options, roots: [key(2), key(0)] }),
    /overlap/,
  );
  assert.throws(
    () => buildDrawCut({ ...options, roots: [key(2), key(2)] }),
    /overlap/,
  );
  assert.throws(
    () => buildDrawCut({ ...options, ready: Array(257).fill(key(0)) }),
    /256/,
  );
  assert.throws(
    () => buildDrawCut({ ...options, absent: Array(257).fill(key(0)) }),
    /256/,
  );
  assert.throws(
    () => buildDrawCut({ ...options, ready: [key(0, 0.5)] }),
    /coordinates/,
  );
});

// Independent pointwise oracle: inspect every ready source, never subtract or
// recursively traverse tiles. Edge-cell midpoints exhaust every region in which
// coverage can differ, including boundaries where picking changes sources.
function oracle(options: DrawCutOptions, x: number, z: number): TileKey | null {
  if (
    (options.worldBounds && !inside(options.worldBounds, x, z)) ||
    !inside(rounded(options.viewport), x, z)
  )
    return null;
  const root = options.roots.find((root) => inside(tileBounds(root), x, z));
  if (!root) return null;
  if (
    options.absent?.some(
      (tile) => tile.level <= root.level && inside(tileBounds(tile), x, z),
    )
  )
    return null;
  let best: TileKey | null = null;
  for (const tile of options.ready) {
    if (
      tile.level < Math.min(options.targetLevel, root.level) ||
      tile.level > root.level
    )
      continue;
    if (inside(tileBounds(tile), x, z) && (!best || tile.level < best.level))
      best = tile;
  }
  return best;
}

test("arbitrary sparse mixed-ready forests match a pointwise oracle over every boundary cell", () => {
  let seed = 0x3a17c4;
  const random = () =>
    (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const worldBounds: Bounds = [-500, -490, 500, 495];
  const roots = rootForest(worldBounds);
  const universe: TileKey[] = [];
  for (let level = 0; level <= 2; level++) {
    const width = 4 / 2 ** level;
    for (let z = -width; z < width; z++)
      for (let x = -width; x < width; x++) universe.push(key(level, x, z));
  }
  for (let iteration = 0; iteration < 60; iteration++) {
    const ready = universe.filter(() => random() < 0.45);
    const absent = universe.filter(() => random() < 0.025);
    const options: DrawCutOptions = {
      roots,
      ready,
      absent,
      worldBounds,
      viewport: [
        -600 + random() * 500,
        -600 + random() * 500,
        100 + random() * 500,
        100 + random() * 500,
      ],
      targetLevel: iteration % 4,
    };
    const cut = checked(options);
    const boxes = [
      worldBounds,
      options.viewport,
      rounded(options.viewport),
      ...universe.map(tileBounds),
    ];
    const axis = (first: number, last: number) =>
      [...new Set(boxes.flatMap((box) => [box[first], box[last]]))].sort(
        (a, b) => a - b,
      );
    const xs = axis(0, 2),
      zs = axis(1, 3);
    for (let z = 0; z < zs.length - 1; z++)
      for (let x = 0; x < xs.length - 1; x++)
        for (const [px, pz] of [
          [xs[x], zs[z]],
          [(xs[x] + xs[x + 1]) / 2, (zs[z] + zs[z + 1]) / 2],
        ]) {
          assert.deepEqual(
            pickDrawCut(cut, px, pz)?.key ?? null,
            oracle(options, px, pz),
            `iteration=${iteration}, point=${px},${pz}`,
          );
        }
  }
});

test("L16 worlds and 256 sparse ready tiles stay bounded without visiting the full tree", () => {
  // A subprocess timeout makes a full-tree regression fail instead of hanging
  // the test process while enumerating billions of unready L0 coordinates.
  const moduleUrl = new URL("../web/src/lod/cut.ts", import.meta.url).href;
  const script = `
    import { buildDrawCut, pickDrawTile as pickDrawCut } from ${JSON.stringify(moduleUrl)};
    const roots = [-1, 0].flatMap(z => [-1, 0].map(x => ({level:16,x,z})));
    const ready = [...roots, ...Array.from({length:252}, (_, i) => ({level:0,x:-65000+i*509,z:65000-i*503}))];
    const bounds = [-8388608,-8388608,8388608,8388608];
    const cut = buildDrawCut({roots,ready,worldBounds:bounds,viewport:bounds,targetLevel:0});
    const area = cut.reduce((sum, {clip:b}) => sum+(b[2]-b[0])*(b[3]-b[1]),0);
    const edge = buildDrawCut({roots,ready:[...roots,{level:0,x:65535,z:65535}],worldBounds:bounds,viewport:[8388607,8388607,8388608,8388608],targetLevel:0});
    process.stdout.write(JSON.stringify({count:cut.length, area, edge, outside:pickDrawCut(cut,8388608,0)}));
  `;
  const result = JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: 5000,
    }),
  );
  assert.ok(result.count > 256 && result.count <= 4 * 256);
  assert.equal(result.area, 16777216 ** 2);
  assert.deepEqual(result.edge, [
    { key: key(0, 65535, 65535), clip: [8388607, 8388607, 8388608, 8388608] },
  ]);
  assert.equal(result.outside, undefined);
});
