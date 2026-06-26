/*
 * Station-view arrival buckets — pure functions, no DOM, no stores. Spec
 * lives in docs/rebuild-v2/vehicles-and-views.md §3. Thresholds were
 * preserved from the v1 legacy implementation
 * (apps/legacy/src/utils/arrival/statusUtils.ts + arrivalUtils.ts).
 *
 * Six buckets in display order:
 *
 *   departing    about to leave / picking up speed at the stop
 *   at-station   physically at the stop (or scheduled to be dwelling mid-stop)
 *   arriving     close to arrival (≤ 2 min OR within 1 min of scheduled arrival)
 *   incoming     future, > 2 min away
 *   departed     already passed (within 5 min recency window). Hidden from
 *                station boards unless `userPrefs.showDepartedVehicles` is on;
 *                map view always shows them.
 *   off-route    sanity bucket — surfaces only in debug view
 */

import type { Vehicle } from './types';

export type ArrivalBucket =
  | 'departing'
  | 'at-station'
  | 'arriving'
  | 'incoming'
  | 'departed'
  | 'off-route';

/** Display order (lower = earlier). Tie-break by ascending eta minutes. */
export const BUCKET_ORDER: Record<ArrivalBucket, number> = {
  departing: 0,
  'at-station': 1,
  arriving: 2,
  incoming: 3,
  departed: 4,
  'off-route': 5,
};

/** Human-readable label for each bucket. Used by section headers on the
 *  StationCard. Lives in the domain because the bucket name is a UX
 *  concept, not a CSS one. */
export const BUCKET_LABEL: Record<ArrivalBucket, string> = {
  departing: 'Departing',
  'at-station': 'At station',
  arriving: 'Arriving',
  incoming: 'Incoming',
  departed: 'Recently departed',
  'off-route': 'Off route',
};

// Thresholds — see v1 references in the spec.
export const PROXIMITY_AT_STATION_M = 50;       // v1: STATION_PROXIMITY_METERS
export const OFF_ROUTE_DISTANCE_M = 200;        // v1: off-route cutoff
export const ARRIVING_THRESHOLD_MIN = 2;
export const RECENT_DEPARTURE_WINDOW_MIN = 5;
export const DEPARTING_SPEED_KMH = 5;
export const SCHEDULED_DWELL_GAP_MIN = 1;

export interface BucketInputs {
  /** Signed: positive = future, negative = past. */
  etaMinutes: number;
  /** Always positive. */
  distanceToStopMeters: number;
  /** km/h. Undefined for `scheduled` / `predicted` kinds. */
  vehicleSpeedKmh?: number;
  /** Minutes since local midnight at the target stop. */
  scheduledArrivalMin?: number;
  scheduledDepartureMin?: number;
  /** Minutes since local midnight, current wall clock. */
  nowMin: number;
  /** Whether the vehicle is on the route shape. Pass true if you don't have
   *  a shape check yet (the off-route bucket will only fire on big distance). */
  onRouteShape?: boolean;
}

/**
 * Determine the bucket for a single vehicle at a single target stop.
 * Pure function — only reads inputs, no side effects.
 *
 * The `kind` is taken from the vehicle so we can decide whether speed-based
 * heuristics apply (they do for live*, not for scheduled/predicted).
 */
