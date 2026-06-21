/**
 * Vehicle-to-schedule matching and duplicate detection for GTFS schedule data.
 *
 * Pure functions (no I/O, no store access) implementing Correctness Property 8
 * (Vehicle-to-schedule matching) from the design document. They assign each
 * GPS-visible vehicle to the active scheduled trip whose expected along-route
 * position best matches the vehicle, and flag vehicles that cannot be matched
 * (or that lose a same-trip contest) as suspect duplicates.
 *
 * ## Position-to-timing conversion: simplifying assumption
 *
 * Property 8 describes matching by comparing a vehicle's *spatial* progress
 * along its route to the *expected* scheduled position. Projecting a vehicle's
 * GPS coordinates onto its route requires route geometry (`RouteShape`) and/or
 * stop coordinates (`TranzyStopResponse[]`) — for example via
 * `projectPointToShape` / `estimateVehicleProgressWithShape` in
 * `src/utils/arrival/`. None of those inputs are available in this function's
 * signature, so we cannot derive a spatial progress fraction here.
 *
 * Instead we convert position to a *timing* quantity that the schedule already
 * provides. Both the vehicle and each candidate trip are expressed as
 * "minutes elapsed since the scheduled departure from the start station":
 *
 *   expectedElapsed(trip)   = currentMinutes − scheduledStart(trip)
 *   vehicleElapsed(vehicle) = currentMinutes − scheduledStart(vehicle.trip_id)
 *
 * The vehicle is anchored to the trip it reports it is serving
 * (`vehicle.trip_id`). The timing delta against any candidate trip therefore
 * reduces to the difference between scheduled start times:
 *
 *   timingDelta = |vehicleElapsed − expectedElapsed|
 *               = |scheduledStart(candidate) − scheduledStart(vehicle.trip_id)|
 *
 * A vehicle matches the candidate trip with the smallest timing delta, provided
 * that delta is within ±10 minutes (Requirement 8.2). When several vehicles map
 * to the same trip, the closest one (ties broken deterministically by vehicle
 * id) is treated as real and the others as suspect duplicates (Requirements
 * 8.3, 8.5). Vehicles with no schedule anchor or no candidate within tolerance
 * are flagged as suspect duplicates (Requirement 8.4).
 *
 * Candidate trips are taken from `activeTrips` exactly as provided; the caller
 * is responsible for scoping that set to the relevant route(s). This function
 * has no trip→route mapping because the schedule payload does not carry
 * route ids.
 */

import type { SchedulePayload, VehicleMatchResult } from '../../types/schedule';
import type { EnhancedVehicleData } from '../vehicle/vehicleEnhancementUtils';
import { CONFIDENCE_LEVELS } from '../core/stringConstants';

/** Maximum timing difference (minutes) for a vehicle to match a trip. */
export const TIMING_TOLERANCE_MINUTES = 10;

/**
 * Headway threshold (minutes) below which a route is considered "high
 * frequency". On such routes, many legitimate vehicles fall within the ±10 min
 * matching tolerance of multiple trips, so suspect-duplicate flagging becomes
 * unreliable and noisy — callers skip it entirely (issue #24). Equal to the
 * matching tolerance: if scheduled trips are closer together than the tolerance
 * itself, duplicate detection cannot be trusted.
 */
export const HIGH_FREQUENCY_HEADWAY_MINUTES = TIMING_TOLERANCE_MINUTES;

/**
 * Window (minutes) around the current time used to sample a route's headway.
 * Trips whose scheduled start is within this window of "now" represent the
 * service level the rider currently sees.
 */
const HEADWAY_SAMPLE_WINDOW_MINUTES = 60;

/** Timing delta thresholds (minutes) used to grade a real match's confidence. */
const HIGH_CONFIDENCE_MAX_DELTA = 3;
const MEDIUM_CONFIDENCE_MAX_DELTA = 7;

/** Sentinel timingDeltaMinutes for vehicles with no comparable scheduled trip. */
const NO_MATCH_DELTA = -1;

