/*
 * Favorites-page worker queries: filter-cascade scope
 * (`getRoutesThroughStations`) and paginated station reads
 * (`getStationsPage`). Lives in its own module so the filter cache
 * has a single home and the existing `stops.ts` keeps its narrow
 * focus on the search-overlay / station-view contracts.
 *
 * Cache shape: the filter cascade can have at most
 * (num_modes * num_networks) distinct keys per feed. Capped at 4
 * most-recently-used entries via a tiny LRU keyed by filter
 * signature; cleared on db handle swap (each feed gets a fresh
 * Database so the module-level cache invalidates naturally on
 * setFeed).
 */

import type { Database } from '@sqlite.org/sqlite-wasm';
import type { Route, VehicleType } from '$lib/domain/types';
import { vehicleTypeFromGtfs } from '$lib/domain/types';
import type { StopWithDistance } from '$lib/data/gtfs/types';
import { haversineMeters } from '@n3ary/gtfs-spec/shape';
import { selectAll } from '../sqlHelpers';
import { getRoutesWithSchedule } from './routesWithSchedule';

/** Filter signature used as cache key + SQL parameter binding order. */
export interface FavoritesStationsFilter {
  /** `undefined` = no mode filter; Set = filter to those modes. */
  modes?: ReadonlySet<VehicleType>;
  /** `undefined` = no network filter; empty Set = match none. */
  networks?: ReadonlySet<string>;
}

export interface StationsPageQuery {
  offset: number;
  limit: number;
  /** 'name' = SQL ORDER BY stop_name; 'distance' = SQL returns
   *  the scope rows then the caller (or this helper, in JS) sorts
   *  by Haversine from `anchor`. */
  sortBy: 'name' | 'distance';
  /** Required when sortBy='distance'; ignored otherwise. */
  anchor?: { lat: number; lon: number };
  /** Pre-computed scope of stop ids admitted by the filter cascade.
   *  `undefined` = no filter cascade (use the whole feed). */
  scope?: ReadonlySet<string>;
}

export interface StationsPageResult {
  rows: StopWithDistance[];
  /** Total rows the scope contains. Equal to rows.length when the
   *  whole feed fits in one page; otherwise the caller's basis for
   *  "has more?" decisions. */
  total: number;
}

interface RouteRowBase {
  route_id: string;
  route_short_name: string;
  route_long_name: string | null;
  route_desc: string | null;
  route_color: string | null;
  route_text_color: string | null;
  route_type: number | null;
  network_ids: string | null;
}

function routeDescExpr(db: Database): string {
  const cols = selectAll<{ name: string }>(db, `PRAGMA table_info(routes);`);
  return cols.some((c) => c.name === 'route_desc') ? 'route_desc' : 'NULL AS route_desc';
}

function routeNetworksJoinExpr(db: Database): { join: string; select: string } {
  const tables = selectAll<{ name: string }>(
    db,
    `SELECT name FROM sqlite_master WHERE type='table' AND name='route_networks';`,
  );
  if (tables.length === 0) return { join: '', select: 'NULL AS network_ids' };
  return {
    join: 'LEFT JOIN route_networks rn ON rn.route_id = r.route_id',
    select: "GROUP_CONCAT(rn.network_id, ',') AS network_ids",
  };
}

