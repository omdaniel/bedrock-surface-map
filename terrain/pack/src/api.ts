import {
  BlockVolume,
  type Dimension,
  type Block as GameBlock,
} from "@minecraft/server";
import type { Access, Block, Rules } from "./core.js";

export function surfaceAccess(dimension: Dimension, rules: Rules) {
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
      // BDS's height-map query omits liquids and thin blocks. A bounded, exact
      // volume query includes them and throws rather than concealing unloading.
      queries++;
      const blocks = dimension.getBlocks(
        new BlockVolume({ x, y: access.minimum, z }, { x, y: 319, z }),
        { excludeTypes: ["minecraft:air"] },
        false,
      );
      let highest = -Infinity;
      for (const location of blocks.getBlockLocationIterator())
        highest = Math.max(highest, location.y);
      return Number.isFinite(highest) ? read(x, highest, z) : undefined;
    },
    block: read,
    biome: (x, y, z) => {
      queries++;
      return dimension.getBiome({ x, y, z }).id;
    },
  };
  // The shared scanner handles invisible block types during descent.
  void rules;
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
