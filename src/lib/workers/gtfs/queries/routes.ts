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
  network_ids: string | null;
};

// `route_desc` was added to the SQLite schema (`gtfs` `make-sqlite.js`)
// after the initial release; older feed blobs cached by clients won't
// have the column and a bare SELECT would throw `no such column`.
// Probe `PRAGMA table_info` once and project NULL when absent so the
// UI degrades gracefully (shows long_name only) until the feed is
// rebuilt.
function routeDescExpr(db: Database): string {
  const cols = selectAll<{ name: string }>(db, `PRAGMA table_info(routes);`);
  return cols.some((c) => c.name === 'route_desc') ? 'route_desc' : 'NULL AS route_desc';
}

// `route_networks` was added together with `networks.txt` support.
// Older cached blobs won't have the table — probe once and fall back
// to NULL so callers get `route.networks === undefined` rather than an error.
function routeNetworksJoinExpr(db: Database): { join: string; select: string } {
  const tables = selectAll<{ name: string }>(db, `SELECT name FROM sqlite_master WHERE type='table' AND name='route_networks';`);
  if (tables.length === 0) return { join: '', select: 'NULL AS network_ids' };
  return {
    join: 'LEFT JOIN route_networks rn ON rn.route_id = r.route_id',
    select: "GROUP_CONCAT(rn.network_id, ',') AS network_ids",
  };
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
    networks: r.network_ids
      ? r.network_ids.split(',').filter(Boolean)
      : undefined,
  };
}

export function getRoutes(db: Database): Route[] {
  const withSchedule = getRoutesWithSchedule(db);
  const desc = routeDescExpr(db);
  const { join, select: netSelect } = routeNetworksJoinExpr(db);
  const rows = selectAll<RouteRow>(
    db,
    `SELECT r.route_id, r.route_short_name, r.route_long_name, ${desc === 'route_desc' ? 'r.route_desc' : 'NULL AS route_desc'},
            r.route_color, r.route_text_color, r.route_type,
            ${netSelect}
     FROM routes r
     ${join}
     GROUP BY r.route_id
     ORDER BY CAST(r.route_short_name AS INTEGER), r.route_short_name;`,
  );
  return rows.map((r) => rowToRoute(r, withSchedule));
}

export function getRouteById(db: Database, routeId: string): Route | null {
  const withSchedule = getRoutesWithSchedule(db);
  const desc = routeDescExpr(db);
  const { join, select: netSelect } = routeNetworksJoinExpr(db);
  const rows = selectAll<RouteRow>(
    db,
    `SELECT r.route_id, r.route_short_name, r.route_long_name, ${desc === 'route_desc' ? 'r.route_desc' : 'NULL AS route_desc'},
            r.route_color, r.route_text_color, r.route_type,
            ${netSelect}
     FROM routes r
     ${join}
     WHERE r.route_id = ?
     GROUP BY r.route_id;`,
    [routeId],
  );
  return rows.length === 0 ? null : rowToRoute(rows[0], withSchedule);
}

/** All distinct routes that serve a given stop. Ordered by route
 *  short_name (numeric where possible). Used by the map view's stop
 *  popup. */
export function getRoutesForStop(db: Database, stopId: string): Route[] {
  const withSchedule = getRoutesWithSchedule(db);
  const desc = routeDescExpr(db);
  const descCol = desc === 'route_desc' ? 'r.route_desc' : 'NULL AS route_desc';
  const { join: netJoin, select: netSelect } = routeNetworksJoinExpr(db);
  const rows = selectAll<RouteRow>(
    db,
    `SELECT DISTINCT r.route_id, r.route_short_name, r.route_long_name, ${descCol},
            r.route_color, r.route_text_color, r.route_type,
            ${netSelect}
     FROM stop_times st
     JOIN trips t ON t.trip_id = st.trip_id
     JOIN routes r ON r.route_id = t.route_id
     ${netJoin}
     WHERE st.stop_id = ?
     GROUP BY r.route_id
     ORDER BY CAST(r.route_short_name AS INTEGER), r.route_short_name;`,
    [stopId],
  );
  return rows.map((r) => rowToRoute(r, withSchedule));
}

/** Batched variant of {@link getRoutesForStop} — one SQL round-trip
 *  for many stops. Used by the header search overlay to fetch route
 *  chips for every result row without N Comlink hops. Returns an
 *  object keyed by stop_id; stops with no routes are omitted (callers
 *  should treat missing keys as an empty list). */
export function getRoutesForStops(
  db: Database,
  stopIds: readonly string[],
): Record<string, Route[]> {
  if (stopIds.length === 0) return {};
  const withSchedule = getRoutesWithSchedule(db);
  const desc = routeDescExpr(db);
  const descCol = desc === 'route_desc' ? 'r.route_desc' : 'NULL AS route_desc';
  const { join: netJoin, select: netSelect } = routeNetworksJoinExpr(db);
  const ph = stopIds.map(() => '?').join(',');
  const rows = selectAll<RouteRow & { stop_id: string }>(
    db,
    `SELECT st.stop_id, r.route_id, r.route_short_name, r.route_long_name, ${descCol},
            r.route_color, r.route_text_color, r.route_type,
            ${netSelect}
     FROM stop_times st
     JOIN trips t ON t.trip_id = st.trip_id
     JOIN routes r ON r.route_id = t.route_id
     ${netJoin}
     WHERE st.stop_id IN (${ph})
     GROUP BY st.stop_id, r.route_id
     ORDER BY st.stop_id, CAST(r.route_short_name AS INTEGER), r.route_short_name;`,
    [...stopIds],
  );
  const grouped: Record<string, Route[]> = {};
  for (const r of rows) {
    if (!grouped[r.stop_id]) grouped[r.stop_id] = [];
    grouped[r.stop_id].push(rowToRoute(r, withSchedule));
  }
  return grouped;
}
