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
  /** Meters from the query coordinate. Optional because the by-id
   *  entry path (getStationBoard) has no GPS context to compute it
   *  against — every other producer (getStopsNear, getStationBoardsNear)
   *  always sets it. Consumers that need it should check for `number`. */
  distance?: number;
}

export interface UpcomingDeparture {
  tripId: string;
  routeId: string;
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

  /**
   * Single-stop variant of getStationBoardsNear. Used by the
   * /station/[id] route and any future view that resolves a stop
   * without GPS (e.g. user picks a stop from a map). Returns null
   * when the stop_id does not exist.
   *
   * `stop.distance` is undefined here — there's no GPS context to
   * compute it against. Consumers that want a distance should use
   * getStationBoardsNear instead.
   */
  getStationBoard(
    stopId: number,
    nowMs: number,
    windowMinutes: number,
  ): Promise<{ stop: StopWithDistance; vehicles: Vehicle[] } | null>;

  /**
   * Resolve trip_id → route shape polyline for many trips in one
   * round-trip. Used by the Phase 5.4 prediction stage: the page
   * collects the trip_ids of every reconciled vehicle currently on
   * screen and asks for their shapes; the predictor then projects
   * vehicle + stop onto the polyline to derive a GPS-based ETA.
   *
   * Returned record is keyed by tripId. Trips whose shape is missing
   * from the feed are omitted from the result (caller falls back to
   * scheduled ETA for those).
   *
   * Worker caches shapes by shape_id, so re-fetching the same shape
   * across renders is O(1).
   */
  getShapesForTrips(
    tripIds: string[],
  ): Promise<Record<string, Array<{ lat: number; lon: number }>>>;

  /** Single route by id, or null when the id isn't in the feed. */
  getRouteById(routeId: string): Promise<Route | null>;

  /**
   * Schedule view: trips on (routeId, directionId) whose service is
   * active on `localDate` and whose tripStartMin falls in
   * [fromMin, fromMin + windowMinutes]. Each entry carries the
   * canonical trip_id, headsign, service_id, and origin start time.
   *
   * Callers compute the date + fromMin in feed-local tz themselves so
   * this method stays a pure window query — enabling "tomorrow until
   * noon" or "today including post-midnight night routes" without
   * special-casing inside the worker.
   */
  getRouteSchedule(
    routeId: string,
    directionId: 0 | 1,
    localDate: string,
    fromMin: number,
    windowMinutes: number,
  ): Promise<ScheduleTrip[]>;

  /**
   * Ordered list of stops a trip serves, with arrival time and
   * cumulative distance-along-shape at each (the latter omitted when
   * the feed doesn't carry shape_dist_traveled). Used by the schedule
   * view to render the stop strip + estimated arrival per stop.
   */
  getStopsAlongTrip(tripId: string): Promise<ScheduleTripStop[]>;

  /**
   * Departure times at the trip origin grouped by day-of-week
   * pattern: weekday (any Mon–Fri), saturday, sunday. Each list is
   * minutes-since-midnight, sorted ascending, deduped. Drives the
   * "Week" tab on the schedule view. Only `calendar.txt` rows are
   * considered; calendar_dates exceptions (one-off cancels / adds)
   * intentionally don't move the table since the user is reading a
   * recurring pattern, not a specific date.
   */
  getWeeklySchedule(
    routeId: string,
    directionId: 0 | 1,
  ): Promise<WeeklySchedule>;

  /**
   * Origin + terminus stop names for a (route, direction). Stable
   * for the life of the feed — derived from any single trip on the
   * pair. Lets the schedule + map headers show "{origin} → {headsign}"
   * the moment the page mounts, before (and independent of) the
   * trip / shape fetches that drive the body of the view. Null when
   * no trips exist on that pair.
   */
  getRouteDirectionEndpoints(
    routeId: string,
    directionId: 0 | 1,
  ): Promise<RouteDirectionEndpoints | null>;

