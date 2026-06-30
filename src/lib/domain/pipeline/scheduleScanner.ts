/*
 * scheduleScanner — first pipeline stage. Pure function: given a flat list
 * of GTFS rows (joined stop_times + trips + routes) at a target stop and
 * the current `nowMinSinceMidnight`, emit one Vehicle per scheduled
 * arrival in the active window.
 *
 * EVERY row emitted here is `kind: 'scheduled'`. That's intentional:
 * 'scheduled' just means "this trip exists in the schedule", which is
 * the only thing we know in a schedule-only pipeline. The live
 * reconciler upgrades matched rows to `tracked` / `verified` downstream.
 *
 * Map view position interpolation along the route shape is a separate
 * rendering concern and doesn't change the kind — a scheduled row
 * whose `schedule.tripPhase` is `last` or `on-route` can carry an
 * interpolated position with `source: 'predicted-from-schedule'`.
 */

import type {
  Route,
  ScheduledRun,
  Vehicle,
  VehicleType,
} from '../types';
import { vehicleTypeFromGtfs } from '../types';
import { timeToMinutes } from './timeUtils';

/** Raw row shape from the joined SQL query the worker runs. */
export interface ScheduleRow {
  trip_id: string;
  arrival_time: string;        // GTFS HH:MM:SS (24h+ allowed)
  departure_time: string;
  pickup_type: number | null;  // 1 = drop-off only
  /** Position of this stop within the trip's stop_times. */
  stop_sequence: number;
  /** Min stop_sequence for the same trip — i.e. the origin index.
   *  When `stop_sequence === first_seq` this row is the trip's start,
   *  which means schedule is authoritative for the displayed ETA
   *  (no GPS-based prediction is possible before departure). */
  first_seq: number;
  /** Max stop_sequence for the same trip — i.e. the terminus index.
   *  When `stop_sequence === last_seq` this row is the trip's terminus
   *  arrival, which we treat as drop-off-only regardless of what
   *  `pickup_type` says (operators routinely leave it null). */
  last_seq: number;
  /** GTFS time at which this trip arrives at its terminus. Used to keep
   *  a vehicle in the 'departed' bucket only while it's still en route. */
  trip_end_time: string;
  /** GTFS time at which this trip departs its FIRST stop (origin).
   *  Surfaced so the reconciler can match live observations by
   *  (route, direction, start_time) instead of trip_id. */
  trip_start_time: string;
  /** GTFS `trips.direction_id` (0 or 1). Used as part of the reconciler's
   *  match key. May be null if the feed doesn't populate it. */
  direction_id: number | null;
  route_id: string | number;
  route_short_name: string;
  route_color: string | null;
  route_text_color: string | null;
  route_type: number | null;
  trip_headsign: string | null;
  stop_lat: number;
  stop_lon: number;
}

export interface ScheduleScannerInputs {
  rows: ScheduleRow[];
  /** Minutes since local midnight when "now" happened. */
  nowMinSinceMidnight: number;
  /** Unix ms for the same "now". Reserved — unused now that nothing here
   *  stamps a position; the live reconciler will use it. */
  nowMs: number;
  /** How many minutes in the future to include. */
  windowMinutes: number;
}

export function scanSchedule(inputs: ScheduleScannerInputs): Vehicle[] {
  const {
    rows,
    nowMinSinceMidnight,
    windowMinutes,
  } = inputs;

  const upper = nowMinSinceMidnight + windowMinutes;

  const out: Vehicle[] = [];
  for (const r of rows) {
    const arrivalMin = timeToMinutes(r.arrival_time);
    const departureMin = timeToMinutes(r.departure_time);
    const tripEndMin = timeToMinutes(r.trip_end_time);

    // Inclusion rule:
    //   * future arrivals up to `windowMinutes` ahead, OR
    //   * past arrivals whose trip hasn't yet reached its terminus (so the
    //     vehicle is still en route somewhere on the line and belongs in
    //     the 'departed' bucket on this stop's board).
    if (arrivalMin > upper) continue;
    if (arrivalMin <= nowMinSinceMidnight && tripEndMin <= nowMinSinceMidnight) {
      continue;
    }

    const route: Route = {
      // GTFS route_id is text per the spec; keep it as the worker
      // emitted it. Number() coercion here would map non-numeric ids
      // (e.g. '102L') to NaN.
      id: String(r.route_id),
      shortName: r.route_short_name,
      color: r.route_color ? `#${r.route_color}` : '#F3513C',
      textColor: r.route_text_color ? `#${r.route_text_color}` : undefined,
    };
    const type: VehicleType = vehicleTypeFromGtfs(r.route_type);
    const schedule: ScheduledRun = {
      tripId: r.trip_id,
      scheduledArrival: arrivalMin,
      scheduledDeparture: departureMin,
      headsign: r.trip_headsign ?? undefined,
      directionId: r.direction_id === 0 || r.direction_id === 1 ? r.direction_id : -1,
      tripStartMin: timeToMinutes(r.trip_start_time),
      isFirstStop: r.stop_sequence === r.first_seq,
      isLastStop: r.stop_sequence === r.last_seq || undefined,
    };
    const dropOffOnly =
      Number(r.pickup_type) === 1 || r.stop_sequence === r.last_seq
        ? true
        : undefined;
    const etaMinutes = arrivalMin - nowMinSinceMidnight;
    // Confidence rule (initial — `assignTripPhases` upgrades `next`
    // rows to `high` once the phase is known):
    //   At the trip's origin the schedule IS authoritative — the bus is
    //   parked, no GPS-based ETA is possible before departure. Default
    //   to `medium` so the UI doesn't fade it.
    //   At intermediate stops a schedule-only row (no live match) is
    //   inherently low-confidence: it's a wall-clock guess with no GPS
    //   to back it up.
    // Reconciler bumps matched rows to 'medium' / 'high' downstream.
    const confidence = schedule.isFirstStop ? 'medium' : 'low';

    out.push({
      kind: 'scheduled',
      id: `trip:${r.trip_id}`,
      route,
      type,
      tripId: r.trip_id,
      directionId: schedule.directionId,
      schedule,
      headsign: r.trip_headsign ?? undefined,
      dropOffOnly,
      confidence,
      eta: {
        distanceMeters: 0,
        minutes: etaMinutes,
        confidence,
      },
    });
  }
  assignTripPhases(out, nowMinSinceMidnight);
  return out;
}

