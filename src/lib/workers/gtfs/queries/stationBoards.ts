/*
 * Station-board entry points that wrap `getStationArrivals` with the
 * `{ stop, vehicles }` shape the UI's `assembleLiveBoard` expects.
 *
 *   - `getStationBoard`     — single stop by id (no GPS context).
 *   - `getStationBoardsNear` — nearby stops in one round-trip.
 *
 * Both delegate to `getStationArrivals` per stop; no SQL duplication.
 */

import type { Database } from '@sqlite.org/sqlite-wasm';
import type { StopWithDistance } from '$lib/data/gtfs/types';
import type { Vehicle } from '$lib/domain/types';
import { selectAll } from '../sqlHelpers';
import { getStationArrivals } from './stationArrivals';
import { getStopsNear } from './stops';

export function getStationBoard(
  db: Database,
  tz: string,
  stopId: string,
  nowMs: number,
  windowMinutes: number,
  hasFrequencies: boolean,
): { stop: StopWithDistance; vehicles: Vehicle[] } | null {
  type Row = { stop_id: string; stop_name: string; stop_lat: number; stop_lon: number };
  const rows = selectAll<Row>(
    db,
    `SELECT stop_id, stop_name, stop_lat, stop_lon FROM stops WHERE stop_id = ?;`,
    [stopId],
  );
  if (rows.length === 0) return null;
  const s = rows[0];
  return {
    stop: {
      id: s.stop_id,
      name: s.stop_name,
      lat: s.stop_lat,
      lon: s.stop_lon,
      // distance intentionally absent — no GPS context here.
    },
    vehicles: getStationArrivals(db, tz, stopId, nowMs, windowMinutes, hasFrequencies),
  };
}

/** Stops near (lat, lon) with their arrivals in one round-trip.
 *  Replaces N+1 calls to getStopsNear + getStationArrivals from the
 *  UI. */
export function getStationBoardsNear(
  db: Database,
  tz: string,
  lat: number,
  lon: number,
  radiusMeters: number,
  maxStations: number,
  nowMs: number,
  windowMinutes: number,
  hasFrequencies: boolean,
): { stop: StopWithDistance; vehicles: Vehicle[] }[] {
  const stops = getStopsNear(db, lat, lon, radiusMeters, maxStations);
  return stops.map((stop) => ({
    stop,
    vehicles: getStationArrivals(db, tz, stop.id, nowMs, windowMinutes, hasFrequencies),
  }));
}
