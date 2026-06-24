/**
 * Ghost-vehicle suppression: frequency-aware matching against live GPS (Req 7, 12).
 *
 * A ghost (a scheduled run that has departed but has no GPS vehicle) is only
 * worth showing when the live feed is NOT already covering that run. Two pure
 * rules decide suppression:
 *
 *  1. **Positional match.** If a live GPS vehicle on the same route is within a
 *     distance threshold of the ghost's predicted position, they are treated as
 *     the same physical run and the ghost is suppressed. The threshold scales
 *     with the route's scheduled headway near "now": infrequent routes tolerate
 *     a larger distance (a ghost could be far from the nearest live vehicle and
 *     still be distinct), frequent routes tolerate less.
 *  2. **High-frequency blanket suppression.** On a route whose headway is at or
 *     below {@link GHOST_VEHICLE_MATCH.HIGH_FREQUENCY_HEADWAY_MINUTES}, if ANY
 *     live GPS vehicle is present, ghosts are not shown at all — the feed is
 *     dense enough that synthesized runs would only duplicate/clutter.
 *
 * Pure functions — no I/O, no store access.
 */

import { GHOST_VEHICLE_MATCH } from '../core/constants';
import { calculateDistance, type Coordinates } from '../location/distanceUtils';

/** A scheduled run's identity for start-station claiming. */
export interface RunStart {
  tripId: string;
  /** First-stop departure, minutes since midnight. */
  startMin: number;
}

/** A live GPS vehicle reduced to what start-station claiming needs. */
export interface GpsVehicleLite {
  position: Coordinates;
  /** Predicted/current speed (km/h); ~0 means stopped/waiting. */
  speed: number;
  /**
   * The stop_id where this vehicle's CURRENT trip originates (its first stop),
   * or null when unknown. Only a vehicle whose trip originates at the run's
   * start stop may claim that departure — a vehicle terminating there (just
   * arrived inbound at a turnaround) must not take over the outbound card.
   */
  originStopId?: number | null;
}

/**
 * Determine which scheduled runs starting at a given stop are "covered" by a
 * live GPS vehicle physically waiting at that start stop.
 *
 * A vehicle stopped within {@link GHOST_VEHICLE_MATCH.START_CLAIM_PROXIMITY_METERS}
 * of the start stop is presumed to be the bus that will serve the NEXT departure
 * from there. With N such stopped vehicles, the N SOONEST FUTURE runs are claimed
 * (so a bus waiting before its time shows no duplicate future card). It never
 * claims an already-departed run: a stationary bus is always treated as the next
 * departure. Reclassifying it as a LATE earlier run only happens once it leaves
 * the start (handled elsewhere), per the rule "stationary => next scheduled".
 *
 * @returns the subset of `runs` (by tripId) that are covered.
 */
export function claimRunsAtStart(
  runs: RunStart[],
  startStop: Coordinates,
  startStopId: number,
  routeVehicles: GpsVehicleLite[],
  nowMin: number,
  windowMinutes: number,
): Set<string> {
  const claimed = new Set<string>();
  if (runs.length === 0) return claimed;

  let stoppedAtStart = 0;
  for (const v of routeVehicles) {
    if (v.speed > GHOST_VEHICLE_MATCH.START_CLAIM_SPEED_KMH) continue;
    // Only a bus DEPARTING from this stop (its trip originates here) may claim.
    // A bus terminating here (just arrived inbound at a turnaround) must not.
    // When the origin is unknown, fall back to proximity-only (legacy behavior).
    if (v.originStopId != null && v.originStopId !== startStopId) continue;
    let d: number;
    try {
      d = calculateDistance(v.position, startStop);
    } catch {
      continue;
    }
    if (d <= GHOST_VEHICLE_MATCH.START_CLAIM_PROXIMITY_METERS) stoppedAtStart++;
  }
  if (stoppedAtStart === 0) return claimed;

  // Only the SOONEST upcoming departures — never a past run.
  const eligible = runs
    .filter((r) => r.startMin >= nowMin && r.startMin <= nowMin + windowMinutes)
    .sort((a, b) => a.startMin - b.startMin);

  for (let i = 0; i < Math.min(stoppedAtStart, eligible.length); i++) {
    claimed.add(eligible[i].tripId);
  }
  return claimed;
}

