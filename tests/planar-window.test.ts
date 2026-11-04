import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chooseStride,
  heightWindowBytes,
  regionBytes,
  SURFACE_STRIDES,
} from "../web/src/cache-budget.ts";
import {
  containsBounds,
  expandView,
  heightBounds,
  intersects,
} from "../web/src/planar-window.ts";

test("uniform strides extend to large maps without changing the view", () => {
  for (const allowed of SURFACE_STRIDES) {
    assert.equal(
      chooseStride(3, (stride) => stride >= allowed),
      allowed,
    );
    assert.ok(
      Number.isFinite(heightWindowBytes([-256, -256, 256, 256], allowed)),
    );
  }
  assert.equal(
    chooseStride(0.5, () => true),
    2,
  );
  assert.equal(
    chooseStride(5, () => true),
    1,
  );
  assert.equal(
    chooseStride(0.05, (step) => 16384 * regionBytes(step) < 200_000_000),
    16,
  );
});

test("negative region edges and buffered coverage use the same planar coordinates", () => {
  const view = { left: -256, top: -256, right: 0, bottom: 0 };
  assert.ok(intersects(-1, -1, view));
  assert.ok(!intersects(0, -1, view));
  assert.ok(!intersects(-2, -1, view));
  const padded = expandView(view, 256);
  assert.ok(intersects(-2, -1, padded));
  const map = { bounds: [-4096, -4096, 4096, 4096], height_range: [0, 160] };
  const bounds = heightBounds(map, padded, 45);
  assert.deepEqual(bounds, [-768, -768, 512, 512]);
  assert.ok(containsBounds(bounds, heightBounds(map, view, 45)));
  assert.ok(!containsBounds([], bounds));
});

test("a remote sparse gap does not create a whole-world height allocation", () => {
  const map = {
    bounds: [-8_388_608, -8_388_608, 8_388_608, 8_388_608],
    height_range: [0, 160],
  };
  const bounds = heightBounds(
    map,
    { left: -128, top: -128, right: 128, bottom: 128 },
    45,
  );
  assert.deepEqual(bounds, [-256, -256, 256, 256]);
  assert.ok(heightWindowBytes(bounds) < 2_000_000);
  assert.equal(heightWindowBytes(bounds, 3), Infinity);
});