  /**
   * All distinct routes that serve a given stop. Used by the map view
   * to show route badges inside the stop popup. Ordered by route
   * short_name (same sort as getRoutes). Empty array when the stop has
   * no scheduled service.
   */
  getRoutesForStop(stopId: number): Promise<Route[]>;

  /**
   * Route ids for which `stopId` is the first stop (origin) of at least one trip.
   * Used to show the isStart ▶ marker on route badges in the station view.
   */
  getOriginRoutesAtStop(stopId: number): Promise<string[]>;

  /**
   * One round-trip payload for the route-map view: every trip
   * currently active on (routeId, directionId) plus a representative
   * shape polyline for the direction.
   *
   * "Active" means a trip whose origin departure is in the window
   * `[localMin - lookbackMin, localMin + lookaheadMin]` AND that
   * isn't already past its terminus arrival. Each trip carries its
   * full ordered stop_times so the UI can predict the bus's current
   * position by interpolating between consecutive stops.
   *
   * The shape comes from the first matching trip — feeds whose
   * trips share a shape per direction (the common case) get a
   * single polyline; feeds with multiple shape variants per
   * direction render whichever variant the first trip uses, which
   * is good enough for the v2 cut.
   */
  getRouteMapView(
    routeId: string,
    directionId: 0 | 1,
    localDate: string,
    localMin: number,
    lookbackMin: number,
    lookaheadMin: number,
  ): Promise<RouteMapView | null>;
}

/** One trip on a route+direction, surfaced by getRouteSchedule. */
export interface ScheduleTrip {
  tripId: string;
  /** Minutes since local midnight at the trip's first stop. */
  tripStartMin: number;
  /** Headsign as published in trips.txt (operator-controlled). */
  headsign: string | null;
  /** GTFS service_id — exposed so the UI can spot
   *  through-the-night services (single service spanning past
   *  midnight) once the night-route handling lands. */
  serviceId: string;
}

/** Trip-origin departure times for a route+direction, bucketed by
 *  recurring weekly pattern. Each entry is minutes-since-midnight. */
export interface WeeklySchedule {
  /** Departures that run on any of Mon–Fri (per calendar.txt). */
  weekday: number[];
  saturday: number[];
  sunday: number[];
}

/** Origin + terminus stop names for a route+direction. Stable per
 *  feed; lets the schedule / map headers paint immediately, before
 *  the day's trips are fetched. */
export interface RouteDirectionEndpoints {
  originName: string;
  terminusName: string;
}

/** One stop on a single trip's stop_times. */
export interface ScheduleTripStop {
  stopId: number;
  stopName: string;
  lat: number;
  lon: number;
  /** GTFS "HH:MM:SS" arrival_time at this stop (may exceed 24h). */
  arrivalTime: string;
  /** Minutes since local midnight at this stop, for sorting + ETA. */
  arrivalMin: number;
  /** 1-based stop_sequence as in GTFS. */
  stopSequence: number;
}

/** One active trip in the map-view payload. */
export interface RouteMapTrip {
  tripId: string;
  headsign: string | null;
  /** Origin departure minute (the first stop's arrivalMin). */
  tripStartMin: number;
  /** Terminus arrival minute (the last stop's arrivalMin). */
  tripEndMin: number;
  /** Full ordered stop_times for the trip. */
  stops: ScheduleTripStop[];
}

/** One round-trip payload backing the route-map view. */
export interface RouteMapView {
  /** The route as `Route` (same shape served elsewhere). */
  route: import('$lib/domain/types').Route;
  /** Representative polyline for the direction. May be empty if the
   *  feed doesn't carry shapes.txt for this route. */
  shape: Array<{ lat: number; lon: number }>;
  /** Stops in shape order (deduped + sorted by their stop_sequence on
   *  the representative trip). Used both for stop markers on the map
   *  and for fitting the initial viewport. */
  stops: ScheduleTripStop[];
  /** Active trips on (routeId, directionId), sorted by tripStartMin
   *  ascending. */
  trips: RouteMapTrip[];
}
