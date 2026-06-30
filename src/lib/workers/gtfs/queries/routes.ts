/*
 * Route queries — all metadata about lines themselves: full list,
 * by id, by stop. None of these depend on calendar/time; they all
 * project routes.txt rows to the UI's Route shape.
 */

import type { Database } from '@sqlite.org/sqlite-wasm';
import type { Route } from '$lib/domain/types';
import { vehicleTypeFromGtfs } from '$lib/domain/types';
import { selectAll } from '../sqlHelpers';

type RouteRow = {
  route_id: string;
  route_short_name: string;
  route_color: string | null;
  route_text_color: string | null;
  route_type: number | null;
};

function rowToRoute(r: RouteRow): Route {
  return {
    id: r.route_id,
    shortName: r.route_short_name,
    color: r.route_color ? `#${r.route_color}` : '#F3513C',
    textColor: r.route_text_color ? `#${r.route_text_color}` : undefined,
    type: vehicleTypeFromGtfs(r.route_type),
  };
}

export function getRoutes(db: Database): Route[] {
  const rows = selectAll<RouteRow>(
    db,
    `SELECT route_id, route_short_name, route_color, route_text_color, route_type
     FROM routes
     ORDER BY CAST(route_short_name AS INTEGER), route_short_name;`,
  );
  return rows.map(rowToRoute);
}

export function getRouteById(db: Database, routeId: string): Route | null {
  const rows = selectAll<RouteRow>(
    db,
    `SELECT route_id, route_short_name, route_color, route_text_color, route_type
     FROM routes WHERE route_id = ?;`,
    [routeId],
  );
  return rows.length === 0 ? null : rowToRoute(rows[0]);
}

/** All distinct routes that serve a given stop. Ordered by route
 *  short_name (numeric where possible). Used by the map view's stop
 *  popup. */
export function getRoutesForStop(db: Database, stopId: number): Route[] {
  const rows = selectAll<RouteRow>(
    db,
    `SELECT DISTINCT r.route_id, r.route_short_name, r.route_color, r.route_text_color, r.route_type
     FROM stop_times st
     JOIN trips t ON t.trip_id = st.trip_id
     JOIN routes r ON r.route_id = t.route_id
     WHERE st.stop_id = ?
     ORDER BY CAST(r.route_short_name AS INTEGER), r.route_short_name;`,
    [stopId],
  );
  return rows.map(rowToRoute);
}
