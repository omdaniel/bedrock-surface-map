export const MAP_CACHE_BYTES = 256 * 1024 * 1024;
export const REGION_GPU_BYTES = 65536 * 32 + 349524;
export const REGION_BYTES = REGION_GPU_BYTES + 65536 * 8;
// Keep working room for one decoder, height-window replacement and uploads.
export const WORKING_BYTES = 32 * 1024 * 1024;
export type SurfaceStride = 1 | 2 | 4;

export function regionGpuBytes(stride: number) {
  const side = 256 / stride;
  let texture = 0;
  for (let n = side; n >= 1; n /= 2) texture += n * n * 4;
  return side * side * 32 + texture;
}
export function regionBytes(stride: number) {
  return regionGpuBytes(stride) + (65536 * 8) / (stride * stride);
}
export function scaleBarBlocks(scale: number) {
  const maxBlocks = 100 / scale;
  const power = 10 ** Math.floor(Math.log10(maxBlocks));
  return (
    [5, 2, 1].map((v) => v * power).find((v) => v <= maxBlocks) ?? power / 2
  );
}

/** Select a single planar resolution without moving the camera. */
export function chooseStride(
  scale: number,
  fits: (stride: SurfaceStride) => boolean,
): SurfaceStride {
  const candidates: SurfaceStride[] =
    scaleBarBlocks(scale) > 100 ? [2, 4] : [1, 2, 4];
  return candidates.find(fits) ?? 4;
}

export function heightWindowBytes(bounds: number[], stride = 1) {
  let width = (bounds[2] - bounds[0]) / stride,
    height = (bounds[3] - bounds[1]) / stride;
  const columns = width * height;
  if (
    bounds.length !== 4 ||
    ![1, 2, 4].includes(stride) ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    columns > 16 * 1024 * 1024
  )
    return Infinity;
  // GPU maximum pyramid plus compact CPU source pages. The pyramid has no CPU copy.
  let words = 128;
  for (;;) {
    words += width * height;
    if (width === 1 && height === 1) break;
    width = Math.ceil(width / 2);
    height = Math.ceil(height / 2);
  }
  return words * 4 + columns * 2;
}
