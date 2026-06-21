/**
 * Unit tests for schedule ↔ vehicle display integration (task 8.1).
 *
 * Covers Requirements 7.1 (ghost identification surfaced for display),
 * 7.2 (estimated progress passed through), 7.3 (ghosts distinguishable via the
 * display item `kind`), 7.4 (GPS vehicle on a trip removes its ghost), and the
 * additive graceful-degradation guarantee (Req 10.2).
 */

import { describe, it, expect } from 'vitest';
import {
  deriveGpsVehicleTripIds,
  buildTripRouteMap,
  getGhostCandidatesForDisplay,
  combineVehiclesAndGhosts,
} from '../../../utils/schedule/scheduleVehicleIntegration';
import type { SchedulePayload, ScheduleStopTime } from '../../../types/schedule';
import type { TranzyTripResponse } from '../../../types/rawTranzyApi';
import type { EnhancedVehicleData } from '../../../utils/vehicle/vehicleEnhancementUtils';

/** Build a minimal enhanced vehicle; only id/trip_id/route_id matter here. */
function makeVehicle(
  id: number,
  tripId: string | null,
  routeId: number | null = 1,
): EnhancedVehicleData {
  return {
    id,
    label: `V${id}`,
    latitude: 46.77,
    longitude: 23.6,
    timestamp: '2025-01-15T08:00:00Z',
    speed: 20,
    route_id: routeId,
    trip_id: tripId,
    vehicle_type: 3,
    bike_accessible: 'BIKE_INACCESSIBLE',
    wheelchair_accessible: 'WHEELCHAIR_INACCESSIBLE',
    apiLatitude: 46.77,
    apiLongitude: 23.6,
    apiSpeed: 20,
  };
}

/** A trip running from `startMinutes` (stop 0) to `startMinutes + duration`. */
function tripStops(startMinutes: number, duration = 30): ScheduleStopTime[] {
  return [
    { s: 100, q: 0, a: startMinutes, d: startMinutes },
    { s: 101, q: 1, a: startMinutes + duration, d: startMinutes + duration },
  ];
}

function makeSchedule(
  stopTimes: Record<string, ScheduleStopTime[]>,
): SchedulePayload {
  return {
    version: '2025-01-15T03:00:00Z',
    stopTimes,
    calendar: [],
    calendarExceptions: [],
    tripServiceMap: {},
  };
}

function makeTrip(tripId: string, routeId: number): TranzyTripResponse {
  return {
    trip_id: tripId,
    route_id: routeId,
    service_id: 'Mon-Fri',
    trip_headsign: 'Center',
    direction_id: 0,
    block_id: 0,
    shape_id: 'shape-1',
  };
}

describe('deriveGpsVehicleTripIds', () => {
  it('collects non-null trip ids from vehicles', () => {
    const set = deriveGpsVehicleTripIds([
      makeVehicle(1, 'T1'),
      makeVehicle(2, 'T2'),
      makeVehicle(3, null),
    ]);
    expect(set).toEqual(new Set(['T1', 'T2']));
  });

  it('returns an empty set for no vehicles', () => {
    expect(deriveGpsVehicleTripIds([])).toEqual(new Set());
  });
});

describe('buildTripRouteMap', () => {
  it('maps trip_id to route_id from trip-store data', () => {
    const map = buildTripRouteMap([makeTrip('T1', 24), makeTrip('T2', 1)]);
    expect(map).toEqual({ T1: 24, T2: 1 });
  });
});

