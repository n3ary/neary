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
import { minSinceMidnightInTz } from './pipeline/timeUtils';
import {
  DEFAULT_FEED_SPEED_CONFIG,
  type FeedSpeedConfig,
} from './speedCascade';
import {
  clockToBucket,
  DEFAULT_TOD_PROFILE,
  type TodProfile,
} from './timeOfDay';

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

export type GpsFreshness = 'fresh' | 'stale' | 'very-stale';

export interface GpsPredictedPosition extends PredictedPosition {
  /** How stale the GPS fix is at `nowMs`:
   *   - 'fresh':       < 3 min old; cascade extrapolation, marker UI
   *                    treats this as high-trust.
   *   - 'stale':       3–5 min old; same cascade walk, marker UI hints
   *                    at reduced trust (e.g. yellow border).
   *   - 'very-stale':  5–15 min old; same cascade walk, marker UI hints
   *                    at low trust (e.g. red border).
   *   - older than 15 min: predictor returns null — caller falls back
   *                    to schedule prediction or drops the marker. */
  freshness: GpsFreshness;
}

/** Optional cascade context for `predictPositionFromGps`. When omitted,
 *  the predictor uses the Cluj-tuned defaults and assumes UTC for
 *  computing the TOD bucket — fine for tests, but real callers should
 *  pass `{ timezone }` so peak/night windows align with the feed's
 *  local clock. */
export interface PredictPositionFromGpsContext {
  /** IANA timezone of the feed (e.g. 'Europe/Bucharest'). */
  timezone?: string;
  feedConfig?: FeedSpeedConfig;
  todProfile?: TodProfile;
}

/** Hard cap on how far forward the dead-reckoner walks the bus per
 *  refresh tick. Sized for the worst-case 15-min very-stale window at
 *  the city-edge speed (≈45 km/h) — anything beyond that would risk
 *  the marker skating past the visible part of the route. The poly-
 *  line clamp in `pointAtDistance` still caps at the trip's total
 *  length. */
const MAX_DEAD_RECKON_M = 12_000;
const FRESH_MS = 3 * 60_000;
const STALE_MS = 5 * 60_000;
const VERY_STALE_MS = 15 * 60_000;
/** Reported speeds below this read as "stopped" — mirrors the speed
 *  cascade's STOPPED_KMH so a bus parked at a red light falls back
 *  to the TOD-bucket speed instead of dragging the marker to zero. */
const STOPPED_KMH = 5;

/** Result of dead-reckoning a GPS observation forward along a route
 *  shape. Both the map view's bus marker and the station view's ETA
 *  consume this same projection so the two pipelines can never
 *  disagree about where the bus currently is — same `(dtMs, kmh,
 *  forward)` math, same on-shape position, every render tick. */
export interface DeadReckonedAlongShape {
  /** Dead-reckoned position projected back onto the shape. */
  position: LatLon;
  /** Distance along the polyline from origin, in metres. */
  distAlongM: number;
  /** Wall-clock delta from the GPS fix to `nowMs`. */
  dtMs: number;
  freshness: GpsFreshness;
}

/** Project a GPS observation onto a measured polyline, then walk
 *  forward along the polyline by `(nowMs − obs.asOfMs) × speed`. Speed
 *  picked by the cascade: the vehicle's own speed when moving, the
 *  TOD-bucket speed when parked (red light, stop dwell).
 *
 *  Returns `null` when the fix is older than `VERY_STALE_MS` — at that
 *  point the prediction is too noisy to trust. The map view hides the
 *  marker; `applyGpsEta` in `stationBoard.ts` falls back to the row's
 *  schedule-only ETA. Without this consistency the station view kept
 *  treating a stale-fix vehicle as "still approaching" while the map
 *  had already extrapolated it past the stop (issue #86). */
export function deadReckonGpsAlongShape(
  obs: GpsObservation,
  measured: MeasuredPolyline,
  nowMs: number,
  ctx: PredictPositionFromGpsContext = {},
): DeadReckonedAlongShape | null {
  const dt = nowMs - obs.asOfMs;
  if (dt > VERY_STALE_MS) return null;
  if (measured.points.length < 2) return null;
  const proj = projectOnPolyline(
    { lat: obs.lat, lon: obs.lon },
    measured.points,
  );
  const freshness: GpsFreshness =
    dt < FRESH_MS ? 'fresh' : dt < STALE_MS ? 'stale' : 'very-stale';
  const kmh = pickWalkKmh(obs, ctx, nowMs);
  const speedMs = (kmh * 1000) / 3600;
  const forward = Math.min(
    MAX_DEAD_RECKON_M,
    (speedMs * Math.max(0, dt)) / 1000,
  );
  const distAlongM = Math.min(measured.totalDistM, proj.distAlongM + forward);
  const p = pointAtDistance(measured, distAlongM);
  return { position: p, distAlongM, dtMs: dt, freshness };
}

/**
 * Position from live GPS, dead-reckoned forward along the trip's shape.
 *
 * Thin wrapper over `deadReckonGpsAlongShape` — same physics, just the
 * map-marker-shaped output. Returns `null` when the fix is too stale
 * to project (mirrors the helper's contract).
 *
 * Freshness bands let the UI hint at trust:
 *   - 'fresh' (< 3 min):       high trust.
 *   - 'stale' (3–5 min):       reduced trust.
 *   - 'very-stale' (5–15 min): low trust.
 *   - older than 15 min:       returns `null` (caller falls back).
 */
export function predictPositionFromGps(
  plan: TripShapePlan,
  obs: GpsObservation,
  nowMs: number,
  ctx: PredictPositionFromGpsContext = {},
): GpsPredictedPosition | null {
  const result = deadReckonGpsAlongShape(obs, plan.measured, nowMs, ctx);
  if (!result) return null;
  return {
    lat: result.position.lat,
    lon: result.position.lon,
    status: 'active',
    freshness: result.freshness,
  };
}

function pickWalkKmh(
  obs: GpsObservation,
  ctx: PredictPositionFromGpsContext,
  nowMs: number,
): number {
  if (obs.speedMs != null && obs.speedMs * 3.6 > STOPPED_KMH) {
    return obs.speedMs * 3.6;
  }
  const cfg = ctx.feedConfig ?? DEFAULT_FEED_SPEED_CONFIG;
  const tz = ctx.timezone ?? 'UTC';
  const profile = ctx.todProfile ?? DEFAULT_TOD_PROFILE;
  const bucket = clockToBucket(minSinceMidnightInTz(nowMs, tz), profile);
  switch (bucket) {
    case 'peak': return cfg.kmh_peak;
    case 'night': return cfg.kmh_night;
    case 'offpeak': default: return cfg.kmh_offpeak;
  }
}
