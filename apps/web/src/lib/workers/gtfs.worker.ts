/*
 * GTFS Web Worker — owns the SQLite-WASM instance and the OPFS-SAHPool VFS.
 *
 * Architecture (plan §3):
 *   - Runs in a dedicated worker so SQL queries never block the UI thread.
 *   - First launch downloads <id>.sqlite3.gz from the neary-gtfs binaries
 *     branch (fronted by jsDelivr), decompresses, and imports into the
 *     OPFS SAH pool. Subsequent launches open the OPFS-resident file
 *     directly.
 *   - The OPFS-SAHPool VFS works without COOP/COEP headers (it uses sync
 *     file APIs that are worker-only and don't need SharedArrayBuffer).
 *
 * The repo API is exposed via Comlink — typed as `GtfsRepo` (./types.ts).
 */

import * as Comlink from 'comlink';
import sqlite3InitModule, { type Database, type Sqlite3Static } from '@sqlite.org/sqlite-wasm';

import type { Feed } from '$lib/data/feeds';
import type { Route, Station, Vehicle } from '$lib/domain/types';
import type {
  GtfsRepo, StopWithDistance, UpcomingDeparture,
} from '$lib/data/gtfs/types';
import { scanSchedule, type ScheduleRow } from '$lib/domain/pipeline/scheduleScanner';
import { dateKeyInTz, minSinceMidnightInTz } from '$lib/domain/pipeline/timeUtils';

// ---------------------------------------------------------------------------
// Source URL resolution per feed.
//
// neary-gtfs publishes to the `binaries` branch. We fetch raw via
// raw.githubusercontent.com — CORS-open, stable, and after first fetch
// the file lives in OPFS so we never re-download. jsDelivr's CF edge
// (cdn.jsdelivr.net) intermittently 502s on this branch's binary files
// even when feeds.json is cached fine — see issue tracker. Each
// feeds.json entry has `files.sqlite_gz` as a path relative to the
// branch root.
// ---------------------------------------------------------------------------

const BINARIES_BASE = 'https://raw.githubusercontent.com/ciotlosm/neary-gtfs/binaries';
const OPFS_POOL_NAME = 'neary-gtfs';

function seedUrlFor(feed: Feed): string {
  if (!feed.files.sqlite_gz) {
    throw new Error(`Feed "${feed.id}" has no sqlite_gz in feeds.json`);
  }
  return `${BINARIES_BASE}/${feed.files.sqlite_gz}`;
}

function opfsFileFor(feedId: string): string {
  return `/${feedId}.sqlite3`;
}

// ---------------------------------------------------------------------------
// Lazy + feed-aware bootstrap. The pool is created once (it persists across
// feed switches — multiple feed files can coexist in OPFS). The DB instance
// is per-feed: switching feeds closes the previous DB and opens (or seeds)
// the new one.
// ---------------------------------------------------------------------------

let poolPromise: Promise<Awaited<ReturnType<Sqlite3Static['installOpfsSAHPoolVfs']>>> | null = null;
let currentFeedId: string | null = null;
let currentFeedTz: string | null = null;
let currentDb: Database | null = null;
let bootstrapping: Promise<Database> | null = null;

async function getPool() {
  if (!poolPromise) {
    poolPromise = (async () => {
      const sqlite3: Sqlite3Static = await sqlite3InitModule({
        print: (m: string) => console.log('[gtfs.worker:sqlite]', m),
        printErr: (m: string) => console.error('[gtfs.worker:sqlite]', m),
      });
      return sqlite3.installOpfsSAHPoolVfs({ name: OPFS_POOL_NAME });
    })();
  }
  return poolPromise;
}

async function bootstrap(feed: Feed): Promise<Database> {
  const poolUtil = await getPool();
  const opfsFile = opfsFileFor(feed.id);

  if (!poolUtil.getFileNames().includes(opfsFile)) {
    const url = seedUrlFor(feed);
    console.log(`[gtfs.worker] Seeding OPFS for feed ${feed.id} from`, url);
    const res = await fetch(url);
    if (!res.ok || !res.body) {
      throw new Error(`Seed download for feed "${feed.id}" failed (HTTP ${res.status})`);
    }
    // Magic-byte detection: some static servers (Vite's sirv during dev)
    // auto-decompress `.gz` responses; jsDelivr / GitHub raw do not.
    // Decompress only when the body still starts with the gzip header.
    let bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      const stream = new Response(bytes).body!.pipeThrough(new DecompressionStream('gzip'));
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    console.log(`[gtfs.worker] Importing ${bytes.byteLength} bytes into ${opfsFile}…`);
    poolUtil.importDb(opfsFile, bytes);
  } else {
    console.log(`[gtfs.worker] Feed ${feed.id} already seeded; opening directly.`);
  }

  const db = new poolUtil.OpfsSAHPoolDb(opfsFile);
  db.exec('PRAGMA query_only = 1;');
  return db;
}