describe('getGhostCandidatesForDisplay', () => {
  it('surfaces an active trip with no GPS vehicle as a ghost (7.1, 7.2)', () => {
    // Trip started 08:00 (480), runs 30 min; now 08:10 (490) -> in progress.
    const scheduleData = makeSchedule({ T1: tripStops(480, 30) });

    const ghosts = getGhostCandidatesForDisplay({
      vehicles: [],
      activeTrips: ['T1'],
      scheduleData,
      currentMinutes: 490,
      tripRouteMap: { T1: 24 },
    });

    expect(ghosts).toHaveLength(1);
    expect(ghosts[0].tripId).toBe('T1');
    expect(ghosts[0].routeId).toBe(24);
    expect(ghosts[0].scheduledStartMinutes).toBe(480);
    expect(ghosts[0].elapsedMinutes).toBe(10);
    // 10 / 30 elapsed.
    expect(ghosts[0].estimatedProgress).toBeCloseTo(1 / 3, 5);
  });

  it('removes the ghost when a GPS vehicle appears on that trip (7.4)', () => {
    const scheduleData = makeSchedule({ T1: tripStops(480, 30) });

    const ghosts = getGhostCandidatesForDisplay({
      vehicles: [makeVehicle(1, 'T1')], // real vehicle now on T1
      activeTrips: ['T1'],
      scheduleData,
      currentMinutes: 490,
      tripRouteMap: { T1: 24 },
    });

    expect(ghosts).toEqual([]);
  });

  it('uses the unknown-route sentinel when no route map is provided', () => {
    const scheduleData = makeSchedule({ T1: tripStops(480, 30) });

    const ghosts = getGhostCandidatesForDisplay({
      vehicles: [],
      activeTrips: ['T1'],
      scheduleData,
      currentMinutes: 490,
    });

    expect(ghosts[0].routeId).toBe(0);
  });

  it('returns no ghosts when schedule data is unavailable (10.2)', () => {
    const ghosts = getGhostCandidatesForDisplay({
      vehicles: [makeVehicle(1, 'T1')],
      activeTrips: ['T1'],
      scheduleData: null,
      currentMinutes: 490,
    });

    expect(ghosts).toEqual([]);
  });

  it('excludes only the GPS-occupied trip, keeping other ghosts', () => {
    const scheduleData = makeSchedule({
      T1: tripStops(480, 30),
      T2: tripStops(470, 40),
    });

    const ghosts = getGhostCandidatesForDisplay({
      vehicles: [makeVehicle(1, 'T1')],
      activeTrips: ['T1', 'T2'],
      scheduleData,
      currentMinutes: 490,
      tripRouteMap: { T1: 24, T2: 25 },
    });

    expect(ghosts.map((g) => g.tripId)).toEqual(['T2']);
  });
});

describe('combineVehiclesAndGhosts', () => {
  it('lists GPS vehicles first, then ghost markers tagged distinctly (7.3)', () => {
    const scheduleData = makeSchedule({
      T1: tripStops(480, 30), // GPS-occupied
      T2: tripStops(470, 40), // ghost
    });
    const vehicles = [makeVehicle(1, 'T1')];

    const items = combineVehiclesAndGhosts({
      vehicles,
      activeTrips: ['T1', 'T2'],
      scheduleData,
      currentMinutes: 490,
      tripRouteMap: { T1: 24, T2: 25 },
    });

    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ kind: 'gps', vehicle: vehicles[0] });
    expect(items[1].kind).toBe('ghost');
    if (items[1].kind === 'ghost') {
      expect(items[1].ghost.tripId).toBe('T2');
    }
  });

  it('returns only GPS vehicles when schedule data is unavailable (10.2)', () => {
    const vehicles = [makeVehicle(1, 'T1'), makeVehicle(2, 'T2')];

    const items = combineVehiclesAndGhosts({
      vehicles,
      activeTrips: ['T1', 'T2'],
      scheduleData: null,
      currentMinutes: 490,
    });

    expect(items).toEqual([
      { kind: 'gps', vehicle: vehicles[0] },
      { kind: 'gps', vehicle: vehicles[1] },
    ]);
  });
});

// ============================================================================
// Vehicle-to-schedule matching & duplicate detection (task 8.2)
// ============================================================================

import {
  applyScheduleMatching,
  buildVehicleMatchMap,
} from '../../../utils/schedule/scheduleVehicleIntegration';

