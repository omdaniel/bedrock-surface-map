import {
  intersection,
  tileId,
  tileSpan,
  type Bounds,
  type TileKey,
  type View,
} from "./selection.ts";

export interface DemandTile {
  key: TileKey;
  /** Visible work always precedes speculative work. */
  priority: "visible" | "buffer";
  distance: number;
}
export interface DemandPlan {
  tiles: DemandTile[];
  visible: Bounds | null;
  buffer: Bounds | null;
  visibleCount: number;
  bufferComplete: boolean;
}
export interface DemandOptions {
  /** Hard metadata/work bound; a too-large visible view must coarsen. */
  maxTiles?: number;
  marginScreens?: number;
  /** Blocks per second, independent of viewport pixel density. */
  velocity?: { x: number; z: number };
  lookaheadSeconds?: number;
}

/** A bounded symmetric guard band plus capped directional lookahead.
 * No per-viewer server state is involved. GPU admission may further restrict
 * speculative residency; the returned order always protects visible coverage.
 */
export function planDemand(
  view: View,
  bounds: Bounds,
  level: number,
  options: DemandOptions = {},
): DemandPlan {
  const maxTiles = options.maxTiles ?? 256;
  const margin = options.marginScreens ?? 0.5;
  const lookahead = options.lookaheadSeconds ?? 0.75;
  const velocity = options.velocity ?? { x: 0, z: 0 };
  if (
    !Number.isInteger(maxTiles) ||
    maxTiles < 1 ||
    maxTiles > 4096 ||
    !Number.isFinite(margin) ||
    margin < 0 ||
    margin > 2 ||
    !Number.isFinite(lookahead) ||
    lookahead < 0 ||
    lookahead > 2 ||
    !Number.isFinite(velocity.x) ||
    !Number.isFinite(velocity.z)
  )
    throw new Error("Invalid terrain demand limits");
  const size = tileSpan(level);
  const raw: Bounds = [view.left, view.top, view.right, view.bottom];
  const visible = intersection(raw, bounds);
  if (!visible)
    return {
      tiles: [],
      visible: null,
      buffer: null,
      visibleCount: 0,
      bufferComplete: true,
    };
  const width = raw[2] - raw[0],
    height = raw[3] - raw[1];
  if (width <= 0 || height <= 0) throw new Error("Invalid terrain viewport");
  const mx = Math.max(size, width * margin),
    mz = Math.max(size, height * margin);
  const clamp = (v: number, extent: number) =>
    Math.max(-extent, Math.min(extent, v));
  const dx = clamp(velocity.x * lookahead, Math.max(width, size));
  const dz = clamp(velocity.z * lookahead, Math.max(height, size));
  const buffer = intersection(
    [
      raw[0] - mx + Math.min(0, dx),
      raw[1] - mz + Math.min(0, dz),
      raw[2] + mx + Math.max(0, dx),
      raw[3] + mz + Math.max(0, dz),
    ],
    bounds,
  )!;
  const range = (b: Bounds) => [
    Math.floor(b[0] / size),
    Math.floor(b[1] / size),
    Math.ceil(b[2] / size),
    Math.ceil(b[3] / size),
  ];
  const v = range(visible),
    b = range(buffer);
  const visibleCount = (v[2] - v[0]) * (v[3] - v[1]);
  if (!Number.isSafeInteger(visibleCount) || visibleCount > maxTiles)
    throw new Error("Visible terrain demand requires a coarser level");
  const centerX = (visible[0] + visible[2]) / 2,
    centerZ = (visible[1] + visible[3]) / 2;
  const tiles: DemandTile[] = [];
  const add = (x: number, z: number, priority: DemandTile["priority"]) => {
    const tx = (x + 0.5) * size,
      tz = (z + 0.5) * size;
    tiles.push({
      key: { level, x, z },
      priority,
      distance: (tx - centerX - dx * 0.5) ** 2 + (tz - centerZ - dz * 0.5) ** 2,
    });
  };
  for (let z = v[1]; z < v[3]; z++)
    for (let x = v[0]; x < v[2]; x++) add(x, z, "visible");
  // Enumerate outward rings instead of allocating a list proportional to an
  // enormous view or velocity. At most a bounded ring beyond the quota is sorted.
  for (let ring = 1; tiles.length < maxTiles; ring++) {
    const left = Math.max(b[0], v[0] - ring),
      right = Math.min(b[2], v[2] + ring);
    const top = Math.max(b[1], v[1] - ring),
      bottom = Math.min(b[3], v[3] + ring);
    const before = tiles.length;
    for (let z = top; z < bottom; z++)
      for (let x = left; x < right; x++) {
        if (x >= v[0] && x < v[2] && z >= v[1] && z < v[3]) continue;
        const distance = Math.max(
          v[0] - x,
          x - v[2] + 1,
          v[1] - z,
          z - v[3] + 1,
        );
        if (distance === ring) add(x, z, "buffer");
      }
    if (
      before === tiles.length ||
      (left === b[0] && right === b[2] && top === b[1] && bottom === b[3])
    )
      break;
  }
  tiles.sort(
    (a, b) =>
      Number(a.priority === "buffer") - Number(b.priority === "buffer") ||
      a.distance - b.distance ||
      a.key.z - b.key.z ||
      a.key.x - b.key.x,
  );
  const count = (b[2] - b[0]) * (b[3] - b[1]);
  return {
    tiles: tiles.slice(0, maxTiles),
    visible,
    buffer,
    visibleCount,
    bufferComplete: count <= maxTiles,
  };
}

/** Readiness for one demand epoch; callers supply only current-revision IDs. */
export function demandReady(
  plan: DemandPlan,
  available: ReadonlySet<string>,
  visibleOnly = false,
): boolean {
  return plan.tiles.every(
    (t) =>
      (visibleOnly && t.priority !== "visible") || available.has(tileId(t.key)),
  );
}

/** The nearest safe pan margin from already-resident target-resolution tiles.
 * A sparse source can use explicit absent tiles; missing downloads never count.
 */
export function coveredView(
  view: View,
  ready: readonly TileKey[],
  level: number,
): boolean {
  const ids = new Set(ready.filter((k) => k.level === level).map(tileId));
  const size = tileSpan(level);
  const width = Math.ceil(view.right / size) - Math.floor(view.left / size);
  const height = Math.ceil(view.bottom / size) - Math.floor(view.top / size);
  if (width <= 0 || height <= 0 || width * height > ids.size) return false;
  for (
    let z = Math.floor(view.top / size);
    z < Math.ceil(view.bottom / size);
    z++
  )
    for (
      let x = Math.floor(view.left / size);
      x < Math.ceil(view.right / size);
      x++
    )
      if (!ids.has(tileId({ level, x, z }))) return false;
  return true;
}