/** Close the currently-open DB, if any. The OPFS file stays put. */
function closeCurrent() {
  if (currentDb) {
    try {
      currentDb.close();
    } catch (e) {
      console.warn('[gtfs.worker] db.close() failed', e);
    }
    currentDb = null;
  }
  currentFeedTz = null;
  bootstrapping = null;
  // Shape polylines are feed-scoped — invalidate so the next feed
  // can't see stale entries from this one.
  shapeCache.clear();
}

async function ensureDb(): Promise<Database> {
  if (currentDb) return currentDb;
  if (bootstrapping) return bootstrapping;
  throw new Error('GTFS worker not bound to a feed yet — call setFeed(feed) first.');
}

// ---------------------------------------------------------------------------
// Small query helper — selectObjects returns rows as plain JS objects.
// Cleaner than the resultRows-mutate-in-place pattern for our use case.
// ---------------------------------------------------------------------------

function selectAll<T>(db: Database, sql: string, bind?: unknown[]): T[] {
  return db.exec({
    sql,
    bind,
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as T[];
}

// ---------------------------------------------------------------------------
// Haversine distance (meters). Identical to the v1 distance util but inlined
// to keep the worker dependency-free.
// ---------------------------------------------------------------------------

function haversineMeters(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad;
  const dLon = (bLon - aLon) * toRad;
  const sa = Math.sin(dLat / 2);
  const so = Math.sin(dLon / 2);
  const c = sa * sa + Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * so * so;
  return 2 * R * Math.asin(Math.sqrt(c));
}

/** Convert HH:MM:SS (may exceed 24h, e.g. "25:13:00") to absolute minutes. */
function timeToMinutes(t: string): number {
  const [h, m] = t.split(':');
  return Number(h) * 60 + Number(m);
}

// ---------------------------------------------------------------------------
// Repo implementation
// ---------------------------------------------------------------------------

const dayKeyCols = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;

const api: GtfsRepo = {
  async setFeed(feed: Feed): Promise<void> {
    if (currentFeedId === feed.id && currentDb) return;
    if (currentFeedId === feed.id && bootstrapping) {
      await bootstrapping;
      return;
    }
    closeCurrent();
    currentFeedId = feed.id;
    currentFeedTz = feed.timezone || 'UTC';
    bootstrapping = bootstrap(feed);
    try {
      currentDb = await bootstrapping;
    } catch (e) {
      // Failure leaves us without a current db so subsequent calls fail
      // loudly. Reset the feed tracker so a later setFeed(sameFeed) can
      // retry.
      currentFeedId = null;
      throw e;
    } finally {
      bootstrapping = null;
    }
  },

  async ready() {
    await ensureDb();
    return true;
  },

  async getRoutes(): Promise<Route[]> {
    const db = await ensureDb();
    type Row = { route_id: number; route_short_name: string; route_color: string | null; route_text_color: string | null };
    const rows = selectAll<Row>(
      db,
      `SELECT route_id, route_short_name, route_color, route_text_color
       FROM routes
       ORDER BY CAST(route_short_name AS INTEGER), route_short_name;`,
    );
    return rows.map((r) => ({
      id: r.route_id,
      shortName: r.route_short_name,
      color: r.route_color ? `#${r.route_color}` : '#666666',
      textColor: r.route_text_color ? `#${r.route_text_color}` : undefined,
    }));
  },

  async getStopsNear(lat, lon, radiusMeters, limit = 25): Promise<StopWithDistance[]> {
    const db = await ensureDb();
    const dLat = radiusMeters / 111_320;
    const dLon = radiusMeters / (111_320 * Math.cos((lat * Math.PI) / 180));
    type Row = { stop_id: number; stop_name: string; stop_lat: number; stop_lon: number };
    const candidates = selectAll<Row>(
      db,
      `SELECT stop_id, stop_name, stop_lat, stop_lon
       FROM stops
       WHERE stop_lat BETWEEN ? AND ?
         AND stop_lon BETWEEN ? AND ?;`,
      [lat - dLat, lat + dLat, lon - dLon, lon + dLon],
    );
    const refined: StopWithDistance[] = candidates
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
    return refined;
  },

  async getDeparturesFromStop(stopId, localDate, localMinutesSinceMidnight, windowMinutes) {
    const db = await ensureDb();

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
      route_id: number;
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
        routeColor: r.route_color ? `#${r.route_color}` : '#666666',
        headsign: r.trip_headsign,
        departureTime: r.departure_time,
      }));
  },

  async getStationArrivals(stopId, nowMs, windowMinutes): Promise<Vehicle[]> {
    const db = await ensureDb();
    const tz = currentFeedTz ?? 'UTC';
    const localDate = dateKeyInTz(nowMs, tz);
    const nowMinSinceMidnight = minSinceMidnightInTz(nowMs, tz);

    const services = activeServicesOn(db, localDate);
    if (services.length === 0) return [];

    const placeholders = services.map(() => '?').join(',');
    const rows = selectAll<ScheduleRow>(
      db,
      // Four correlated subqueries per row:
      //   first_seq         — trip's origin index. Used to flag the
      //                       row as "this stop is the trip's start"
      //                       so the UI can render it at full opacity
      //                       (schedule is authoritative there) while
      //                       fading intermediate-stop scheduled rows.
      //   last_seq          — trip's terminus index, used to detect
      //                       drop-off-only terminus arrivals.
      //   trip_end_time     — arrival_time at that terminus, used to keep
      //                       a vehicle in the 'departed' bucket only
      //                       while it's still en route (not yet arrived
      //                       at its terminus).
      //   trip_start_time   — departure_time at the trip's FIRST stop
      //                       (origin). Surfaced for the reconciler so it
      //                       can match live observations by
      //                       (route, direction, start_time) instead of
      //                       trip_id (trip_ids drift between static GTFS
      //                       and GTFS-RT feeds in some operators).
      // All four are cheap thanks to stop_times_trip_seq_idx (trip_id, stop_sequence).
      `SELECT st.trip_id, st.arrival_time, st.departure_time, st.pickup_type,
              st.stop_sequence,
              t.direction_id,
              (SELECT MIN(stop_sequence) FROM stop_times WHERE trip_id = st.trip_id) AS first_seq,
              (SELECT MAX(stop_sequence) FROM stop_times WHERE trip_id = st.trip_id) AS last_seq,
              (SELECT arrival_time FROM stop_times WHERE trip_id = st.trip_id
               ORDER BY stop_sequence DESC LIMIT 1) AS trip_end_time,
              (SELECT departure_time FROM stop_times WHERE trip_id = st.trip_id
               ORDER BY stop_sequence ASC LIMIT 1) AS trip_start_time,
              r.route_id, r.route_short_name, r.route_color, r.route_text_color, r.route_type,
              t.trip_headsign,
              s.stop_lat, s.stop_lon
       FROM stop_times st
       JOIN trips t  ON t.trip_id  = st.trip_id
       JOIN routes r ON r.route_id = t.route_id
       JOIN stops s  ON s.stop_id  = st.stop_id
       WHERE st.stop_id = ?
         AND t.service_id IN (${placeholders});`,
      [stopId, ...services],
    );

    return scanSchedule({
      rows,
      nowMinSinceMidnight,
      nowMs,
      windowMinutes,
    });
  },

  async getStationBoardsNear(lat, lon, radiusMeters, maxStations, nowMs, windowMinutes) {
    // Single-round-trip variant of getStopsNear + N×getStationArrivals.
    // Worker does the fan-out so the UI sees one Promise instead of N+1.
    const stops = await api.getStopsNear(lat, lon, radiusMeters, maxStations);
    const boards: { stop: StopWithDistance; vehicles: Vehicle[] }[] = [];
    for (const stop of stops) {
      const vehicles = await api.getStationArrivals(stop.id, nowMs, windowMinutes);
      boards.push({ stop, vehicles });
    }
    return boards;
  },

  async getStationBoard(stopId, nowMs, windowMinutes) {
    // By-id entry point for /station/[id] and any future view that
    // resolves a stop without GPS (e.g. user taps a stop on the map).
    // Same shape as one element of getStationBoardsNear so consumers
    // can use the exact same assembleLiveBoard composer downstream.
    const db = await ensureDb();
    type Row = { stop_id: number; stop_name: string; stop_lat: number; stop_lon: number };
    const rows = selectAll<Row>(
      db,
      `SELECT stop_id, stop_name, stop_lat, stop_lon FROM stops WHERE stop_id = ?;`,
      [stopId],
    );
    if (rows.length === 0) return null;
    const s = rows[0];
    const vehicles = await api.getStationArrivals(stopId, nowMs, windowMinutes);
    return {
      stop: {
        id: s.stop_id, name: s.stop_name, lat: s.stop_lat, lon: s.stop_lon,
        // distance intentionally absent — no GPS context here, and
        // StopWithDistance treats it as optional. The StationCard
        // already handles undefined distance gracefully.
      },
      vehicles,
    };
  },

  async getShapesForTrips(tripIds) {
    if (tripIds.length === 0) return {};
    const db = await ensureDb();

    // 1. Resolve trip_id -> shape_id, deduped. Use a single IN(...)
    //    query so resolution is one round-trip regardless of how many
    //    vehicles are visible.
    const uniqTrips = Array.from(new Set(tripIds));
    const tripPh = uniqTrips.map(() => '?').join(',');
    type TripShapeRow = { trip_id: string; shape_id: string | null };
    const tripRows = selectAll<TripShapeRow>(
      db,
      `SELECT trip_id, shape_id FROM trips WHERE trip_id IN (${tripPh});`,
      uniqTrips,
    );
    const tripIdToShapeId = new Map<string, string>();
    for (const r of tripRows) {
      if (r.shape_id) tripIdToShapeId.set(r.trip_id, r.shape_id);
    }

    // 2. For shape_ids not yet cached, fetch their polylines in a
    //    single grouped SELECT. The composite index
    //    (shape_id, shape_pt_sequence) keeps this cheap.
    const neededShapeIds = new Set<string>();
    for (const sid of tripIdToShapeId.values()) {
      if (!shapeCache.has(sid)) neededShapeIds.add(sid);
    }
    if (neededShapeIds.size > 0) {
      const shapePh = Array.from(neededShapeIds).map(() => '?').join(',');
      type ShapeRow = { shape_id: string; shape_pt_lat: number; shape_pt_lon: number };
      const shapeRows = selectAll<ShapeRow>(
        db,
        `SELECT shape_id, shape_pt_lat, shape_pt_lon
         FROM shapes
         WHERE shape_id IN (${shapePh})
         ORDER BY shape_id, shape_pt_sequence;`,
        Array.from(neededShapeIds),
      );
      const grouped = new Map<string, Array<{ lat: number; lon: number }>>();
      for (const r of shapeRows) {
        const list = grouped.get(r.shape_id) ?? [];
        list.push({ lat: r.shape_pt_lat, lon: r.shape_pt_lon });
        grouped.set(r.shape_id, list);
      }
      for (const sid of neededShapeIds) {
        // Cache even empty shapes (negative cache) so a missing
        // shape_id doesn't re-query every render.
        shapeCache.set(sid, grouped.get(sid) ?? []);
      }
    }

    // 3. Build the tripId-keyed result. Trips with no shape_id or
    //    an empty cached polyline are omitted — caller falls back.
    const out: Record<string, Array<{ lat: number; lon: number }>> = {};
    for (const tid of uniqTrips) {
      const sid = tripIdToShapeId.get(tid);
      if (!sid) continue;
      const poly = shapeCache.get(sid);
      if (!poly || poly.length < 2) continue;
      out[tid] = poly;
    }
    return out;
  },

  async getRouteById(routeId) {
    const db = await ensureDb();
    type Row = {
      route_id: number;
      route_short_name: string;
      route_color: string | null;
      route_text_color: string | null;
    };
    const rows = selectAll<Row>(
      db,
      `SELECT route_id, route_short_name, route_color, route_text_color
       FROM routes WHERE route_id = ?;`,
      [routeId],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      id: r.route_id,
      shortName: r.route_short_name,
      color: r.route_color ? `#${r.route_color}` : '#666666',
      textColor: r.route_text_color ? `#${r.route_text_color}` : undefined,
    };
  },

  async getRouteSchedule(routeId, directionId, nowMs, windowMinutes) {
    // Trips on (routeId, directionId) whose service is active today
    // AND whose origin departure falls within [now, now + window].
    // We deliberately key off the trip's FIRST stop's departure_time
    // (origin) so the schedule view aligns with passenger language
    // ("when does the 25 leave Mărăști?"), and so it dovetails with
    // the reconciler's match key.
    const db = await ensureDb();
    const tz = currentFeedTz ?? 'UTC';
    const localDate = dateKeyInTz(nowMs, tz);
    const nowMin = minSinceMidnightInTz(nowMs, tz);

    const services = activeServicesOn(db, localDate);
    if (services.length === 0) return [];

    const placeholders = services.map(() => '?').join(',');
    type Row = {
      trip_id: string;
      trip_headsign: string | null;
      service_id: string;
      trip_start_time: string;
    };
    const rows = selectAll<Row>(
      db,
      `SELECT t.trip_id, t.trip_headsign, t.service_id,
              (SELECT departure_time FROM stop_times WHERE trip_id = t.trip_id
               ORDER BY stop_sequence ASC LIMIT 1) AS trip_start_time
       FROM trips t
       WHERE t.route_id = ?
         AND t.direction_id = ?
         AND t.service_id IN (${placeholders});`,
      [routeId, directionId, ...services],
    );

    const upper = nowMin + windowMinutes;
    return rows
      .map((r) => ({
        tripId: r.trip_id,
        tripStartMin: timeToMinutes(r.trip_start_time),
        headsign: r.trip_headsign,
        serviceId: r.service_id,
      }))
      .filter((r) => r.tripStartMin >= nowMin && r.tripStartMin <= upper)
      .sort((a, b) => a.tripStartMin - b.tripStartMin);
  },

  async getStopsAlongTrip(tripId) {
    const db = await ensureDb();
    type Row = {
      stop_id: number;
      stop_name: string;
      stop_lat: number;
      stop_lon: number;
      arrival_time: string;
      stop_sequence: number;
    };
    const rows = selectAll<Row>(
      db,
      `SELECT s.stop_id, s.stop_name, s.stop_lat, s.stop_lon,
              st.arrival_time, st.stop_sequence
       FROM stop_times st
       JOIN stops s ON s.stop_id = st.stop_id
       WHERE st.trip_id = ?
       ORDER BY st.stop_sequence ASC;`,
      [tripId],
    );
    return rows.map((r) => ({
      stopId: r.stop_id,
      stopName: r.stop_name,
      lat: r.stop_lat,
      lon: r.stop_lon,
      arrivalTime: r.arrival_time,
      arrivalMin: timeToMinutes(r.arrival_time),
      stopSequence: r.stop_sequence,
    }));
  },
};

