export const MAP_CACHE_BYTES = 256 * 1024 * 1024;
export const REGION_GPU_BYTES = 65536 * 32 + 349524;
export const REGION_BYTES = REGION_GPU_BYTES + 65536 * 8;

export function heightWindowBytes(bounds: number[]) {
  let width = bounds[2] - bounds[0],
    height = bounds[3] - bounds[1];
  const columns = width * height;
  if (
    bounds.length !== 4 ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    columns > 16 * 1024 * 1024
  )
    return Infinity;
  // Mirror surface_core::height_pyramid: CPU + GPU trees and compact source pages.
  let words = 128;
  for (;;) {
    words += width * height;
    if (width === 1 && height === 1) break;
    width = Math.ceil(width / 2);
    height = Math.ceil(height / 2);
  }
  return words * 8 + columns * 2;
}
