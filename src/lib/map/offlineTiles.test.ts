/**
 * offlineTiles.test.ts — slippy-map math, budget zoom selection, and
 * the bbox prefetch loop. caches/fetch/localStorage/navigator are
 * stubbed on globalThis; the stub fetch plays the SW's role (caching
 * stamped responses), which is exactly how production works.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  lonToTileX,
  latToTileY,
  tilesForBbox,
  pickPrefetchZooms,
  tileUrl,
  prefetchFeedTiles,
  getTileCacheStatus,
  deleteTileCache,
  PREFETCH_INTERVAL_MS,
} from './offlineTiles.js';
import { OSM_TILE_CACHE_NAME } from '$lib/sw/handlers';
import type { Feed } from '$lib/data/feeds';

const ORADEA_BBOX: Feed['bbox'] = {
  minLat: 46.89047,
  minLon: 21.71732,
  maxLat: 47.16987,
  maxLon: 22.11185,
};
const CLUJ_BBOX: Feed['bbox'] = {
  minLat: 44.17349,
  minLon: 23.28848,
  maxLat: 46.89827,
  maxLon: 28.65672,
};

const feed = (bbox: Feed['bbox']): Feed => ({ id: 'test-feed', name: 'Test', bbox }) as Feed;

/* ---------- stub plumbing ---------- */

function makeStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    _store: store,
  };
}

/** Simulates the SW tile handler: every fetch caches a copy stamped
 *  with the test's shared clock, so freshness math is deterministic. */
function makeSwWorld(opts: { fail?: boolean } = {}) {
  const tileStore = new Map<string, Response>();
  const clock = { now: 1_780_000_000_000 };
  const cache = {
    match: async (url: string) => tileStore.get(url) ?? null,
  };
  const cachesStub = { open: async () => cache };
  const fetchStub = vi.fn(async (url: string) => {
    if (opts.fail) throw new TypeError('Load failed');
    const res = new Response('PNG', { status: 200 });
    tileStore.set(
      url,
      new Response('PNG', {
        status: 200,
        headers: { 'x-sw-cached-at': String(clock.now) },
      }),
    );
    return res;
  });
  return { tileStore, cachesStub, fetchStub, clock };
}

let storage: ReturnType<typeof makeStorage>;