// Shape cache lives at module scope so it survives across method
// calls. Shapes are immutable per feed; the cache is invalidated
// implicitly when setFeed swaps the database (closeCurrent below
// clears it explicitly).
const shapeCache = new Map<string, Array<{ lat: number; lon: number }>>();

// ---------------------------------------------------------------------------
// Service-calendar helper — resolves which service_ids are active for a
// local YYYYMMDD considering both `calendar` (weekly pattern + validity
// range) and `calendar_dates` (exceptions: 1 = added, 2 = removed).
// ---------------------------------------------------------------------------

function activeServicesOn(db: Database, localDate: string): string[] {
  const dow = new Date(
    Number(localDate.slice(0, 4)),
    Number(localDate.slice(4, 6)) - 1,
    Number(localDate.slice(6, 8)),
  ).getDay();
  const dayCol = dayKeyCols[(dow + 6) % 7];

  type IdRow = { service_id: string };
  const base = selectAll<IdRow>(
    db,
    `SELECT service_id FROM calendar
     WHERE ${dayCol} = 1
       AND start_date <= ?
       AND end_date >= ?;`,
    [localDate, localDate],
  ).map((r) => r.service_id);

  const removed = new Set(
    selectAll<IdRow>(
      db,
      `SELECT service_id FROM calendar_dates WHERE date = ? AND exception_type = 2;`,
      [localDate],
    ).map((r) => r.service_id),
  );

  const added = selectAll<IdRow>(
    db,
    `SELECT service_id FROM calendar_dates WHERE date = ? AND exception_type = 1;`,
    [localDate],
  ).map((r) => r.service_id);

  return Array.from(new Set([...base.filter((id) => !removed.has(id)), ...added]));
}

Comlink.expose(api);
