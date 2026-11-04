import { planDemand, type DemandPlan } from "./demand.ts";
import { planHeightWindow, type HeightPlan } from "./heights.ts";
import {
  MAX_COORDINATE,
  desiredLevel,
  intersection,
  tileSpan,
  type Bounds,
  type View,
} from "./selection.ts";

export interface ViewDemand {
  view: View;
  /** Physical pixels per world block. */
  scale: number;
  elevation: number;
  azimuth: number;
}

export interface ViewPlan {
  level: number;
  plan: DemandPlan;
  /** Null only when the viewport does not intersect the dataset. */
  height: HeightPlan | null;
}

export interface ViewPlanOptions {
  maxTiles?: number;
  maxHeightSamples?: number;
  marginScreens?: number;
  lookaheadSeconds?: number;
}

interface Candidate {
  area: Bounds;
  height: HeightPlan;
}

const SEARCH_STEPS = 8;

/** Preserve pixel-selected detail before spending budget on speculative decode
 * and GPU residency. The compressed hierarchy's local retention is independent.
 *
 * Try the requested guard/lookahead, then shorten lookahead, shrink the guard
 * towards one tile on each side, and finally shrink that ring towards visible
 * only. Coarsen only when the WHOLE visible tiles plus their unchanged sun halo
 * cannot fit. Every returned buffer is complete and has its full height coverage.
 * No camera or lighting input is modified. Empty/off-world views return no work;
 * impossible visible coverage at maxLevel throws rather than dropping its halo.
 */
export function planView(
  demand: ViewDemand,
  bounds: Bounds,
  heightRange: readonly [number, number],
  previousLevel: number,
  maxLevel: number,
  velocity: { x: number; z: number } = { x: 0, z: 0 },
  options: ViewPlanOptions = {},
): ViewPlan {
  const requestedLevel = desiredLevel(demand.scale, previousLevel, maxLevel);
  const maxTiles = options.maxTiles ?? 120;
  const maxHeightSamples = options.maxHeightSamples ?? 2 * 1024 * 1024;
  const margin = options.marginScreens ?? 0.5;
  const lookahead = options.lookaheadSeconds ?? 0.75;
  if (
    !Number.isSafeInteger(maxTiles) ||
    maxTiles < 1 ||
    maxTiles > 4096 ||
    !Number.isSafeInteger(maxHeightSamples) ||
    maxHeightSamples < 1 ||
    maxHeightSamples > 16 * 1024 * 1024 ||
    !Number.isFinite(margin) ||
    margin < 0 ||
    margin > 2 ||
    !Number.isFinite(lookahead) ||
    lookahead < 0 ||
    lookahead > 2 ||
    !Number.isFinite(velocity.x) ||
    !Number.isFinite(velocity.z)
  )
    throw new RangeError("Invalid view-planning limits or velocity");
  if (
    bounds.length !== 4 ||
    !bounds.every(
      (v) => Number.isSafeInteger(v) && Math.abs(v) <= MAX_COORDINATE,
    )
  )
    throw new RangeError("Dataset bounds must be integer world coordinates");
  if (
    heightRange.length !== 2 ||
    !heightRange.every(
      (v) => Number.isSafeInteger(v) && v >= -32767 && v <= 32767,
    ) ||
    heightRange[0] > heightRange[1]
  )
    throw new RangeError("Invalid encoded global height range");
  if (
    !Number.isFinite(demand.elevation) ||
    demand.elevation < 0 ||
    demand.elevation > 90 ||
    !Number.isFinite(demand.azimuth)
  )
    throw new RangeError("Invalid sunlight settings");
  const { view } = demand;
  const raw: Bounds = [view.left, view.top, view.right, view.bottom];
  const visible = intersection(raw, bounds);
  const requested = {
    maxTiles,
    marginScreens: margin,
    lookaheadSeconds: lookahead,
    velocity,
  };
  if (!visible)
    return {
      level: requestedLevel,
      plan: planDemand(view, bounds, requestedLevel, requested),
      height: null,
    };

  const width = view.right - view.left;
  const height = view.bottom - view.top;
  for (let level = requestedLevel; level <= maxLevel; level++) {
    const span = tileSpan(level);
    const fit = (area: Bounds | null): Candidate | null => {
      if (!area) return null;
      const whole: Bounds = [
        Math.floor(area[0] / span) * span,
        Math.floor(area[1] / span) * span,
        Math.ceil(area[2] / span) * span,
        Math.ceil(area[3] / span) * span,
      ];
      const count =
        ((whole[2] - whole[0]) / span) * ((whole[3] - whole[1]) / span);
      // Reject oversized grids before enumerating ANY surface or height keys.
      if (!Number.isSafeInteger(count) || count > maxTiles) return null;
      const heights = planHeightWindow(
        whole,
        bounds,
        heightRange,
        level,
        demand.elevation,
        demand.azimuth,
        maxHeightSamples,
      );
      return heights ? { area, height: heights } : null;
    };
    const guard = (screens: number, seconds: number, tileMargin = 1) => {
      const mx = Math.max(span * tileMargin, width * screens);
      const mz = Math.max(span * tileMargin, height * screens);
      const clamp = (v: number, extent: number) =>
        Math.max(-extent, Math.min(extent, v));
      const dx = clamp(velocity.x * seconds, Math.max(width, span));
      const dz = clamp(velocity.z * seconds, Math.max(height, span));
      return intersection(
        [
          raw[0] - mx + Math.min(0, dx),
          raw[1] - mz + Math.min(0, dz),
          raw[2] + mx + Math.max(0, dx),
          raw[3] + mz + Math.max(0, dz),
        ],
        bounds,
      );
    };
    const finish = (candidate: Candidate): ViewPlan => ({
      level,
      // Clip speculative demand to the accepted rectangle. This also allows a
      // sub-tile/no guard despite planDemand's usual one-tile minimum margin.
      plan: planDemand(view, candidate.area, level, requested),
      height: candidate.height,
    });
    const grow = (
      best: Candidate,
      limit: number,
      trial: (amount: number) => Bounds | null,
    ) => {
      let lo = 0,
        hi = limit;
      for (let i = 0; i < SEARCH_STEPS; i++) {
        const mid = (lo + hi) / 2;
        const candidate = fit(trial(mid));
        if (candidate) {
          best = candidate;
          lo = mid;
        } else hi = mid;
      }
      return best;
    };

    const minimum = fit(visible);
    if (!minimum) continue;
    const full = fit(guard(margin, lookahead));
    if (full) return finish(full);
    const symmetric = fit(guard(margin, 0));
    if (symmetric)
      return finish(
        grow(symmetric, lookahead, (seconds) => guard(margin, seconds)),
      );
    const ring = fit(guard(0, 0));
    if (ring) return finish(grow(ring, margin, (screens) => guard(screens, 0)));
    return finish(grow(minimum, 1, (fraction) => guard(0, 0, fraction)));
  }
  throw new RangeError(
    "Visible terrain and its full shadow footprint do not fit the view-planning limits",
  );
}
