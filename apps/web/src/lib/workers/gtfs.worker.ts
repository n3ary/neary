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
// Source URL resolution per agency.
//
// Phase 2 ships agency 2 (CTP Cluj) locally — scripts/build-sqlite outputs
// to apps/web/static/dev-data/, served at /dev-data/. Other agencies don't
// have a SQLite blob yet; the future location once the neary-gtfs pipeline
// publishes them is encoded here so the URL doesn't move when they land.
// ---------------------------------------------------------------------------

const OPFS_POOL_NAME = 'neary-gtfs';

function seedUrlFor(agencyId: number): string {
  // Local-first for agency 2 so dev doesn't depend on the (yet-to-exist) CDN
  // .sqlite3 publication. Production deploy will swap this branch out once
  // the pipeline lands the blob on the releases branch.
  if (agencyId === 2) return `/dev-data/agency-${agencyId}.sqlite3.gz`;
  return `https://raw.githubusercontent.com/ciotlosm/neary-gtfs/releases/data/${agencyId}/${agencyId}.sqlite3.gz`;
}

function manifestUrlFor(agencyId: number): string {
  if (agencyId === 2) return `/dev-data/agency-${agencyId}.manifest.json`;
  return `https://raw.githubusercontent.com/ciotlosm/neary-gtfs/releases/data/${agencyId}/${agencyId}.manifest.json`;
}

function opfsFileFor(agencyId: number): string {
  return `/agency-${agencyId}.sqlite3`;
}

// ---------------------------------------------------------------------------
// Lazy + agency-aware bootstrap. The pool is created once (it persists across
// agency switches — multiple agency files can coexist in OPFS). The DB
// instance is per-agency: switching agencies closes the previous DB and
// opens (or seeds) the new one.
// ---------------------------------------------------------------------------

let poolPromise: Promise<Awaited<ReturnType<Sqlite3Static['installOpfsSAHPoolVfs']>>> | null = null;
let currentAgencyId: number | null = null;
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

async function bootstrap(agencyId: number): Promise<Database> {
  const poolUtil = await getPool();
  const opfsFile = opfsFileFor(agencyId);

  if (!poolUtil.getFileNames().includes(opfsFile)) {
    const url = seedUrlFor(agencyId);
    console.log(`[gtfs.worker] Seeding OPFS for agency ${agencyId} from`, url);
    const res = await fetch(url);
    if (!res.ok || !res.body) {
      throw new Error(
        `Seed download for agency ${agencyId} failed (HTTP ${res.status}). ` +
        (agencyId === 2
          ? 'Did you run scripts/build-sqlite?'
          : 'This agency does not have a SQLite blob published yet.'),
      );
    }
    // Magic-byte detection: some static servers (Vite's sirv) auto-decompress
    // `.gz` responses; raw.githubusercontent.com does not. Decompress only
    // when the body still starts with the gzip header.
    let bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      const stream = new Response(bytes).body!.pipeThrough(new DecompressionStream('gzip'));
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    console.log(`[gtfs.worker] Importing ${bytes.byteLength} bytes into ${opfsFile}…`);
    poolUtil.importDb(opfsFile, bytes);
  } else {
    console.log(`[gtfs.worker] Agency ${agencyId} already seeded; opening directly.`);
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
  bootstrapping = null;
}

async function ensureDb(): Promise<Database> {
  if (currentDb) return currentDb;
  if (bootstrapping) return bootstrapping;
  throw new Error('GTFS worker not bound to an agency yet — call setAgency(id) first.');
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
  async setAgency(agencyId: number): Promise<void> {
    if (currentAgencyId === agencyId && currentDb) return;
    if (currentAgencyId === agencyId && bootstrapping) {
      await bootstrapping;
      return;
    }
    closeCurrent();
    currentAgencyId = agencyId;
    bootstrapping = bootstrap(agencyId);
    try {
      currentDb = await bootstrapping;
    } catch (e) {
      // Failure leaves us without a current db so subsequent calls fail
      // loudly. Reset the agency tracker so a later setAgency(sameId) can
      // retry.
      currentAgencyId = null;
      throw e;
    } finally {
      bootstrapping = null;
    }
  },

  async ready() {
    await ensureDb();
    return true;
  },

  async getManifest() {
    if (currentAgencyId == null) {
      throw new Error('No agency set — call setAgency(id) first.');
    }
    const res = await fetch(manifestUrlFor(currentAgencyId));
    if (!res.ok) throw new Error(`Manifest fetch failed (${res.status})`);
    return (await res.json()) as Manifest;
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
};

Comlink.expose(api);
