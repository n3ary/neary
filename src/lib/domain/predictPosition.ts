// Predict a vehicle's current position from its trip's stop timeline. Two flavors: straight-line and shape-aware.

import {
  measurePolyline,
  pointAtDistance,
  projectOnPolyline,
  type LatLon,
  type MeasuredPolyline,
  type Polyline,
} from '@n3ary/gtfs-spec/shape';
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
  /** Minutes since local midnight. GTFS extended time allowed (24h+ for past-midnight night routes). */
  arrivalMin: number;
  /** Pre-computed distance along the trip's shape from origin to this stop, in metres. When present, `buildTripShapePlan` reads it directly instead of projecting on the client. Populated by feeds whose stop_times.shape_dist_traveled is non-null at build time. */
  distAlongM?: number;
}

export type TripStatus = 'before' | 'at-origin' | 'active' | 'after';

export interface PredictedPosition {
  lat: number;
  lon: number;
  status: TripStatus;
}

/** A vehicle inside this many minutes of its origin departure counts as 'at-origin' rather than 'before'. Mirrors the UI convention of `imminentEtaThresholdMin`. */
export const DEFAULT_IMMINENT_MIN = 5;

/** Linear interpolation between consecutive stops. Returns null only when stops is empty. */
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

/** Precomputed per-trip data for `predictPositionOnShape`. Build once at mount; per-tick work is a binary search + interpolation. */
export interface TripShapePlan {
  measured: MeasuredPolyline;
  /** Same length + order as stops. arrivalMin = schedule; distAlongM = stop's position projected onto the shape. */
  legs: Array<{ arrivalMin: number; distAlongM: number }>;
}

/** Build a TripShapePlan. Fast path when every stop carries distAlongM (skips per-stop projection, O(stops)); otherwise project every stop. Returns null when no usable shape exists. */
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
  // Doubled-back shapes (same trace for both directions) project out-of-order; the time-based bracket below uses arrivalMin, so a non-monotonic legs[] still interpolates sensibly.
  return { measured, legs };
}

/** Shape-aware variant of predictPosition. Same status semantics. */
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
  /** Vehicle speed in m/s. null skips extrapolation — position falls back to the last GPS fix snapped onto the shape. */
  speedMs: number | null;
  /** Unix ms when the GPS fix was reported by the upstream feed. */
  asOfMs: number;
}

export type GpsFreshness = 'fresh' | 'stale' | 'very-stale';

export interface GpsPredictedPosition extends PredictedPosition {
  /** 'fresh' < 3 min = high trust; 'stale' 3-5 min = reduced; 'very-stale' 5-15 min = low. Older than 15 min: predictor returns null. */
  freshness: GpsFreshness;
}

/** Optional context for `predictPositionFromGps`. Real callers should pass `{ timezone }` so peak/night windows align with the feed's local clock. */
export interface PredictPositionFromGpsContext {
  /** IANA timezone of the feed (e.g. 'Europe/Bucharest'). */
  timezone?: string;
  feedConfig?: FeedSpeedConfig;
  todProfile?: TodProfile;
}

// Sized for the worst-case 15-min very-stale window at the city-edge speed (~45 km/h). Beyond this, the marker would skate past the visible route. `pointAtDistance` still clamps at the trip's total length.
const MAX_DEAD_RECKON_M = 12_000;
const FRESH_MS = 3 * 60_000;
const STALE_MS = 5 * 60_000;
const VERY_STALE_MS = 15 * 60_000;

// Mirrors speedCascade.STOPPED_KMH so a parked bus falls back to the TOD-bucket speed instead of dragging the marker to zero.
const STOPPED_KMH = 5;

/** Result of dead-reckoning a GPS observation forward along the route shape. Same projection for map + station so they can never disagree about where the bus is right now. */
export interface DeadReckonedAlongShape {
  position: LatLon;
  /** Distance along the polyline from origin, in metres. */
  distAlongM: number;
  /** Wall-clock delta from GPS fix to nowMs. */
  dtMs: number;
  freshness: GpsFreshness;
}

/** Project GPS onto polyline, then walk forward by (nowMs - obs.asOfMs) * cascade speed. Returns null when fix is older than VERY_STALE_MS — at that point prediction is too noisy to trust. */
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

/** Position from live GPS, dead-reckoned forward. Thin wrapper over `deadReckonGpsAlongShape` with map-marker-shaped output. Returns null when fix is too stale to project. */
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
