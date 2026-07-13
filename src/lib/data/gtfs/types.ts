/*
 * Repository contract — the typed API the GTFS worker exposes via Comlink.
 *
 * This is the only thing UI code imports; the worker file itself is opaque
 * (Web Worker module, runs SQLite-WASM in OPFS). Keep this module pure
 * types so it stays trivially shareable between worker and main thread.
 */

import type { Feed } from '$lib/data/feeds';
import type { Network, Route, RouteTag, Station, Vehicle } from '$lib/domain/types';
import type { NearyFeedConfig } from '$lib/workers/gtfs/queries/feedConfig';
import type { ReconcileStats } from '$lib/domain/reconcile';

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

/** Payload broadcast by the worker after every live-poll + reconcile
 *  cycle. The single source of truth for "current vehicles" on the main
 *  thread; consumed by `reconciledVehiclesStore`.
 *
 *  `vehicles` holds the global reconciled set — a mix of `kind:
 *  'scheduled'` (active trips with no live match), `kind: 'tracked'`
 *  (matched), and `kind: 'gps-only'` (orphan live observations on a
 *  (route, dir) the feed knows about). ETA fields are origin-relative;
 *  station views recompute per-stop ETA locally. */
export interface ReconciledSnapshot {
  vehicles: Vehicle[];
  /** Upstream feed's own timestamp (Unix ms). Null when never fetched. */
  feedTimestampMs: number | null;
  /** Worker-side completion time of the latest tick (Unix ms). */
  lastFetchMs: number | null;
  /** Reconciler telemetry from the latest tick. Null before the first
   *  successful poll. */
  stats: ReconcileStats | null;
  /** Last error message, if the latest tick failed. Vehicles + stats
   *  reflect the previous successful tick when this is set, so the UI
   *  can keep rendering stale data while surfacing the failure. */
  error: string | null;
}

export interface GtfsRepo {
  /**
   * Bind the repo to a feed. First call for a given feed.id seeds the OPFS
   * file (downloads its sqlite_gz from `gtfs.n3ary.com` +
   * decompresses + opens). Subsequent calls with the same id are a no-op;
   * calls with a different id close the current DB and re-bootstrap
   * against the new one.
   *
   * `onProgress`, when passed, is invoked from inside the worker with the
   * running download counter. Wrap it with `Comlink.proxy()` on the caller
   * side so Comlink marshals it back across the worker boundary. Fires at
   * most every ~250 ms so a multi-hundred-MB sqlite_gz on a slow link
   * doesn't spam postMessages. `totalBytes` is `null` when the upstream
   * doesn't send Content-Length.
   *
   * Throws (rejects) with a descriptive message when the seed download or
   * open fails — the caller (typically the +layout effect) surfaces it via
   * StatusBar.
   */
  setFeed(
    feed: Feed,
    onProgress?: (bytesReceived: number, totalBytes: number | null) => void,
  ): Promise<void>;

  /** All routes, sorted by short_name (numeric where possible). */
  getRoutes(): Promise<Route[]>;

  /** All networks in the feed (`networks.txt`). Empty array for feeds
   *  that don't ship the table. */
  getNetworks(): Promise<Network[]>;

  /** All tags in the feed (`_route_tags.txt` producer extension).
   *  Empty array for feeds that don't ship the producer extension. */
  getRouteTags(): Promise<RouteTag[]>;

  /** Per-feed config written by the gtfs pipeline into `_neary_config`.
   *  Returns an empty object for blobs that pre-date this table. */
  getFeedConfig(): Promise<NearyFeedConfig>;

  /**
   * Stops within `radiusMeters` of (lat, lon). Bounding-box prefiltered in
   * SQL then refined by Haversine in JS — accurate, no spatial extension
   * needed.
   */
  getStopsNear(lat: number, lon: number, radiusMeters: number, limit?: number): Promise<StopWithDistance[]>;

  /**
   * Diacritic-insensitive substring search over stop names.
   *
   * `sort: 'distance'` (default) sorts by distance from the anchor
   * (GPS position or active feed's `center`); empty `text` falls back
   * to "nearest 25" so the header search overlay shows useful
   * results before the user types.
   *
   * `sort: 'name'` sorts alphabetically; anchor params are ignored.
   * Used when the user has no GPS — distance from the feed centroid
   * carries no rider-useful signal.
   */
  searchStops(
    text: string,
    anchorLat: number,
    anchorLon: number,
    limit?: number,
    sort?: 'distance' | 'name',
  ): Promise<StopWithDistance[]>;

