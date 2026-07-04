/*
 * Stop queries — nearby stops, departures from a stop, "stop is origin
 * of which routes". Per-stop trip-active filtering lives elsewhere
 * (stationArrivals); this module just shapes raw stop_times rows.
 */

import type { Database } from '@sqlite.org/sqlite-wasm';
import { haversineMeters } from '@n3ary/gtfs-spec/shape';
import { DAY_KEY_COLS } from '@n3ary/gtfs-spec/spec';
import { timeToMinutes } from '$lib/domain/pipeline/timeUtils';
import type { StopWithDistance, UpcomingDeparture } from '$lib/data/gtfs/types';
import { selectAll } from '../sqlHelpers';

/** Stops within `radiusMeters` of (lat, lon). Bounding-box prefilter
 *  in SQL (uses the lat/lon index) then Haversine refinement in JS.
 *  Drops stops that never appear in any stop_times (terminus pads,
 *  legacy entries).
 *
 *  Child stops (those with `parent_station` pointing at a location_type=1
 *  station row) roll up to their parent: one entry per parent station,
 *  named after the parent, navigation-id pointing at a representative
 *  child. Surface-transit feeds where the producer didn't model parents
 *  pass through unchanged. */
export function getStopsNear(
  db: Database,
  lat: number,
  lon: number,
  radiusMeters: number,
  limit = 25,
): StopWithDistance[] {
  const dLat = radiusMeters / 111_320;
  const dLon = radiusMeters / (111_320 * Math.cos((lat * Math.PI) / 180));
  const candidates = selectStopsWithParent(
    db,
    `WHERE s.stop_lat BETWEEN ? AND ?
       AND s.stop_lon BETWEEN ? AND ?`,
    [lat - dLat, lat + dLat, lon - dLon, lon + dLon],
  );
  return rollupByParent(candidates)
    .map((s) => ({
      id: s.id,
      name: s.name,
      lat: s.lat,
      lon: s.lon,
      distance: haversineMeters(lat, lon, s.lat, s.lon),
    }))
    .filter((s) => s.distance <= radiusMeters)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit);
}

/** Diacritic-insensitive substring search over stop names.
 *
 *  Two sort modes:
 *  - `'distance'` (default): sort by distance from `(anchorLat, anchorLon)`.
 *    Empty `text` falls back to `getStopsNear` with a wide radius so the
 *    overlay shows useful results before the user types. Used when the
 *    user has a GPS position.
 *  - `'name'`: sort alphabetically by `stop_name` (locale-aware). Empty
 *    `text` returns the alphabetical head of the feed's stops. Used when
 *    the user has no GPS — distance from the feed centroid carries no
 *    rider-useful signal, so we don't pretend otherwise. `anchorLat` /
 *    `anchorLon` are ignored.
 *
 *  Like `getStopsNear`, child stops roll up to their parent station so
 *  the user sees one entry per logical place rather than one per
 *  platform/entrance. Name matching uses the *displayed* name (parent
 *  name when present) so `'piata unirii'` matches a parent even when
 *  the children are labelled "Lift Piața Unirii 1".
 *
 *  We fetch all schedule-bearing stops and filter in JS rather than via
 *  SQL `LIKE`: SQLite's `LIKE` is ASCII-only for case folding so
 *  `'piata'` wouldn't match `'Piața'` (ț = U+021B). NFD+strip-marks
 *  normalization on both sides handles the diacritic case cleanly.
 *  Mid-sized city feeds (~2k stops) make the JS pass trivial; for
 *  large-network feeds an order of magnitude larger this can become
 *  a FTS5 virtual table without changing the public signature. */
export function searchStops(
  db: Database,
  text: string,
  anchorLat: number,
  anchorLon: number,
  limit = 25,
  sort: 'distance' | 'name' = 'distance',
): StopWithDistance[] {
  const needle = normalizeForSearch(text);

  if (sort === 'distance' && !needle) {
    // Empty input + distance mode: nearest 25 (wide-enough radius to cover any feed bbox).
    return getStopsNear(db, anchorLat, anchorLon, 50_000, limit);
  }

  const candidates = selectStopsWithParent(
    db,
    // Match ALL schedule-bearing stops; caller filters by text below.
    // Trailing `AND 1=1` keeps the shared query's `AND EXISTS (...)`
    // grammar intact (needs at least one boolean on the WHERE side).
    `WHERE 1=1`,
    [],
  );
  const rolled = rollupByParent(candidates);
  const matched = needle
    ? rolled.filter((s) => normalizeForSearch(s.name).includes(needle))
    : rolled;

  if (sort === 'name') {
    return matched
      .map((s) => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, limit);
  }

  return matched
    .map((s) => ({
      id: s.id,
      name: s.name,
      lat: s.lat,
      lon: s.lon,
      distance: haversineMeters(anchorLat, anchorLon, s.lat, s.lon),
    }))
    .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity))
    .slice(0, limit);
}

/** Row shape returned by `selectStopsWithParent`. Parent fields are
 *  populated only when the row has a `parent_station` that resolves to
 *  an existing stops row; otherwise null. */
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