describe('applyScheduleMatching', () => {
  it('annotates a single matched vehicle as real with no warning (8.1, 8.5)', () => {
    // Vehicle on T1 which starts at 480; now 490 -> 10 min elapsed, delta 0.
    const scheduleData = makeSchedule({ T1: tripStops(480, 30) });
    const vehicles = [makeVehicle(1, 'T1')];

    const matched = applyScheduleMatching({
      vehicles,
      activeTrips: ['T1'],
      scheduleData,
      currentMinutes: 490,
    });

    expect(matched).toHaveLength(1);
    expect(matched[0].vehicle).toBe(vehicles[0]);
    expect(matched[0].match?.isSuspectDuplicate).toBe(false);
    expect(matched[0].match?.showWarningIndicator).toBe(false);
    expect(matched[0].match?.matchConfidence).toBe('high');
    expect(matched[0].match?.tripId).toBe('T1');
    expect(matched[0].match?.timingDeltaMinutes).toBe(0);
  });

  it('flags a vehicle with no schedule anchor as a suspect duplicate (8.4, 8.5)', () => {
    // T1 is active, but the vehicle reports trip T_UNKNOWN (no stop times).
    const scheduleData = makeSchedule({ T1: tripStops(480, 30) });
    const vehicles = [makeVehicle(1, 'T_UNKNOWN')];

    const matched = applyScheduleMatching({
      vehicles,
      activeTrips: ['T1'],
      scheduleData,
      currentMinutes: 490,
    });

    expect(matched[0].match?.isSuspectDuplicate).toBe(true);
    expect(matched[0].match?.showWarningIndicator).toBe(true);
    // Suspect duplicates are graded with reduced (low) confidence.
    expect(matched[0].match?.matchConfidence).toBe('low');
  });

  it('flags the worse of two same-trip vehicles as a suspect duplicate (8.3, 8.5)', () => {
    // Two vehicles both anchored to T1. Their timing deltas tie at 0 (same
    // anchor), so the lower vehicle id wins; the other is the duplicate.
    const scheduleData = makeSchedule({ T1: tripStops(480, 30) });
    const vehicles = [makeVehicle(1, 'T1'), makeVehicle(2, 'T1')];

    const matched = applyScheduleMatching({
      vehicles,
      activeTrips: ['T1'],
      scheduleData,
      currentMinutes: 490,
    });

    const byId = new Map(matched.map((m) => [m.vehicle.id, m.match]));
    expect(byId.get(1)?.isSuspectDuplicate).toBe(false);
    expect(byId.get(2)?.isSuspectDuplicate).toBe(true);
    expect(byId.get(2)?.showWarningIndicator).toBe(true);
  });

  it('skips suspect-duplicate flagging on a high-frequency route (#24)', () => {
    // Three trips 5 min apart -> median headway 5 min (< 10 min tolerance), so
    // the route is high-frequency and duplicate flagging is skipped entirely.
    const scheduleData = makeSchedule({
      T1: tripStops(480, 30),
      T2: tripStops(485, 30),
      T3: tripStops(490, 30),
    });
    // Two vehicles on T1 (would normally tie -> one suspect) plus an unmatchable
    // vehicle (unknown trip) that would normally be flagged too.
    const vehicles = [
      makeVehicle(1, 'T1'),
      makeVehicle(2, 'T1'),
      makeVehicle(3, 'T_UNKNOWN'),
    ];

    const matched = applyScheduleMatching({
      vehicles,
      activeTrips: ['T1', 'T2', 'T3'],
      scheduleData,
      currentMinutes: 488,
    });

    // No vehicle is flagged as a suspect duplicate on a high-frequency route.
    for (const m of matched) {
      expect(m.match?.isSuspectDuplicate).toBe(false);
      expect(m.match?.showWarningIndicator).toBe(false);
    }
  });

  it('keeps suspect-duplicate flagging on a low-frequency route (#24)', () => {
    // Trips 30 min apart -> headway 30 min (>= 10), normal duplicate detection.
    const scheduleData = makeSchedule({
      T1: tripStops(480, 30),
      T2: tripStops(510, 30),
    });
    const vehicles = [makeVehicle(1, 'T1'), makeVehicle(2, 'T1')];

    const matched = applyScheduleMatching({
      vehicles,
      activeTrips: ['T1', 'T2'],
      scheduleData,
      currentMinutes: 490,
    });

    const byId = new Map(matched.map((m) => [m.vehicle.id, m.match]));
    expect(byId.get(1)?.isSuspectDuplicate).toBe(false);
    expect(byId.get(2)?.isSuspectDuplicate).toBe(true);
  });

  it('returns all vehicles unannotated when schedule data is unavailable (8.6)', () => {
    const vehicles = [makeVehicle(1, 'T1'), makeVehicle(2, 'T2')];

    const matched = applyScheduleMatching({
      vehicles,
      activeTrips: ['T1', 'T2'],
      scheduleData: null,
      currentMinutes: 490,
    });

    expect(matched).toEqual([
      { vehicle: vehicles[0], match: null },
      { vehicle: vehicles[1], match: null },
    ]);
  });

  it('preserves input order and length one-to-one with vehicles', () => {
    const scheduleData = makeSchedule({
      T1: tripStops(480, 30),
      T2: tripStops(470, 40),
    });
    const vehicles = [
      makeVehicle(3, 'T2'),
      makeVehicle(1, 'T1'),
      makeVehicle(2, null),
    ];

    const matched = applyScheduleMatching({
      vehicles,
      activeTrips: ['T1', 'T2'],
      scheduleData,
      currentMinutes: 490,
    });

    expect(matched.map((m) => m.vehicle.id)).toEqual([3, 1, 2]);
  });
});

