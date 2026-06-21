/**
 * Schedule ↔ vehicle display integration (task 8.1).
 *
 * This module is the additive seam that wires the pure ghost-vehicle detector
 * (`identifyGhostTrips`) into the vehicle display layer. It derives the set of
 * trip ids that currently have a GPS-visible vehicle, asks the detector which
 * active scheduled trips have no live vehicle (ghost candidates), and exposes a
 * combined display list so the UI can render ghost markers distinctly from
 * GPS-tracked vehicles.
 *
 * ## Design constraints
 *
 * - **Pure / additive only.** No store access, no I/O. The existing GPS-only
 *   flow (`enhanceVehicle`/`enhanceVehicles`) is untouched; this module only
 *   reads existing data and produces extra display items. When `scheduleData`
 *   is null/absent the functions return no ghosts and an unchanged GPS list,
 *   preserving current behavior (Requirement 10.2).
 * - **GPS wins over ghosts (Req 7.4).** A trip with a GPS-visible vehicle is
 *   never surfaced as a ghost. This is enforced by deriving
 *   `gpsVehicleTripIds` from the live vehicles and passing it to
 *   `identifyGhostTrips`, which skips any trip in that set. So when a real
 *   vehicle appears on a trip previously shown as a ghost, the ghost candidate
 *   disappears automatically on the next computation.
 * - **Route ids come from the trip store, not the schedule.** The schedule
 *   payload only maps `trip_id → service_id`, so callers pass a
 *   `trip_id → route_id` lookup built from `tripStore`
 *   (`TranzyTripResponse.route_id`). See {@link buildTripRouteMap}.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4.
 */

import type {
  SchedulePayload,
  GhostVehicleCandidate,
} from '../../types/schedule';
import type { TranzyTripResponse } from '../../types/rawTranzyApi';
import type { EnhancedVehicleData } from '../vehicle/vehicleEnhancementUtils';
import { identifyGhostTrips } from './ghostVehicleUtils';

/**
 * A single item to render on the vehicle display layer. The discriminated
 * `kind` field is the visual-distinction flag the UI uses to draw ghost markers
 * differently from GPS-tracked vehicle markers (Requirement 7.3).
 */
export type VehicleDisplayItem =
  | { kind: 'gps'; vehicle: EnhancedVehicleData }
  | { kind: 'ghost'; ghost: GhostVehicleCandidate };

/** Parameters for {@link getGhostCandidatesForDisplay}. */
export interface GhostDisplayParams {
  /** GPS-visible vehicles currently known (from `vehicleStore`). */
  vehicles: EnhancedVehicleData[];
  /** Trip ids active today (from `scheduleStore` active-service resolution). */
  activeTrips: string[];
  /** Schedule payload, or null when schedule data is unavailable. */
  scheduleData: SchedulePayload | null;
  /** Current time as minutes since midnight. */
  currentMinutes: number;
  /**
   * Optional `trip_id → route_id` lookup (from `tripStore`). When omitted, ghost
   * candidates carry the unknown-route sentinel (`0`) from the detector.
   */
  tripRouteMap?: Record<string, number>;
}

/**
 * Collect the set of trip ids that currently have a GPS-visible vehicle
 * assigned. Vehicles without a `trip_id` (not in service) are ignored.
 *
 * This set is what makes "GPS replaces ghost" work (Req 7.4): any trip present
 * here is excluded from ghost detection.
 */
export function deriveGpsVehicleTripIds(
  vehicles: EnhancedVehicleData[],
): Set<string> {
  const tripIds = new Set<string>();
  for (const vehicle of vehicles) {
    if (vehicle.trip_id) {
      tripIds.add(vehicle.trip_id);
    }
  }
  return tripIds;
}

/**
 * Build a `trip_id → route_id` lookup from trip-store data so ghost candidates
 * can carry a real route id (the schedule payload has no route mapping).
 */
export function buildTripRouteMap(
  trips: TranzyTripResponse[],
): Record<string, number> {
  const map: Record<string, number> = {};
  for (const trip of trips) {
    map[trip.trip_id] = trip.route_id;
  }
  return map;
}

/**
 * Compute the ghost vehicle candidates to display alongside GPS vehicles.
 *
 * Derives the GPS-occupied trip ids from `vehicles`, then defers to
 * `identifyGhostTrips` for the lifecycle rules (scheduled start in the past,
 * scheduled end not passed, no GPS vehicle). Trips with a GPS vehicle are
 * excluded (Req 7.4).
 *
 * @returns Ghost candidates, or an empty array when schedule data is
 *   unavailable (graceful degradation, Req 10.2).
 */
export function getGhostCandidatesForDisplay(
  params: GhostDisplayParams,
): GhostVehicleCandidate[] {
  const { vehicles, activeTrips, scheduleData, currentMinutes, tripRouteMap } =
    params;

  // Graceful degradation: no schedule data -> no ghosts, existing behavior.
  if (!scheduleData) return [];

  const gpsVehicleTripIds = deriveGpsVehicleTripIds(vehicles);

  return identifyGhostTrips(
    activeTrips,
    gpsVehicleTripIds,
    scheduleData,
    currentMinutes,
    tripRouteMap ?? {},
  );
}