  /**
   * Next departures from a stop within `windowMinutes` minutes, where the
   * trip's service is active on `localDate` ("YYYYMMDD"). Joins
   * stop_times -> trips -> routes -> calendar.
   */
  getDeparturesFromStop(
    stopId: string,
    localDate: string,
    localMinutesSinceMidnight: number,
    windowMinutes: number,
  ): Promise<UpcomingDeparture[]>;

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
    stopId: string,
    nowMs: number,
    windowMinutes: number,
  ): Promise<{ stop: StopWithDistance; vehicles: Vehicle[] } | null>;

  /**
   * Resolve a set of stop ids to their canonical Station records
   * (id + name + coordinates; distance is undefined - no GPS context).
   * Used by the favorites feature to render user-pinned stops without
   * pulling a schedule. Missing ids are silently dropped from the
   * result (a station may have been removed from a newer feed build
   * after the user favorited it).
   */
  getStopsByIds(stopIds: readonly string[]): Promise<StopWithDistance[]>;

  /**
   * Filter-cascade scope: distinct routes that serve each schedule-
   * bearing stop in the feed, optionally narrowed by mode + network.
   *
   * "Serves" = at least one trip with a usable arrival_time stops
   * there, same definition as `getRoutesForStops`. The 24-hour window
   * the spec mentions is implicit — we consider all services
   * (any day-of-week, any calendar window) so the result is stable
   * across a single bound feed and doesn't refetch as the minute
   * rolls over.
   *
   * Result: object keyed by stop_id; stops with zero matching
   * routes are absent (caller treats as out-of-scope). Empty
   * `networks` Set means "no networks match" — every station is out
   * of scope. Empty `modes` Set is the same.
   *
   * Cached in the worker keyed by filter signature (4-entry LRU cap)
   * so toggling filters back-and-forth is free after the first call.
   * Feed switches invalidate via the db handle.
   */
  getRoutesThroughStations(filter: {
    /** Mode filter: only routes whose GTFS route_type matches this
     *  VehicleType. undefined = no mode filter. */
    modes?: import('$lib/domain/types').VehicleType;
    /** Network filter: only routes carrying this single network id
     *  (1:1 per route — school / normal for the cluj feed). undefined
     *  = no network filter. */
    networks?: string;
    /** Tag filter: only routes carrying this single tag id (1:many
     *  per route — night / metroline / festival / airport / special
     *  for the cluj feed). undefined = no tag filter. */
    tags?: string;
  }): Promise<Record<string, Route[]>>;

  /**
   * One page of stations for the /favorites Stations tab.
   * `scope` is the pre-computed filter-cascade result; `undefined`
   * means "no filter cascade, return the full feed set".
   *
   * Returns the page rows plus the total scope size so the caller
   * can decide whether to prefetch the next page.
   */
  getStationsPage(query: {
    offset: number;
    limit: number;
    sortBy: 'name' | 'distance';
    anchor?: { lat: number; lon: number };
    scope?: ReadonlyArray<string>;
  }): Promise<{
    rows: StopWithDistance[];
    total: number;
  }>;

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
   * Distinct route_ids with at least one trip departing in
   * [nowMin, nowMin + windowMin] on the given local date. Used by
   * the /favorites Routes tab to rank "routes running right now"
   * to the top without an N+1 schedule call per route. Both
   * directions collapse to a single set.
   */
  getActiveRouteIdsInWindow(
    localDate: string,
    nowMin: number,
    windowMinutes: number,
  ): Promise<string[]>;

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
  getRoutesForStop(stopId: string): Promise<Route[]>;

  /**
   * Batched variant of {@link GtfsRepo.getRoutesForStop} — one worker
   * round-trip for many stops. Result keyed by stop_id; stops with no
   * routes are absent (callers treat as empty). Used by the header
   * search overlay to render route chips on every result row.
   */
  getRoutesForStops(stopIds: readonly string[]): Promise<Record<string, Route[]>>;
  /** Distinct stop IDs served by one route, across all trips. */
  getStopsForRoute(routeId: string): Promise<string[]>;
  /** Batched variant: `routeId -> stopIds[]` for many routes. */
  getStopsForRoutes(routeIds: readonly string[]): Promise<Record<string, string[]>>;

  /**
   * Route ids for which `stopId` is the first stop (origin) of at least one trip.
   * Used to show the isStart ▶ marker on route badges in the station view.
   */
  getOriginRoutesAtStop(stopId: string): Promise<string[]>;

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

  /**
   * Subscribe to the worker's reconciled-vehicles broadcast. The worker
   * polls GTFS-RT every `DEFAULT_CONFIG.livePollMs`, reconciles against
   * the active-trip set, and pushes a `ReconciledSnapshot` to every
   * subscriber. The callback is invoked immediately with the latest
   * snapshot if one is already available (late-subscriber catch-up).
   *
   * Returns an unsubscribe function (Comlink-proxied). Call it on
   * teardown — listeners are NOT cleared automatically on feed switch.
   */
  subscribeReconciled(
    cb: (snap: ReconciledSnapshot) => void,
  ): Promise<() => void>;

  /** Force an immediate live poll + reconciliation cycle. Used by the
   *  manual refresh button in the header. */
  refreshLive(): Promise<void>;

  /**
   * Subscribe a callback to receive per-stop assembled vehicle boards
   * on every successful live tick. Replaces the old pull-style
   * `assembleLiveBoards(boards, nowMs)` IPC method: the worker pushes
   * `Array<{ stopId, vehicles }>` (vehicles already merged + GPS-ETA
   * adjusted) every poll cycle and on `setStopIds` (so a stop-set
   * change or fresh subscription reflects within a microtask).
   *
   * Shape polylines and stop-distance arrays never cross IPC; the
   * worker resolves them from SQLite per push.
   *
   * The returned handle's `unsubscribe` and `setStopIds` are
   * Comlink-proxied — call them directly from main.
   *
   * Late subscribers receive an immediate push from the worker's
   * latest snapshot if one is already available.
   */
  subscribeStationBoards(
    initialStopIds: readonly string[],
    cb: (payload: StationBoardPush) => void,
  ): Promise<StationBoardsSubscription>;

  /**
   * Return the subset of `feeds` whose sqlite snapshot currently lives
   * in OPFS (i.e. downloaded at least once and not subsequently
   * deleted). Backs the Settings feed-picker's cache indicator —
   * cheap (one OPFS dir listing + a hash-map probe per feed) so the
   * page can call it after every registry refresh + after every delete
   * without worrying about redrawing the UI mid-flight.
   */
  listCachedFeeds(feeds: readonly Feed[]): Promise<string[]>;

  /**
   * Remove every OPFS file belonging to `feed.id` (legacy and every
   * hash-versioned snapshot). If the feed is the currently bound one
   * the worker's DB handle is closed first so the pool doesn't try
   * to reopen a file it has just dropped. No-op when nothing was
   * cached.
   *
   * Returns the number of files actually removed so the caller can
   * report a meaningful success / no-op status.
   */
  deleteFeedCache(feed: Feed): Promise<number>;
}

