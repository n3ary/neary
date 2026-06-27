/*
 * Predict a vehicle's current position from its trip's stop timeline.
 *
 * Two flavors:
 *
 *   `predictPosition(stops, nowMin)` — straight-line interpolation
 *   between consecutive stops. Falls back well when the feed doesn't
 *   carry shapes.txt.
 *
 *   `predictPositionOnShape(plan, nowMin)` — interpolates along the
 *   route's polyline using cumulative distances, so the marker
 *   follows the road instead of cutting through buildings. Use
 *   whenever a shape is available; build the `TripShapePlan` once
 *   per trip+shape pair with `buildTripShapePlan` and reuse across
 *   every render tick.
 *
 * Status values let the UI hide / dim a vehicle without re-deriving:
 *   - 'before':   nowMin < origin departure — bus hasn't started yet.
 *   - 'at-origin': nowMin in [origin - imminentMin, origin departure]
 *                  — coming up at the start station.
 *   - 'active':   between origin departure and terminus arrival.
 *   - 'after':    past terminus.
 *
 * Live GPS hasn't been wired through this helper yet — when it is,
 * the reconciler will short-circuit prediction with the GPS fix.
 */

import {
  measurePolyline,
  pointAtDistance,
  projectOnPolyline,
  type LatLon,
  type MeasuredPolyline,
  type Polyline,
} from './shapeProjection';

export interface PredictStop {
  lat: number;
  lon: number;
  /** Minutes since local midnight (GTFS extended time allowed,
   *  i.e. 24h+ for past-midnight night routes). */
  arrivalMin: number;
  /** Optional pre-computed distance along the trip's shape from origin
   *  to this stop, in metres. When present, `buildTripShapePlan` reads
   *  it directly instead of projecting on the client. Populated by feeds
   *  whose `stop_times.shape_dist_traveled` is non-null at build time. */
  distAlongM?: number;
}

export type TripStatus = 'before' | 'at-origin' | 'active' | 'after';

export interface PredictedPosition {
  lat: number;
  lon: number;
  status: TripStatus;
}

/** Default 'imminent' window — a vehicle inside this many minutes of
 *  its origin departure counts as 'at-origin' rather than 'before'.
 *  Matches the existing UI convention of "imminentEtaThresholdMin". */
export const DEFAULT_IMMINENT_MIN = 5;

/**
 * Pick the position to render for a vehicle on a known trip.
 * Returns `null` only when the trip has no stops at all — every
 * other case yields a position + status.
 *
 * Straight-line variant: the position between two stops lies on the
 * direct segment between their coordinates. Acceptable when no shape
 * is available; prefer `predictPositionOnShape` when the feed does
 * have shapes.txt for the route.
 */
export function predictPosition(
  stops: readonly PredictStop[],
  nowMin: number,
  imminentMin: number = DEFAULT_IMMINENT_MIN,
): PredictedPosition | null {
  if (stops.length === 0) return null;
  const origin = stops[0];
  const terminus = stops[stops.length - 1];

  if (nowMin < origin.arrivalMin) {
    const status: TripStatus =
      origin.arrivalMin - nowMin <= imminentMin ? 'at-origin' : 'before';
    return { lat: origin.lat, lon: origin.lon, status };
  }
  if (nowMin >= terminus.arrivalMin) {
    return { lat: terminus.lat, lon: terminus.lon, status: 'after' };
  }

  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (nowMin >= a.arrivalMin && nowMin < b.arrivalMin) {
      const span = b.arrivalMin - a.arrivalMin;
      const t = span > 0 ? (nowMin - a.arrivalMin) / span : 0;
      return {
        lat: a.lat + (b.lat - a.lat) * t,
        lon: a.lon + (b.lon - a.lon) * t,
        status: 'active',
      };
    }
  }
  return { lat: terminus.lat, lon: terminus.lon, status: 'active' };
}

/** Precomputed per-trip data used by `predictPositionOnShape`.
 *  Build once when the route's shape + stops arrive (mount-time);
 *  the only per-tick work is then a binary search + an interpolation. */
export interface TripShapePlan {
  /** Polyline + cumulative distances. */
  measured: MeasuredPolyline;
  /** One entry per stop in `stops`, same length and order.
   *  `arrivalMin` carries the schedule; `distAlongM` is the stop's
   *  position projected onto the shape. */
  legs: Array<{ arrivalMin: number; distAlongM: number }>;
}

/** Build a `TripShapePlan` for a trip.
 *
 *  Fast path (preferred): when every `PredictStop` carries
 *  `distAlongM` (populated at build time from
 *  `stop_times.shape_dist_traveled`), the per-stop polyline projection
 *  is skipped entirely — page load drops from O(stops × shape segments)
 *  to O(stops).
 *
 *  Fallback: when any stop is missing `distAlongM`, project every stop
 *  onto the shape (today's behaviour). Mixed presence falls back to
 *  projection so consumers see consistent data within a single plan.
 *
 *  Returns `null` when no usable shape exists — caller should fall
 *  back to `predictPosition`. */
