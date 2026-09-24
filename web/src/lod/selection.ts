export const TILE_SIZE = 128;
export const MAX_LEVEL = 16;
export const MAX_COORDINATE = 8_388_608;
export const REFINE_SAMPLE_PIXELS = 3;
export const COARSEN_SAMPLE_PIXELS = 1;
export const REFINE_DEBOUNCE_MS = 100;

export interface TileKey {
  level: number;
  x: number;
  z: number;
}
/** World block coordinates, with exclusive maxima. */
export type Bounds = [number, number, number, number];
export interface View {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function validateLevel(level: number) {
  if (!Number.isInteger(level) || level < 0 || level > MAX_LEVEL)
    throw new RangeError("LOD level must be an integer from 0 through 16");
}

function validateBounds(bounds: readonly number[]) {
  if (
    bounds.length !== 4 ||
    !bounds.every(
      (v) => Number.isFinite(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER,
    ) ||
    bounds[0] > bounds[2] ||
    bounds[1] > bounds[3]
  )
    throw new RangeError("Invalid half-open bounds");
}

function validateTile(tile: TileKey) {
  validateLevel(tile.level);
  const span = tileSpan(tile.level);
  if (
    ![tile.x, tile.z].every(
      (v) =>
        Number.isSafeInteger(v) &&
        Number.isSafeInteger(v * span) &&
        Number.isSafeInteger((v + 1) * span),
    )
  )
    throw new RangeError("Tile coordinates exceed exact integer arithmetic");
}

export function tileId(tile: TileKey): string {
  validateTile(tile);
  return `${tile.level}/${tile.x}/${tile.z}`;
}

export function tileSpan(level: number): number {
  validateLevel(level);
  return TILE_SIZE * 2 ** level;
}

export function tileBounds(tile: TileKey): Bounds {
  validateTile(tile);
  const span = tileSpan(tile.level);
  return [
    tile.x * span,
    tile.z * span,
    (tile.x + 1) * span,
    (tile.z + 1) * span,
  ];
}

export function parentTile(tile: TileKey): TileKey | null {
  validateTile(tile);
  if (tile.level === MAX_LEVEL) return null;
  return {
    level: tile.level + 1,
    x: Math.floor(tile.x / 2),
    z: Math.floor(tile.z / 2),
  };
}

/** North-west, north-east, south-west, south-east; north is negative Z. */
export function childTiles(tile: TileKey): TileKey[] {
  validateTile(tile);
  if (tile.level === 0) return [];
  const level = tile.level - 1;
  const x = tile.x * 2;
  const z = tile.z * 2;
  return [
    { level, x, z },
    { level, x: x + 1, z },
    { level, x, z: z + 1 },
    { level, x: x + 1, z: z + 1 },
  ];
}

export function intersects(
  a: readonly number[],
  b: readonly number[],
): boolean {
  return intersection(a, b) !== null;
}

export function intersection(
  a: readonly number[],
  b: readonly number[],
): Bounds | null {
  validateBounds(a);
  validateBounds(b);
  const left = Math.max(a[0], b[0]);
  const top = Math.max(a[1], b[1]);
  const right = Math.min(a[2], b[2]);
  const bottom = Math.min(a[3], b[3]);
  return left < right && top < bottom ? [left, top, right, bottom] : null;
}

/** Smallest common level with at most one containing root per sign quadrant. */
export function rootForest(bounds: readonly number[]): TileKey[] {
  validateBounds(bounds);
  if (
    !bounds.every((v) => Number.isInteger(v) && Math.abs(v) <= MAX_COORDINATE)
  )
    throw new RangeError("Root bounds must be integers within +/-8388608");
  if (bounds[0] === bounds[2] || bounds[1] === bounds[3]) return [];
  const split = (min: number, max: number) =>
    min < 0 && max > 0
      ? [
          [min, 0],
          [0, max],
        ]
      : [[min, max]];
  const xs = split(bounds[0], bounds[2]);
  const zs = split(bounds[1], bounds[3]);
  for (let level = 0; level <= MAX_LEVEL; level++) {
    const span = tileSpan(level);
    if (
      ![...xs, ...zs].every(
        ([min, max]) => Math.floor(min / span) === Math.ceil(max / span) - 1,
      )
    )
      continue;
    return zs.flatMap(([z]) =>
      xs.map(([x]) => ({
        level,
        x: Math.floor(x / span),
        z: Math.floor(z / span),
      })),
    );
  }
  throw new RangeError("Root bounds exceed the LOD hierarchy");
}

/** Hysteresis in physical pixels. The caller debounces refinement for 100 ms. */
export function desiredLevel(
  scalePixelsPerBlock: number,
  previousLevel: number,
  maxLevel = MAX_LEVEL,
): number {
  if (!Number.isFinite(scalePixelsPerBlock) || scalePixelsPerBlock <= 0)
    throw new RangeError(
      "Physical pixels per block must be positive and finite",
    );
  validateLevel(previousLevel);
  validateLevel(maxLevel);
  let level = Math.min(previousLevel, maxLevel);
  while (level > 0 && scalePixelsPerBlock * 2 ** level > REFINE_SAMPLE_PIXELS)
    level--;
  while (
    level < maxLevel &&
    scalePixelsPerBlock * 2 ** level < COARSEN_SAMPLE_PIXELS
  )
    level++;
  return level;
}

export interface TileByteEstimate {
  surfaceBytes: number;
  pickBytes: number;
  shadeBytes: number;
  heightBytes: number;
  totalBytes: number;
}

/** Resident resources only; transient decode/copy work needs its own reservation. */
export function estimateTileBytes(level: number): TileByteEstimate {
  validateLevel(level);
  const surfaceBytes = level === 0 ? 524_288 : 393_216;
  // Two CPU words per cell, including packed mean/min and max/flags for summaries.
  const pickBytes = 131_072;
  const shadeBytes = level === 0 ? 0 : 67_600;
  const heightBytes = level === 0 ? 87_380 : 152_916;
  return {
    surfaceBytes,
    pickBytes,
    shadeBytes,
    heightBytes,
    totalBytes: surfaceBytes + pickBytes + shadeBytes + heightBytes,
  };
}

/** Clip first, then align outwards to target tiles without changing the camera. */
export function viewTargetBounds(
  view: View,
  bounds: readonly number[],
  level = 0,
): Bounds | null {
  const span = tileSpan(level);
  const visible = intersection(
    [view.left, view.top, view.right, view.bottom],
    bounds,
  );
  if (!visible) return null;
  return intersection(
    [
      Math.floor(visible[0] / span) * span,
      Math.floor(visible[1] / span) * span,
      Math.ceil(visible[2] / span) * span,
      Math.ceil(visible[3] / span) * span,
    ],
    bounds,
  );
}

/**
 * Sweep the visible receiver bounds toward the sun, then add one L0 neighbor.
 * Global encoded height extrema are sixteenths of a block; angles are degrees,
 * NOAA north-zero clockwise (east +X, north -Z). At zero elevation, a nonflat
 * range conservatively reaches the dataset edge in each up-sun direction.
 */
export function shadowBounds(
  view: View,
  bounds: readonly number[],
  heightRange: readonly number[],
  elevation: number,
  azimuth: number,
): Bounds | null {
  validateBounds(bounds);
  if (
    heightRange.length !== 2 ||
    !heightRange.every(Number.isFinite) ||
    heightRange[0] > heightRange[1]
  )
    throw new RangeError("Invalid encoded global height range");
  if (
    !Number.isFinite(elevation) ||
    elevation < 0 ||
    elevation > 90 ||
    !Number.isFinite(azimuth)
  )
    throw new RangeError(
      "Sun elevation must be 0..90 and azimuth must be finite",
    );
  const visible = intersection(
    [view.left, view.top, view.right, view.bottom],
    bounds,
  );
  if (!visible) return null;
  const height = (heightRange[1] - heightRange[0]) / 16;
  if (!Number.isFinite(height)) throw new RangeError("Height range overflow");
  const reach =
    height === 0 || elevation === 90
      ? 0
      : height / Math.tan((elevation * Math.PI) / 180);
  let degrees = azimuth % 360;
  if (degrees < 0) degrees += 360;
  const bearing = (degrees * Math.PI) / 180;
  const cardinal = degrees % 90 === 0 ? (degrees / 90) % 4 : null;
  const east = cardinal === null ? Math.sin(bearing) : [0, 1, 0, -1][cardinal];
  const north =
    cardinal === null ? -Math.cos(bearing) : [-1, 0, 1, 0][cardinal];
  const project = (direction: number, extent: number) => {
    if (direction === 0 || reach === 0) return 0;
    const offset =
      Math.sign(direction) * Math.min(extent, Math.abs(direction) * reach);
    const rounded = Math.round(offset);
    // Suppress trig roundoff at exact block edges before outward tile alignment.
    return Math.abs(offset - rounded) <=
      8 * Number.EPSILON * Math.max(1, Math.abs(offset))
      ? rounded
      : offset;
  };
  const dx = project(east, bounds[2] - bounds[0]);
  const dz = project(north, bounds[3] - bounds[1]);
  return viewTargetBounds(
    {
      left: visible[0] + Math.min(0, dx) - TILE_SIZE,
      top: visible[1] + Math.min(0, dz) - TILE_SIZE,
      right: visible[2] + Math.max(0, dx) + TILE_SIZE,
      bottom: visible[3] + Math.max(0, dz) + TILE_SIZE,
    },
    bounds,
  );
}

function edgeNeighbors(a: Bounds, b: Bounds): boolean {
  return (
    ((a[2] === b[0] || a[0] === b[2]) &&
      Math.max(a[1], b[1]) < Math.min(a[3], b[3])) ||
    ((a[3] === b[1] || a[1] === b[3]) &&
      Math.max(a[0], b[0]) < Math.min(a[2], b[2]))
  );
}

/**
 * Refine a common-level root forest breadth-first where the cap admits all
 * visible children and edge neighbors differ by at most one level (2:1).
 * Budget pressure leaves covering parents, never alters view bounds.
 */
export function selectCut(
  roots: readonly TileKey[],
  targetBounds: readonly number[],
  targetLevel: number,
  maxTiles: number,
): TileKey[] {
  validateBounds(targetBounds);
  validateLevel(targetLevel);
  if (!Number.isSafeInteger(maxTiles) || maxTiles < 0)
    throw new RangeError("Invalid cut tile cap");
  if (roots.length > 4)
    throw new RangeError("A root forest contains at most four tiles");
  const boxes = roots.map(tileBounds);
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++)
      if (intersects(boxes[i], boxes[j]))
        throw new RangeError("Cut roots must not overlap");
  if (roots.some((root) => root.level !== roots[0].level))
    throw new RangeError("Cut roots must use a common level");
  const cut = roots
    .filter((tile) => intersects(tileBounds(tile), targetBounds))
    .map((tile) => ({ ...tile }));
  if (cut.length > maxTiles)
    throw new RangeError("Cut tile cap cannot contain the visible roots");
  let changed: boolean;
  do {
    changed = false;
    for (let i = 0; i < cut.length; i++) {
      const tile = cut[i];
      if (tile.level <= targetLevel) continue;
      const children = childTiles(tile).filter((child) =>
        intersects(tileBounds(child), targetBounds),
      );
      if (cut.length - 1 + children.length > maxTiles) continue;
      const unbalanced = children.some((child) => {
        const box = tileBounds(child);
        return cut.some(
          (neighbor, j) =>
            j !== i &&
            Math.abs(child.level - neighbor.level) > 1 &&
            edgeNeighbors(box, tileBounds(neighbor)),
        );
      });
      if (unbalanced) continue;
      cut.splice(i, 1);
      cut.push(...children);
      changed = true;
      i--;
    }
    // A previously blocked tile can refine once its coarser neighbor catches up.
  } while (changed);
  return cut;
}
