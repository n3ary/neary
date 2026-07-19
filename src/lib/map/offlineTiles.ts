/**
 * offlineTiles — bbox-driven prefetch of OSM map tiles so the map
 * view keeps working with no connection, and stays fresh when there
 * is one.
 *
 * How it fits together:
 *   - The SW owns the tile bucket (`cacheFirstOsmTile`, fixed-name
 *     cache `runtime-osm-tiles-v1`): every tile request — Leaflet's
 *     or ours — is CacheFirst with a 30-day background revalidate.
 *   - This module only decides WHICH tile URLs to warm, then issues
 *     plain fetch()es; the SW intercepts them and does the actual
 *     caching with its put-time stamp. (Without a SW — dev mode —
 *     the fetches just warm the browser HTTP cache; harmless.)
 *   - `prefetchFeedTiles` is called once per feed bind (see
 *     +layout.svelte) and again on every `online` event.
 *
 * OSM Tile Usage Policy
 * (https://operations.osmfoundation.org/policies/tiles/) — bulk
 * downloading is what gets clients blocked, so the prefetch is
 * deliberately conservative:
 *   - hard budget of PREFETCH_TILE_BUDGET tiles per feed, choosing
 *     the highest zooms that fit (a regional bbox like cluj-napoca
 *     gets z10 only ~192 tiles; a city bbox like oradea gets
 *     z10–z14 ~507 tiles). Everything above that zoom is cached
 *     lazily, when the user actually views it.
 *   - at most CONCURRENCY requests in flight.
 *   - skipped entirely on Save-Data / 2g, and re-runs at most once
 *     per PREFETCH_INTERVAL_MS per feed regardless of how often the
 *     app opens or reconnects.
 */

import type { Feed } from '$lib/data/feeds';
import { OSM_TILE_CACHE_NAME, OSM_TILE_MAX_AGE_MS } from '$lib/sw/handlers';

export interface TileCoord {
  z: number;
  x: number;
  y: number;
}

export const PREFETCH_ZOOM_MIN = 10;
export const PREFETCH_ZOOM_MAX = 14;
export const PREFETCH_TILE_BUDGET = 600;
export const PREFETCH_INTERVAL_MS = 24 * 60 * 60_000;
const CONCURRENCY = 2;
const STAMP_KEY = 'neary-tile-prefetch-v1';

/** Slippy-map tile math (wiki.openstreetmap.org/wiki/Slippy_map). */
export function lonToTileX(lon: number, z: number): number {
  return Math.min(2 ** z - 1, Math.max(0, Math.floor(((lon + 180) / 360) * 2 ** z)));
}

export function latToTileY(lat: number, z: number): number {
  // Web-Mercator is undefined at the poles; clamp to the tile grid.
  const clamped = Math.min(85.05112878, Math.max(-85.05112878, lat));
  const r = (clamped * Math.PI) / 180;
  return Math.min(
    2 ** z - 1,
    Math.max(0, Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z)),
  );
}

export function tilesForBbox(
  bbox: Feed['bbox'],
  z: number,
): TileCoord[] {
  const x0 = lonToTileX(bbox.minLon, z);
  const x1 = lonToTileX(bbox.maxLon, z);
  // North edge has the smaller y.
  const y0 = latToTileY(bbox.maxLat, z);
  const y1 = latToTileY(bbox.minLat, z);
  const out: TileCoord[] = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      out.push({ z, x, y });
    }
  }
  return out;
}

function countTiles(bbox: Feed['bbox'], z: number): number {
  return (
    (lonToTileX(bbox.maxLon, z) - lonToTileX(bbox.minLon, z) + 1) *
    (latToTileY(bbox.minLat, z) - latToTileY(bbox.maxLat, z) + 1)
  );
}

/** Largest prefix PREFETCH_ZOOM_MIN..z whose cumulative tile count
 *  fits the budget. Always returns at least [PREFETCH_ZOOM_MIN] — a
 *  coarse outline beats no offline map at all. */
