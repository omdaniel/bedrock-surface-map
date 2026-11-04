import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MISSING_HEIGHT,
  buildHeightWindow,
  coversPlan,
  planHeightWindow,
  type HeightPlan,
} from "../web/src/lod/heights.ts";
import {
  MAX_COORDINATE,
  tileBounds,
  tileId,
  type Bounds,
} from "../web/src/lod/selection.ts";

const WORLD: Bounds = [
  -MAX_COORDINATE,
  -MAX_COORDINATE,
  MAX_COORDINATE,
  MAX_COORDINATE,
];
const CELLS = 128 * 128;

function mustPlan(surface: Bounds, dataset: Bounds, level = 0): HeightPlan {
  const plan = planHeightWindow(surface, dataset, [0, 0], level, 45, 0);
  assert.ok(plan);
  return plan;
}

test("whole buffered surface tiles get a conservative neighbor halo across negative coordinates", () => {
  const plan = mustPlan([-256, -128, 128, 256], WORLD);
  assert.deepEqual(plan.bounds, [-384, -256, 256, 384]);
  assert.equal(plan.level, 0);
  assert.equal(plan.stride, 1);
  assert.equal(plan.width, 640);
  assert.equal(plan.height, 640);
  assert.equal(plan.keys.length, 25);
  assert.equal(new Set(plan.keys.map(tileId)).size, 25);
  for (const key of plan.keys) {
    const box = tileBounds(key);
    assert.ok(box[0] >= plan.bounds[0] && box[1] >= plan.bounds[1]);
    assert.ok(box[2] <= plan.bounds[2] && box[3] <= plan.bounds[3]);
  }
});

test("clip to irregular dataset edges before restoring complete boundary-page footprints", () => {
  const fine = mustPlan([-128, -128, 128, 128], [-17, -11, 21, 65]);
  assert.deepEqual(fine.bounds, [-128, -128, 128, 128]);
  assert.equal(fine.keys.length, 4);
  const coarse = mustPlan([-512, -512, 512, 512], [-17, -11, 21, 65], 2);
  assert.deepEqual(coarse.bounds, [-512, -512, 512, 512]);
  assert.equal(coarse.width, 256);
  assert.equal(coarse.height, 256);
  const edge = mustPlan([MAX_COORDINATE - 128, 0, MAX_COORDINATE, 128], WORLD);
  assert.deepEqual(edge.bounds, [
    MAX_COORDINATE - 256,
    -128,
    MAX_COORDINATE,
    256,
  ]);
  assert.equal(
    planHeightWindow([256, 256, 384, 384], [0, 0, 128, 128], [0, 0], 0, 45, 0),
    null,
  );
  assert.equal(planHeightWindow([0, 0, 0, 128], WORLD, [0, 0], 0, 45, 0), null);
});

test("low sun extends up-sun, while zero elevation reaches dataset edges without overflow", () => {
  const dataset: Bounds = [-4096, -4096, 4096, 4096];
  const surface: Bounds = [0, 0, 128, 128];
  const high = planHeightWindow(surface, dataset, [0, 4096], 0, 75, 90)!;
  const low = planHeightWindow(surface, dataset, [0, 4096], 0, 15, 90)!;
  assert.ok(low.bounds[2] > high.bounds[2]);
  assert.deepEqual(low.bounds.slice(0, 2), [-128, -128]);
  assert.ok(low.bounds[2] >= 128 + 256 / Math.tan(Math.PI / 12));
  const horizon = planHeightWindow(
    surface,
    dataset,
    [0, 4096],
    0,
    0,
    90,
    4 * 1024 * 1024,
  )!;
  assert.deepEqual(horizon.bounds, [-128, -128, 4096, 256]);
  const north = planHeightWindow(
    surface,
    dataset,
    [0, 4096],
    0,
    0,
    0,
    4 * 1024 * 1024,
  )!;
  assert.deepEqual(north.bounds, [-128, -4096, 256, 256]);
  assert.deepEqual(
    planHeightWindow(surface, dataset, [0, 0], 0, 0, 90),
    mustPlan(surface, dataset),
  );
  assert.deepEqual(
    planHeightWindow(surface, dataset, [0, 4096], 0, 90, -270),
    mustPlan(surface, dataset),
  );
  assert.equal(
    planHeightWindow(surface, WORLD, [-32767, 32767], 0, 0.000001, 45),
    null,
  );
});

