/*
 * GTFS Web Worker — owns the SQLite-WASM instance and the OPFS-SAHPool VFS.
 *
 * Architecture (plan §3):
 *   - Runs in a dedicated worker so SQL queries never block the UI thread.
 *   - First launch downloads agency-<id>.sqlite3.gz from CDN (locally:
 *     /dev-data/agency-2.sqlite3.gz served from apps/web/static/),
 *     decompresses, and imports into the OPFS SAH pool. Subsequent launches
 *     open the OPFS-resident file directly.
 *   - The OPFS-SAHPool VFS works without COOP/COEP headers (it uses sync
 *     file APIs that are worker-only and don't need SharedArrayBuffer).
 *
 * The repo API is exposed via Comlink — typed as `GtfsRepo` (./types.ts).
 */

import * as Comlink from 'comlink';
import sqlite3InitModule, { type Database, type Sqlite3Static } from '@sqlite.org/sqlite-wasm';

import type { Route, Station } from '$lib/domain/types';
import type {
  GtfsRepo, Manifest, StopWithDistance, UpcomingDeparture,
} from '$lib/data/gtfs/types';

// ---------------------------------------------------------------------------
// Constants — Phase 2 hardcodes a single agency. Multi-agency support comes
// when the agency picker (Phase 3) lands; until then we always open agency 2.
// ---------------------------------------------------------------------------

const AGENCY_ID = 2;
const OPFS_POOL_NAME = 'neary-gtfs';
const OPFS_FILE = `/agency-${AGENCY_ID}.sqlite3`;
const SEED_URL = `/dev-data/agency-${AGENCY_ID}.sqlite3.gz`;
const MANIFEST_URL = `/dev-data/agency-${AGENCY_ID}.manifest.json`;

// ---------------------------------------------------------------------------
// Lazy bootstrap — first method call triggers init; subsequent ones await
// the same promise. Errors propagate to the caller via the Comlink boundary.
// ---------------------------------------------------------------------------

let dbReady: Promise<Database> | null = null;

async function bootstrap(): Promise<Database> {
  if (dbReady) return dbReady;
  dbReady = (async () => {
    // 1) Initialize the wasm runtime.
    const sqlite3: Sqlite3Static = await sqlite3InitModule({
      print: (m: string) => console.log('[gtfs.worker:sqlite]', m),
      printErr: (m: string) => console.error('[gtfs.worker:sqlite]', m),
    });

    // 2) Install the OPFS Synchronous Access Handle pool VFS. Returns a util
    //    object we'll use to import the seed and open the DB.
    //    `installOpfsSAHPoolVfs` is async — the pool can't be used before it
    //    resolves.
    const poolUtil = await sqlite3.installOpfsSAHPoolVfs({ name: OPFS_POOL_NAME });

    // 3) Seed if absent. `getFileNames()` lists files inside the pool's
    //    private OPFS area.
    const existing = poolUtil.getFileNames();
    if (!existing.includes(OPFS_FILE)) {
      console.log('[gtfs.worker] Seeding OPFS from', SEED_URL);
      const res = await fetch(SEED_URL);
      if (!res.ok || !res.body) {
        throw new Error(`Seed download failed (${res.status}). Did you run scripts/build-sqlite?`);
      }
      // Stream-decompress gzip in-place; modern browsers (incl. iOS Safari)
      // ship DecompressionStream natively.
      const decompressed = new Response(res.body.pipeThrough(new DecompressionStream('gzip')));
      const bytes = new Uint8Array(await decompressed.arrayBuffer());
      console.log(`[gtfs.worker] Decompressed ${bytes.byteLength} bytes; importing into OPFS…`);
      poolUtil.importDb(OPFS_FILE, bytes);
    } else {
      console.log('[gtfs.worker] OPFS already seeded; opening directly.');
    }

    // 4) Open the DB. The constructor exposed by the pool util produces a
    //    Database wired to the OPFS-backed file.
    const db = new poolUtil.OpfsSAHPoolDb(OPFS_FILE);
    db.exec('PRAGMA query_only = 1;'); // read-only is enough for the GTFS workload
    return db;
  })();
  return dbReady;
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
  async ready() {
    await bootstrap();
    return true;
  },

  async getManifest() {
    // Manifest sits alongside the gzipped DB on the same origin; it isn't in
    // the SQLite blob itself (so we can update freshness without rewriting
    // the DB).
    const res = await fetch(MANIFEST_URL);
    if (!res.ok) throw new Error(`Manifest fetch failed (${res.status})`);
    return (await res.json()) as Manifest;
  },

  async getRoutes(): Promise<Route[]> {
    const db = await bootstrap();
    type Row = { route_id: number; route_short_name: string; route_color: string | null; route_text_color: string | null };
    const rows = selectAll<Row>(
      db,
      // Sort numeric where possible, fall back to lexicographic for route ids
      // like "M5" / "B12". CAST returns 0 on non-numeric strings.
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
    const db = await bootstrap();
    // Bounding-box prefilter so SQL only walks nearby rows; then refine in
    // JS with exact Haversine and sort by distance.
    //
    // 1 deg lat ≈ 111_320 m globally; 1 deg lon ≈ 111_320 * cos(lat).
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
    const db = await bootstrap();

    // 1) Resolve services active on `localDate`. The CTP feed currently
    //    doesn't ship calendar_dates (exceptions), so this is a calendar-only
    //    lookup — when calendar_dates is present we should also UNION-add
    //    exception_type=1 services and EXCEPT exception_type=2 services for
    //    the same day. Cheap follow-up once the CSV is in the feed.
    const dow = new Date(
      Number(localDate.slice(0, 4)),
      Number(localDate.slice(4, 6)) - 1,
      Number(localDate.slice(6, 8)),
    ).getDay(); // 0 = Sunday
    const dayCol = dayKeyCols[(dow + 6) % 7]; // map JS Sunday=0 to monday-indexed array

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

    // 2) Find departures in the time window. Filter by service IN (...) and
    //    departure-time >= now AND <= now + window. Trips that wrap past
    //    midnight have departures like "25:13:00" — we compare as
    //    minutes-since-midnight (parsed in JS) below, so the SQL pulls a
    //    superset and JS narrows it.
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
};

Comlink.expose(api);
