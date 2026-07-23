/*
 * Recurring weekly departure pattern for a (route, direction).
 * Origin departure times grouped by which day-of-week pattern the
 * trip's `service_id` matches (weekday / saturday / sunday).
 *
 * Intentionally ignores `calendar_dates` exceptions — the weekly
 * table is a recurring-pattern view, not a what-runs-on-a-specific-
 * day view.
 *
 * For frequency-based trips (rows in `frequencies.txt`), the
 * recurring pattern is "every `headway_secs` from `start_time` to
 * `end_time`" — we expand each frequency row into one synthetic
 * minute slot per generated departure and union with the
 * schedule-based set.
 */

import type { Database } from '@sqlite.org/sqlite-wasm';
import type { WeeklySchedule } from '$lib/data/gtfs/types';
import { timeToMinutes } from '$lib/domain/pipeline/timeUtils';
import { selectAll } from '../sqlHelpers';

export function getWeeklySchedule(
  db: Database,
  routeId: string,
  directionId: 0 | 1,
  hasFrequencies: boolean,
): WeeklySchedule {
  type Row = {
    trip_id: string;
    departure_time: string;
    monday: number;
    tuesday: number;
    wednesday: number;
    thursday: number;
    friday: number;
    saturday: number;
    sunday: number;
  };
  const rows = selectAll<Row>(
    db,
    `SELECT t.trip_id,
       (SELECT departure_time FROM stop_times
         WHERE trip_id = t.trip_id
         ORDER BY stop_sequence ASC LIMIT 1) AS departure_time,
       c.monday, c.tuesday, c.wednesday, c.thursday, c.friday,
       c.saturday, c.sunday
     FROM trips t
     JOIN calendar c ON c.service_id = t.service_id
     WHERE t.route_id = ? AND t.direction_id = ?;`,
    [routeId, directionId],
  );

  const weekday = new Set<number>();
  const saturday = new Set<number>();
  const sunday = new Set<number>();
  const addAt = (min: number, dayBits: { mon: number; tue: number; wed: number; thu: number; fri: number; sat: number; sun: number }) => {
    if (dayBits.mon || dayBits.tue || dayBits.wed || dayBits.thu || dayBits.fri) {
      weekday.add(min);
    }
    if (dayBits.sat) saturday.add(min);
    if (dayBits.sun) sunday.add(min);
  };
  for (const r of rows) {
    if (!r.departure_time) continue;
    const m = timeToMinutes(r.departure_time);
    if (!Number.isFinite(m)) continue;
    addAt(m, {
      mon: r.monday, tue: r.tuesday, wed: r.wednesday, thu: r.thursday, fri: r.friday,
      sat: r.saturday, sun: r.sunday,
    });
  }
  // Frequency expansion. For each frequency row whose anchor is on
  // this (route, direction) and runs on a service with the
  // matching day bits, add start_time + k*headway_min for k=0..(N-1)
  // where N = floor((end_time - start_time) / headway). This mirrors
  // the JS expansion in frequencyExpansion.ts but only for the
  // weekly pattern view (no window filter, full day).
  if (hasFrequencies) {
    type FreqRow = {
      trip_id: string;
      start_time: string;
      end_time: string;
      headway_secs: number;
      monday: number;
      tuesday: number;
      wednesday: number;
      thursday: number;
      friday: number;
      saturday: number;
      sunday: number;
    };
    const freqRows = selectAll<FreqRow>(
      db,
      `SELECT t.trip_id, f.start_time, f.end_time, f.headway_secs,
              c.monday, c.tuesday, c.wednesday, c.thursday, c.friday,
              c.saturday, c.sunday
       FROM frequencies f
       JOIN trips t ON t.trip_id = f.trip_id
       JOIN calendar c ON c.service_id = t.service_id
       WHERE t.route_id = ? AND t.direction_id = ?
         AND (f.exact_times IS NULL OR f.exact_times = 0);`,
      [routeId, directionId],
    );
    for (const f of freqRows) {
      const startMin = timeToMinutes(f.start_time);
      const endMin = timeToMinutes(f.end_time);
      const headwayMin = f.headway_secs / 60;
      if (!Number.isFinite(startMin) || !Number.isFinite(endMin) || !(headwayMin > 0)) continue;
      // Generate all departures in [startMin, endMin) (spec: up to
      // but not including end_time). Weekly view is full day so no
      // window cap.
      const dayBits = {
        mon: f.monday, tue: f.tuesday, wed: f.wednesday, thu: f.thursday, fri: f.friday,
        sat: f.saturday, sun: f.sunday,
      };
      for (let k = 0; ; k++) {
        const m = startMin + k * headwayMin;
        if (m >= endMin) break;
        addAt(Math.round(m), dayBits);
      }
    }
  }
  const sorted = (s: Set<number>) => Array.from(s).sort((a, b) => a - b);
  return {
    weekday: sorted(weekday),
    saturday: sorted(saturday),
    sunday: sorted(sunday),
  };
}
