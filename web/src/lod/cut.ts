import type { TileKey } from "./protocol.ts";
import {
  intersection,
  tileBounds,
  tileId,
  tileSpan,
  type Bounds,
} from "./selection.ts";

export interface DrawTile {
  key: TileKey;
  /** Integer, half-open world scissors, clamped to this source tile. */
  clip: Bounds;
}

export interface DrawCutOptions {
  /** Up to four disjoint forest roots. A root is drawn only if also in ready. */
  roots: readonly TileKey[];
  /** Current-publication resident sources, including available pinned roots. */
  ready: readonly TileKey[];
  /** Optional exact integer dataset bounds; the positional API takes a clipped view. */
  worldBounds?: readonly number[];
  /** Half-open world viewport; minima floor and maxima ceil for GPU Int32 scissors. */
  viewport: readonly number[];
  targetLevel: number;
  /**
   * Optional authoritative empty subtrees from the same publication. Missing
   * downloads are NOT absent. These masks win over stale ready descendants,
   * including when an absent subtree is finer than the current target level.
   */
  absent?: readonly TileKey[];
}

interface Candidate extends DrawTile {
  empty: boolean;
}

const MAX_TILES = 256;

function contains(outer: readonly number[], inner: readonly number[]) {
  return (
    outer[0] <= inner[0] &&
    outer[1] <= inner[1] &&
    inner[2] <= outer[2] &&
    inner[3] <= outer[3]
  );
}

/** Subtract a rectangle into at most four disjoint strips. Inputs are validated. */
function subtract(source: DrawTile, mask: Bounds, output: DrawTile[]) {
  const [left, top, right, bottom] = source.clip;
  const x0 = Math.max(left, mask[0]);
  const z0 = Math.max(top, mask[1]);
  const x1 = Math.min(right, mask[2]);
  const z1 = Math.min(bottom, mask[3]);
  if (x0 >= x1 || z0 >= z1) {
    output.push(source);
    return;
  }
  const key = source.key;
  if (top < z0) output.push({ key, clip: [left, top, right, z0] });
  if (z1 < bottom) output.push({ key, clip: [left, z1, right, bottom] });
  if (left < x0) output.push({ key, clip: [left, z0, x0, z1] });
  if (x1 < right) output.push({ key, clip: [x1, z0, right, z1] });
}

/**
 * Select the actual scissored sources for drawing and picking. Lower numeric
 * levels are finer: choose the finest ready source whose level >= targetLevel,
 * or the root itself when the requested target is coarser than that root.
 * Missing intermediate levels never prevent a ready descendant from drawing.
 * Uncovered child areas keep their nearest ready ancestor, not a blank quad.
 * Without a ready ancestor, only the ready descendants have drawable coverage.
 *
 * Overlay coarser tiles first, subtracting each finer tile from prior coverage.
 * Dyadic tile bounds are nested or disjoint; a later, smaller tile cannot cross
 * a prior coarser split line. Each overlay creates at most four extra clips.
 * For n ready+absent keys: O(n^2) worst-case work, O(n) storage/output (<=4n),
 * independent of world area or the number of unready quadtree nodes. Each input
 * list is capped at 256; no target-level grid or full tree is ever enumerated.
 *
 * A source may appear in several clips. Submit every clip and use this same
 * returned cut with pickDrawTile; do not independently reselect a picking tile.
 */
export function buildDrawCut(
  roots: readonly TileKey[],
  ready: readonly TileKey[],
  view: Bounds,
  targetLevel: number,
): DrawTile[];
/** Options form additionally accepts dataset bounds and explicit absent masks. */
export function buildDrawCut(options: DrawCutOptions): DrawTile[];
export function buildDrawCut(
  rootsOrOptions: readonly TileKey[] | DrawCutOptions,
  readyTiles?: readonly TileKey[],
  view?: Bounds,
  level?: number,
): DrawTile[] {
  const options: DrawCutOptions = Array.isArray(rootsOrOptions)
    ? {
        roots: rootsOrOptions,
        ready: readyTiles!,
        viewport: view!,
        targetLevel: level!,
      }
    : (rootsOrOptions as DrawCutOptions);
  const { roots, ready, worldBounds, viewport, targetLevel } = options;
  const absent = options.absent ?? [];
  tileSpan(targetLevel); // Apply the shared level validation even for empty views.
  if (roots.length > 4)
    throw new RangeError("A draw cut contains at most four roots");
  if (ready.length > MAX_TILES || absent.length > MAX_TILES)
    throw new RangeError(
      "A draw cut accepts at most 256 ready or absent tiles",
    );
  const rootBounds = roots.map(tileBounds);
  for (let i = 0; i < rootBounds.length; i++)
    for (let j = i + 1; j < rootBounds.length; j++)
      if (intersection(rootBounds[i], rootBounds[j]))
        throw new RangeError("Draw cut roots must not overlap");
  const raw = intersection(worldBounds ?? viewport, viewport);
  if (worldBounds && !worldBounds.every(Number.isInteger))
    throw new RangeError("World bounds must be integer block coordinates");
  const visible: Bounds | null = raw
    ? [
        Math.floor(raw[0]),
        Math.floor(raw[1]),
        Math.ceil(raw[2]),
        Math.ceil(raw[3]),
      ]
    : null;
  if (!visible || roots.length === 0) return [];

  const candidates = new Map<string, Candidate>();
  const add = (key: TileKey, empty: boolean) => {
    const bounds = tileBounds(key);
    const root = rootBounds.findIndex((box) => contains(box, bounds));
    if (root < 0) return; // Ignore old-generation or out-of-forest residents.
    if (!empty && key.level < Math.min(targetLevel, roots[root].level)) return;
    const clip = intersection(bounds, visible);
    if (clip) candidates.set(tileId(key), { key: { ...key }, clip, empty });
  };
  for (const key of ready) add(key, false);
  // Explicit absence overrides an identical resident key, independent of order.
  for (const key of absent) add(key, true);
  const ordered = [...candidates.values()].sort(
    (a, b) =>
      b.key.level - a.key.level || a.key.z - b.key.z || a.key.x - b.key.x,
  );
  const holes = ordered.filter((candidate) => candidate.empty);
  let cut: DrawTile[] = [];
  for (const candidate of ordered) {
    if (
      !candidate.empty &&
      holes.some((hole) => contains(hole.clip, candidate.clip))
    )
      continue;
    const next: DrawTile[] = [];
    for (const source of cut) subtract(source, candidate.clip, next);
    if (!candidate.empty)
      next.push({ key: candidate.key, clip: candidate.clip });
    cut = next;
  }
  return cut;
}

/** Return the actual drawn entry at a half-open world coordinate, if covered. */
export function pickDrawTile(
  cut: readonly DrawTile[],
  x: number,
  z: number,
): DrawTile | undefined {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return undefined;
  return cut.find(
    ({ clip }) => clip[0] <= x && x < clip[2] && clip[1] <= z && z < clip[3],
  );
}
