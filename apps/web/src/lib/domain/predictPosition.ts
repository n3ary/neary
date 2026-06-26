/*
 * Predict a vehicle's current position from its trip's stop timeline.
 *
 * A trip's "stops" are an ordered list of (lat, lon, arrivalMin) tuples;
 * `nowMin` is minutes since local midnight. We find the segment the
 * vehicle should be on right now (i.e. the pair of consecutive stops
 * whose arrival times straddle `nowMin`) and linearly interpolate
 * between their coordinates by the time fraction.
 *
 * Limitations (intentional for Phase 1):
 *   - Linear segment between stop coordinates instead of along the
 *     GTFS shape polyline. A bus on a curvy road shows up as
 *     straight-line dots between stops. Acceptable for v2's first
 *     map cut; can be sharpened by projecting onto shape later.
 *   - Time is purely scheduled. Live GPS hasn't been wired through
 *     this helper yet — when it is, the live reconciler will short-
 *     circuit `predictPosition` with the GPS fix.
 *
 * Status values let the UI hide / dim a vehicle without re-deriving:
 *   - 'before':   nowMin < origin departure — bus hasn't started yet.
 *   - 'at-origin': nowMin in [origin - imminentMin, origin departure]
 *                  — coming up at the start station.
 *   - 'active':   between origin departure and terminus arrival.
 *   - 'after':    past terminus.
 */

export interface PredictStop {
  lat: number;
  lon: number;
  /** Minutes since local midnight (GTFS extended time allowed,
   *  i.e. 24h+ for past-midnight night routes). */
  arrivalMin: number;
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
 */
export function predictPosition(
  stops: readonly PredictStop[],
  nowMin: number,
  imminentMin: number = DEFAULT_IMMINENT_MIN,
): PredictedPosition | null {
  if (stops.length === 0) return null;
  const origin = stops[0];
  const terminus = stops[stops.length - 1];

  // Not started yet — sit at origin. `status` distinguishes
  // 'before' (too early to display) from 'at-origin' (imminent;
  // worth showing dimly).
  if (nowMin < origin.arrivalMin) {
    const status: TripStatus =
      origin.arrivalMin - nowMin <= imminentMin ? 'at-origin' : 'before';
    return { lat: origin.lat, lon: origin.lon, status };
  }
  // Past terminus — pin at terminus, marked 'after' so the UI hides it.
  if (nowMin >= terminus.arrivalMin) {
    return { lat: terminus.lat, lon: terminus.lon, status: 'after' };
  }

  // Active: find the segment [stops[i], stops[i+1]] whose arrivals
  // bracket nowMin. Linear search is fine — trips have O(20–60) stops.
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
  // Should be unreachable given the early returns, but keep the
  // type narrow by falling back to the terminus.
  return { lat: terminus.lat, lon: terminus.lon, status: 'active' };
}
