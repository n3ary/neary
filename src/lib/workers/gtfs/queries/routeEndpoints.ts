/*
 * Origin + end-stop names for a (route, direction). Stable across
 * trips on the same direction (occasional short-runs notwithstanding)
 * so we read them from one representative trip via `LIMIT 1` instead
 * of scanning all of them.
 *
 * Lets the schedule + map headers paint immediately, before (and
 * independent of) the trip / shape fetches that drive the body.
 */

import type { Database } from '@sqlite.org/sqlite-wasm';
import type { RouteDirectionEndpoints } from '$lib/data/gtfs/types';
import { selectAll } from '../sqlHelpers';

export function getRouteDirectionEndpoints(
  db: Database,
  routeId: string,
  directionId: 0 | 1,
): RouteDirectionEndpoints | null {
  type Row = { origin_name: string | null; terminus_name: string | null };
  const rows = selectAll<Row>(
    db,
    `SELECT
       (SELECT s.stop_name FROM stop_times st JOIN stops s ON s.stop_id = st.stop_id
        WHERE st.trip_id = t.trip_id ORDER BY st.stop_sequence ASC LIMIT 1) AS origin_name,
       (SELECT s.stop_name FROM stop_times st JOIN stops s ON s.stop_id = st.stop_id
        WHERE st.trip_id = t.trip_id ORDER BY st.stop_sequence DESC LIMIT 1) AS terminus_name
     FROM trips t
     WHERE t.route_id = ? AND t.direction_id = ?
     LIMIT 1;`,
    [routeId, directionId],
  );
  const r = rows[0];
  if (!r || !r.origin_name || !r.terminus_name) return null;
  return { originName: r.origin_name, terminusName: r.terminus_name };
}
