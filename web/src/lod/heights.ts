import { planDemand } from "./demand.ts";
import {
  MAX_COORDINATE,
  TILE_SIZE,
  shadowBounds,
  tileBounds,
  tileId,
  tileSpan,
  type Bounds,
  type TileKey,
} from "./selection.ts";

export const MISSING_HEIGHT = -1_000_000;
const MAX_SAMPLES = 16 * 1024 * 1024;
const PAGE_SAMPLES = TILE_SIZE * TILE_SIZE;

export interface HeightPlan {
  /** Half-open world bounds, aligned outwards to complete height pages. */
  bounds: Bounds;
  level: number;
  stride: number;
  /** Sample counts, not world-block extents. */
  width: number;
  height: number;
  keys: TileKey[];
}

function validateBounds(bounds: Bounds): void {
  if (
    bounds.length !== 4 ||
    !bounds.every(
      (v) => Number.isSafeInteger(v) && Math.abs(v) <= MAX_COORDINATE,
    ) ||
    bounds[0] > bounds[2] ||
    bounds[1] > bounds[3]
  )
    throw new RangeError("Height bounds must be integer world coordinates");
}

/** Plan once for the union of buffered WHOLE surface tiles, not the viewport.
 * Encoded heightRange values are sixteenths of a block, as in the manifest.
 * Clip the sun halo to the dataset before outward page alignment, retaining
 * complete boundary-tile footprints needed by the renderer's fine eligibility.
 * No partial halo, implicit coarsening, or speculative demand is returned.
 */
export function planHeightWindow(
  surfaceBounds: Bounds,
  datasetBounds: Bounds,
  heightRange: readonly [number, number],
  level: number,
  elevation: number,
  azimuth: number,
  maxSamples = 1_048_576,
): HeightPlan | null {
  validateBounds(surfaceBounds);
  validateBounds(datasetBounds);
  const span = tileSpan(level);
  const stride = span / TILE_SIZE;
  if (
    !Number.isSafeInteger(maxSamples) ||
    maxSamples < 1 ||
    maxSamples > MAX_SAMPLES
  )
    throw new RangeError(
      "Height sample budget must be an integer from 1 through 16M",
    );
  if (
    heightRange.length !== 2 ||
    !heightRange.every(
      (v) => Number.isSafeInteger(v) && v >= -32767 && v <= 32767,
    )
  )
    throw new RangeError("Height range must contain encoded integer heights");
  const halo = shadowBounds(
    {
      left: surfaceBounds[0],
      top: surfaceBounds[1],
      right: surfaceBounds[2],
      bottom: surfaceBounds[3],
    },
    datasetBounds,
    heightRange,
    elevation,
    azimuth,
    stride,
  );
  if (!halo) return null;
  const bounds: Bounds = [
    Math.floor(halo[0] / span) * span,
    Math.floor(halo[1] / span) * span,
    Math.ceil(halo[2] / span) * span,
    Math.ceil(halo[3] / span) * span,
  ];
  validateBounds(bounds);
  const width = (bounds[2] - bounds[0]) / stride;
  const height = (bounds[3] - bounds[1]) / stride;
  const samples = width * height;
  // Bound both allocation and demand enumeration before generating any keys.
  if (!Number.isSafeInteger(samples) || samples > maxSamples) return null;
  const demand = planDemand(
    { left: bounds[0], top: bounds[1], right: bounds[2], bottom: bounds[3] },
    bounds,
    level,
    { maxTiles: samples / PAGE_SAMPLES, marginScreens: 0, lookaheadSeconds: 0 },
  );
  return {
    bounds,
    level,
    stride,
    width,
    height,
    keys: demand.tiles.map((tile) => tile.key),
  };
}

/** Assemble decoded means in row-major sample order. Null is an explicit absent
 * tree; an unrequested, failed, or pending page must remain undefined and throws.
 * Boundary pages already carry missing samples outside the dataset. Extra cached
 * pages are ignored. Inputs are validated before allocating the output window.
 */
export function buildHeightWindow(
  plan: HeightPlan,
  pages: ReadonlyMap<string, Float32Array | null>,
): Float32Array {
  validateBounds(plan.bounds);
  const span = tileSpan(plan.level);
  const { bounds, stride, width, height } = plan;
  if (
    stride !== span / TILE_SIZE ||
    !bounds.every((v) => v % span === 0) ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width !== (bounds[2] - bounds[0]) / stride ||
    height !== (bounds[3] - bounds[1]) / stride ||
    !Number.isSafeInteger(width * height) ||
    width * height > MAX_SAMPLES ||
    plan.keys.length !== (width * height) / PAGE_SAMPLES
  )
    throw new RangeError("Invalid height window plan dimensions or key count");
  const seen = new Set<string>();
  for (const key of plan.keys) {
    const box = tileBounds(key);
    const id = tileId(key);
    if (
      key.level !== plan.level ||
      seen.has(id) ||
      box[0] < bounds[0] ||
      box[1] < bounds[1] ||
      box[2] > bounds[2] ||
      box[3] > bounds[3]
    )
      throw new RangeError(
        "Height plan keys must uniquely cover the window at its level",
      );
    seen.add(id);
    const page = pages.get(id);
    if (page === undefined) throw new Error(`Incomplete height window: ${id}`);
    if (
      page !== null &&
      (!(page instanceof Float32Array) ||
        page.length !== PAGE_SAMPLES ||
        !page.every(Number.isFinite))
    )
      throw new RangeError(`Invalid height page: ${id}`);
  }
  const result = new Float32Array(width * height);
  result.fill(MISSING_HEIGHT);
  for (const key of plan.keys) {
    const page = pages.get(tileId(key))!;
    if (page === null) continue;
    // Divide signed WORLD offsets by the window stride exactly once. A coarse
    // page still contains 128 rows of 128 means, never 128*stride samples.
    const x = (key.x * span - bounds[0]) / stride;
    const z = (key.z * span - bounds[1]) / stride;
    for (let row = 0; row < TILE_SIZE; row++)
      result.set(
        page.subarray(row * TILE_SIZE, (row + 1) * TILE_SIZE),
        (z + row) * width + x,
      );
  }
  return result;
}

/** A larger resident window can satisfy a new plan only at the same level. */
export function coversPlan(
  current: HeightPlan | null | undefined,
  next: HeightPlan | null | undefined,
): boolean {
  return (
    !!current &&
    !!next &&
    current.level === next.level &&
    current.bounds[0] <= next.bounds[0] &&
    current.bounds[1] <= next.bounds[1] &&
    current.bounds[2] >= next.bounds[2] &&
    current.bounds[3] >= next.bounds[3]
  );
}
