import {
  BlockVolume,
  type Dimension,
  type Block as GameBlock,
} from "@minecraft/server";
import type { Access, Block } from "./core.js";

export function surfaceAccess(dimension: Dimension) {
  let queries = 0;
  let lowerBound:
    { x: number; z: number; block: GameBlock | undefined } | undefined;
  const describe = (b: GameBlock | undefined): Block | undefined => {
    if (!b) return undefined;
    queries++;
    return {
      y: b.y,
      material: { name: b.typeId, states: b.permutation.getAllStates() },
    };
  };
  const read = (x: number, y: number, z: number) => {
    queries++;
    return describe(dimension.getBlock({ x, y, z }));
  };
  const access: Access = {
    minimum: dimension.heightRange.min,
    loaded: (x, z) => {
      queries++;
      return dimension.isChunkLoaded({ x, y: 64, z });
    },
    top: (x, z) => {
      // The native height map supplies a lower bound, not the final surface:
      // water and thin blocks above it must be included by an exact volume query.
      const ceiling = dimension.heightRange.max;
      queries++;
      const solid = dimension.getTopmostBlock({ x, z });
      lowerBound = { x, z, block: solid };
      const floor = solid ? solid.y + 1 : access.minimum;
      if (floor >= ceiling) return describe(solid);
      queries++;
      const blocks = dimension.getBlocks(
        new BlockVolume({ x, y: floor, z }, { x, y: ceiling - 1, z }),
        { excludeTypes: ["minecraft:air"] },
        false,
      );
      let highest = -Infinity;
      for (const location of blocks.getBlockLocationIterator())
        highest = Math.max(highest, location.y);
      if (Number.isFinite(highest)) return read(x, highest, z);
      return describe(solid);
    },
    block: read,
    belowWater: (x, y, z) => {
      if (y < access.minimum) return undefined;
      // Reuse the solid lower bound from this column's top query, so the exact
      // water/air-filtered query never enumerates the entire underground column.
      // Unloading throws, so a partial column can never replace published terrain.
      const solid =
        lowerBound?.x === x &&
        lowerBound.z === z &&
        lowerBound.block &&
        lowerBound.block.y <= y
          ? lowerBound.block
          : undefined;
      const floor = solid ? solid.y + 1 : access.minimum;
      if (floor > y) return describe(solid);
      queries++;
      const blocks = dimension.getBlocks(
        new BlockVolume({ x, y: floor, z }, { x, y, z }),
        {
          excludeTypes: [
            "minecraft:air",
            "minecraft:water",
            "minecraft:flowing_water",
          ],
        },
        false,
      );
      let highest = -Infinity;
      for (const location of blocks.getBlockLocationIterator())
        highest = Math.max(highest, location.y);
      return Number.isFinite(highest) ? read(x, highest, z) : describe(solid);
    },
    biome: (x, y, z) => {
      queries++;
      return dimension.getBiome({ x, y, z }).id;
    },
  };
  return {
    access,
    reset: () => {
      queries = 0;
    },
    get queries() {
      return queries;
    },
  };
}