export function pickPrefetchZooms(
  bbox: Feed['bbox'],
  budget: number = PREFETCH_TILE_BUDGET,
): number[] {
  const zooms: number[] = [];
  let total = 0;
  for (let z = PREFETCH_ZOOM_MIN; z <= PREFETCH_ZOOM_MAX; z++) {
    total += countTiles(bbox, z);
    if (total > budget) break;
    zooms.push(z);
  }
  return zooms.length > 0 ? zooms : [PREFETCH_ZOOM_MIN];
}

/** Deterministic subdomain spread so the prefetch doesn't hammer one
 *  host (OSM serves a/b/c; the app already allows all three in CSP). */
export function tileUrl(t: TileCoord): string {
  const s = ['a', 'b', 'c'][(t.x + t.y) % 3];
  return `https://${s}.tile.openstreetmap.org/${t.z}/${t.x}/${t.y}.png`;
}

function readStamps(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(STAMP_KEY) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
}

/**
 * Warm the tile cache for the feed's bbox. Returns null when skipped
 * (offline, metered connection, ran recently, or no Cache API);
 * otherwise the run's counts. Never throws — this is a background
 * nicety, it must never break the boot path.
 */
export async function prefetchFeedTiles(
  feed: Feed,
  now: number = Date.now(),
): Promise<{ fetched: number; skipped: number; failed: number } | null> {
  if (typeof caches === 'undefined' || typeof localStorage === 'undefined') return null;
  if (typeof navigator !== 'undefined') {
    if (!navigator.onLine) return null;
    const conn = (
      navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }
    ).connection;
    if (conn?.saveData || conn?.effectiveType === '2g' || conn?.effectiveType === 'slow-2g') {
      return null;
    }
  }
  const stamps = readStamps();
  if (now - (stamps[feed.id] ?? 0) < PREFETCH_INTERVAL_MS) return null;

  const zooms = pickPrefetchZooms(feed.bbox);
  const urls = zooms.flatMap((z) => tilesForBbox(feed.bbox, z)).map(tileUrl);
  const cache = await caches.open(OSM_TILE_CACHE_NAME);
  const result = { fetched: 0, skipped: 0, failed: 0 };

  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const url = urls[next++]!;
      try {
        const existing = await cache.match(url);
        if (existing) {
          const cachedAt = Number(existing.headers.get('x-sw-cached-at') ?? 0);
          if (now - cachedAt < OSM_TILE_MAX_AGE_MS) {
            result.skipped++;
            continue;
          }
        }
        // The SW's tile handler caches the response on its way through.
        const res = await fetch(url);
        if (res.ok) result.fetched++;
        else result.failed++;
      } catch {
        result.failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // Stamp even on partial failure — otherwise a feed with a few
  // persistently failing tiles would retry the whole bbox on every
  // launch and burn metered data.
  stamps[feed.id] = now;
  try {
    localStorage.setItem(STAMP_KEY, JSON.stringify(stamps));
  } catch {
    // Quota / privacy mode — next launch just re-checks the cache.
  }
  return result;
}

let lastFeed: Feed | null = null;
let listenerArmed = false;
let queued = false;

function queueIdlePrefetch(feed: Feed): void {
  if (queued || typeof window === 'undefined') return;
  queued = true;
  const go = () => {
    queued = false;
    void prefetchFeedTiles(feed).then((r) => {
      if (r) {
        console.log(
          `[tiles] prefetch ${feed.id}: ${r.fetched} fetched, ${r.skipped} already cached, ${r.failed} failed`,
        );
      }
    });
  };
  // Idle-time: tile warming must never contend with the boot path.
  // Safari lacks requestIdleCallback; the cast keeps TS from
  // narrowing window to never in the fallback branch.
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  };
  if (w.requestIdleCallback) {
    w.requestIdleCallback(go, { timeout: 15_000 });
  } else {
    w.setTimeout(go, 3_000);
  }
}

/** Entry point called from +layout.svelte after a feed binds.
 *  Idempotent per feed; also re-arms on every `online` event so the
 *  cache refreshes itself whenever connectivity returns. */
export function scheduleTilePrefetch(feed: Feed): void {
  lastFeed = feed;
  queueIdlePrefetch(feed);
  if (listenerArmed || typeof window === 'undefined') return;
  listenerArmed = true;
  window.addEventListener('online', () => {
    if (lastFeed) queueIdlePrefetch(lastFeed);
  });
}