/**
 * Estimate a route's scheduled headway (minutes between consecutive departures)
 * near `nowMin`, from the route's start-station departure times.
 *
 * Uses the MEDIAN gap of departures within `±windowMinutes` of now, which is
 * robust to the irregular spacing real timetables have. Returns `null` when
 * there are fewer than two departures in the window (frequency unknown).
 */
export function computeHeadwayMinutes(
  startDepartures: number[],
  nowMin: number,
  windowMinutes: number = GHOST_VEHICLE_MATCH.HEADWAY_WINDOW_MINUTES,
): number | null {
  const inWindow = startDepartures
    .filter((d) => Math.abs(d - nowMin) <= windowMinutes)
    .sort((a, b) => a - b);

  if (inWindow.length < 2) return null;

  const gaps: number[] = [];
  for (let i = 1; i < inWindow.length; i++) {
    gaps.push(inWindow[i] - inWindow[i - 1]);
  }
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 === 0 ? (gaps[mid - 1] + gaps[mid]) / 2 : gaps[mid];
}

/**
 * Positional match distance (meters) for a route's ghosts, scaled by headway.
 *
 * Linear in headway around the pivot: at the high-frequency headway the distance
 * equals the configured base, growing/shrinking proportionally and clamped to
 * the configured bounds. When headway is unknown (`null`), the base is used.
 */
export function ghostMatchDistanceMeters(headwayMinutes: number | null): number {
  const { BASE_DISTANCE_METERS, MIN_DISTANCE_METERS, MAX_DISTANCE_METERS, HIGH_FREQUENCY_HEADWAY_MINUTES } =
    GHOST_VEHICLE_MATCH;
  if (headwayMinutes === null) return BASE_DISTANCE_METERS;
  const scaled = (headwayMinutes / HIGH_FREQUENCY_HEADWAY_MINUTES) * BASE_DISTANCE_METERS;
  return Math.min(MAX_DISTANCE_METERS, Math.max(MIN_DISTANCE_METERS, scaled));
}

/**
 * Whether a route is "high frequency" (headway at/below the configured pivot).
 * Unknown headway (`null`) is treated as NOT high frequency (don't blanket-suppress).
 */
export function isHighFrequency(headwayMinutes: number | null): boolean {
  return headwayMinutes !== null && headwayMinutes <= GHOST_VEHICLE_MATCH.HIGH_FREQUENCY_HEADWAY_MINUTES;
}

/**
 * Whether a ghost at `ghostPosition` is already covered by a live GPS vehicle on
 * the same route — i.e. some `routeVehiclePosition` is within `matchDistanceMeters`.
 */
export function isGhostCoveredByGps(
  ghostPosition: Coordinates,
  routeVehiclePositions: Coordinates[],
  matchDistanceMeters: number,
): boolean {
  for (const pos of routeVehiclePositions) {
    let distance: number;
    try {
      distance = calculateDistance(ghostPosition, pos);
    } catch {
      continue; // skip invalid coordinates
    }
    if (distance <= matchDistanceMeters) return true;
  }
  return false;
}

/**
 * Combined decision: should a ghost on this route be suppressed?
 *
 * @param headwayMinutes Route headway near now (or null when unknown).
 * @param routeHasGps Whether the route currently has ANY live GPS vehicle.
 * @param ghostPosition The ghost's predicted position.
 * @param routeVehiclePositions Predicted positions of live GPS vehicles on the route.
 */
export function shouldSuppressGhost(
  headwayMinutes: number | null,
  routeHasGps: boolean,
  ghostPosition: Coordinates,
  routeVehiclePositions: Coordinates[],
): boolean {
  // Positional match: suppress only when a live GPS vehicle is physically
  // close to this specific ghost's position. The high-frequency blanket rule
  // (suppress ALL ghosts when any GPS exists) is disabled — it was too
  // aggressive and hid legitimate schedule info on busy routes.
  if (routeVehiclePositions.length === 0) return false;

  const matchDistance = ghostMatchDistanceMeters(headwayMinutes);
  return isGhostCoveredByGps(ghostPosition, routeVehiclePositions, matchDistance);
}
