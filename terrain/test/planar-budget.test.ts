import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseStride,
  heightWindowBytes,
  MAP_CACHE_BYTES,
  regionBytes,
  regionGpuBytes,
  scaleBarBlocks,
  WORKING_BYTES,
  type SurfaceStride,
} from "../../web/src/cache-budget.ts";

test("the displayed 100-block bar retains fine detail until the next bar step", () => {
  for (const [scale, blocks, stride] of [
    [2, 50, 1],
    [1, 100, 1],
    [0.75, 100, 1],
    [0.500001, 100, 1],
    [0.5, 200, 2],
    [0.499999, 200, 2],
    [0.2, 500, 2],
    [0.1, 1000, 2],
    [0.025, 2000, 2],
  ]) {
    assert.equal(scaleBarBlocks(scale), blocks, `bar at scale ${scale}`);
    assert.equal(
      chooseStride(scale, () => true),
      stride,
      `stride at ${scale}`,
    );
    assert.ok(blocks * scale <= 100, "the bar fits its 100 CSS pixels");
  }
});

test("one global stride is the finest permitted candidate that fits the budget", () => {
  for (const { scale, allowed, expected, visited } of [
    { scale: 1, allowed: [1, 2, 4], expected: 1, visited: [1] },
    { scale: 1, allowed: [2, 4], expected: 2, visited: [1, 2] },
    { scale: 1, allowed: [4], expected: 4, visited: [1, 2, 4] },
    { scale: 0.5, allowed: [1, 2, 4], expected: 2, visited: [2] },
    { scale: 0.5, allowed: [1, 4], expected: 4, visited: [2, 4] },
  ]) {
    const calls: SurfaceStride[] = [];
    const selected = chooseStride(scale, (stride) => {
      calls.push(stride);
      return allowed.includes(stride);
    });
    assert.equal(selected, expected);
    assert.deepEqual(calls, visited);
  }
  // A caller still checks capacity when even the coarsest representation fails.
  assert.equal(
    chooseStride(1, () => false),
    4,
  );
  assert.equal(
    chooseStride(0.5, () => false),
    4,
  );
});

test("a dense 20-by-14-region view needs stride 4 with the working reserve", () => {
  const bounds = [0, 0, 5120, 3584];
  const resident = (stride: SurfaceStride) =>
    280 * regionBytes(stride) + heightWindowBytes(bounds, stride);
  assert.equal(WORKING_BYTES, 32 * 1024 * 1024);
  assert.ok(resident(1) > MAP_CACHE_BYTES);
  // Stride 2 alone fits 256 MiB, but must also leave room for decode/uploads.
  assert.ok(resident(2) < MAP_CACHE_BYTES);
  assert.ok(resident(2) + WORKING_BYTES > MAP_CACHE_BYTES);
  assert.ok(resident(4) + WORKING_BYTES < MAP_CACHE_BYTES);
  const fits = (stride: SurfaceStride) =>
    resident(stride) + WORKING_BYTES <= MAP_CACHE_BYTES;
  assert.equal(chooseStride(1, fits), 4);
  assert.equal(chooseStride(0.2, fits), 4);
  // Selection is stateless: a later fine view can recover immediately.
  assert.equal(
    chooseStride(1, () => true),
    1,
  );
});

test("region storage reduces GPU cells, complete mip textures and CPU picking", () => {
  // Independently counted 256/128/64-square cells (32 GPU + 8 picking bytes),
  // with every RGBA mip down to 1x1; fixed renderer resources are separate.
  for (const [stride, gpu, cpu] of [
    [1, 2446676, 524288],
    [2, 611668, 131072],
    [4, 152916, 32768],
  ]) {
    assert.equal(regionGpuBytes(stride), gpu);
    assert.equal(regionBytes(stride), gpu + cpu);
    assert.equal(regionBytes(stride) - regionGpuBytes(stride), cpu);
    assert.ok(Math.abs(regionBytes(stride) - regionBytes(1) / stride ** 2) < 2);
    assert.ok(
      Math.abs(regionGpuBytes(stride) - regionGpuBytes(1) / stride ** 2) < 2,
    );
  }
});

test("height windows reduce the GPU pyramid and compact source pages to quarter/sixteenth", () => {
  const bounds = [-256, -256, 0, 0];
  // Pyramid cell counts are 87381, 21845 and 5461, plus a 128-word header.
  const expected = [481108, 120660, 30548];
  for (const [index, stride] of [1, 2, 4].entries()) {
    const bytes = heightWindowBytes(bounds, stride);
    assert.equal(bytes, expected[index]);
    assert.equal(bytes, heightWindowBytes([0, 0, 256, 256], stride));
    // The fixed header/tail prevents exact proportionality, within 512 bytes.
    assert.ok(Math.abs(bytes - expected[0] / stride ** 2) < 512);
  }
  assert.equal(heightWindowBytes(bounds), expected[0]);
  // Rectangular and odd-sized reduced windows keep ceil-halving the long axis.
  assert.equal(
    heightWindowBytes([0, 0, 4, 32], 4),
    (128 + 8 + 4 + 2 + 1) * 4 + 16,
  );
  assert.equal(
    heightWindowBytes([0, 0, 12, 20], 4),
    (128 + 15 + 6 + 2 + 1) * 4 + 30,
  );
});

test("the height-cell limit applies after reduction", () => {
  const bounds = [-4096, -4096, 4096, 4096];
  assert.equal(heightWindowBytes(bounds, 1), Infinity);
  assert.ok(Number.isFinite(heightWindowBytes(bounds, 2)));
  assert.ok(Number.isFinite(heightWindowBytes(bounds, 4)));
  assert.ok(
    1024 * regionBytes(4) + heightWindowBytes(bounds, 4) + WORKING_BYTES <
      MAP_CACHE_BYTES,
  );
  assert.equal(heightWindowBytes([0, 0, 16388, 16384], 4), Infinity);
});

test("malformed or unrepresentable height windows cannot be admitted", () => {
  for (const bounds of [
    [],
    [0, 0, 256],
    [0, 0, 256, 256, 256],
    [0, 0, 0, 256],
    [0, 0, 256, 0],
    [256, 0, 0, 256],
    [0, 256, 256, 0],
    [0, 0, NaN, 256],
    [0, 0, 256, Infinity],
    [-Infinity, 0, 256, 256],
    [0, 0, 255.5, 256],
    [0, 0, Number.MAX_SAFE_INTEGER + 1, 256],
  ]) {
    for (const stride of [1, 2, 4])
      assert.equal(
        heightWindowBytes(bounds, stride),
        Infinity,
        `${bounds}/${stride}`,
      );
  }
  for (const stride of [0, -1, 3, 8, 1.5, NaN, Infinity])
    assert.equal(heightWindowBytes([0, 0, 256, 256], stride), Infinity);
  assert.equal(heightWindowBytes([0, 0, 255, 256], 2), Infinity);
  assert.equal(heightWindowBytes([0, 0, 256, 254], 4), Infinity);
});
