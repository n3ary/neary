/*
 * scheduleScanner — first pipeline stage. Pure function: given a flat list
 * of GTFS rows (joined stop_times + trips + routes) at a target stop and
 * the current `nowMinSinceMidnight`, emit one Vehicle per scheduled
 * arrival in the active window.
 *
 * EVERY row emitted here is `kind: 'scheduled'`. That's intentional:
 * 'scheduled' just means "this trip exists in the schedule", which is
 * the only thing we know in a schedule-only pipeline. The `'predicted'`
 * kind is reserved for the live reconciler (Phase 5+): it emits a
 * `predicted` vehicle when we've polled live sources, found none
 * reporting the trip, and chose to *estimate* its position from the
 * schedule. That choice doesn't exist at this layer.
 *
 * Map view position interpolation along the route shape is a separate
 * rendering concern and doesn't change the kind.
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
  /** Max stop_sequence for the same trip — i.e. the terminus index.
   *  When `stop_sequence === last_seq` this row is the trip's terminus
   *  arrival, which we treat as drop-off-only regardless of what
   *  `pickup_type` says (operators routinely leave it null). */
  last_seq: number;
  /** GTFS time at which this trip arrives at its terminus. Used to keep
   *  a vehicle in the 'departed' bucket only while it's still en route. */
  trip_end_time: string;
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
   *  stamps a position; the live reconciler will use it in Phase 5. */
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
      // route_id can be TEXT in GTFS; we keep number for legacy compat
      // until ID types are fully widened (tracked in vehicles-and-views).
      id: Number(r.route_id),
      shortName: r.route_short_name,
      color: r.route_color ? `#${r.route_color}` : '#666666',
      textColor: r.route_text_color ? `#${r.route_text_color}` : undefined,
    };
    const type: VehicleType = vehicleTypeFromGtfs(r.route_type);
    const schedule: ScheduledRun = {
      tripId: r.trip_id,
      scheduledArrival: arrivalMin,
      scheduledDeparture: departureMin,
      headsign: r.trip_headsign ?? undefined,
    };
    const dropOffOnly =
      Number(r.pickup_type) === 1 || r.stop_sequence === r.last_seq
        ? true
        : undefined;
    const etaMinutes = arrivalMin - nowMinSinceMidnight;

    out.push({
      kind: 'scheduled',
      id: `trip:${r.trip_id}`,
      route,
      type,
      schedule,
      headsign: r.trip_headsign ?? undefined,
      dropOffOnly,
      confidence: 'low',
      eta: {
        distanceMeters: 0,
        minutes: etaMinutes,
        confidence: 'low',
      },
    });
  }
  return out;
}
