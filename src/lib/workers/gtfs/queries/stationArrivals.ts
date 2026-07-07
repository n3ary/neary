/*
 * Per-stop scheduled arrivals — the main station-card data source.
 *
 * Returns one `Vehicle` per scheduled arrival at this stop, in the
 * "today + window" view. Everything is `kind: 'scheduled'`; the
 * reconciliation upgrade happens later via `mergeReconciledIntoStationBoard`
 * on the main thread using the worker's broadcast.
 */

import type { Database } from '@sqlite.org/sqlite-wasm';
import type { Vehicle } from '$lib/domain/types';
import { scanSchedule, type ScheduleRow } from '$lib/domain/pipeline/scheduleScanner';
import { dateKeyInTz, minSinceMidnightInTz } from '$lib/domain/pipeline/timeUtils';
import { activeServicesOn } from '../activeServices';
import { selectAll } from '../sqlHelpers';

export function getStationArrivals(
  db: Database,
  tz: string,
  stopId: string,
  nowMs: number,
  windowMinutes: number,
): Vehicle[] {
  const localDate = dateKeyInTz(nowMs, tz);
  const nowMinSinceMidnight = minSinceMidnightInTz(nowMs, tz);

  const services = activeServicesOn(db, localDate);
  if (services.length === 0) return [];

  const placeholders = services.map(() => '?').join(',');
  const rows = selectAll<ScheduleRow>(
    db,
    // Four correlated subqueries per row:
    //   first_seq        — trip's origin index. Used to flag the
    //                      row as "this stop is the trip's start"
    //                      so the UI can render it at full opacity
    //                      (schedule is authoritative there) while
    //                      fading intermediate-stop scheduled rows.
    //   last_seq         — trip's end-stop index, used to detect
    //                      drop-off-only arrivals there.
    //   trip_end_time    — arrival_time at the end stop, used to keep
    //                      a vehicle in the 'departed' bucket only
    //                      while it's still en route (not yet arrived
    //                      at its end stop).
    //   trip_start_time  — departure_time at the trip's FIRST stop
    //                      (origin). Surfaced for the reconciler so it
    //                      can match live observations by
    //                      (route, direction, start_time) instead of
    //                      trip_id (trip_ids drift between static GTFS
    //                      and GTFS-RT feeds in some operators).
    // All four are cheap thanks to stop_times_trip_seq_idx (trip_id, stop_sequence).
    `SELECT st.trip_id, st.arrival_time, st.departure_time, st.pickup_type,
            st.stop_sequence,
            t.direction_id,
            (SELECT MIN(stop_sequence) FROM stop_times WHERE trip_id = st.trip_id) AS first_seq,
            (SELECT MAX(stop_sequence) FROM stop_times WHERE trip_id = st.trip_id) AS last_seq,
            (SELECT arrival_time FROM stop_times WHERE trip_id = st.trip_id
             ORDER BY stop_sequence DESC LIMIT 1) AS trip_end_time,
            (SELECT departure_time FROM stop_times WHERE trip_id = st.trip_id
             ORDER BY stop_sequence ASC LIMIT 1) AS trip_start_time,
            r.route_id, r.route_short_name, r.route_color, r.route_text_color, r.route_type,
            t.trip_headsign,
            s.stop_lat, s.stop_lon
     FROM stop_times st
     JOIN trips t  ON t.trip_id  = st.trip_id
     JOIN routes r ON r.route_id = t.route_id
     JOIN stops s  ON s.stop_id  = st.stop_id
     WHERE st.stop_id = ?
       AND t.service_id IN (${placeholders});`,
    [stopId, ...services],
  );

  return scanSchedule({
    rows,
    nowMinSinceMidnight,
    nowMs,
    windowMinutes,
  });
}
