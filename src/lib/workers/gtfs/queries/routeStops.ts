/*
 * Stop sequence for one trip — the ordered list of stops with their
 * scheduled arrival times. Drives the schedule-view's stop strip
 * and feeds the map view's per-trip projection.
 */

import type { Database } from '@sqlite.org/sqlite-wasm';
import type { ScheduleTripStop } from '$lib/data/gtfs/types';
import { timeToMinutes } from '$lib/domain/pipeline/timeUtils';
import { selectAll } from '../sqlHelpers';

export function getStopsAlongTrip(db: Database, tripId: string): ScheduleTripStop[] {
  type Row = {
    stop_id: number;
    stop_name: string;
    stop_lat: number;
    stop_lon: number;
    arrival_time: string;
    stop_sequence: number;
    shape_dist_traveled: number | null;
  };
  const rows = selectAll<Row>(
    db,
    `SELECT s.stop_id, s.stop_name, s.stop_lat, s.stop_lon,
            st.arrival_time, st.stop_sequence, st.shape_dist_traveled
     FROM stop_times st
     JOIN stops s ON s.stop_id = st.stop_id
     WHERE st.trip_id = ?
     ORDER BY st.stop_sequence ASC;`,
    [tripId],
  );
  return rows.map((r) => ({
    stopId: r.stop_id,
    stopName: r.stop_name,
    lat: r.stop_lat,
    lon: r.stop_lon,
    arrivalTime: r.arrival_time,
    arrivalMin: timeToMinutes(r.arrival_time),
    stopSequence: r.stop_sequence,
    distAlongM: r.shape_dist_traveled ?? undefined,
  }));
}

export function getStopDistancesForTrips(
  db: Database,
  tripIds: readonly string[],
): Record<string, number[]> {
  if (tripIds.length === 0) return {};
  const uniq = Array.from(new Set(tripIds));
  const ph = uniq.map(() => '?').join(',');
  type Row = {
    trip_id: string;
    stop_sequence: number;
    shape_dist_traveled: number | null;
  };
  const rows = selectAll<Row>(
    db,
    `SELECT trip_id, stop_sequence, shape_dist_traveled
     FROM stop_times
     WHERE trip_id IN (${ph})
       AND shape_dist_traveled IS NOT NULL
     ORDER BY trip_id, stop_sequence ASC;`,
    uniq,
  );
  const out: Record<string, number[]> = {};
  for (const r of rows) {
    if (!(r.trip_id in out)) out[r.trip_id] = [];
    out[r.trip_id].push(r.shape_dist_traveled as number);
  }
  return out;
}