export function buildTripShapePlan(
  stops: readonly PredictStop[],
  shape: Polyline,
): TripShapePlan | null {
  if (stops.length === 0 || shape.length < 2) return null;
  const measured = measurePolyline(shape);
  const everyStopHasDist = stops.every((s) => typeof s.distAlongM === 'number');
  const legs = everyStopHasDist
    ? stops.map((s) => ({ arrivalMin: s.arrivalMin, distAlongM: s.distAlongM as number }))
    : stops.map((s) => {
        const proj = projectOnPolyline({ lat: s.lat, lon: s.lon } as LatLon, shape);
        return { arrivalMin: s.arrivalMin, distAlongM: proj.distAlongM };
      });
  // Stops projected onto a doubled-back shape (rare but possible
  // when an operator publishes the same trace for both directions)
  // can land out of order. Ignore that here — the time-based bracket
  // below uses arrivalMin, not distAlongM, so a non-monotonic legs[]
  // array still produces sensible interpolation.
  return { measured, legs };
}

/** Shape-aware variant of `predictPosition`. Same status semantics. */
export function predictPositionOnShape(
  plan: TripShapePlan,
  nowMin: number,
  imminentMin: number = DEFAULT_IMMINENT_MIN,
): PredictedPosition | null {
  const { legs, measured } = plan;
  if (legs.length === 0) return null;
  const origin = legs[0];
  const terminus = legs[legs.length - 1];

  const originPoint = pointAtDistance(measured, origin.distAlongM);
  if (nowMin < origin.arrivalMin) {
    const status: TripStatus =
      origin.arrivalMin - nowMin <= imminentMin ? 'at-origin' : 'before';
    return { lat: originPoint.lat, lon: originPoint.lon, status };
  }
  if (nowMin >= terminus.arrivalMin) {
    const p = pointAtDistance(measured, terminus.distAlongM);
    return { lat: p.lat, lon: p.lon, status: 'after' };
  }

  for (let i = 0; i < legs.length - 1; i++) {
    const a = legs[i];
    const b = legs[i + 1];
    if (nowMin >= a.arrivalMin && nowMin < b.arrivalMin) {
      const span = b.arrivalMin - a.arrivalMin;
      const t = span > 0 ? (nowMin - a.arrivalMin) / span : 0;
      const distAlongM = a.distAlongM + (b.distAlongM - a.distAlongM) * t;
      const p = pointAtDistance(measured, distAlongM);
      return { lat: p.lat, lon: p.lon, status: 'active' };
    }
  }
  const p = pointAtDistance(measured, terminus.distAlongM);
  return { lat: p.lat, lon: p.lon, status: 'active' };
}

/** GPS observation used to anchor dead-reckoning. */
export interface GpsObservation {
  lat: number;
  lon: number;
  /** Vehicle speed in m/s. `null` skips extrapolation — position falls
   *  back to the last known GPS fix snapped onto the shape. */
  speedMs: number | null;
  /** Unix ms when the GPS fix was reported by the upstream feed. */
  asOfMs: number;
}

export type GpsFreshness = 'fresh' | 'stale' | 'expired';

export interface GpsPredictedPosition extends PredictedPosition {
  /** How stale the GPS fix is at `nowMs`:
   *   - 'fresh':  < 2 min old; full dead-reckoning trusted.
   *   - 'stale':  2–5 min old; position is the snapped GPS fix
   *               (no extrapolation), UI should hint at lower confidence.
   *   - 'expired': > 5 min old; caller should fall back to schedule
   *                (this helper returns null instead). */
  freshness: GpsFreshness;
}

/** Hard cap on how far forward the dead-reckoner walks the bus per
 *  refresh tick. Caps a 10 m/s × 5 min worst case at 3 km regardless
 *  of the actual interval, so a stale-but-not-expired fix can't fly the
 *  marker off the visible part of the route. */
const MAX_DEAD_RECKON_M = 3000;
const FRESH_MS = 2 * 60_000;
const EXPIRE_MS = 5 * 60_000;

/**
 * Position from live GPS, dead-reckoned forward along the trip's shape.
 *
 * Why: the reconciler matches a live observation to a scheduled trip, but
 * the observation is a snapshot — between polls the marker shouldn't sit
 * still. Project the GPS fix onto the shape, then walk `speed × dt` metres
 * along the polyline so the marker glides until the next observation lands.
 *
 * Returns `null` when the fix is older than `EXPIRE_MS` (caller falls back
 * to the schedule predictor) or when the projection fails.
 */
export function predictPositionFromGps(
  plan: TripShapePlan,
  obs: GpsObservation,
  nowMs: number,
): GpsPredictedPosition | null {
  const dt = nowMs - obs.asOfMs;
  if (dt > EXPIRE_MS) return null;
  if (plan.measured.points.length < 2) return null;

  const proj = projectOnPolyline(
    { lat: obs.lat, lon: obs.lon },
    plan.measured.points,
  );

  const freshness: GpsFreshness =
    dt < FRESH_MS ? 'fresh' : 'stale';

  // 'stale' fixes skip dead-reckoning — the speed at the time of the fix
  // is too old to extrapolate from. Render the snapped point as-is.
  let distAlongM = proj.distAlongM;
  if (freshness === 'fresh' && obs.speedMs != null && obs.speedMs > 0) {
    const forward = Math.min(
      MAX_DEAD_RECKON_M,
      (obs.speedMs * Math.max(0, dt)) / 1000,
    );
    distAlongM = Math.min(plan.measured.totalDistM, proj.distAlongM + forward);
  }

  const p = pointAtDistance(plan.measured, distAlongM);
  return { lat: p.lat, lon: p.lon, status: 'active', freshness };
}
