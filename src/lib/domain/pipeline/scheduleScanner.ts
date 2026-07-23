// First pipeline stage. Pure: emits one Vehicle per scheduled arrival in the active window — all `kind: 'scheduled'`. The live reconciler upgrades matched rows to `tracked`/`verified` downstream.

import type {
  Route,
  ScheduledRun,
  Vehicle,
  VehicleType,
} from '../types';
import { MISSING_ROUTE_COLOR, vehicleTypeFromGtfs } from '../types';
import { timeToMinutes } from './timeUtils';

/** Raw row from the joined SQL query the worker runs. */
export interface ScheduleRow {
  trip_id: string;
  /** GTFS HH:MM:SS (24h+ allowed). */
  arrival_time: string;
  departure_time: string;
  /** 1 = drop-off only. */
  pickup_type: number | null;
  /** Position of this stop within the trip's stop_times. */
  stop_sequence: number;
  /** Min stop_sequence for the same trip. When `stop_sequence === first_seq` this row is the trip's origin; schedule is authoritative (no GPS prediction possible before departure). */
  first_seq: number;
  /** Max stop_sequence. When `stop_sequence === last_seq` this row is the terminus; treated as drop-off-only regardless of pickup_type (operators routinely leave it null). */
  last_seq: number;
  /** Trip-terminus GTFS time. Keeps the vehicle in 'departed' only while it's still en route. */
  trip_end_time: string;
  /** Trip-origin GTFS time. Reconciler matches by (route, direction, start_time) instead of trip_id. */
  trip_start_time: string;
  /** GTFS trips.direction_id (0, 1, or null). Part of the reconciler's match key. */
  direction_id: number | null;
  route_id: string | number;
  route_short_name: string;
  route_color: string | null;
  route_text_color: string | null;
  route_type: number | null;
  trip_headsign: string | null;
  stop_lat: number;
  stop_lon: number;
  /** Optional override for the emitted Vehicle.id. Defaults to
   *  `trip:${trip_id}` when undefined. Used by the frequency-expansion
   *  path to encode the generated departure's effective time, so
   *  two generated departures for the same anchor trip get distinct
   *  stable ids (and downstream consumers that key on `id` don't
   *  collapse them). */
  id?: string;
}

export interface ScheduleScannerInputs {
  rows: ScheduleRow[];
  /** Minutes since local midnight when "now" happened. */
  nowMinSinceMidnight: number;
  /** Unix ms for the same "now". Unused currently — the live reconciler will use it. */
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

    // Drop rows with unparseable arrival_time — adapter-emitted live-only fallback trips (`..._NT001`) ship without per-stop times. Without a real time we'd emit `NaN min` into the UI.
    if (!Number.isFinite(arrivalMin)) continue;

    // Inclusion: future arrivals up to windowMinutes ahead, OR past arrivals whose trip hasn't reached its terminus (still en route, belongs in 'departed').
    if (arrivalMin > upper) continue;
    if (arrivalMin <= nowMinSinceMidnight && tripEndMin <= nowMinSinceMidnight) {
      continue;
    }

    const route: Route = {
      // GTFS route_id is text per spec; keep as the worker emitted it. Number() would map non-numeric ids ('102L') to NaN.
      id: String(r.route_id),
      shortName: r.route_short_name,
      color: r.route_color ? `#${r.route_color}` : MISSING_ROUTE_COLOR,
      textColor: r.route_text_color ? `#${r.route_text_color}` : undefined,
      // NaN-arrival skip above guarantees this trip has a usable arrival_time — set explicitly so consumers don't fall through ?? true.
      hasSchedule: true,
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
    // Initial confidence: at origin the schedule IS authoritative (bus is parked), so 'medium' instead of fading. At intermediate stops a no-GPS match is inherently low-confidence wall-clock guess. Reconciler bumps matched rows downstream.
    const confidence = schedule.isFirstStop ? 'medium' : 'low';

    out.push({
      kind: 'scheduled',
      id: r.id ?? `trip:${r.trip_id}`,
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

/** Classify each emitted row by the trip's lifecycle phase on its route (per `(routeId, directionId)` cohort): exactly one `next` (smallest tripStartMin > now), at most one `last` (largest <= now, still running because the scanner already filtered trips past terminus), `on-route` (any earlier past departure still running), `later` (any future departure that isn't `next`). Applied to every row, not only origin rows — tripPhase is a property of the trip's lifecycle, independent of which stop's row we're looking at. Tie-break by tripId when two trips share a departure time. */
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
        // Only at the trip's origin: the `next` bus is parked and schedule IS the position. At downstream stops the bus is on the road and schedule is just a prediction.
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