export function bucketOf(
  kind: Vehicle['kind'],
  inputs: BucketInputs,
): ArrivalBucket {
  const {
    etaMinutes,
    distanceToStopMeters,
    vehicleSpeedKmh,
    scheduledArrivalMin,
    scheduledDepartureMin,
    nowMin,
    onRouteShape = true,
  } = inputs;

  const isLive = kind === 'live' || kind === 'reconciled' || kind === 'corroborated';

  // 1. Off-route hard fail — only for vehicles we have live GPS for.
  if (isLive && distanceToStopMeters > OFF_ROUTE_DISTANCE_M && !onRouteShape) {
    return 'off-route';
  }

  // 2. At station — physical proximity is only meaningful for live vehicles
  //    (we trust GPS). For predicted/scheduled we instead use the schedule's
  //    own arrival ≤ now ≤ departure window. Otherwise a scheduled future
  //    arrival with no real distance (we pass 0 by default) would always
  //    fall into the at-stop branch.
  const inDwellWindow =
    scheduledArrivalMin != null &&
    scheduledDepartureMin != null &&
    nowMin >= scheduledArrivalMin &&
    nowMin <= scheduledDepartureMin;

  const physicallyAtStation = distanceToStopMeters <= PROXIMITY_AT_STATION_M;

  if ((isLive && physicallyAtStation) || (!isLive && inDwellWindow)) {
    // Split the at-stop period into arriving / at-station / departing using
    // the scheduled dwell gap and any live motion signal.
    const dwellMin =
      scheduledDepartureMin != null && scheduledArrivalMin != null
        ? scheduledDepartureMin - scheduledArrivalMin
        : 0;

    // (a) Live vehicle picking up speed → departing.
    if (vehicleSpeedKmh != null && vehicleSpeedKmh >= DEPARTING_SPEED_KMH) {
      return 'departing';
    }
    // (b) Within last minute of scheduled dwell → departing.
    if (
      scheduledDepartureMin != null &&
      nowMin >= scheduledDepartureMin - 1 &&
      nowMin <= scheduledDepartureMin + 1
    ) {
      return 'departing';
    }
    // (c) Within first minute of scheduled dwell → arriving.
    if (
      scheduledArrivalMin != null &&
      nowMin >= scheduledArrivalMin - 1 &&
      nowMin <= scheduledArrivalMin + 1
    ) {
      return 'arriving';
    }
    // (d) Mid-dwell on a route with a meaningful gap → at-station.
    if (dwellMin >= SCHEDULED_DWELL_GAP_MIN) return 'at-station';
    // (e) Short gap, no other signal → just passing; call it arriving.
    return 'arriving';
  }

  // 3. Future.
  if (etaMinutes >= 0) {
    return etaMinutes <= ARRIVING_THRESHOLD_MIN ? 'arriving' : 'incoming';
  }

  // 4. Past.
  if (-etaMinutes <= RECENT_DEPARTURE_WINDOW_MIN) return 'departed';
  return 'off-route';
}

/** Sort comparator: bucket display order, then ascending eta minutes,
 *  then vehicle id for stability. */
export function compareForBoard(
  a: { vehicle: Vehicle; bucket: ArrivalBucket; etaMinutes: number },
  b: { vehicle: Vehicle; bucket: ArrivalBucket; etaMinutes: number },
): number {
  const byBucket = BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket];
  if (byBucket !== 0) return byBucket;
  const byEta = a.etaMinutes - b.etaMinutes;
  if (byEta !== 0) return byEta;
  return a.vehicle.id.localeCompare(b.vehicle.id);
}

/** Build a bucket→count map from a list of bucketed entries. Useful for
 *  the station card's count chips. */
export function bucketCounts(buckets: ArrivalBucket[]): Record<ArrivalBucket, number> {
  const counts: Record<ArrivalBucket, number> = {
    departing: 0,
    'at-station': 0,
    arriving: 0,
    incoming: 0,
    departed: 0,
    'off-route': 0,
  };
  for (const b of buckets) counts[b]++;
  return counts;
}

/**
 * Filter a list of bucketed entries for station-view display.
 *
 *   showDepartedVehicles=false  drops `departed` (always allowed on map view)
 *   showDropOffOnly=false       drops entries where vehicle.dropOffOnly is true
 *
 *  `off-route` is always dropped from station view (debug only).
 *  Schedule-only kinds (`scheduled` / `predicted`) are always shown —
 *  they're the whole point when no live source is wired.
 */
export function filterForStationView<
  T extends { vehicle: Vehicle; bucket: ArrivalBucket },
>(
  entries: T[],
  prefs: {
    showDepartedVehicles: boolean;
    showDropOffOnly: boolean;
  },
): T[] {
  return entries.filter((e) => {
    if (e.bucket === 'off-route') return false;
    if (e.bucket === 'departed' && !prefs.showDepartedVehicles) return false;
    if (e.vehicle.dropOffOnly && !prefs.showDropOffOnly) return false;
    return true;
  });
}
