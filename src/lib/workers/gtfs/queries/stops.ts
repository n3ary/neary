/*
 * Stop queries — nearby stops, departures from a stop, "stop is origin
 * of which routes". Per-stop trip-active filtering lives elsewhere
 * (stationArrivals); this module just shapes raw stop_times rows.
 */

import type { Database } from '@sqlite.org/sqlite-wasm';
import { haversineMeters } from '$lib/domain/distance';
import { timeToMinutes } from '$lib/domain/pipeline/timeUtils';
import type { StopWithDistance, UpcomingDeparture } from '$lib/data/gtfs/types';
import { dayKeyCols, selectAll } from '../sqlHelpers';

/** Stops within `radiusMeters` of (lat, lon). Bounding-box prefilter
 *  in SQL (uses the lat/lon index) then Haversine refinement in JS.
 *  Drops stops that never appear in any stop_times (terminus pads,
 *  legacy entries). */
export function getStopsNear(
  db: Database,
  lat: number,
  lon: number,
  radiusMeters: number,
  limit = 25,
): StopWithDistance[] {
  const dLat = radiusMeters / 111_320;
  const dLon = radiusMeters / (111_320 * Math.cos((lat * Math.PI) / 180));
  type Row = { stop_id: number; stop_name: string; stop_lat: number; stop_lon: number };
  // The window-level "service is active right now" check stays in
  // stationArrivals so the nearby list still surfaces stops whose
  // buses have stopped for the night.
  const candidates = selectAll<Row>(
    db,
    `SELECT s.stop_id, s.stop_name, s.stop_lat, s.stop_lon
     FROM stops s
     WHERE s.stop_lat BETWEEN ? AND ?
       AND s.stop_lon BETWEEN ? AND ?
       AND EXISTS (
         SELECT 1 FROM stop_times st WHERE st.stop_id = s.stop_id LIMIT 1
       );`,
    [lat - dLat, lat + dLat, lon - dLon, lon + dLon],
  );
  return candidates
    .map((s) => ({
      id: s.stop_id,
      name: s.stop_name,
      lat: s.stop_lat,
      lon: s.stop_lon,
      distance: haversineMeters(lat, lon, s.stop_lat, s.stop_lon),
    }))
    .filter((s) => s.distance <= radiusMeters)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit);
}

/** Next departures from a stop within `windowMinutes`, where the
 *  trip's service is active on `localDate`. */
export function getDeparturesFromStop(
  db: Database,
  stopId: number,
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
  const dayCol = dayKeyCols[(dow + 6) % 7];

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
export function getOriginRoutesAtStop(db: Database, stopId: number): string[] {
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