/** Per-stop assembled vehicles, as pushed by `subscribeStationBoards`.
 *  Stops that don't exist in the feed are silently dropped. */
export type StationBoardPush = ReadonlyArray<{
  stopId: string;
  vehicles: Vehicle[];
}>;

/** Comlink-proxied handle returned from `subscribeStationBoards`. */
export interface StationBoardsSubscription {
  /** Tear down the subscription. Call on component teardown. */
  unsubscribe: () => void;
  /** Replace the stop set. Triggers an immediate push so a stop-set
   *  change is reflected without waiting for the next poll. */
  setStopIds: (next: readonly string[]) => void;
}

/** One trip on a route+direction, surfaced by getRouteSchedule. */
export interface ScheduleTrip {
  tripId: string;
  /** Minutes since local midnight at the trip's first stop. */
  tripStartMin: number;
  /** Minutes since local midnight at the trip's last stop (terminus
   *  arrival). Lets the UI tell whether a past trip is still en
   *  route (`tripEndMin > nowMin`) and therefore still trackable on
   *  the map, or has finished its run. */
  tripEndMin: number;
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
  stopId: string;
  stopName: string;
  lat: number;
  lon: number;
  /** GTFS "HH:MM:SS" arrival_time at this stop (may exceed 24h). */
  arrivalTime: string;
  /** Minutes since local midnight at this stop, for sorting + ETA. */
  arrivalMin: number;
  /** 1-based stop_sequence as in GTFS. */
  stopSequence: number;
  /** GTFS `shape_dist_traveled` — cumulative distance along the trip's
   *  shape from origin to this stop, in metres. Populated at build time
   *  by feeds whose stop_times carry the column (per-feed opt-in via
   *  the producer pipeline). When present, runtime predictors can
   *  skip per-stop polyline projection; when absent (undefined),
   *  `buildTripShapePlan` falls back to
   *  projecting on the client. */
  distAlongM?: number;
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
