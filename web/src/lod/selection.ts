export const TILE_SIZE = 128;
export const MAX_LEVEL = 16;
export const MAX_COORDINATE = 8_388_608;
export const REFINE_SAMPLE_PIXELS = 3;
export const COARSEN_SAMPLE_PIXELS = 1;

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

/** Hysteresis in physical pixels. */
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
  neighborMargin = TILE_SIZE,
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
  if (!Number.isSafeInteger(neighborMargin) || neighborMargin < 1)
    throw new RangeError("Invalid shadow neighbor margin");
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
      left: visible[0] + Math.min(0, dx) - neighborMargin,
      top: visible[1] + Math.min(0, dz) - neighborMargin,
      right: visible[2] + Math.max(0, dx) + neighborMargin,
      bottom: visible[3] + Math.max(0, dz) + neighborMargin,
    },
    bounds,
  );
}
