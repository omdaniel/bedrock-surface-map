import {
  intersects,
  parentTile,
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

export interface ResidentCutOptions {
  roots: readonly TileKey[];
  bounds: Bounds;
  focus: readonly [number, number];
  maxTiles: number;
  targetLevel: number;
  /** Maximum visited nodes, including visible roots. Defaults to 512. */
  maxVisits?: number;
  /** Complete sparse child list; [] is terminal, undefined is unavailable metadata. */
  children(key: TileKey): readonly TileKey[] | undefined;
  isReady(key: TileKey): boolean;
}

interface ResidentNode {
  key: TileKey;
  bounds: Bounds;
  ready: boolean;
  parent: ResidentNode | null;
}

/**
 * Select ready coverage without requiring intermediate surface residency.
 * Visible roots must be ready, nonoverlapping and already 2:1 balanced.
 * Empty child lists are terminal summaries, not absent coverage.
 */
export function residentCut(options: ResidentCutOptions): TileKey[] {
  const maxVisits = options.maxVisits ?? 512;
  if (
    !Number.isSafeInteger(maxVisits) ||
    maxVisits < 1 ||
    !Number.isInteger(options.maxTiles) ||
    options.maxTiles < 0 ||
    options.maxTiles > 128 ||
    !Number.isInteger(options.targetLevel) ||
    options.targetLevel < 0 ||
    options.targetLevel > 16 ||
    !options.focus.every(Number.isFinite)
  )
    throw new RangeError("Invalid resident cut options");
  intersects(options.bounds, options.bounds);
  const order = (a: TileKey, b: TileKey) =>
    b.level - a.level || a.z - b.z || a.x - b.x;
  const distance = (bounds: Bounds) => {
    const dx = Math.max(
      bounds[0] - options.focus[0],
      0,
      options.focus[0] - bounds[2],
    );
    const dz = Math.max(
      bounds[1] - options.focus[1],
      0,
      options.focus[1] - bounds[3],
    );
    return dx * dx + dz * dz;
  };
  const nearFirst = (a: TileKey, b: TileKey) =>
    distance(tileBounds(a)) - distance(tileBounds(b)) || order(a, b);
  const visible = options.roots
    .filter((key) => intersects(tileBounds(key), options.bounds))
    .sort(nearFirst);
  if (visible.length > options.maxTiles || visible.length > maxVisits)
    throw new RangeError("Resident cut capacity cannot hold its visible roots");
  for (let i = 0; i < visible.length; i++) {
    const a = tileBounds(visible[i]);
    for (let j = i + 1; j < visible.length; j++) {
      const b = tileBounds(visible[j]);
      if (
        intersects(a, b) ||
        (neighbors(a, b) && Math.abs(visible[i].level - visible[j].level) > 1)
      )
        throw new RangeError("Resident cut roots overlap or are unbalanced");
    }
  }
  let visits = 0;
  const visit = (key: TileKey, parent: ResidentNode | null): ResidentNode => {
    visits++;
    return {
      key,
      parent,
      bounds: tileBounds(key),
      ready: options.isReady(key),
    };
  };
  // Reserve visits for every root before a focus-first descent consumes the cap.
  const roots = visible.map((key) => visit(key, null));
  if (roots.some((node) => !node.ready))
    throw new RangeError("Resident cut requires ready visible roots");

  const frontier = (node: ResidentNode): ResidentNode[] | undefined => {
    const fallback = node.ready ? [node] : undefined;
    if (
      !node.key.level ||
      (node.ready && node.key.level <= options.targetLevel)
    )
      return fallback;
    const known = options.children(node.key);
    if (known === undefined || known.length === 0) return fallback;
    if (known.length > 4)
      throw new RangeError("Resident cut metadata has too many children");
    const ids = new Set<string>();
    for (const child of known) {
      const id = tileId(child);
      const parent = parentTile(child);
      if (!parent || tileId(parent) !== tileId(node.key) || ids.has(id))
        throw new RangeError("Resident cut metadata has an invalid child");
      ids.add(id);
    }
    const children = known
      .filter((key) => intersects(tileBounds(key), options.bounds))
      .sort(nearFirst);
    if (visits + children.length > maxVisits) return fallback;
    const nodes = children.map((key) => visit(key, node));
    const next: ResidentNode[] = [];
    for (const child of nodes) {
      const selected = frontier(child);
      if (selected === undefined) return fallback;
      next.push(...selected);
    }
    return next;
  };
  let cut = roots.flatMap((root) => frontier(root)!);
  const contains = (ancestor: ResidentNode, node: ResidentNode) =>
    ancestor.bounds[0] <= node.bounds[0] &&
    ancestor.bounds[1] <= node.bounds[1] &&
    ancestor.bounds[2] >= node.bounds[2] &&
    ancestor.bounds[3] >= node.bounds[3];

  // Every repair replaces descendants by a previously unselected ready ancestor.
  // Nothing is refined again, so there can be at most `visits` repairs.
  for (let repairs = 0; repairs <= visits; repairs++) {
    let replacement: ResidentNode | undefined;
    for (let i = 0; i < cut.length && !replacement; i++) {
      for (let j = i + 1; j < cut.length; j++) {
        const a = cut[i],
          b = cut[j];
        if (
          Math.abs(a.key.level - b.key.level) <= 1 ||
          !neighbors(a.bounds, b.bounds)
        )
          continue;
        const fine = a.key.level < b.key.level ? a : b;
        let parent = fine.parent;
        while (parent && !parent.ready) parent = parent.parent;
        if (!parent)
          throw new Error("Unbalanced resident cut has no ready ancestor");
        replacement = parent;
        break;
      }
    }
    if (!replacement && cut.length > options.maxTiles) {
      const counts = new Map<ResidentNode, number>();
      for (const node of cut)
        for (let parent = node.parent; parent; parent = parent.parent)
          counts.set(parent, (counts.get(parent) ?? 0) + 1);
      const candidates = new Set<ResidentNode>();
      for (const node of cut) {
        let parent = node.parent;
        while (parent && (!parent.ready || (counts.get(parent) ?? 0) < 2))
          parent = parent.parent;
        if (parent) candidates.add(parent);
      }
      replacement = [...candidates].sort(
        (a, b) =>
          distance(b.bounds) - distance(a.bounds) ||
          a.key.level - b.key.level ||
          order(a.key, b.key),
      )[0];
      if (!replacement)
        throw new Error("Resident cut cannot reach its tile capacity");
    }
    if (!replacement) return cut.map((node) => node.key).sort(order);
    const ancestor = replacement;
    cut = [...cut.filter((node) => !contains(ancestor, node)), ancestor];
  }
  throw new Error("Resident cut exceeded its bounded repair count");
}

/** Picking follows displayed coverage, not whichever finer tile is cached. */
export function coveringTile(
  cut: readonly TileKey[],
  x: number,
  z: number,
): TileKey | undefined {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return undefined;
  return cut.find((key) => {
    const bounds = tileBounds(key);
    return x >= bounds[0] && x < bounds[2] && z >= bounds[1] && z < bounds[3];
  });
}

/** Active/fading tiles retain the parent caches used by mixed-resolution edges. */
export function cutAncestors(
  cut: readonly TileKey[],
  rootLevel: number,
): Set<string> {
  if (!Number.isInteger(rootLevel) || rootLevel < 0 || rootLevel > 16)
    throw new RangeError("Invalid root level");
  const ids = new Set<string>();
  for (const key of cut) {
    if (key.level > rootLevel) throw new RangeError("Tile is above its root");
    let current: TileKey | null = key;
    while (current && current.level <= rootLevel) {
      const id = tileId(current);
      if (ids.has(id)) break;
      ids.add(id);
      current = parentTile(current);
    }
  }
  return ids;
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
