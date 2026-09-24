import assert from "node:assert/strict";
import test from "node:test";
import {
  heightWindowBytes,
  MAP_CACHE_BYTES,
  REGION_BYTES,
} from "../../web/src/cache-budget.ts";

test("height budget includes both complete pyramids and compact source pages", () => {
  assert.equal(heightWindowBytes([0, 0, 1, 1]), 129 * 8 + 2);
  assert.equal(heightWindowBytes([-256, 0, 0, 256]), 87509 * 8 + 65536 * 2);
  // Unequal dimensions keep halving the longer axis after the shorter reaches 1.
  assert.equal(heightWindowBytes([0, 0, 1, 8]), (128 + 8 + 4 + 2 + 1) * 8 + 16);
  assert.equal(heightWindowBytes([0, 0, 0, 256]), Infinity);
  assert.equal(heightWindowBytes([0, 0, 8192, 8192]), Infinity);
});

test("detail and heights compete for one budget", () => {
  const heights = heightWindowBytes([-1792, -1024, 1792, 1024]);
  assert.ok(heights < MAP_CACHE_BYTES);
  assert.ok(heights + 14 * 8 * REGION_BYTES > MAP_CACHE_BYTES);
});