/**
 * Resolve a trip's scheduled departure from its start station, in
 * minutes-since-midnight.
 *
 * The start station is the stop time with the smallest `stop_sequence` (`q`);
 * its departure minutes (`d`) is the trip's scheduled start.
 *
 * @returns Minutes-since-midnight of the trip's scheduled departure, or `null`
 *   when the trip has no stop times in the schedule payload.
 */
function getScheduledStartMinutes(
  tripId: string,
  scheduleData: SchedulePayload,
): number | null {
  const stopTimes = scheduleData.stopTimes[tripId];
  if (!stopTimes || stopTimes.length === 0) return null;

  let firstDeparture = stopTimes[0].d;
  let firstSequence = stopTimes[0].q;
  for (const stopTime of stopTimes) {
    if (stopTime.q < firstSequence) {
      firstSequence = stopTime.q;
      firstDeparture = stopTime.d;
    }
  }
  return firstDeparture;
}

/** Grade a real match's confidence from its absolute timing delta. */
function confidenceFromDelta(delta: number): VehicleMatchResult['matchConfidence'] {
  if (delta <= HIGH_CONFIDENCE_MAX_DELTA) return CONFIDENCE_LEVELS.HIGH;
  if (delta <= MEDIUM_CONFIDENCE_MAX_DELTA) return CONFIDENCE_LEVELS.MEDIUM;
  return CONFIDENCE_LEVELS.LOW;
}

/** Per-vehicle interim matching state, before duplicate resolution. */
interface InterimMatch {
  vehicleId: number;
  /** Closest candidate trip id, or null when no candidate could be evaluated. */
  nearestTripId: string | null;
  /** Absolute timing delta to the nearest candidate, or NO_MATCH_DELTA. */
  delta: number;
  /** Whether the nearest candidate is within ±10 minute tolerance. */
  withinTolerance: boolean;
}

/**
 * Match GPS-visible vehicles to active scheduled trips and flag suspect
 * duplicates.
 *
 * Each input vehicle produces exactly one {@link VehicleMatchResult}, in input
 * order. See the file header for the position-to-timing conversion assumption.
 *
 * @param vehicles GPS-visible vehicles to match (already enhanced)
 * @param activeTrips Candidate active trip ids (caller scopes to the route)
 * @param scheduleData The schedule payload providing scheduled start times
 * @param currentMinutes Current time as minutes-since-midnight
 * @returns One match result per vehicle, preserving input order
 */
export function matchVehiclesToSchedule(
  vehicles: EnhancedVehicleData[],
  activeTrips: string[],
  scheduleData: SchedulePayload,
  currentMinutes: number,
): VehicleMatchResult[] {
  // Precompute candidate trips with a resolvable scheduled start time.
  const candidates: Array<{ tripId: string; start: number }> = [];
  for (const tripId of activeTrips) {
    const start = getScheduledStartMinutes(tripId, scheduleData);
    if (start !== null) {
      candidates.push({ tripId, start });
    }
  }

  // Phase 1 — find the nearest candidate trip for each vehicle.
  const interim: InterimMatch[] = vehicles.map((vehicle) => {
    const vehicleId = vehicle.id;
    const anchorStart =
      vehicle.trip_id !== null
        ? getScheduledStartMinutes(vehicle.trip_id, scheduleData)
        : null;

    // No schedule anchor, or no candidates to compare against.
    if (anchorStart === null || candidates.length === 0) {
      return {
        vehicleId,
        nearestTripId: null,
        delta: NO_MATCH_DELTA,
        withinTolerance: false,
      };
    }

    const vehicleElapsed = currentMinutes - anchorStart;

    let best: { tripId: string; delta: number } | null = null;
    for (const candidate of candidates) {
      const expectedElapsed = currentMinutes - candidate.start;
      const delta = Math.abs(vehicleElapsed - expectedElapsed);
      const isBetter =
        best === null ||
        delta < best.delta ||
        // Deterministic tie-break: prefer the lexicographically smaller trip id.
        (delta === best.delta && candidate.tripId < best.tripId);
      if (isBetter) {
        best = { tripId: candidate.tripId, delta };
      }
    }

    // `best` is non-null here because `candidates` is non-empty.
    const resolved = best as { tripId: string; delta: number };
    return {
      vehicleId,
      nearestTripId: resolved.tripId,
      delta: resolved.delta,
      withinTolerance: resolved.delta <= TIMING_TOLERANCE_MINUTES,
    };
  });

  // Phase 2 — among vehicles matched to the same trip, only the best is real.
  const matchedByTrip = new Map<string, InterimMatch[]>();
  for (const match of interim) {
    if (match.withinTolerance && match.nearestTripId !== null) {
      const group = matchedByTrip.get(match.nearestTripId);
      if (group) {
        group.push(match);
      } else {
        matchedByTrip.set(match.nearestTripId, [match]);
      }
    }
  }

  const realVehicleIds = new Set<number>();
  for (const group of matchedByTrip.values()) {
    group.sort((a, b) =>
      a.delta !== b.delta ? a.delta - b.delta : a.vehicleId - b.vehicleId,
    );
    realVehicleIds.add(group[0].vehicleId);
  }

  // Phase 3 — build the per-vehicle results.
  return interim.map((match) => {
    const matched = match.withinTolerance && match.nearestTripId !== null;
    const isReal = matched && realVehicleIds.has(match.vehicleId);

    return {
      vehicleId: match.vehicleId,
      // Only surface a trip id for vehicles that matched within tolerance.
      tripId: matched ? (match.nearestTripId as string) : '',
      matchConfidence: isReal
        ? confidenceFromDelta(match.delta)
        : CONFIDENCE_LEVELS.LOW,
      isSuspectDuplicate: !isReal,
      timingDeltaMinutes: match.delta,
    };
  });
}

