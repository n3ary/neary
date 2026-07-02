/*
 * routesWithSchedule — the set of route_ids that have at least one
 * trip whose stop_times rows include a usable arrival_time.
 *
 * Why: some adapter pipelines emit "live-only fallback" trips (ids
 * typically ending in `_NT*`) when the static timetable is missing
 * for a (route, direction). These rows exist in trips.txt + stop_times
 * but every stop_time carries an empty arrival_time, so a /schedule/
 * route view for such a route would render an empty board. The UI
 * gates schedule buttons on the route's `hasSchedule` flag (populated
 * from this set) so users
 * don't tap into a dead surface.
 *
 * Caching: the per-route schedule availability doesn't change while a
 * feed is bound, so the result is cached on the database handle.
 * Switching feeds creates a new Database instance; the cache key
 * (the db reference itself) invalidates automatically.
 */

import type { Database } from '@sqlite.org/sqlite-wasm';
import { selectAll } from '../sqlHelpers';

let cache: { db: Database; set: Set<string> } | null = null;

export function getRoutesWithSchedule(db: Database): Set<string> {
  if (cache && cache.db === db) return cache.set;
  const rows = selectAll<{ route_id: string }>(
    db,
    `SELECT DISTINCT t.route_id
     FROM trips t
     WHERE EXISTS (
       SELECT 1 FROM stop_times st
       WHERE st.trip_id = t.trip_id
         AND st.arrival_time IS NOT NULL
         AND st.arrival_time != ''
     );`,
  );
  const set = new Set(rows.map((r) => r.route_id));
  cache = { db, set };
  return set;
}
