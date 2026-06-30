/*
 * Route queries — all metadata about lines themselves: full list,
 * by id, by stop. None of these depend on calendar/time; they all
 * project routes.txt rows to the UI's Route shape.
 */

import type { Database } from '@sqlite.org/sqlite-wasm';
import type { Route } from '$lib/domain/types';
import { vehicleTypeFromGtfs } from '$lib/domain/types';
import { selectAll } from '../sqlHelpers';
import { getRoutesWithSchedule } from './routesWithSchedule';

type RouteRow = {
  route_id: string;
  route_short_name: string;
  route_long_name: string | null;
  route_desc: string | null;
  route_color: string | null;
  route_text_color: string | null;
  route_type: number | null;
};

// `route_desc` was added to the SQLite schema (neary-gtfs `make-sqlite.js`)
// after the initial release; older feed blobs cached by clients won't
// have the column and a bare SELECT would throw `no such column`.
// Probe `PRAGMA table_info` once and project NULL when absent so the
// UI degrades gracefully (shows long_name only) until the feed is
// rebuilt.
function routeDescExpr(db: Database): string {
  const cols = selectAll<{ name: string }>(db, `PRAGMA table_info(routes);`);
  return cols.some((c) => c.name === 'route_desc') ? 'route_desc' : 'NULL AS route_desc';
}

function rowToRoute(r: RouteRow, withSchedule: Set<string>): Route {
  return {
    id: r.route_id,
    shortName: r.route_short_name,
    longName: r.route_long_name?.trim() ? r.route_long_name : undefined,
    description: r.route_desc?.trim() ? r.route_desc : undefined,
    color: r.route_color ? `#${r.route_color}` : '#F3513C',
    textColor: r.route_text_color ? `#${r.route_text_color}` : undefined,
    type: vehicleTypeFromGtfs(r.route_type),
    hasSchedule: withSchedule.has(r.route_id),
  };
}

export function getRoutes(db: Database): Route[] {
  const withSchedule = getRoutesWithSchedule(db);
  const desc = routeDescExpr(db);
  const rows = selectAll<RouteRow>(
    db,
    `SELECT route_id, route_short_name, route_long_name, ${desc},
            route_color, route_text_color, route_type
     FROM routes
     ORDER BY CAST(route_short_name AS INTEGER), route_short_name;`,
  );
  return rows.map((r) => rowToRoute(r, withSchedule));
}

export function getRouteById(db: Database, routeId: string): Route | null {
  const withSchedule = getRoutesWithSchedule(db);
  const desc = routeDescExpr(db);
  const rows = selectAll<RouteRow>(
    db,
    `SELECT route_id, route_short_name, route_long_name, ${desc},
            route_color, route_text_color, route_type
     FROM routes WHERE route_id = ?;`,
    [routeId],
  );
  return rows.length === 0 ? null : rowToRoute(rows[0], withSchedule);
}

/** All distinct routes that serve a given stop. Ordered by route
 *  short_name (numeric where possible). Used by the map view's stop
 *  popup. */
export function getRoutesForStop(db: Database, stopId: number): Route[] {
  const withSchedule = getRoutesWithSchedule(db);
  const desc = routeDescExpr(db);
  const descCol = desc === 'route_desc' ? 'r.route_desc' : 'NULL AS route_desc';
  const rows = selectAll<RouteRow>(
    db,
    `SELECT DISTINCT r.route_id, r.route_short_name, r.route_long_name, ${descCol},
            r.route_color, r.route_text_color, r.route_type
     FROM stop_times st
     JOIN trips t ON t.trip_id = st.trip_id
     JOIN routes r ON r.route_id = t.route_id
     WHERE st.stop_id = ?
     ORDER BY CAST(r.route_short_name AS INTEGER), r.route_short_name;`,
    [stopId],
  );
  return rows.map((r) => rowToRoute(r, withSchedule));
}
