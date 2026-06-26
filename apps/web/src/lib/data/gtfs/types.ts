/*
 * Repository contract — the typed API the GTFS worker exposes via Comlink.
 *
 * This is the only thing UI code imports; the worker file itself is opaque
 * (Web Worker module, runs SQLite-WASM in OPFS). Keep this module pure
 * types so it stays trivially shareable between worker and main thread.
 */

import type { Feed } from '$lib/data/feeds';
import type { Route, Station, Vehicle } from '$lib/domain/types';

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
  /**
   * Bind the repo to a feed. First call for a given feed.id seeds the OPFS
   * file (downloads its sqlite_gz from jsDelivr + decompresses + opens).
   * Subsequent calls with the same id are a no-op; calls with a different
   * id close the current DB and re-bootstrap against the new one.
   *
   * Throws (rejects) with a descriptive message when the seed download or
   * open fails — the caller (typically the +layout effect) surfaces it via
   * StatusBar.
   */
  setFeed(feed: Feed): Promise<void>;

  /** True once the DB is open and queryable. Cheap; safe to await on every call. */
  ready(): Promise<true>;

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

  /**
   * Domain-shaped arrivals at a stop, ready for bucketing + rendering.
   * Schedule-only in Phase 4: every entry is `kind: 'scheduled'` or
   * `kind: 'predicted'` (no live data wired yet). Phase 5 plugs the live
   * pipeline stages downstream of the scheduleScanner.
   *
   *   nowMs           Unix ms — the moment this query represents
   *   windowMinutes   How many minutes into the future to include
   *
   * Past arrivals within the 5 min recency window are also returned so the
   * `departed` bucket can render when the user opts in.
   */
  getStationArrivals(
    stopId: number,
    nowMs: number,
    windowMinutes: number,
  ): Promise<Vehicle[]>;

  /**
   * Stops near (lat, lon) with their arrivals fetched in one round-trip.
   * Replaces N+1 calls to getStopsNear + getStationArrivals from the UI.
   * Each entry is `{ stop, vehicles }`; consumers run
   * `assembleStationBoard(vehicles, prefs, nowMs)` to bucket + filter + sort.
   */
  getStationBoardsNear(
    lat: number,
    lon: number,
    radiusMeters: number,
    maxStations: number,
    nowMs: number,
    windowMinutes: number,
  ): Promise<{ stop: StopWithDistance; vehicles: Vehicle[] }[]>;
}