/**
 * Combine GPS-enhanced vehicles with ghost candidates into a single ordered
 * display list for the UI layer. GPS vehicles come first (unchanged), followed
 * by ghost markers. The `kind` discriminator lets the renderer style ghosts
 * distinctly (Req 7.3).
 *
 * When `scheduleData` is unavailable, the result contains only the GPS vehicles
 * — identical to the pre-schedule behavior (Req 10.2).
 */
export function combineVehiclesAndGhosts(
  params: GhostDisplayParams,
): VehicleDisplayItem[] {
  const items: VehicleDisplayItem[] = params.vehicles.map((vehicle) => ({
    kind: 'gps' as const,
    vehicle,
  }));

  for (const ghost of getGhostCandidatesForDisplay(params)) {
    items.push({ kind: 'ghost', ghost });
  }

  return items;
}

// ============================================================================
// Vehicle-to-schedule matching & duplicate detection (task 8.2)
// ============================================================================
//
// This section wires the pure matcher (`matchVehiclesToSchedule`) into the
// vehicle display layer, again additively. It annotates each GPS-visible
// vehicle with its schedule match result so the UI can render suspect
// duplicates with reduced confidence and a warning indicator (Req 8.5).
//
// Graceful degradation (Req 8.6): when `scheduleData` is null the matcher is
// skipped entirely and every vehicle is returned unannotated/unflagged —
// identical to the pre-schedule behavior (also Req 10.2).
//
// Requirements: 8.1, 8.4, 8.5, 8.6.

import type { VehicleMatchResult } from '../../types/schedule';
import type { ConfidenceLevel } from '../core/stringConstants';
import { matchVehiclesToSchedule, isHighFrequencyRoute } from './vehicleMatchingUtils';

/**
 * Display-facing annotation derived from a {@link VehicleMatchResult}. Carries
 * the reduced confidence and the explicit warning flag the UI uses to mark
 * suspect duplicates (Req 8.5).
 */
export interface VehicleMatchAnnotation {
  /** Matched trip id, or '' when the vehicle did not match within tolerance. */
  tripId: string;
  /** Match confidence; suspect duplicates are graded low (reduced). */
  matchConfidence: ConfidenceLevel;
  /** True when the vehicle could not be matched to a scheduled trip. */
  isSuspectDuplicate: boolean;
  /** Absolute timing delta to the matched trip, or -1 when not comparable. */
  timingDeltaMinutes: number;
  /** UI hint: render a warning indicator for this vehicle (Req 8.5). */
  showWarningIndicator: boolean;
}

/**
 * A GPS-visible vehicle paired with its schedule match annotation.
 *
 * `match` is `null` when schedule data is unavailable (graceful degradation,
 * Req 8.6) — the vehicle is shown exactly as before, with no duplicate flag.
 */
export interface MatchedVehicle {
  vehicle: EnhancedVehicleData;
  match: VehicleMatchAnnotation | null;
}

/** Parameters for the schedule-matching wiring functions. */
export interface VehicleMatchingParams {
  /** GPS-visible vehicles to match (already enhanced). */
  vehicles: EnhancedVehicleData[];
  /**
   * Candidate active trip ids. The caller is responsible for scoping this set
   * to the relevant route(s); the schedule payload carries no route mapping.
   */
  activeTrips: string[];
  /** Schedule payload, or null when schedule data is unavailable. */
  scheduleData: SchedulePayload | null;
  /** Current time as minutes since midnight. */
  currentMinutes: number;
}

/**
 * Convert a raw match result into a display annotation.
 *
 * When `skipDuplicateFlagging` is true (a high-frequency route, issue #24) the
 * suspect-duplicate flag and its warning indicator are forced off so no vehicle
 * is marked as a duplicate. The matched trip id and timing delta are preserved;
 * only the (unreliable) duplicate signal is suppressed.
 */
function toAnnotation(
  result: VehicleMatchResult,
  skipDuplicateFlagging = false,
): VehicleMatchAnnotation {
  const isSuspectDuplicate = skipDuplicateFlagging ? false : result.isSuspectDuplicate;
  return {
    tripId: result.tripId,
    matchConfidence: result.matchConfidence,
    isSuspectDuplicate,
    timingDeltaMinutes: result.timingDeltaMinutes,
    // The warning indicator tracks the suspect-duplicate flag (Req 8.5).
    showWarningIndicator: isSuspectDuplicate,
  };
}

