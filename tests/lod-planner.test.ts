import assert from "node:assert/strict";
import { test } from "node:test";
import { coveredView, planDemand } from "../web/src/lod/demand.ts";
import { planHeightWindow } from "../web/src/lod/heights.ts";
import {
  planView,
  type ViewDemand,
  type ViewPlan,
} from "../web/src/lod/planner.ts";
import {
  MAX_COORDINATE,
  desiredLevel,
  intersection,
  shadowBounds,
  tileBounds,
  tileId,
  tileSpan,
  type Bounds,
  type View,
} from "../web/src/lod/selection.ts";

const BOUNDS: Bounds = [-8192, -8192, 8192, 8192];
const RANGE: [number, number] = [1024, 4696];
const STILL = { x: 0, z: 0 };
const HEIGHT_LIMIT = 2 * 1024 * 1024;

function demand(
  scale = 3,
  x = 64,
  z = 64,
  elevation = 45,
  azimuth = 330,
): ViewDemand {
  return {
    view: {
      left: x - 960 / scale,
      right: x + 960 / scale,
      top: z - 540 / scale,
      bottom: z + 540 / scale,
    },
    scale,
    elevation,
    azimuth,
  };
}

function wholeView(view: View, bounds: Bounds, level: number): Bounds {
  const clipped = intersection(
    [view.left, view.top, view.right, view.bottom],
    bounds,
  )!;
  const span = tileSpan(level);
  return [
    Math.floor(clipped[0] / span) * span,
    Math.floor(clipped[1] / span) * span,
    Math.ceil(clipped[2] / span) * span,
    Math.ceil(clipped[3] / span) * span,
  ];
}

function contains(outer: Bounds, inner: Bounds) {
  return (
    outer[0] <= inner[0] &&
    outer[1] <= inner[1] &&
    outer[2] >= inner[2] &&
    outer[3] >= inner[3]
  );
}

function checkPlan(
  result: ViewPlan,
  input: ViewDemand,
  bounds = BOUNDS,
  range = RANGE,
  maxTiles = 120,
  maxSamples = HEIGHT_LIMIT,
) {
  assert.ok(result.plan.tiles.length <= maxTiles);
  assert.equal(result.plan.bufferComplete, true);
  assert.equal(
    new Set(result.plan.tiles.map((t) => tileId(t.key))).size,
    result.plan.tiles.length,
  );
  const visible = intersection(
    [input.view.left, input.view.top, input.view.right, input.view.bottom],
    bounds,
  );
  assert.deepEqual(result.plan.visible, visible);
  if (!visible) {
    assert.equal(result.height, null);
    assert.deepEqual(result.plan.tiles, []);
    return;
  }
  assert.ok(result.height);
  assert.equal(result.height.level, result.level);
  assert.equal(result.height.stride, 2 ** result.level);
  assert.ok(result.height.width * result.height.height <= maxSamples);
  assert.equal(
    result.height.keys.length * 128 * 128,
    result.height.width * result.height.height,
  );
  assert.ok(
    coveredView(
      {
        left: visible[0],
        top: visible[1],
        right: visible[2],
        bottom: visible[3],
      },
      result.plan.tiles.map((t) => t.key),
      result.level,
    ),
  );
  const boxes = result.plan.tiles.map((t) => tileBounds(t.key));
  const receivers: Bounds = [
    Math.min(...boxes.map((b) => b[0])),
    Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])),
    Math.max(...boxes.map((b) => b[3])),
  ];
  const expected = planHeightWindow(
    receivers,
    bounds,
    range,
    result.level,
    input.elevation,
    input.azimuth,
    maxSamples,
  );
  assert.deepEqual(
    result.height,
    expected,
    "every buffered whole tile keeps its actual full shadow footprint",
  );
  for (const tile of result.plan.tiles) {
    assert.equal(tile.key.level, result.level);
    const b = tileBounds(tile.key);
    const halo = shadowBounds(
      { left: b[0], top: b[1], right: b[2], bottom: b[3] },
      bounds,
      range,
      input.elevation,
      input.azimuth,
      2 ** result.level,
    )!;
    assert.ok(contains(result.height.bounds, halo));
    assert.equal(
      tile.priority,
      intersection(b, visible) ? "visible" : "buffer",
    );
  }
  assert.ok(
    result.plan.tiles
      .slice(0, result.plan.visibleCount)
      .every((t) => t.priority === "visible"),
  );
}