function rowToRoute(r: RouteRowBase, withSchedule: Set<string>): Route {
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

/** Cache key for the filter-cascade query. Mode + network filter
 *  combination, in that order. `*` = no filter (all in scope). */
function filterKey(filter: FavoritesStationsFilter): string {
  const modes = filter.modes === undefined
    ? '*'
    : Array.from(filter.modes).sort().join(',') || '-';
  const networks = filter.networks === undefined
    ? '*'
    : Array.from(filter.networks).sort().join(',') || '-';
  return `${modes}|${networks}`;
}

/** Routes-through-station cache. One LRU per Database handle so a
 *  feed swap invalidates implicitly. 4-entry cap per the spec — the
 *  realistic keyset is small (≤ modes × networks) so eviction is
 *  essentially never hit in practice, but the cap keeps the module
 *  from leaking memory in pathological scripted flows. */
const CACHE_CAP = 4;
let routesCache: {
  db: Database;
  entries: Map<string, Record<string, Route[]>>;
} | null = null;

function getRoutesCache(db: Database): Map<string, Record<string, Route[]>> {
  if (routesCache && routesCache.db === db) return routesCache.entries;
  routesCache = { db, entries: new Map() };
  return routesCache.entries;
}

/** Distinct routes that serve each schedule-bearing stop in the
 *  feed, optionally filtered by mode + network.
 *
 *  "Serves" is derived from any trip the feed schedules through the
 *  stop with a usable arrival_time — same definition the rest of the
 *  app uses for "has schedule". This deliberately includes all
 *  services (any day-of-week, any calendar window) so the result is
 *  stable across a single bound feed and doesn't refetch as the
 *  minute-of-day rolls over.
 *
 *  Result keys: every stop id with at least one matching route.
 *  Stops with zero matching routes are absent — caller treats as
 *  "out of scope". Matches the batched `getRoutesForStops` shape so
 *  the favorites page's route-chip rendering can reuse the same
 *  record-style lookup.
 */
export function getRoutesThroughStations(
  db: Database,
  filter: FavoritesStationsFilter,
): Record<string, Route[]> {
  const key = filterKey(filter);
  const cache = getRoutesCache(db);
  const hit = cache.get(key);
  if (hit) {
    // Refresh recency — re-insert to move to the back of the
    // insertion order (Map iteration is insertion-ordered).
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  const withSchedule = getRoutesWithSchedule(db);
  const desc = routeDescExpr(db);
  const descCol = desc === 'route_desc' ? 'r.route_desc' : 'NULL AS route_desc';
  const { join: netJoin, select: netSelect } = routeNetworksJoinExpr(db);

  // Build the WHERE clause for mode + network filters. The mode
  // filter maps VehicleType -> GTFS route_type integer for an exact
  // match; the network filter joins route_networks. SQL returns the
  // DISTINCT (stop_id, route_id) pairs the JS side then projects
  // to the record shape, applying the network filter (because the
  // SQL join emits rows per (route, network) — we collapse those
  // to per-route once before the filter so a route in two networks
  // doesn't double-count).
  const modeList = filter.modes === undefined
    ? null
    : Array.from(filter.modes)
        .map((t) => gtfsRouteTypeFor(t))
        .filter((n): n is number => n != null);

  const conds: string[] = ['st.arrival_time IS NOT NULL', `st.arrival_time != ''`];
  const params: Array<string | number> = [];
  if (modeList !== null) {
    if (modeList.length === 0) {
      // No mode can match — cache an empty result so subsequent
      // calls don't repeat the work.
      const empty: Record<string, Route[]> = {};
      insertAtCap(cache, key, empty);
      return empty;
    }
    const ph = modeList.map(() => '?').join(',');
    conds.push(`r.route_type IN (${ph})`);
    params.push(...modeList);
  }
  if (filter.networks !== undefined) {
    if (filter.networks.size === 0) {
      const empty: Record<string, Route[]> = {};
      insertAtCap(cache, key, empty);
      return empty;
    }
    const ph = Array.from(filter.networks).map(() => '?').join(',');
    conds.push(`rn.network_id IN (${ph})`);
    params.push(...filter.networks);
  }

  const rows = selectAll<RouteRowBase & { stop_id: string }>(
    db,
    `SELECT st.stop_id, r.route_id, r.route_short_name, r.route_long_name, ${descCol},
            r.route_color, r.route_text_color, r.route_type,
            ${netSelect}
     FROM stop_times st
     JOIN trips t  ON t.trip_id = st.trip_id
     JOIN routes r ON r.route_id = t.route_id
     ${netJoin}
     WHERE ${conds.join(' AND ')}
     GROUP BY st.stop_id, r.route_id;`,
    params,
  );

  const grouped: Record<string, Route[]> = {};
  for (const r of rows) {
    if (!grouped[r.stop_id]) grouped[r.stop_id] = [];
    grouped[r.stop_id].push(rowToRoute(r, withSchedule));
  }

  insertAtCap(cache, key, grouped);
  return grouped;
}

function insertAtCap(
  cache: Map<string, Record<string, Route[]>>,
  key: string,
  value: Record<string, Route[]>,
): void {
  cache.set(key, value);
  while (cache.size > CACHE_CAP) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

interface StopRowWithParent {
  stop_id: string;
  stop_name: string;
  stop_lat: number;
  stop_lon: number;
  parent_station: string | null;
  parent_name: string | null;
  parent_lat: number | null;
  parent_lon: number | null;
}

function selectStopsRaw(
  db: Database,
  whereClause: string,
  params: ReadonlyArray<string | number>,
): StopRowWithParent[] {
  return selectAll<StopRowWithParent>(
    db,
    `SELECT s.stop_id, s.stop_name, s.stop_lat, s.stop_lon, s.parent_station,
            p.stop_name AS parent_name, p.stop_lat AS parent_lat, p.stop_lon AS parent_lon
     FROM stops s
     LEFT JOIN stops p ON p.stop_id = s.parent_station
     ${whereClause}
       AND EXISTS (
         SELECT 1 FROM stop_times st
         WHERE st.stop_id = s.stop_id
           AND st.arrival_time IS NOT NULL
           AND st.arrival_time != ''
         LIMIT 1
       );`,
    params,
  );
}

function rollupByParent(rows: ReadonlyArray<StopRowWithParent>): StopWithDistance[] {
  const out = new Map<string, StopWithDistance>();
  for (const r of rows) {
    if (r.parent_station && r.parent_name != null) {
      if (out.has(r.parent_station)) continue;
      out.set(r.parent_station, {
        id: r.stop_id,
        name: r.parent_name,
        lat: r.parent_lat ?? r.stop_lat,
        lon: r.parent_lon ?? r.stop_lon,
      });
    } else {
      out.set(r.stop_id, {
        id: r.stop_id,
        name: r.stop_name,
        lat: r.stop_lat,
        lon: r.stop_lon,
      });
    }
  }
  return Array.from(out.values());
}

type RolledWithKey = StopWithDistance & { _dedupKey: string };

/** Same as rollupByParent but also returns the parent-station key for
 *  each entry. Used by the chunked path so we can dedupe across
 *  chunks by parent station — different child stop_ids under the
 *  same parent must collapse to one entry. */
function rollupByParentWithDedupKey(
  rows: ReadonlyArray<StopRowWithParent>,
): RolledWithKey[] {
  const out: RolledWithKey[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.parent_station && r.parent_name != null) {
      if (seen.has(r.parent_station)) continue;
      seen.add(r.parent_station);
      out.push({
        id: r.stop_id,
        name: r.parent_name,
        lat: r.parent_lat ?? r.stop_lat,
        lon: r.parent_lon ?? r.stop_lon,
        _dedupKey: r.parent_station,
      });
    } else {
      if (seen.has(r.stop_id)) continue;
      seen.add(r.stop_id);
      out.push({
        id: r.stop_id,
        name: r.stop_name,
        lat: r.stop_lat,
        lon: r.stop_lon,
        _dedupKey: r.stop_id,
      });
    }
  }
  return out;
}

/** One page of stations. Sorted by `sortBy`. `scope` filters the
 *  candidate set to a pre-computed filter-cascade result (undefined
 *  = full feed). Returns the page plus the total scope size so the
 *  caller can drive the prefetch sentinel.
 *
 *  Two sort modes:
 *    - 'name': SQL ORDER BY stop_name + locale-equivalent; JS does
 *      a final localeCompare pass to match the search overlay's
 *      case-folded diacritic-stripped ordering. Cheap because we
 *      sort after LIMIT/OFFSET.
 *    - 'distance': SQL returns rows in name order, JS sorts the
 *      whole page by Haversine from `anchor`, then re-slices
 *      [offset, offset+limit]. Same shape for any page — predictable
 *      for the caller.
 */
export function getStationsPage(
  db: Database,
  q: StationsPageQuery,
): StationsPageResult {
  if (q.scope !== undefined && q.scope.size === 0) {
    return { rows: [], total: 0 };
  }

  let whereClause = 'WHERE 1=1';
  const params: Array<string | number> = [];
  if (q.scope !== undefined) {
    // SQLite has a 999-parameter cap by default; a feed's stop set
    // is tiny relative to that, but a future national feed could
    // push 5,000+ stations through here. Cap at 999 per chunk —
    // UNION the chunks if needed. Realistically the page size is
    // much smaller, so we trust the caller to chunk.
    const ids = Array.from(q.scope);
    if (ids.length > 900) {
      return getStationsPageChunked(db, q, ids);
    }
    const ph = ids.map(() => '?').join(',');
    whereClause += ` AND s.stop_id IN (${ph})`;
    params.push(...ids);
  }

  if (q.sortBy === 'name') {
    const rows = selectStopsRaw(db, whereClause, params);
    const rolled = rollupByParent(rows).sort((a, b) => a.name.localeCompare(b.name));
    return {
      rows: rolled.slice(q.offset, q.offset + q.limit),
      total: rolled.length,
    };
  }

  // distance sort: SQL doesn't know the anchor, so we sort the
  // full filtered set in JS by Haversine, then slice. For 5k stops
  // this is ~10 ms — well under a 60 fps frame.
  const anchor = q.anchor;
  if (!anchor) {
    // Fall back to name sort when caller asks for distance without
    // providing an anchor — better than throwing at the page.
    const rows = selectStopsRaw(db, whereClause, params);
    const rolled = rollupByParent(rows).sort((a, b) => a.name.localeCompare(b.name));
    return {
      rows: rolled.slice(q.offset, q.offset + q.limit),
      total: rolled.length,
    };
  }
  const rows = selectStopsRaw(db, whereClause, params);
  const rolled = rollupByParent(rows);
  rolled.sort((a, b) => {
    const ad = a.lat == null || a.lon == null
      ? Number.POSITIVE_INFINITY
      : haversineMeters(anchor.lat, anchor.lon, a.lat, a.lon);
    const bd = b.lat == null || b.lon == null
      ? Number.POSITIVE_INFINITY
      : haversineMeters(anchor.lat, anchor.lon, b.lat, b.lon);
    return ad - bd;
  });
  const sliced = rolled.slice(q.offset, q.offset + q.limit)
    .map((s) => ({
      ...s,
      distance: s.lat != null && s.lon != null
        ? haversineMeters(anchor.lat, anchor.lon, s.lat, s.lon)
        : undefined,
    }));
  return { rows: sliced, total: rolled.length };
}

/** Inline so favoritesQueries doesn't depend on the network-domain
 *  helper for a one-line mapping. */
function gtfsRouteTypeFor(t: VehicleType): number | null {
  switch (t) {
    case 'tram': return 0;
    case 'metro': return 1;
    case 'rail': return 2;
    case 'bus': return 3;
    case 'ferry': return 4;
    case 'cablecar': return 5;
    case 'gondola': return 6;
    case 'funicular': return 7;
    case 'trolleybus': return 11;
    case 'monorail': return 12;
    case 'unknown': return null;
  }
}

function getStationsPageChunked(
  db: Database,
  q: StationsPageQuery,
  ids: string[],
): StationsPageResult {
  // Dedupe across chunks by parent-station key (not by child
  // stop_id, since multiple children can map to the same parent).
  const all: StopWithDistance[] = [];
  const seenKeys = new Set<string>();
  const CHUNK = 900;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const ph = slice.map(() => '?').join(',');
    const rows = selectStopsRaw(
      db,
      `WHERE s.stop_id IN (${ph})`,
      slice,
    );
    for (const s of rollupByParentWithDedupKey(rows)) {
      if (seenKeys.has(s._dedupKey)) continue;
      seenKeys.add(s._dedupKey);
      all.push({
        id: s.id,
        name: s.name,
        lat: s.lat,
        lon: s.lon,
      });
    }
  }
  const anchor = q.anchor;
  if (q.sortBy === 'distance' && anchor) {
    all.sort((a, b) => {
      const ad = a.lat == null || a.lon == null
        ? Number.POSITIVE_INFINITY
        : haversineMeters(anchor.lat, anchor.lon, a.lat, a.lon);
      const bd = b.lat == null || b.lon == null
        ? Number.POSITIVE_INFINITY
        : haversineMeters(anchor.lat, anchor.lon, b.lat, b.lon);
      return ad - bd;
    });
    return {
      rows: all.slice(q.offset, q.offset + q.limit).map((s) => ({
        ...s,
        distance: s.lat != null && s.lon != null
          ? haversineMeters(anchor.lat, anchor.lon, s.lat, s.lon)
          : undefined,
      })),
      total: all.length,
    };
  }
  all.sort((a, b) => a.name.localeCompare(b.name));
  return {
    rows: all.slice(q.offset, q.offset + q.limit),
    total: all.length,
  };
}