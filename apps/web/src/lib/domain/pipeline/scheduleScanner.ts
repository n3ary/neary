/*
 * scheduleScanner — first pipeline stage. Pure function: given a flat list
 * of GTFS rows (joined stop_times + trips + routes) at a target stop and
 * the current `nowMinSinceMidnight`, emit one Vehicle per scheduled
 * arrival in the window.
 *
 *   kind = 'scheduled'  → future arrival
 *   kind = 'predicted'  → scheduled to be at/around the stop right now
 *                         (between arrival - 1 min and departure + 5 min).
 *                         Position is the stop's lat/lon as a placeholder
 *                         until the shape-walking predictor lands in a
 *                         later phase. Confidence 'low' to flag it.
 *
 * No live data is consumed here. Downstream stages (Phase 5) take this
 * output and upgrade `kind` to live/reconciled/corroborated as live
 * sources report matches.
 */

import type {
  LiveSource,
  Route,
  ScheduledRun,
  Vehicle,
  VehicleType,
} from '../types';
import { vehicleTypeFromGtfs } from '../types';
import { DEFAULT_CONFIG } from '../config';
import { timeToMinutes } from './timeUtils';

/** Raw row shape from the joined SQL query the worker runs. */
export interface ScheduleRow {
  trip_id: string;
  arrival_time: string;        // GTFS HH:MM:SS (24h+ allowed)
  departure_time: string;
  pickup_type: number | null;  // 1 = drop-off only
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
  /** Unix ms for the same "now". Stamped onto position.asOf for predicted. */
  nowMs: number;
  /** How many minutes in the future to include. */
  windowMinutes: number;
  /** How many minutes in the past to include (so the bucketer can produce
   *  the `departed` bucket from this same scan). Default 5 — matches the
   *  recency window in buckets.ts. */
  pastWindowMinutes?: number;
  /** Sources we tried to query for live data, even if none responded for
   *  this trip. Empty array means "we only have schedule, no live wired". */
  checkedSources?: LiveSource[];
}

const PREDICTED_DEPARTURE_GRACE_MIN = DEFAULT_CONFIG.predictedDepartureGraceMin;

export function scanSchedule(inputs: ScheduleScannerInputs): Vehicle[] {
  const {
    rows,
    nowMinSinceMidnight,
    nowMs,
    windowMinutes,
    pastWindowMinutes = 5,
    checkedSources = [],
  } = inputs;

  const lower = nowMinSinceMidnight - pastWindowMinutes;
  const upper = nowMinSinceMidnight + windowMinutes;

  const out: Vehicle[] = [];
  for (const r of rows) {
    const arrivalMin = timeToMinutes(r.arrival_time);
    const departureMin = timeToMinutes(r.departure_time);
    // GTFS allows 25:30:00 etc. for trips that cross midnight — accept
    // them but only when the wall-clock window can reach them. Cheap
    // filter on the arrival time:
    if (arrivalMin < lower || arrivalMin > upper) continue;

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
    const dropOffOnly = Number(r.pickup_type) === 1 ? true : undefined;
    const id = `trip:${r.trip_id}`;
    const etaMinutes = arrivalMin - nowMinSinceMidnight;
    const eta = {
      distanceMeters: 0,
      minutes: etaMinutes,
      confidence: 'low' as const,
    };

    const isCurrentlyAtStop =
      nowMinSinceMidnight >= arrivalMin - 1 &&
      nowMinSinceMidnight <= departureMin + PREDICTED_DEPARTURE_GRACE_MIN;

    if (isCurrentlyAtStop) {
      out.push({
        kind: 'predicted',
        id,
        route,
        type,
        schedule,
        headsign: r.trip_headsign ?? undefined,
        dropOffOnly,
        confidence: 'low',
        position: {
          lat: r.stop_lat,
          lon: r.stop_lon,
          source: 'predicted-from-schedule',
          asOf: nowMs,
        },
        checkedSources,
        eta,
      });
    } else {
      out.push({
        kind: 'scheduled',
        id,
        route,
        type,
        schedule,
        headsign: r.trip_headsign ?? undefined,
        dropOffOnly,
        confidence: 'low',
        eta,
      });
    }
  }
  return out;
}
