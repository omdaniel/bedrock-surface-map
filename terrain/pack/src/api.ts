import {
  BlockVolume,
  type Dimension,
  type Block as GameBlock,
} from "@minecraft/server";
import type { Access, Block } from "./core.js";

export function surfaceAccess(dimension: Dimension) {
  let queries = 0;
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
      // Unlike getTopmostBlock, the filtered downward query includes liquids and
      // passable blocks. Check the ceiling separately: getBlockBelow excludes it.
      const ceiling = dimension.heightRange.max;
      queries++;
      const blocks = dimension.getBlocks(
        new BlockVolume({ x, y: ceiling - 1, z }, { x, y: ceiling, z }),
        { excludeTypes: ["minecraft:air"] },
        false,
      );
      let highest = -Infinity;
      for (const location of blocks.getBlockLocationIterator())
        highest = Math.max(highest, location.y);
      if (Number.isFinite(highest)) return read(x, highest, z);
      queries++;
      return describe(
        dimension.getBlockBelow(
          { x, y: ceiling - 1, z },
          {
            includeLiquidBlocks: true,
            includePassableBlocks: true,
            maxDistance: ceiling - access.minimum,
          },
        ),
      );
    },
    block: read,
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
