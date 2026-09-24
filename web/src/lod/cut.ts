import {
  intersects,
  tileBounds,
  tileId,
  type Bounds,
  type TileKey,
} from "./selection.ts";

export interface CutOptions {
  roots: readonly TileKey[];
  bounds: Bounds;
  focus: readonly [number, number];
  maxTiles: number;
  shouldRefine(key: TileKey): boolean;
  children(key: TileKey): readonly TileKey[] | undefined;
  admit(
    parent: TileKey,
    children: readonly TileKey[],
    replacement: readonly TileKey[],
  ): boolean;
}

/** Balanced at edges/corners, sibling-atomic refinement of known sparse nodes. */
export function balancedCut(options: CutOptions): TileKey[] {
  if (
    !Number.isInteger(options.maxTiles) ||
    options.maxTiles < options.roots.length ||
    options.maxTiles > 128
  )
    throw new RangeError("Invalid resident cut capacity");
  const boxes = new Map<string, Bounds>();
  const box = (key: TileKey) => {
    const id = tileId(key);
    let bounds = boxes.get(id);
    if (!bounds) {
      bounds = tileBounds(key);
      boxes.set(id, bounds);
    }
    return bounds;
  };
  const distance = (key: TileKey) => {
    const b = box(key);
    return (
      ((b[0] + b[2]) / 2 - options.focus[0]) ** 2 +
      ((b[1] + b[3]) / 2 - options.focus[1]) ** 2
    );
  };
  let cut = options.roots.filter((key) => intersects(box(key), options.bounds));
  const blocked = new Set<string>();
  for (let steps = 0; steps < 2048; steps++) {
    const candidates = cut.filter(
      (key) =>
        key.level > 0 && !blocked.has(tileId(key)) && options.shouldRefine(key),
    );
    candidates.sort(
      (a, b) =>
        b.level - a.level ||
        distance(a) - distance(b) ||
        a.z - b.z ||
        a.x - b.x,
    );
    const parent = candidates[0];
    if (!parent) break;
    const id = tileId(parent);
    const children = options
      .children(parent)
      ?.filter((key) => intersects(box(key), options.bounds));
    if (
      !children?.length ||
      cut.length - 1 + children.length > options.maxTiles
    ) {
      blocked.add(id);
      continue;
    }
    const others = cut.filter((key) => tileId(key) !== id);
    if (
      children.some((child) =>
        others.some(
          (other) =>
            Math.abs(child.level - other.level) > 1 &&
            neighbors(box(child), box(other)),
        ),
      )
    ) {
      blocked.add(id);
      continue;
    }
    const next = [...others, ...children];
    if (!options.admit(parent, children, next)) {
      blocked.add(id);
      continue;
    }
    cut = next;
    // A neighboring coarse branch may now permit a previously blocked split.
    blocked.clear();
  }
  return cut.sort((a, b) => b.level - a.level || a.z - b.z || a.x - b.x);
}

function neighbors(a: Bounds, b: Bounds) {
  return (
    ((a[2] === b[0] || a[0] === b[2]) &&
      Math.max(a[1], b[1]) <= Math.min(a[3], b[3])) ||
    ((a[3] === b[1] || a[1] === b[3]) &&
      Math.max(a[0], b[0]) <= Math.min(a[2], b[2]))
  );
}