beforeEach(() => {
  storage = makeStorage();
  vi.stubGlobal('localStorage', storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ---------- math ---------- */

describe('slippy map math', () => {
  it('maps the Cluj center to its known z13 tile', () => {
    expect(lonToTileX(23.6, 13)).toBe(4633);
    expect(latToTileY(46.77, 13)).toBe(2888);
  });

  it('is (0,0) at z0 and clamps at the edges', () => {
    expect(lonToTileX(0, 0)).toBe(0);
    expect(latToTileY(0, 0)).toBe(0);
    expect(lonToTileX(180, 13)).toBe(2 ** 13 - 1);
    expect(lonToTileX(-180, 13)).toBe(0);
    expect(latToTileY(89, 10)).toBe(0);
    expect(latToTileY(-89, 10)).toBe(2 ** 10 - 1);
  });

  it('counts a bbox grid without gaps', () => {
    // Ground truth computed independently of this module.
    expect(tilesForBbox(ORADEA_BBOX, 12)).toHaveLength(30);
    expect(tilesForBbox(ORADEA_BBOX, 13)).toHaveLength(100);
  });
});

describe('pickPrefetchZooms', () => {
  it('a city bbox gets z13–z14 within the budget', () => {
    expect(pickPrefetchZooms(ORADEA_BBOX)).toEqual([13, 14]);
  });

  it('a regional bbox is capped at z13', () => {
    // cluj-napoca's bbox is ~300 km across: z13 alone is 54 948 tiles,
    // well over the 600-budget, so only z13 fits.
    expect(pickPrefetchZooms(CLUJ_BBOX)).toEqual([13]);
  });

  it('a tiny bbox uses every zoom up to the max', () => {
    const tiny = { minLat: 46.77, minLon: 23.59, maxLat: 46.78, maxLon: 23.61 };
    expect(pickPrefetchZooms(tiny)).toEqual([13, 14, 15, 16, 17]);
  });

  it('never returns an empty set', () => {
    const huge = { minLat: 0, minLon: 0, maxLat: 60, maxLon: 120 };
    expect(pickPrefetchZooms(huge, 1)).toEqual([13]);
  });
});

describe('tileUrl', () => {
  it('builds a deterministic slippy URL across subdomains', () => {
    expect(tileUrl({ z: 13, x: 4633, y: 2888 })).toBe(
      'https://a.tile.openstreetmap.org/13/4633/2888.png',
    );
    expect(tileUrl({ z: 13, x: 4633, y: 2888 })).toBe(tileUrl({ z: 13, x: 4633, y: 2888 }));
  });
});

/* ---------- prefetch ---------- */

describe('prefetchFeedTiles', () => {
  function stubEnv(worldOpts: { fail?: boolean } = {}, navigatorOpts: object = { onLine: true }) {
    const world = makeSwWorld(worldOpts);
    vi.stubGlobal('caches', world.cachesStub);
    vi.stubGlobal('fetch', world.fetchStub);
    vi.stubGlobal('navigator', navigatorOpts);
    return world;
  }

  it('warms every budget tile on first run and stamps the feed', async () => {
    const world = stubEnv();

    const r = await prefetchFeedTiles(feed(ORADEA_BBOX), world.clock.now);

    // oradea z13 (100) + z14 (361) = 461 tiles.
    expect(r).toEqual({ fetched: 461, skipped: 0, failed: 0 });
    expect(world.fetchStub).toHaveBeenCalledTimes(461);
    expect(world.tileStore.size).toBe(461);
    const stamps = JSON.parse(storage._store.get('neary-tile-prefetch-v1')!);
    expect(stamps['test-feed']).toBe(world.clock.now);
  });

  it('skips the run entirely inside the interval', async () => {
    const world = stubEnv();
    await prefetchFeedTiles(feed(ORADEA_BBOX), world.clock.now);

    const r = await prefetchFeedTiles(
      feed(ORADEA_BBOX),
      world.clock.now + PREFETCH_INTERVAL_MS - 1,
    );

    expect(r).toBeNull();
    expect(world.fetchStub).toHaveBeenCalledTimes(461);
  });

  it('re-run after the interval skips still-fresh tiles', async () => {
    const world = stubEnv();
    await prefetchFeedTiles(feed(ORADEA_BBOX), world.clock.now);

    // 25h later: all 461 cached tiles are ~1 day old, far under the
    // 30-day freshness window, so no network traffic at all.
    world.clock.now += 25 * 60 * 60_000;
    const r = await prefetchFeedTiles(feed(ORADEA_BBOX), world.clock.now);

    expect(r).toEqual({ fetched: 0, skipped: 461, failed: 0 });
  });

  it('does nothing when offline', async () => {
    const world = stubEnv({}, { onLine: false });
    expect(await prefetchFeedTiles(feed(ORADEA_BBOX))).toBeNull();
    expect(world.fetchStub).not.toHaveBeenCalled();
  });

  it('does nothing on Save-Data or 2g', async () => {
    const a = stubEnv({}, { onLine: true, connection: { saveData: true } });
    expect(await prefetchFeedTiles(feed(ORADEA_BBOX))).toBeNull();
    expect(a.fetchStub).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
    const b = stubEnv({}, { onLine: true, connection: { effectiveType: '2g' } });
    expect(await prefetchFeedTiles(feed(ORADEA_BBOX))).toBeNull();
    expect(b.fetchStub).not.toHaveBeenCalled();
  });

  it('counts failures but still stamps the feed (no retry storm)', async () => {
    const world = stubEnv({ fail: true });

    const r = await prefetchFeedTiles(feed(ORADEA_BBOX), world.clock.now);

    expect(r).toEqual({ fetched: 0, skipped: 0, failed: 461 });
    const stamps = JSON.parse(storage._store.get('neary-tile-prefetch-v1')!);
    expect(stamps['test-feed']).toBe(world.clock.now);
  });
});


/* ---------- tile cache management ---------- */

describe('getTileCacheStatus', () => {
  it('returns entry count and estimated bytes from the cache', async () => {
    const tileStore = new Map<string, Response>();
    const cache = {
      async match() { return null; },
      async keys() {
        return Array.from(tileStore.keys()) as unknown as Request[];
      },
    };
    const cachesStub = {
      open: async () => cache,
    };
    // Seed 100 entries.
    for (let i = 0; i < 100; i++) {
      tileStore.set(`https://a.tile.openstreetmap.org/13/4633/${2888 + i}.png`, new Response());
    }
    vi.stubGlobal('caches', cachesStub);

    const result = await getTileCacheStatus();

    expect(result).toEqual({ entries: 100, estimatedBytes: 100 * 12 * 1024 });
    vi.unstubAllGlobals();
  });

  it('returns null when Cache API is unavailable', async () => {
    vi.stubGlobal('caches', undefined);
    expect(await getTileCacheStatus()).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe('deleteTileCache', () => {
  it('deletes the cache store and clears the prefetch stamp', async () => {
    const tileStore = new Map<string, Response>();
    const cache = {
      async match() { return null; },
      async keys() {
        return Array.from(tileStore.keys()) as unknown as Request[];
      },
    };
    const deletedCaches: string[] = [];
    const cachesStub = {
      open: async () => cache,
      delete: async (name: string) => { deletedCaches.push(name); return true; },
    };
    for (let i = 0; i < 50; i++) {
      tileStore.set(`https://a.tile.openstreetmap.org/13/4633/${2888 + i}.png`, new Response());
    }
    storage._store.set('neary-tile-prefetch-v1', JSON.stringify({ 'test-feed': 1_780_000_000_000 }));
    vi.stubGlobal('caches', cachesStub);

    const count = await deleteTileCache();

    expect(count).toBe(50);
    expect(deletedCaches).toContain(OSM_TILE_CACHE_NAME);
    expect(storage._store.get('neary-tile-prefetch-v1')).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('returns 0 when Cache API is unavailable', async () => {
    vi.stubGlobal('caches', undefined);
    expect(await deleteTileCache()).toBe(0);
    vi.unstubAllGlobals();
  });
});