/**
 * Estimate a route's scheduled headway (minutes) near the current time.
 *
 * Headway is the typical gap between consecutive scheduled departures. We sample
 * the candidate trips whose start time is within {@link HEADWAY_SAMPLE_WINDOW_MINUTES}
 * of `currentMinutes` (falling back to all candidates when fewer than two are in
 * the window), sort their start times, and return the MEDIAN consecutive gap.
 * The median is robust to a single outlier pair, so one coincidentally-close
 * pair on an otherwise sparse route does not make it look high-frequency.
 *
 * `activeTrips` must be scoped to a single route by the caller (the same
 * contract as {@link matchVehiclesToSchedule}); the result is otherwise the
 * headway across whatever mix of routes was passed in.
 *
 * @returns Median consecutive gap in minutes, or null when fewer than two
 *   candidate trips have a resolvable scheduled start (headway undefined).
 */
export function computeScheduledHeadwayMinutes(
  activeTrips: string[],
  scheduleData: SchedulePayload,
  currentMinutes: number,
): number | null {
  const allStarts: number[] = [];
  for (const tripId of activeTrips) {
    const start = getScheduledStartMinutes(tripId, scheduleData);
    if (start !== null) allStarts.push(start);
  }
  if (allStarts.length < 2) return null;

  // Prefer trips near "now"; fall back to all when the window is too sparse.
  const inWindow = allStarts.filter(
    (start) => Math.abs(start - currentMinutes) <= HEADWAY_SAMPLE_WINDOW_MINUTES,
  );
  const sample = inWindow.length >= 2 ? inWindow : allStarts;

  const sorted = [...sample].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push(sorted[i] - sorted[i - 1]);
  }
  if (gaps.length === 0) return null;

  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 === 0 ? (gaps[mid - 1] + gaps[mid]) / 2 : gaps[mid];
}

/**
 * Whether a route should skip suspect-duplicate flagging because it runs at high
 * frequency (headway below the matching tolerance). See issue #24.
 *
 * @returns true when the sampled headway is defined and strictly below
 *   {@link HIGH_FREQUENCY_HEADWAY_MINUTES}. Returns false when the headway is
 *   undefined (too few trips), so sparse routes keep normal duplicate detection.
 */
export function isHighFrequencyRoute(
  activeTrips: string[],
  scheduleData: SchedulePayload,
  currentMinutes: number,
): boolean {
  const headway = computeScheduledHeadwayMinutes(activeTrips, scheduleData, currentMinutes);
  return headway !== null && headway < HIGH_FREQUENCY_HEADWAY_MINUTES;
}