test("budgets bound enumeration before allocation and allow controller 2–4M guard bands", () => {
  assert.equal(
    planHeightWindow(
      [0, 0, 128, 128],
      [0, 0, 128, 128],
      [0, 0],
      0,
      45,
      0,
      CELLS - 1,
    ),
    null,
  );
  assert.equal(
    planHeightWindow(
      [0, 0, 128, 128],
      [0, 0, 128, 128],
      [0, 0],
      0,
      45,
      0,
      CELLS,
    )!.keys.length,
    1,
  );
  assert.equal(planHeightWindow(WORLD, WORLD, [0, 0], 0, 45, 0), null);
  for (const side of [1024, 1280, 1792]) {
    const bounds: Bounds = [0, 0, side, side];
    assert.ok(
      planHeightWindow(bounds, bounds, [0, 0], 0, 45, 0, 4 * 1024 * 1024),
    );
  }
  const guard: Bounds = [0, 0, 1280, 1280];
  assert.equal(planHeightWindow(guard, guard, [0, 0], 0, 45, 0), null);
  assert.ok(planHeightWindow(guard, guard, [0, 0], 0, 45, 0, 2 * 1024 * 1024));
  assert.equal(
    planHeightWindow(
      [0, 0, 4096, 4096],
      [0, 0, 4096, 4096],
      [0, 0],
      0,
      45,
      0,
      16 * 1024 * 1024,
    )!.keys.length,
    1024,
  );
  const root = planHeightWindow(WORLD, WORLD, [-32767, 32767], 16, 0, 45)!;
  assert.equal(root.stride, 65536);
  assert.deepEqual([root.width, root.height, root.keys.length], [256, 256, 4]);
});

test("assembly preserves row-major fine/coarse means and page seams across zero", () => {
  for (const level of [0, 2, 16]) {
    const stride = 2 ** level;
    const bounds: Bounds = [
      -128 * stride,
      -128 * stride,
      128 * stride,
      128 * stride,
    ];
    const plan = mustPlan(bounds, bounds, level);
    const pages = new Map<string, Float32Array | null>();
    for (const key of [...plan.keys].reverse()) {
      pages.set(
        tileId(key),
        Float32Array.from(
          { length: CELLS },
          (_, i) =>
            (key.z * 128 + Math.floor(i / 128)) * 256 + key.x * 128 + (i % 128),
        ),
      );
    }
    const before = new Float32Array(pages.get(tileId(plan.keys[0]))!);
    const result = buildHeightWindow(plan, pages);
    assert.equal(result.length, 256 * 256);
    for (let z = 0; z < 256; z++)
      for (let x = 0; x < 256; x++)
        assert.equal(
          result[z * 256 + x],
          (z - 128) * 256 + x - 128,
          `L${level} (${x},${z})`,
        );
    assert.deepEqual(pages.get(tileId(plan.keys[0])), before);
  }
});

