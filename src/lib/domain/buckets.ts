/*
 * Station-view arrival buckets — pure functions, no DOM, no stores.
 * Spec: docs/specs/vehicles-and-views.md.
 *
 * Five buckets in display order:
 *
 *   at-station   vehicle is at the stop, or within ARRIVING_THRESHOLD_MIN
 *                of it (close enough to board imminently). The actual
 *                sub-state (about-to-leave / just-arrived / mid-dwell /
 *                close) is derived separately — see AtStationSubState.
 *   incoming     future, eta above the at-station window
 *   drop-off     drop-off-only vehicles (cannot board). Shown as a
 *                dedicated section after incoming when showDropOffOnly
 *                is enabled.
 *   departed     already passed. Hidden from station boards unless
 *                userPrefs.showDepartedVehicles is on; map view always
 *                shows them.
 *   off-route    sanity bucket — surfaces only in debug view
 *
 * The at-station group is internally split into four sub-states (see
 * `AtStationSubState`) that drive per-row label, color, and sort order.
 */

import { formatRelativeMin, type Vehicle } from './types';

export type ArrivalBucket =
  | 'at-station'
  | 'incoming'
  | 'drop-off'
  | 'departed'
  | 'off-route';

/** Display order (lower = earlier). Tie-break by sub-state (at-station),
 *  then by eta, then by vehicle id. */
export const BUCKET_ORDER: Record<ArrivalBucket, number> = {
  'at-station': 0,
  incoming: 1,
  'drop-off': 2,
  departed: 3,
  'off-route': 4,
};

/** Human-readable label for each bucket. Used by section headers on the
 *  StationCard. The at-station group has a fixed label — the per-row
 *  state is conveyed by the row's own label, not the section header. */
export const BUCKET_LABEL: Record<ArrivalBucket, string> = {
  'at-station': 'At station',
  incoming: 'Incoming',
  'drop-off': 'Drop off only',
  departed: 'Departed',
  'off-route': 'Off route',
};

/** Context-aware label for a bucket given the rows that fell into it.
 *  Origin-stop rows (`schedule.isFirstStop`) aren't really 'incoming
 *  from somewhere' — the bus is being prepared to start the trip — so
 *  we swap the verb to match what the rider sees on the curb:
 *
 *    incoming:  all origin → 'Scheduled'
 *               mixed      → 'Incoming & Scheduled'
 *               none       → 'Incoming'
 *
 *  The at-station section uses a fixed label; per-row state lives on
 *  the BoardRow. */