/**
 * Annotate GPS-visible vehicles with their schedule match results.
 *
 * Runs {@link matchVehiclesToSchedule} and pairs each vehicle (in input order)
 * with its annotation. Suspect duplicates carry reduced (low) confidence and a
 * warning indicator (Req 8.5); matched vehicles carry the graded confidence
 * from the matcher (Req 8.1).
 *
 * When `scheduleData` is null, matching is skipped and every vehicle is
 * returned with `match: null` (graceful degradation, Req 8.6) — preserving the
 * existing all-vehicles-shown behavior with no duplicate detection.
 *
 * @returns One {@link MatchedVehicle} per input vehicle, in input order.
 */
export function applyScheduleMatching(
  params: VehicleMatchingParams,
): MatchedVehicle[] {
  const { vehicles, activeTrips, scheduleData, currentMinutes } = params;

  // Graceful degradation: no schedule -> show all vehicles unannotated.
  if (!scheduleData) {
    return vehicles.map((vehicle) => ({ vehicle, match: null }));
  }

  const results = matchVehiclesToSchedule(
    vehicles,
    activeTrips,
    scheduleData,
    currentMinutes,
  );

  // Issue #24: on high-frequency routes (headway below the matching tolerance)
  // legitimate vehicles routinely fall within tolerance of multiple trips, so
  // suspect-duplicate flagging is unreliable and noisy. Skip it entirely for
  // such routes — show every vehicle without a warning. Low-frequency routes
  // keep normal duplicate detection.
  const skipDuplicateFlagging = isHighFrequencyRoute(
    activeTrips,
    scheduleData,
    currentMinutes,
  );

  // `matchVehiclesToSchedule` returns one result per vehicle in input order.
  return vehicles.map((vehicle, index) => ({
    vehicle,
    match: toAnnotation(results[index], skipDuplicateFlagging),
  }));
}

/**
 * Build a `vehicleId → annotation` lookup for the matched vehicles.
 *
 * Convenience for UI/consumers that already hold the vehicle list and only need
 * to look up a vehicle's duplicate/confidence state by id. Returns an empty map
 * when schedule data is unavailable (graceful degradation, Req 8.6).
 */
export function buildVehicleMatchMap(
  params: VehicleMatchingParams,
): Map<number, VehicleMatchAnnotation> {
  const map = new Map<number, VehicleMatchAnnotation>();
  if (!params.scheduleData) return map;

  for (const { vehicle, match } of applyScheduleMatching(params)) {
    if (match) {
      map.set(vehicle.id, match);
    }
  }
  return map;
}

// ============================================================================
// Start station prediction suppression (task 8.3)
// ============================================================================
//
// This section wires the pure predicate (`shouldSuppressPrediction`) into the
// vehicle position-prediction flow. The actual suppression effect lives in
// `predictVehiclePosition`/`enhanceVehicle`, which accept an optional
// `suppressForwardPrediction` flag (defaulting to off). This helper computes
// that flag from schedule data so a vehicle waiting at its start station before
// its scheduled departure is shown stationary instead of being predicted
// forward along the route (Req 9.1).
//
// Graceful degradation (Req 9.4 / 10.2): when `scheduleData` is null the
// predicate is skipped entirely and `false` is returned, leaving the existing
// GPS-based position prediction behavior unchanged.
//
// Requirements: 9.1, 9.2, 9.3, 9.4.

import type {
  TranzyStopResponse,
  TranzyStopTimeResponse,
} from '../../types/rawTranzyApi';
import { shouldSuppressPrediction } from './startStationUtils';

/** Parameters for {@link isPredictionSuppressed}. */
export interface PredictionSuppressionParams {
  /** The enhanced vehicle (carries trip_id and current GPS position). */
  vehicle: EnhancedVehicleData;
  /** Schedule payload, or null when schedule data is unavailable. */
  scheduleData: SchedulePayload | null;
  /** Tranzy stop-sequence rows for the vehicle's trip. */
  tripStopTimes: TranzyStopTimeResponse[];
  /** Station data providing stop coordinates. */
  stops: TranzyStopResponse[];
  /** Current time as minutes since midnight. */
  currentMinutes: number;
}

/**
 * Decide whether forward position prediction should be suppressed for a vehicle
 * waiting at its start station before its scheduled departure.
 *
 * Defers to the pure predicate {@link shouldSuppressPrediction} for the four
 * suppression conditions (first stop, proximity, before scheduled departure,
 * schedule data present). The resulting boolean is intended to be passed to
 * `enhanceVehicle`/`predictVehiclePosition` via their
 * `suppressForwardPrediction` option so the suppression actually takes effect.
 *
 * When `scheduleData` is null, returns `false` (graceful degradation, Req 9.4)
 * — existing prediction behavior is unchanged.
 */
export function isPredictionSuppressed(
  params: PredictionSuppressionParams,
): boolean {
  const { vehicle, scheduleData, tripStopTimes, stops, currentMinutes } =
    params;

  // Graceful degradation: no schedule data -> never suppress.
  if (!scheduleData) return false;

  return shouldSuppressPrediction(
    vehicle,
    scheduleData,
    tripStopTimes,
    stops,
    currentMinutes,
  );
}
