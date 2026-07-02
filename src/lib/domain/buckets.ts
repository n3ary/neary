/*
 * Station-view arrival buckets — pure functions, no DOM, no stores.
 * Spec: docs/specs/vehicles-and-views.md.
 *
 * Seven buckets in display order:
 *
 *   departing    about to leave / picking up speed at the stop
 *   at-station   physically at the stop (or scheduled to be dwelling mid-stop)
 *   arriving     close to arrival (eta ≤ arrivingThresholdMin OR within
 *                minDwellGapMin of scheduled arrival)
 *   incoming     future, eta above arrivingThresholdMin
 *   drop-off     drop-off-only vehicles (cannot board). Shown as a dedicated
 *                section after incoming when showDropOffOnly is enabled.
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
  | 'drop-off'
  | 'departed'
  | 'off-route';

/** Display order (lower = earlier). Tie-break by ascending eta minutes. */
export const BUCKET_ORDER: Record<ArrivalBucket, number> = {
  departing: 0,
  'at-station': 1,
  arriving: 2,
  incoming: 3,
  'drop-off': 4,
  departed: 5,
  'off-route': 6,
};

/** Human-readable label for each bucket. Used by section headers on the
 *  StationCard. Lives in the domain because the bucket name is a UX
 *  concept, not a CSS one. */
export const BUCKET_LABEL: Record<ArrivalBucket, string> = {
  departing: 'Departing',
  'at-station': 'At station',
  arriving: 'Arriving',
  incoming: 'Incoming',
  'drop-off': 'Drop off only',
  departed: 'Departed',
  'off-route': 'Off route',
};

/** Context-aware label for a bucket given the rows that fell into it.
 *  Origin-stop rows (`schedule.isFirstStop`) aren't really 'arriving
 *  from somewhere' — the bus is being prepared to start the trip — so
 *  we swap the verb to match what the rider sees on the curb:
 *
 *    arriving:  all origin → 'Preparing'
 *               mixed      → 'Arriving & Preparing'
 *               none       → 'Arriving'
 *    incoming:  all origin → 'Scheduled'
 *               mixed      → 'Incoming & Scheduled'
 *               none       → 'Incoming'
 *
 *  Other buckets are unaffected: a vehicle that is 'departing' from
 *  its origin or 'at-station' at its origin reads correctly either
 *  way. */
export function bucketLabel(
  bucket: ArrivalBucket,
  vehicles: readonly Vehicle[],
): string {
  if (bucket !== 'arriving' && bucket !== 'incoming') {
    return BUCKET_LABEL[bucket];
  }
  let hasOrigin = false;
  let hasOther = false;
  for (const v of vehicles) {
    if (v.schedule?.isFirstStop) hasOrigin = true;
    else hasOther = true;
    if (hasOrigin && hasOther) break;
  }
  const originWord = bucket === 'arriving' ? 'Preparing' : 'Scheduled';
  if (hasOrigin && !hasOther) return originWord;
  if (hasOrigin && hasOther) return `${BUCKET_LABEL[bucket]} & ${originWord}`;
  return BUCKET_LABEL[bucket];
}

// Thresholds — sourced from DEFAULT_CONFIG (lib/domain/config.ts) so a
// single object controls every magic number in the app. Re-exported as
// individual consts to keep existing imports stable.
import { DEFAULT_CONFIG, type NearyConfig } from './config';

export const PROXIMITY_AT_STATION_M = DEFAULT_CONFIG.proximityAtStationM;
export const OFF_ROUTE_DISTANCE_M = DEFAULT_CONFIG.offRouteDistanceM;
export const ARRIVING_THRESHOLD_MIN = DEFAULT_CONFIG.arrivingThresholdMin;
export const DEPARTING_SPEED_KMH = DEFAULT_CONFIG.departingSpeedKmh;
export const SCHEDULED_DWELL_GAP_MIN = DEFAULT_CONFIG.minDwellGapMin;

/** ETA-urgency classification used by the UI to color the time column.
 *  The decision lives in the domain so the UI doesn't have to know about
 *  buckets, thresholds, or config:
 *
 *    'go'      — vehicle is boardable now or imminently. UI: bold success.
 *    'stop'    — vehicle is leaving / has left the boarding window. UI: bold danger.
 *    'neutral' — nothing time-critical. UI: muted.
 *
 *  Map view doesn't compute urgency — it consumes raw vehicles. */
export type Urgency = 'go' | 'stop' | 'neutral';

export function etaUrgency(
  bucket: ArrivalBucket,
  etaMinutes: number,
  config: NearyConfig = DEFAULT_CONFIG,
): Urgency {
  switch (bucket) {
    case 'departing':
      return 'stop';
    case 'at-station':
    case 'arriving':
      return 'go';
    case 'incoming':
      return etaMinutes <= config.imminentEtaThresholdMin ? 'go' : 'neutral';
    default:
      return 'neutral';
  }
}