export function bucketLabel(
  bucket: ArrivalBucket,
  vehicles: readonly Vehicle[],
): string {
  if (bucket !== 'incoming') {
    return BUCKET_LABEL[bucket];
  }
  let hasOrigin = false;
  let hasOther = false;
  for (const v of vehicles) {
    if (v.schedule?.isFirstStop) hasOrigin = true;
    else hasOther = true;
    if (hasOrigin && hasOther) break;
  }
  if (hasOrigin && !hasOther) return 'Scheduled';
  if (hasOrigin && hasOther) return 'Incoming & Scheduled';
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
 *  For at-station rows, urgency comes from `AtStationLabel.urgency` (the
 *  per-row label function already encodes red/green for the sub-state).
 *  This function is the source of truth for the other buckets.
 *
 *  Map view doesn't compute urgency — it consumes raw vehicles. */
export type Urgency = 'go' | 'stop' | 'neutral';

export function etaUrgency(
  bucket: ArrivalBucket,
  etaMinutes: number,
  config: NearyConfig = DEFAULT_CONFIG,
): Urgency {
  switch (bucket) {
    case 'incoming':
      return etaMinutes <= config.imminentEtaThresholdMin ? 'go' : 'neutral';
    default:
      return 'neutral';
  }
}

/** Schedule-only equivalent of `etaUrgency`. Used by views that have a
 *  scheduled departure time but no live vehicle (e.g. the route
 *  schedule list before live data is wired in). */
export function scheduleUrgency(
  deltaMin: number,
  config: NearyConfig = DEFAULT_CONFIG,
): Urgency {
  if (deltaMin <= -1) return 'neutral';
  if (deltaMin < 1) return 'stop';
  if (deltaMin <= config.imminentEtaThresholdMin) return 'go';
  return 'neutral';
}

/** Sub-state for a vehicle in the at-station section. Drives per-row
 *  label, color, and sort order. The at-station section is internally
 *  split into four sub-states:
 *
 *    about-to-leave  vehicle is at the stop, in the last minute of
 *                    scheduled dwell, or already picking up speed.
 *                    UI label: 'departing now' (red).
 *    just-arrived    first minute of scheduled dwell. UI: 'arriving now' (green).
 *    mid-dwell       at the stop, between just-arrived and about-to-leave.
 *                    UI: 'arriving now' (green) — same as just-arrived; the
 *                    section header already says "At station", so the row
 *                    label only needs the action verb.
 *    close           not at the stop yet, but within ARRIVING_THRESHOLD_MIN.
 *                    UI: 'arriving in N min' (or 'arriving now' if eta < 1). */
export type AtStationSubState = 'about-to-leave' | 'just-arrived' | 'mid-dwell' | 'close';

export const AT_STATION_SUB_STATE_ORDER: Record<AtStationSubState, number> = {
  'about-to-leave': 0,  // most urgent — show first
  close: 1,
  'mid-dwell': 2,
  'just-arrived': 3,
};

/** Per-row label and urgency for a vehicle in the at-station section.
 *  Computed once at board assembly time and stored on the BoardRow,
 *  so the UI doesn't have to re-derive from schedule inputs. */
export interface AtStationLabel {
  text: string;
  urgency: Urgency;
}

/** Derive the at-station sub-state for a vehicle in the at-station
 *  bucket. Returns undefined for any other bucket. */
export function atStationSubState(
  bucket: ArrivalBucket,
  inputs: {
    distanceToStopMeters: number;
    vehicleSpeedKmh?: number;
    scheduledArrivalMin?: number;
    scheduledDepartureMin?: number;
    nowMin: number;
  },
): AtStationSubState | undefined {
  if (bucket !== 'at-station') return undefined;

  // "At the stop" matches `bucketOf`'s at-stop branch: live vehicle
  // within proximity, OR a schedule-only row inside the dwell window.
  // Schedule-only rows have no GPS so the proximity check is always
  // false for them; the schedule window is the only signal.
  const atTheStopByProximity = inputs.distanceToStopMeters <= PROXIMITY_AT_STATION_M;
  const atTheStopBySchedule =
    inputs.scheduledArrivalMin != null &&
    inputs.scheduledDepartureMin != null &&
    inputs.nowMin >= inputs.scheduledArrivalMin &&
    inputs.nowMin <= inputs.scheduledDepartureMin;
  const atTheStop = atTheStopByProximity || atTheStopBySchedule;
  if (!atTheStop) return 'close';

  // (a) Live vehicle picking up speed → about-to-leave.
  if (inputs.vehicleSpeedKmh != null && inputs.vehicleSpeedKmh >= DEPARTING_SPEED_KMH) {
    return 'about-to-leave';
  }
  // (b) Last minute of scheduled dwell → about-to-leave.
  if (
    inputs.scheduledDepartureMin != null &&
    inputs.nowMin >= inputs.scheduledDepartureMin - 1 &&
    inputs.nowMin <= inputs.scheduledDepartureMin + 1
  ) {
    return 'about-to-leave';
  }
  // (c) First minute of scheduled dwell → just-arrived.
  if (
    inputs.scheduledArrivalMin != null &&
    inputs.nowMin >= inputs.scheduledArrivalMin - 1 &&
    inputs.nowMin <= inputs.scheduledArrivalMin + 1
  ) {
    return 'just-arrived';
  }
  // (d) Mid-dwell (at the stop, not in either window) → mid-dwell.
  return 'mid-dwell';
}

/** Compute the per-row label and urgency for a vehicle in the
 *  at-station section. Pure: same sub-state + same eta/speed always
 *  yields the same label. */
export function atStationLabel(
  subState: AtStationSubState,
  inputs: {
    etaMinutes: number;
    vehicleSpeedKmh?: number;
  },
): AtStationLabel {
  switch (subState) {
    case 'about-to-leave':
      // Vehicle is leaving the stop — either already moving at
      // DEPARTING_SPEED_KMH or in the last minute of the
      // scheduled dwell. "Departing now" covers both: the user
      // doesn't care which mechanism, only that the bus is gone.
      return { text: 'departing now', urgency: 'stop' };
    case 'just-arrived':
      return { text: 'arriving now', urgency: 'go' };
    case 'mid-dwell':
      return { text: 'arriving now', urgency: 'go' };
    case 'close':
      // Approaching but not at the stop yet. Use the "arriving"
      // prefix so the rider reads it as progress, not as a stale
      // countdown — "in 1 min" is ambiguous (in 1 min until what?).
      if (inputs.etaMinutes < 1) return { text: 'arriving now', urgency: 'go' };
      return { text: arrivingIn(inputs.etaMinutes), urgency: 'go' };
  }
}

/** Render an ETA in [1, inf) minutes as "arriving in N min" (or the
 *  long form). Wraps `formatRelativeMin` with a fixed "arriving "
 *  prefix and rounds the input to whole minutes so live positions
 *  don't flicker between e.g. "in 1 min" and "in 2 min" on a
 *  fractional eta. Caller is responsible for the eta < 1 case
 *  ("arriving now") — this function is only entered for eta >= 1,
 *  so `formatRelativeMin` will always return a string starting
 *  with "in " (never the "<= -1" "N min ago" or "< 1" "now" branches). */
function arrivingIn(etaMin: number): string {
  return `arriving ${formatRelativeMin(Math.round(etaMin))}`;
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

export function bucketOf(
  kind: Vehicle['kind'],
  inputs: BucketInputs,
): ArrivalBucket {
  const {
    etaMinutes,
    distanceToStopMeters,
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

  // 2. At station — physical proximity is only meaningful for live
  //    vehicles (we trust GPS). For schedule-only rows we instead use
  //    the schedule's own arrival ≤ now ≤ departure window. Otherwise
  //    a scheduled future arrival with no real distance (we pass 0 by
  //    default) would always fall into the at-stop branch.
  const inDwellWindow =
    scheduledArrivalMin != null &&
    scheduledDepartureMin != null &&
    nowMin >= scheduledArrivalMin &&
    nowMin <= scheduledDepartureMin;
  const physicallyAtStation = distanceToStopMeters <= PROXIMITY_AT_STATION_M;

  if ((isLive && physicallyAtStation) || (!isLive && inDwellWindow)) {
    return 'at-station';
  }

  // 3. Future, within the at-station ETA window.
  if (etaMinutes >= 0 && etaMinutes <= ARRIVING_THRESHOLD_MIN) {
    return 'at-station'; // sub-state 'close'
  }

  // 4. Future, outside the at-station window.
  if (etaMinutes >= 0) {
    return 'incoming';
  }

  // 5. Past. The scheduleScanner already excluded trips that have
  //    completed (terminus time < now), so anything past here is still
  //    en route and belongs in 'departed'. No artificial recency cap.
  return 'departed';
}

/** Sort comparator: bucket display order, then by sub-state (at-station
 *  rows), then by eta, then by id. Within the `departed` bucket eta is
 *  inverted (most-recent first). */
export function compareForBoard(
  a: {
    vehicle: Vehicle;
    bucket: ArrivalBucket;
    etaMinutes: number;
    atStationSubState?: AtStationSubState;
  },
  b: {
    vehicle: Vehicle;
    bucket: ArrivalBucket;
    etaMinutes: number;
    atStationSubState?: AtStationSubState;
  },
): number {
  const byBucket = BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket];
  if (byBucket !== 0) return byBucket;

  // Within at-station, sort by sub-state priority.
  if (a.bucket === 'at-station' && b.bucket === 'at-station') {
    const aSub = a.atStationSubState != null ? AT_STATION_SUB_STATE_ORDER[a.atStationSubState] : 99;
    const bSub = b.atStationSubState != null ? AT_STATION_SUB_STATE_ORDER[b.atStationSubState] : 99;
    const bySub = aSub - bSub;
    if (bySub !== 0) return bySub;
  }

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
    'at-station': 0,
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