function checkTileGuard(result: ViewPlan, input: ViewDemand, bounds = BOUNDS) {
  const span = tileSpan(result.level);
  const b = wholeView(input.view, bounds, result.level);
  const ring = intersection(
    [b[0] - span, b[1] - span, b[2] + span, b[3] + span],
    bounds,
  )!;
  assert.ok(
    coveredView(
      { left: ring[0], top: ring[1], right: ring[2], bottom: ring[3] },
      result.plan.tiles.map((t) => t.key),
      result.level,
    ),
    "at least one whole tile of guard on every feasible side",
  );
}

test("1920x1080 at scale 3 retains exact detail and a tile guard when the full speculative halo fails", () => {
  const input = demand();
  const original = structuredClone(input);
  const old = planDemand(input.view, BOUNDS, 0);
  const boxes = old.tiles.map((t) => tileBounds(t.key));
  const oldReceivers: Bounds = [
    Math.min(...boxes.map((b) => b[0])),
    Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])),
    Math.max(...boxes.map((b) => b[3])),
  ];
  assert.equal(
    planHeightWindow(oldReceivers, BOUNDS, RANGE, 0, 45, 330, HEIGHT_LIMIT),
    null,
  );
  const result = planView(input, BOUNDS, RANGE, 1, 6, STILL);
  assert.equal(result.level, 0);
  checkPlan(result, input);
  checkTileGuard(result, input);
  assert.deepEqual(input, original);
});

test("modest pans retain a complete prepared guard at exact, 2, 4 and 8 block strides", () => {
  for (const level of [0, 1, 2, 3]) {
    const stride = 2 ** level;
    for (const center of [64, -95.5]) {
      const input = demand(3 / stride, center * stride, center * stride);
      const velocity = { x: 80 * stride, z: -30 * stride };
      const result = planView(input, BOUNDS, RANGE, level, 6, velocity);
      assert.equal(result.level, level);
      checkPlan(result, input);
      checkTileGuard(result, input);
      const size = tileSpan(level) * 0.5;
      for (const [dx, dz] of [
        [size, 0],
        [-size, 0],
        [0, size],
        [0, -size],
        [size, -size],
      ]) {
        const moved = {
          left: input.view.left + dx,
          right: input.view.right + dx,
          top: input.view.top + dz,
          bottom: input.view.bottom + dz,
        };
        assert.ok(
          coveredView(
            moved,
            result.plan.tiles.map((t) => t.key),
            level,
          ),
        );
        const b = wholeView(moved, BOUNDS, level);
        const halo = shadowBounds(
          { left: b[0], top: b[1], right: b[2], bottom: b[3] },
          BOUNDS,
          RANGE,
          45,
          330,
          stride,
        )!;
        assert.ok(contains(result.height!.bounds, halo));
      }
    }
  }
});

test("full requested guard/lookahead is preserved when it fits, otherwise lookahead shrinks first", () => {
  const input = demand(12, 0, 0);
  const velocity = { x: 40, z: -20 };
  const expected = planDemand(input.view, BOUNDS, 0, {
    maxTiles: 120,
    velocity,
  });
  const result = planView(input, BOUNDS, RANGE, 0, 6, velocity);
  assert.deepEqual(result.plan, expected);
  checkPlan(result, input);
  const largeVelocity = { x: 1e200, z: -1e200 };
  const ordinary = demand(3, 0, 0);
  const constrained = planView(ordinary, BOUNDS, RANGE, 1, 6, largeVelocity);
  assert.equal(constrained.level, 0);
  checkPlan(constrained, ordinary);
  checkTileGuard(constrained, ordinary);
});

test("visible-only remains exact when any complete speculative ring exceeds tile or height budgets", () => {
  const input: ViewDemand = {
    view: { left: 0, top: 0, right: 128, bottom: 128 },
    scale: 3,
    elevation: 45,
    azimuth: 330,
  };
  const minimum = planHeightWindow(
    [0, 0, 128, 128],
    BOUNDS,
    RANGE,
    0,
    45,
    330,
  )!;
  for (const options of [
    { maxTiles: 1 },
    { maxHeightSamples: minimum.width * minimum.height },
  ]) {
    const result = planView(
      input,
      BOUNDS,
      RANGE,
      1,
      6,
      { x: 1000, z: 1000 },
      options,
    );
    assert.equal(result.level, 0);
    assert.equal(result.plan.tiles.length, 1);
    checkPlan(
      result,
      input,
      BOUNDS,
      RANGE,
      options.maxTiles ?? 120,
      options.maxHeightSamples ?? HEIGHT_LIMIT,
    );
    assert.deepEqual(result.height, minimum);
  }
});