test("explicit absent pages remain missing; downloads and omitted keys never become absent", () => {
  const plan = mustPlan([-128, -128, 128, 128], [-7, -7, 9, 9]);
  const pages = new Map<string, Float32Array | null>(
    plan.keys.map((key) => [tileId(key), null]),
  );
  assert.ok(buildHeightWindow(plan, pages).every((h) => h === MISSING_HEIGHT));
  const page = new Float32Array(CELLS).fill(MISSING_HEIGHT);
  page[0] = -1.0625;
  page[8 * 128 + 8] = 17.25;
  pages.set("0/0/0", page);
  pages.set("0/8/8", new Float32Array([NaN])); // Outside cached pages are ignored.
  const result = buildHeightWindow(plan, pages);
  assert.equal(result[128 * 256 + 128], -1.0625);
  assert.equal(result[136 * 256 + 136], 17.25);
  assert.equal(result[128 * 256 + 127], MISSING_HEIGHT);
  assert.equal(result[128 * 256 + 137], MISSING_HEIGHT);
  pages.delete("0/-1/0");
  assert.throws(() => buildHeightWindow(plan, pages), /Incomplete.*0\/-1\/0/);
  assert.throws(
    () => buildHeightWindow({ ...plan, keys: plan.keys.slice(1) }, pages),
    /key count/,
  );
});

test("invalid coordinates, budgets, plans and page samples fail explicitly", () => {
  for (const bounds of [
    [0.5, 0, 128, 128],
    [0, 0, Infinity, 128],
    [0, 0, MAX_COORDINATE + 1, 128],
    [128, 0, 0, 128],
  ] as Bounds[])
    assert.throws(
      () => planHeightWindow(bounds, WORLD, [0, 0], 0, 45, 0),
      /coordinates/,
    );
  for (const budget of [
    0,
    -1,
    1.5,
    Infinity,
    Number.MAX_SAFE_INTEGER,
    16 * 1024 * 1024 + 1,
  ])
    assert.throws(
      () => planHeightWindow([0, 0, 128, 128], WORLD, [0, 0], 0, 45, 0, budget),
      /budget/,
    );
  for (const level of [-1, 0.5, 17])
    assert.throws(
      () => planHeightWindow([0, 0, 128, 128], WORLD, [0, 0], level, 45, 0),
      /level/,
    );
  for (const range of [
    [1, 0],
    [0, NaN],
    [-32768, 0],
    [0, 1.5],
  ] as [number, number][])
    assert.throws(
      () => planHeightWindow([0, 0, 128, 128], WORLD, range, 0, 45, 0),
      /height|Height/,
    );
  for (const [elevation, azimuth] of [
    [-1, 0],
    [91, 0],
    [NaN, 0],
    [45, Infinity],
  ])
    assert.throws(
      () =>
        planHeightWindow(
          [0, 0, 128, 128],
          WORLD,
          [0, 0],
          0,
          elevation,
          azimuth,
        ),
      /Sun/,
    );
  const plan = mustPlan([0, 0, 128, 128], [0, 0, 128, 128]);
  const pages = new Map<string, Float32Array | null>([["0/0/0", null]]);
  for (const patch of [
    { stride: 2 },
    { width: 127 },
    { height: Infinity },
    { bounds: [1, 0, 129, 128] as Bounds },
    { keys: [{ level: 1, x: 0, z: 0 }] },
  ])
    assert.throws(
      () => buildHeightWindow({ ...plan, ...patch }, pages),
      /height|Height/,
    );
  for (const page of [
    new Float32Array(1),
    new Float32Array(CELLS).fill(NaN),
    new Float32Array(CELLS).fill(Infinity),
  ]) {
    pages.set("0/0/0", page);
    assert.throws(() => buildHeightWindow(plan, pages), /Invalid height page/);
  }
});

test("window containment allows reuse only at the same level", () => {
  const current = mustPlan([-256, -256, 256, 256], [-256, -256, 256, 256]);
  const next = mustPlan([-128, -128, 128, 128], [-128, -128, 128, 128]);
  assert.ok(coversPlan(current, current));
  assert.ok(coversPlan(current, next));
  assert.ok(!coversPlan(next, current));
  assert.ok(!coversPlan(current, mustPlan(current.bounds, current.bounds, 1)));
  assert.ok(!coversPlan(current, mustPlan([0, 0, 384, 128], [0, 0, 384, 128])));
  assert.ok(!coversPlan(null, next));
  assert.ok(!coversPlan(current, undefined));
});
