import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// The native module exists only in BDS. Its volume value is enough for these
// adapter contract tests; copied-world tests exercise the actual engine methods.
const moduleUrl =
  "data:text/javascript," +
  encodeURIComponent(
    "export class BlockVolume { constructor(from,to) { this.from=from; this.to=to; } }",
  );
registerHooks({
  resolve(specifier, context, next) {
    return specifier === "@minecraft/server"
      ? { url: moduleUrl, shortCircuit: true }
      : next(specifier, context);
  },
});
const { surfaceAccess } = await import("../pack/src/api.ts");

test("height-map lower bound cannot hide water, snow, vegetation or a ceiling block", () => {
  for (const [name, y] of [
    ["water", 203],
    ["snow_layer", 201],
    ["short_grass", 201],
    ["stone", 319],
  ] as const) {
    const block = (typeId: string, y: number) => ({
      y,
      typeId,
      permutation: { getAllStates: () => ({}) },
    });
    const solid = block("minecraft:stone", 200),
      top = block(`minecraft:${name}`, y);
    const reader = surfaceAccess({
      heightRange: { min: -64, max: 320 },
      getTopmostBlock: () => solid,
      getBlocks: (
        volume: { from: { y: number }; to: { y: number } },
        _filter: unknown,
        allowUnloaded: boolean,
      ) => {
        assert.equal(volume.from.y, 201);
        assert.equal(volume.to.y, 319);
        assert.equal(allowUnloaded, false);
        return { getBlockLocationIterator: () => [{ x: -1, y, z: -17 }] };
      },
      getBlock: () => top,
    } as never);
    assert.deepEqual(reader.access.top(-1, -17), {
      y,
      material: { name: `minecraft:${name}`, states: {} },
    });
    assert.equal(reader.queries, 4);
    reader.reset();
    assert.equal(reader.queries, 0);
  }
});

test("empty and unloading are distinct, including columns without a solid height-map entry", () => {
  let unloading = false;
  const reader = surfaceAccess({
    heightRange: { min: -64, max: 320 },
    getTopmostBlock: () => undefined,
    getBlocks: (volume: { from: { y: number } }) => {
      assert.equal(volume.from.y, -64);
      if (unloading) throw Error("UnloadedChunksError");
      return { getBlockLocationIterator: () => [] };
    },
  } as never);
  assert.equal(reader.access.top(0, 0), undefined);
  unloading = true;
  assert.throws(() => reader.access.top(0, 0), /Unloaded/);
});

test("underwater native query is bounded and retains nonwater support", () => {
  const reader = surfaceAccess({
    heightRange: { min: -64, max: 320 },
    getBlocks: (volume, filter, allowUnloaded) => {
      assert.equal(volume.from.y, -64);
      assert.equal(volume.to.y, 62);
      assert.deepEqual(filter.excludeTypes, [
        "minecraft:air",
        "minecraft:water",
        "minecraft:flowing_water",
      ]);
      assert.equal(allowUnloaded, false);
      return {
        getBlockLocationIterator: () => [{ y: 10 }, { y: 40 }, { y: 20 }],
      };
    },
    getBlock: ({ y }) => ({
      y,
      typeId: "minecraft:seagrass",
      permutation: { getAllStates: () => ({}) },
    }),
  } as never);
  assert.equal(reader.access.belowWater!(0, 62, 0)?.y, 40);
  assert.equal(reader.queries, 3);
  assert.equal(reader.access.belowWater!(0, -65, 0), undefined);
  assert.equal(reader.queries, 3);
});

test("water support query reuses the solid bound without hiding plants above it", () => {
  const block = (y, typeId) => ({
    y,
    typeId,
    permutation: { getAllStates: () => ({}) },
  });
  const reader = surfaceAccess({
    heightRange: { min: -64, max: 320 },
    getTopmostBlock: () => block(20, "minecraft:sand"),
    getBlocks: (volume, filter) => {
      assert.equal(volume.from.y, 21);
      return {
        getBlockLocationIterator: () => [
          { y: filter.excludeTypes.length === 1 ? 63 : 40 },
        ],
      };
    },
    getBlock: ({ y }) =>
      block(y, y === 63 ? "minecraft:water" : "minecraft:seagrass"),
  } as never);
  assert.equal(reader.access.top(0, 0)?.y, 63);
  assert.equal(reader.access.belowWater!(0, 62, 0)?.y, 40);
  assert.equal(reader.queries, 7);
});
