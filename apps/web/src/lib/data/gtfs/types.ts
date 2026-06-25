/*
 * Repository contract — the typed API the GTFS worker exposes via Comlink.
 *
 * This is the only thing UI code imports; the worker file itself is opaque
 * (Web Worker module, runs SQLite-WASM in OPFS). Keep this module pure
 * types so it stays trivially shareable between worker and main thread.
 */

import type { Route, Station } from '$lib/domain/types';

export interface Manifest {
  agencyId: number;
  source: string;
  /** ISO timestamp. */
  generatedAt: string;
  rowCounts: Record<string, number>;
  rawBytes: number;
  gzipBytes: number;
}

export interface StopWithDistance extends Station {
  /** Always populated by getStopsNear (meters). */
  distance: number;
}

export interface UpcomingDeparture {
  tripId: string;
  routeId: number;
  routeShortName: string;
  routeColor: string;
  headsign: string | null;
  /** "HH:MM:SS" from GTFS (may exceed 24h, e.g. "25:13:00"). */
  departureTime: string;
}

export interface GtfsRepo {
  /** True once the DB is open and queryable. Cheap; safe to await on every call. */
  ready(): Promise<true>;

  /** Manifest metadata (agency id, source, generated-at, row counts, sizes). */
  getManifest(): Promise<Manifest>;

  /** All routes, sorted by short_name (numeric where possible). */
  getRoutes(): Promise<Route[]>;

  /**
   * Stops within `radiusMeters` of (lat, lon). Bounding-box prefiltered in
   * SQL then refined by Haversine in JS — accurate, no spatial extension
   * needed.
   */
  getStopsNear(lat: number, lon: number, radiusMeters: number, limit?: number): Promise<StopWithDistance[]>;

  /**
   * Next departures from a stop within `windowMinutes` minutes, where the
   * trip's service is active on `localDate` ("YYYYMMDD"). Joins
   * stop_times -> trips -> routes -> calendar.
   */
  getDeparturesFromStop(
    stopId: number,
    localDate: string,
    localMinutesSinceMidnight: number,
    windowMinutes: number,
  ): Promise<UpcomingDeparture[]>;
}