/** Classify each emitted row by the trip's lifecycle phase on its
 *  route relative to `now`. Mutates the rows in place because
 *  `schedule` is the local object pushed onto each emitted vehicle.
 *
 *  Per route, among the rows emitted at this stop:
 *    - exactly one `next`     → smallest `tripStartMin > now`
 *    - at most one `last`     → largest `tripStartMin <= now`
 *      (the trip is still running because the scanner already filtered
 *      out past trips whose `tripEnd <= now`)
 *    - `on-route`             → any earlier past departure still running
 *    - `later`                → any future departure that is not `next`
 *
 *  Applied to every row, not only origin rows: tripPhase is a property
 *  of the trip's lifecycle (when it left origin vs `now`), independent
 *  of which stop's row we're looking at. At a terminus, a row's
 *  tripPhase reads "this trip's bus has just left origin / is on the
 *  road / is the next one to start", which is what UI consumers
 *  (drop-off filter, action-button gates) actually want.
 *
 *  Tie-break by `tripId` lexicographic order when two trips share a
 *  scheduled departure time (rare but GTFS-legal).
 *
 *  Scoped per `(routeId, directionId)`: a stop that's the origin for
 *  one direction of a route AND the terminus for the other direction
 *  will see rows for BOTH directions in the same emission set. Each
 *  direction needs its own `next` / `last` — otherwise a dir-1 arrival
 *  with an earlier `tripStartMin` would steal the `next` slot from
 *  the soonest dir-0 origin departure. */
function assignTripPhases(vehicles: Vehicle[], nowMin: number): void {
  const byCohort = new Map<string, Vehicle[]>();
  for (const v of vehicles) {
    if (v.schedule?.tripStartMin == null) continue;
    const key = `${v.route.id}_${v.directionId ?? -1}`;
    const list = byCohort.get(key);
    if (list) list.push(v);
    else byCohort.set(key, [v]);
  }
  for (const list of byCohort.values()) {
    list.sort((a, b) => {
      const da = a.schedule!.tripStartMin!;
      const db = b.schedule!.tripStartMin!;
      if (da !== db) return da - db;
      return a.schedule!.tripId.localeCompare(b.schedule!.tripId);
    });
    let lastIdx = -1;
    let nextIdx = -1;
    for (let i = 0; i < list.length; i += 1) {
      const dep = list[i].schedule!.tripStartMin!;
      if (dep <= nowMin) lastIdx = i;
      else {
        nextIdx = i;
        break;
      }
    }
    for (let i = 0; i < list.length; i += 1) {
      const v = list[i];
      const schedule = v.schedule!;
      if (i === nextIdx) {
        schedule.tripPhase = 'next';
        // Only bump confidence at the trip's origin: the `next` bus is
        // parked there and schedule IS the position. At downstream
        // stops the bus is somewhere on the road and the schedule is
        // just a prediction, so confidence stays at its default.
        if (schedule.isFirstStop) {
          v.confidence = 'high';
          if (v.eta) v.eta.confidence = 'high';
        }
      } else if (i === lastIdx) {
        schedule.tripPhase = 'last';
      } else if (lastIdx >= 0 && i < lastIdx) {
        schedule.tripPhase = 'on-route';
      } else {
        schedule.tripPhase = 'later';
      }
    }
  }
}
