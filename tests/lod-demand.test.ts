import assert from "node:assert/strict";
import { test } from "node:test";
import { planDemand, coveredView, demandReady } from "../web/src/lod/demand.ts";
import { tileId } from "../web/src/lod/selection.ts";

test("close zoom prepares an all-direction ring with visible tiles first", () => {
  const view = { left: 10, top: 10, right: 110, bottom: 110 };
  const plan = planDemand(view, [-8192, -8192, 8192, 8192], 0);
  assert.equal(plan.visibleCount, 1);
  assert.equal(plan.tiles.length, 9);
  assert.equal(plan.bufferComplete, true);
  assert.equal(plan.tiles[0].priority, "visible");
  assert.ok(
    coveredView(
      { left: -100, top: -100, right: 200, bottom: 200 },
      plan.tiles.map((t) => t.key),
      0,
    ),
  );
  assert.ok(
    !coveredView(
      { left: -200, top: 10, right: 110, bottom: 110 },
      plan.tiles.map((t) => t.key),
      0,
    ),
  );
  assert.ok(demandReady(plan, new Set(plan.tiles.map((t) => tileId(t.key)))));
  assert.ok(!demandReady(plan, new Set([tileId(plan.tiles[0].key)])));
  assert.ok(demandReady(plan, new Set([tileId(plan.tiles[0].key)]), true));
});
test("signed tile boundaries and world edges are clipped correctly", () => {
  const p = planDemand(
    { left: -128, top: -128, right: 0, bottom: 0 },
    [-256, -256, 256, 256],
    0,
  );
  assert.equal(p.visibleCount, 1);
  assert.deepEqual(p.tiles[0].key, { level: 0, x: -1, z: -1 });
  assert.equal(new Set(p.tiles.map((t) => tileId(t.key))).size, p.tiles.length);
  const outside = planDemand(
    { left: 512, top: 512, right: 1024, bottom: 1024 },
    [-256, -256, 256, 256],
    0,
  );
  assert.equal(outside.tiles.length, 0);
});
test("directional lookahead is bounded and never displaces visible work", () => {
  const p = planDemand(
    { left: -256, top: -128, right: 256, bottom: 128 },
    [-8388608, -8388608, 8388608, 8388608],
    0,
    { maxTiles: 14, velocity: { x: 1e10, z: 0 } },
  );
  assert.equal(p.tiles.length, 14);
  assert.equal(p.visibleCount, 8);
  assert.ok(p.tiles.slice(0, 8).every((t) => t.priority === "visible"));
  assert.ok(p.tiles.slice(8).every((t) => t.priority === "buffer"));
  assert.equal(p.bufferComplete, false);
  assert.ok(p.buffer![2] <= 256 + 256 + 512);
});
test("the same physical overview has bounded tile demand as world size increases", () => {
  const counts = [8192, 16384, 32768].map((side, i) => {
    const half = side / 2;
    return planDemand(
      { left: -half, top: -half, right: half, bottom: half },
      [-half, -half, half, half],
      i + 3,
    ).tiles.length;
  });
  assert.deepEqual(counts, [64, 64, 64]);
});
test("oversized visible requests coarsen instead of building unbounded queues", () => {
  assert.throws(
    () =>
      planDemand(
        { left: -8388608, top: -8388608, right: 8388608, bottom: 8388608 },
        [-8388608, -8388608, 8388608, 8388608],
        0,
      ),
    /coarser/,
  );
  assert.throws(
    () =>
      planDemand(
        { left: 0, top: 0, right: 128, bottom: 128 },
        [0, 0, 256, 256],
        0,
        { velocity: { x: Infinity, z: 0 } },
      ),
    /limits/,
  );
});