/** Schedule-only equivalent of `etaUrgency`. Used by views that have a
 *  scheduled departure time but no live vehicle (e.g. the route
 *  schedule list before live data is wired in). Mirrors the bucket
 *  rules from `etaUrgency`:
 *
 *    delta < -1 min  → 'neutral' (already departed; not actionable)
 *    -1 ≤ delta < 1  → 'stop'    (about to leave; render bold red,
 *                                 caller typically labels it 'Departing')
 *    1 ≤ delta ≤ imminentEtaThresholdMin → 'go' (bold accent)
 *    delta > imminentEtaThresholdMin     → 'neutral'
 */
export function scheduleUrgency(
  deltaMin: number,
  config: NearyConfig = DEFAULT_CONFIG,
): Urgency {
  if (deltaMin <= -1) return 'neutral';
  if (deltaMin < 1) return 'stop';
  if (deltaMin <= config.imminentEtaThresholdMin) return 'go';
  return 'neutral';
}

export interface BucketInputs {
  /** Signed: positive = future, negative = past. */
  etaMinutes: number;
  /** Always positive. */
  distanceToStopMeters: number;
  /** km/h. Undefined for `scheduled` kind (no live position). */
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
 * heuristics apply (they do for live-backed kinds, not for scheduled).
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

  const isLive = kind === 'gps-only' || kind === 'tracked' || kind === 'verified';

  // 1. Off-route hard fail — only for vehicles we have live GPS for.
  if (isLive && distanceToStopMeters > OFF_ROUTE_DISTANCE_M && !onRouteShape) {
    return 'off-route';
  }

  // 2. At station — physical proximity is only meaningful for live vehicles
  //    (we trust GPS). For schedule-only rows we instead use the schedule's
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
    // (e) Fallback:
    //     - Live vehicle: GPS says it's physically at the stop right now.
    //       It IS at the station (the user can board). Return 'at-station'
    //       regardless of what the schedule says about future timing —
    //       trust the GPS. This includes the start-station case where the
    //       bus is dwelling and waiting for its scheduled departure.
    //     - Non-live: we got here via the dwell window but dwell < 1 min,
    //       so the trip is just passing through — return 'arriving'.
    return isLive ? 'at-station' : 'arriving';
  }

  // 3. Future.
  if (etaMinutes >= 0) {
    return etaMinutes <= ARRIVING_THRESHOLD_MIN ? 'arriving' : 'incoming';
  }

  // 4. Past. The scheduleScanner already excluded trips that have
  //    completed (terminus time < now), so anything past here is still
  //    en route and belongs in 'departed'. No artificial recency cap.
  return 'departed';
}

/** Sort comparator: bucket display order, then by eta. Within the
 *  `departed` bucket eta is inverted (most-recent first, e.g. -1 before
 *  -10), which is what a transit user expects to read. For every other
 *  bucket eta is ascending (nearest first). Final tie-break by id. */
export function compareForBoard(
  a: { vehicle: Vehicle; bucket: ArrivalBucket; etaMinutes: number },
  b: { vehicle: Vehicle; bucket: ArrivalBucket; etaMinutes: number },
): number {
  const byBucket = BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket];
  if (byBucket !== 0) return byBucket;
  const aEta = a.bucket === 'departed' ? -a.etaMinutes : a.etaMinutes;
  const bEta = b.bucket === 'departed' ? -b.etaMinutes : b.etaMinutes;
  const byEta = aEta - bEta;
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
    'drop-off': 0,
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
 *   showDropOffOnly=false       drops `dropOffOnly` rows from the future
 *                               buckets (departed bucket ignores this)
 *   showOffRouteVehicles=false  drops `off-route` rows (advanced diagnostic)
 *
 *  Schedule-only rows (`scheduled` with no live match) are always shown —
 *  they're the whole point when no live source is wired.
 *
 *  `dropOffOnly` does NOT apply to the `departed` bucket. That flag is
 *  about future boardability ("you can't get on this bus") — for a
 *  vehicle that has already left, the question is moot. When the user
 *  opts in to recently-departed, they should see them regardless.
 */
export function filterForStationView<
  T extends { vehicle: Vehicle; bucket: ArrivalBucket },
>(
  entries: T[],
  prefs: {
    showDepartedVehicles: boolean;
    showDropOffOnly: boolean;
    showOffRouteVehicles: boolean;
  },
): T[] {
  return entries.filter((e) => {
    if (e.bucket === 'off-route' && !prefs.showOffRouteVehicles) return false;
    if (e.bucket === 'departed' && !prefs.showDepartedVehicles) return false;
    if (e.bucket === 'drop-off' && !prefs.showDropOffOnly) return false;
    return true;
  });
}