function selectStopsWithParent(
  db: Database,
  whereClause: string,
  params: ReadonlyArray<string | number>,
): StopRowWithParent[] {
  return selectAll<StopRowWithParent>(
    db,
    // The EXISTS clause requires a stop_time with a non-empty
    // arrival_time. Some feeds carry NT-fallback (no-time) trips whose
    // stop_times have arrival_time = '' -- surface those as stops
    // with active routes = false. Matches routesWithSchedule.ts's
    // definition of "route has schedule".
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

/** Group rows by `parent_station` when present. One entry per parent
 *  with the parent's canonical name + coordinates; rows with no parent
 *  pass through unchanged. The representative `id` is always a child's
 *  stop_id (or a parent-less stop's own id) so navigation lands on a
 *  row that has stop_times — the station view needs that to render
 *  arrivals. Parent stations themselves are excluded from search
 *  candidates by the caller's `EXISTS stop_times` clause anyway.
 *
 *  Within a parent group, the first child encountered wins as the
 *  representative. Order is whatever SQLite returns; stable enough
 *  for a navigation target. */
function rollupByParent(rows: ReadonlyArray<StopRowWithParent>): Array<{
  id: string;
  name: string;
  lat: number;
  lon: number;
}> {
  const out: Array<{ id: string; name: string; lat: number; lon: number }> = [];
  const seenParents = new Set<string>();
  for (const r of rows) {
    if (r.parent_station && r.parent_name != null) {
      if (seenParents.has(r.parent_station)) continue;
      seenParents.add(r.parent_station);
      out.push({
        id: r.stop_id,
        name: r.parent_name,
        lat: r.parent_lat ?? r.stop_lat,
        lon: r.parent_lon ?? r.stop_lon,
      });
    } else {
      // No parent, or parent_station points at a non-existent row
      // (data error). Pass through as-is.
      out.push({
        id: r.stop_id,
        name: r.stop_name,
        lat: r.stop_lat,
        lon: r.stop_lon,
      });
    }
  }
  return out;
}

function normalizeForSearch(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

/** Next departures from a stop within `windowMinutes`, where the
 *  trip's service is active on `localDate`. */
export function getDeparturesFromStop(
  db: Database,
  stopId: string,
  localDate: string,
  localMinutesSinceMidnight: number,
  windowMinutes: number,
): UpcomingDeparture[] {
  // Day-of-week → calendar column. Inline (not via activeServicesOn)
  // because this query intentionally ignores calendar_dates — it's a
  // "what's the recurring pattern from this stop" view.
  const dow = new Date(
    Number(localDate.slice(0, 4)),
    Number(localDate.slice(4, 6)) - 1,
    Number(localDate.slice(6, 8)),
  ).getDay();
  const dayCol = DAY_KEY_COLS[(dow + 6) % 7];

  type ServiceRow = { service_id: string };
  const services = selectAll<ServiceRow>(
    db,
    `SELECT service_id FROM calendar
     WHERE ${dayCol} = 1
       AND start_date <= ?
       AND end_date >= ?;`,
    [localDate, localDate],
  ).map((r) => r.service_id);

  if (services.length === 0) return [];

  const placeholders = services.map(() => '?').join(',');
  type Row = {
    trip_id: string;
    departure_time: string;
    route_id: string;
    route_short_name: string;
    route_color: string | null;
    trip_headsign: string | null;
  };
  const rows = selectAll<Row>(
    db,
    `SELECT st.trip_id, st.departure_time,
            r.route_id, r.route_short_name, r.route_color,
            t.trip_headsign
     FROM stop_times st
     JOIN trips t  ON t.trip_id  = st.trip_id
     JOIN routes r ON r.route_id = t.route_id
     WHERE st.stop_id = ?
       AND t.service_id IN (${placeholders});`,
    [stopId, ...services],
  );

  const upper = localMinutesSinceMidnight + windowMinutes;
  return rows
    .map((r) => ({ ...r, mins: timeToMinutes(r.departure_time) }))
    .filter((r) => r.mins >= localMinutesSinceMidnight && r.mins <= upper)
    .sort((a, b) => a.mins - b.mins)
    .map<UpcomingDeparture>((r) => ({
      tripId: r.trip_id,
      routeId: r.route_id,
      routeShortName: r.route_short_name,
      routeColor: r.route_color ? `#${r.route_color}` : '#F3513C',
      headsign: r.trip_headsign,
      departureTime: r.departure_time,
    }));
}

/** Route ids for which `stopId` is the first stop (origin) of at
 *  least one trip. Used to show the isStart ▶ marker on route badges
 *  in the station view. */
export function getOriginRoutesAtStop(db: Database, stopId: string): string[] {
  type Row = { route_id: string };
  const rows = selectAll<Row>(
    db,
    `SELECT DISTINCT t.route_id
     FROM stop_times st
     JOIN trips t ON t.trip_id = st.trip_id
     WHERE st.stop_id = ?
       AND st.stop_sequence = (
         SELECT MIN(st2.stop_sequence)
         FROM stop_times st2
         WHERE st2.trip_id = st.trip_id
       )
     ORDER BY CAST(t.route_id AS INTEGER), t.route_id;`,
    [stopId],
  );
  return rows.map((r) => r.route_id);
}