test("only the minimum visible tile/shadow footprint can force coarsening", () => {
  const input = demand(3, 64, 64, 15);
  const minimum = planHeightWindow(
    wholeView(input.view, BOUNDS, 0),
    BOUNDS,
    RANGE,
    0,
    15,
    330,
    16 * 1024 * 1024,
  );
  assert.ok(minimum);
  const budget = minimum.width * minimum.height - 1;
  const result = planView(input, BOUNDS, RANGE, 0, 6, STILL, {
    maxHeightSamples: budget,
  });
  assert.equal(result.level, 1);
  checkPlan(result, input, BOUNDS, RANGE, 120, budget);
  const big = demand(1, 0, 0);
  const coarse = planView(big, BOUNDS, [0, 0], 0, 6, STILL);
  assert.equal(coarse.level, 1);
  checkPlan(coarse, big, BOUNDS, [0, 0]);
  assert.throws(
    () =>
      planView(input, BOUNDS, RANGE, 0, 0, STILL, { maxHeightSamples: budget }),
    /full shadow footprint/,
  );
});

test("negative and irregular dataset boundaries clip guard without truncating page height coverage", () => {
  for (const bounds of [
    [-257, -129, 129, 257],
    [
      -MAX_COORDINATE,
      -MAX_COORDINATE,
      -MAX_COORDINATE + 513,
      -MAX_COORDINATE + 513,
    ],
    [
      MAX_COORDINATE - 513,
      MAX_COORDINATE - 513,
      MAX_COORDINATE,
      MAX_COORDINATE,
    ],
  ] as Bounds[]) {
    const input = demand(3, bounds[0] + 100, bounds[1] + 100);
    const result = planView(input, bounds, RANGE, 1, 16, { x: -1000, z: 1000 });
    assert.equal(result.level, 0);
    checkPlan(result, input, bounds);
    checkTileGuard(result, input, bounds);
  }
  const outside = demand(3, 100000, 100000);
  checkPlan(planView(outside, BOUNDS, RANGE, 1, 6, STILL), outside);
});

test("world-wide and horizon requests stay bounded, preserve sunlight, and retain pixel hysteresis", () => {
  const world: Bounds = [
    -MAX_COORDINATE,
    -MAX_COORDINATE,
    MAX_COORDINATE,
    MAX_COORDINATE,
  ];
  const input: ViewDemand = {
    view: { left: world[0], top: world[1], right: world[2], bottom: world[3] },
    scale: 3,
    elevation: 0,
    azimuth: 45,
  };
  const result = planView(input, world, [-32767, 32767], 0, 16, {
    x: Number.MAX_VALUE,
    z: -Number.MAX_VALUE,
  });
  assert.ok(result.level >= 14);
  checkPlan(result, input, world, [-32767, 32767]);
  for (const [scale, previous] of [
    [2.9, 1],
    [3.01, 1],
    [0.99, 0],
    [1.01, 0],
  ]) {
    const tiny: ViewDemand = {
      view: { left: -1, top: -1, right: 1, bottom: 1 },
      scale,
      elevation: 90,
      azimuth: -30,
    };
    assert.equal(
      planView(tiny, BOUNDS, [0, 0], previous, 6, STILL).level,
      desiredLevel(scale, previous, 6),
    );
  }
});

test("invalid settings fail explicitly rather than being swallowed as a coarsening retry", () => {
  for (const options of [
    { maxTiles: 0 },
    { maxTiles: 4097 },
    { maxHeightSamples: 0 },
    { maxHeightSamples: 16 * 1024 * 1024 + 1 },
    { marginScreens: NaN },
    { marginScreens: 3 },
    { lookaheadSeconds: -1 },
  ])
    assert.throws(
      () => planView(demand(), BOUNDS, RANGE, 0, 6, STILL, options),
      /limits/,
    );
  assert.throws(
    () => planView(demand(), BOUNDS, RANGE, 0, 6, { x: Infinity, z: 0 }),
    /velocity/,
  );
  assert.throws(
    () =>
      planView(demand(), [0, 0, MAX_COORDINATE + 1, 128], RANGE, 0, 6, STILL),
    /bounds/,
  );
  assert.throws(
    () => planView(demand(), BOUNDS, [10, 0], 0, 6, STILL),
    /height range/,
  );
  assert.throws(
    () => planView({ ...demand(), elevation: NaN }, BOUNDS, RANGE, 0, 6, STILL),
    /sunlight/,
  );
  assert.throws(
    () => planView({ ...demand(), scale: 0 }, BOUNDS, RANGE, 0, 6, STILL),
    /positive/,
  );
  assert.throws(() => planView(demand(), BOUNDS, RANGE, 0, 17, STILL), /level/);
});
