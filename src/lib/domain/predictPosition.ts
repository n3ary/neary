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

// The dead-reckon walk has a SPEED horizon, not a hard time cap.
// OBSERVED_WALK_MS (~6 live polls) trusts the fix's own speed for
// marker smoothing; beyond it the walk continues at the TOD-bucket
// speed — the expected trajectory, GPS-anchored — because feed
// glitches routinely last minutes, and holding position would show
// stale-high ETAs during the silence, then jump on recovery. The
// walk is dwell-aware (crossed stops cost dwell seconds), so the
// distance it covers tracks what a typical bus actually drives.
// MAX_WALK_M is a defensive ceiling for glitch speeds (~15 min of
// effective TOD-with-dwells is ≈ 3.5 km); `pointAtDistance` still
// clamps at the trip's total length.
const OBSERVED_WALK_MS = 90_000;
const MAX_WALK_M = 5_000;
// An observed stop (speed ≈ 0) is trusted for about one dwell cycle
// (~3 polls): dwells run 10–40 s, so within the hold the bus is
// almost certainly still there. Past it the report is obsolete —
// the bus has likely left — and the TOD walk resumes for the time
// since the hold. Bounds both failure modes: fresh dwellers don't
// skate past their stop, departed buses don't linger as 'arriving
// now' either.
const STOP_HOLD_MS = 45_000;
const FRESH_MS = 3 * 60_000;
const STALE_MS = 5 * 60_000;
const VERY_STALE_MS = 15 * 60_000;

// Mirrors speedCascade.STOPPED_KMH: below this an observed speed means "stopped" — see pickWalkKmh.
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

/** Optional dwell model for the dead-reckon walk. When the trip's stop distances are known, the walk pays dwellSecondsPerStop at every stop it crosses — the bus covers less ground in the same time once stops are involved. Mirrors the ETA's per-segment dwell walk in reverse (same stop list, same per-stop cost) so position and ETA stay consistent by construction. */
export interface DeadReckonDwell {
  /** Cumulative metres of stops along the polyline. */
  stopDistAlongM?: ReadonlyArray<number>;
  /** Flat dwell per crossed stop; defaults to 20 s. */
  dwellSecondsPerStop?: number;
}

/** Project GPS onto polyline, then walk forward by (nowMs - obs.asOfMs): the first OBSERVED_WALK_MS at the observed-or-TOD speed, the remainder at the TOD speed, minus dwell at crossed stops. Returns null when the fix is older than VERY_STALE_MS — at that point prediction is too noisy to trust and the caller falls back to the schedule. */
export function deadReckonGpsAlongShape(
  obs: GpsObservation,
  measured: MeasuredPolyline,
  nowMs: number,
  ctx: PredictPositionFromGpsContext = {},
  dwell: DeadReckonDwell = {},
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
  // A stopped report subtracts its hold from the walkable time, so a
  // bus seen stopped 90 s ago walks only the post-hold remainder.
  const observedStopped = obs.speedMs != null && obs.speedMs * 3.6 <= STOPPED_KMH;
  const walkMs = Math.max(0, Math.max(0, dt) - (observedStopped ? STOP_HOLD_MS : 0));
  // Segment 1 (≤ OBSERVED_WALK_MS): the fix's own speed — precise
  // smoothing. Segment 2: TOD speed — the expected trajectory; a
  // minutes-old observed speed says nothing about the bus now.
  const seg1Ms = Math.min(walkMs, OBSERVED_WALK_MS);
  const seg2Ms = walkMs - seg1Ms;
  const seg1SpeedMs = (pickWalkKmh(obs, ctx, nowMs) * 1000) / 3600;
  const seg2SpeedMs = (pickTodKmh(ctx, nowMs) * 1000) / 3600;
  const dwellSec = dwell.dwellSecondsPerStop ?? 20;
  const stopsAhead = (dwell.stopDistAlongM ?? [])
    .filter((d) => d > proj.distAlongM)
    .sort((a, b) => a - b);
  let endDistM: number;
  if (stopsAhead.length > 0 && dwellSec > 0) {
    const afterSeg1 = advanceWithDwells(proj.distAlongM, seg1Ms, seg1SpeedMs, stopsAhead, dwellSec);
    endDistM = advanceWithDwells(
      afterSeg1,
      seg2Ms,
      seg2SpeedMs,
      stopsAhead.filter((d) => d > afterSeg1),
      dwellSec,
    );
  } else {
    endDistM = proj.distAlongM + (seg1SpeedMs * seg1Ms + seg2SpeedMs * seg2Ms) / 1000;
  }
  const distAlongM = Math.min(
    measured.totalDistM,
    Math.min(proj.distAlongM + MAX_WALK_M, endDistM),
  );
  const p = pointAtDistance(measured, distAlongM);
  return { position: p, distAlongM, dtMs: dt, freshness };
}

/**
 * Advance along the shape consuming the time budget segment by
 * segment: driving costs (distance / speed), each stop crossed costs
 * dwellSec. Returns the absolute distAlongM reached — possibly mid-
 * dwell at a stop when the budget runs out there. The dwell paid en
 * route is exactly why the bus didn't get further, so the ETA (which
 * only counts stops still ahead) never double-charges.
 */
function advanceWithDwells(
  startDistM: number,
  walkMs: number,
  speedMs: number,
  stopsAheadAsc: ReadonlyArray<number>,
  dwellSec: number,
): number {
  let remainingMs = walkMs;
  let pos = startDistM;
  for (const stopDist of stopsAheadAsc) {
    if (remainingMs <= 0) break;
    const driveMs = ((stopDist - pos) / speedMs) * 1000;
    if (remainingMs < driveMs) {
      return pos + (remainingMs / 1000) * speedMs; // never reached the stop
    }
    remainingMs -= driveMs;
    pos = stopDist; // arrived; dwell starts
    if (remainingMs < dwellSec * 1000) return pos; // still dwelling when budget ends
    remainingMs -= dwellSec * 1000;
  }
  return pos + (remainingMs / 1000) * speedMs;
}

/** Position from live GPS, dead-reckoned forward. Thin wrapper over `deadReckonGpsAlongShape` with map-marker-shaped output. The plan's stop distances feed the dwell-aware walk. Returns null when fix is too stale to project. */
export function predictPositionFromGps(
  plan: TripShapePlan,
  obs: GpsObservation,
  nowMs: number,
  ctx: PredictPositionFromGpsContext = {},
  dwellSecondsPerStop?: number,
): GpsPredictedPosition | null {
  const result = deadReckonGpsAlongShape(obs, plan.measured, nowMs, ctx, {
    stopDistAlongM: plan.legs.map((l) => l.distAlongM),
    dwellSecondsPerStop,
  });
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
  // Slow or missing speed → TOD bucket. A slow report is trusted as
  // "stopped" only for STOP_HOLD_MS (the caller subtracts the hold
  // from the walkable time); beyond it the bus has likely moved on.
  return pickTodKmh(ctx, nowMs);
}

/** TOD-bucket walk speed — the expected trajectory for any walk segment past the observed-speed horizon. */
function pickTodKmh(ctx: PredictPositionFromGpsContext, nowMs: number): number {
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