describe('buildVehicleMatchMap', () => {
  it('keys annotations by vehicle id', () => {
    const scheduleData = makeSchedule({ T1: tripStops(480, 30) });
    const vehicles = [makeVehicle(1, 'T1'), makeVehicle(2, 'T_UNKNOWN')];

    const map = buildVehicleMatchMap({
      vehicles,
      activeTrips: ['T1'],
      scheduleData,
      currentMinutes: 490,
    });

    expect(map.get(1)?.isSuspectDuplicate).toBe(false);
    expect(map.get(2)?.isSuspectDuplicate).toBe(true);
  });

  it('returns an empty map when schedule data is unavailable (8.6)', () => {
    const map = buildVehicleMatchMap({
      vehicles: [makeVehicle(1, 'T1')],
      activeTrips: ['T1'],
      scheduleData: null,
      currentMinutes: 490,
    });

    expect(map.size).toBe(0);
  });
});

// ============================================================================
// Start station prediction suppression wiring (task 8.3)
// ============================================================================

import { isPredictionSuppressed } from '../../../utils/schedule/scheduleVehicleIntegration';
import type {
  TranzyStopResponse,
  TranzyStopTimeResponse,
} from '../../../types/rawTranzyApi';

/** Tranzy stop-sequence rows for trip T1: stop 100 (first), then stop 101. */
function makeTripStopTimes(tripId = 'T1'): TranzyStopTimeResponse[] {
  return [
    { trip_id: tripId, stop_id: 100, stop_sequence: 0 },
    { trip_id: tripId, stop_id: 101, stop_sequence: 1 },
  ];
}

/**
 * Stops for the trip. Stop 100 sits at the vehicle's coordinates (46.77, 23.6);
 * stop 101 is far away so the nearest stop to the vehicle is the first stop.
 */
function makeStops(): TranzyStopResponse[] {
  return [
    {
      stop_id: 100,
      stop_name: 'Start',
      stop_lat: 46.77,
      stop_lon: 23.6,
      location_type: 0,
      stop_code: null,
    },
    {
      stop_id: 101,
      stop_name: 'End',
      stop_lat: 46.8,
      stop_lon: 23.7,
      location_type: 0,
      stop_code: null,
    },
  ];
}

describe('isPredictionSuppressed', () => {
  it('suppresses when vehicle waits at start station before departure (9.1, 9.2)', () => {
    // Trip T1 departs at 480; now 470 (before departure). Vehicle is on stop 100.
    const scheduleData = makeSchedule({ T1: tripStops(480, 30) });

    const suppressed = isPredictionSuppressed({
      vehicle: makeVehicle(1, 'T1'),
      scheduleData,
      tripStopTimes: makeTripStopTimes(),
      stops: makeStops(),
      currentMinutes: 470,
    });

    expect(suppressed).toBe(true);
  });

  it('resumes normal prediction once departure time is reached (9.3)', () => {
    const scheduleData = makeSchedule({ T1: tripStops(480, 30) });

    const suppressed = isPredictionSuppressed({
      vehicle: makeVehicle(1, 'T1'),
      scheduleData,
      tripStopTimes: makeTripStopTimes(),
      stops: makeStops(),
      currentMinutes: 480, // departure reached
    });

    expect(suppressed).toBe(false);
  });

  it('does not suppress when schedule data is unavailable (9.4, 10.2)', () => {
    const suppressed = isPredictionSuppressed({
      vehicle: makeVehicle(1, 'T1'),
      scheduleData: null,
      tripStopTimes: makeTripStopTimes(),
      stops: makeStops(),
      currentMinutes: 470,
    });

    expect(suppressed).toBe(false);
  });

  it('does not suppress a vehicle with no trip assignment', () => {
    const scheduleData = makeSchedule({ T1: tripStops(480, 30) });

    const suppressed = isPredictionSuppressed({
      vehicle: makeVehicle(1, null),
      scheduleData,
      tripStopTimes: makeTripStopTimes(),
      stops: makeStops(),
      currentMinutes: 470,
    });

    expect(suppressed).toBe(false);
  });
});
