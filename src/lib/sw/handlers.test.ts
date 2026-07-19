/**
 * sw/handlers.test.ts — unit tests for the Service Worker fetch
 * handlers. The handlers are pure functions over the standard
 * Cache + Fetch APIs; these tests mock those APIs directly so
 * the SW's top-level self.addEventListener side effects don't
 * run.
 *
 * The mocked APIs (caches, fetch) are installed on globalThis
 * before the handlers module is imported, so when the SW
 * imports the handlers it sees the mocks too.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import {
  networkFirstNavigation,
  serveFromPrecache,
  networkFirstFeedsJson,
  cacheFirstOsmTile,
  OSM_TILE_CACHE_NAME,
  OSM_TILE_MAX_AGE_MS,
} from './handlers.js';

const PRECACHE = 'precache-v42';
const RUNTIME_HTML = 'runtime-html-v42-v1';
const RUNTIME_FEEDS = 'runtime-feeds-json-v1';

type CacheEntry = { request: Request; response: Response };

function makeMockCache(): Cache & { _store: Map<string, CacheEntry> } {
  const store = new Map<string, CacheEntry>();
  // The real Cache.match() resolves string args against the
  // document base URL (i.e. the SW's location.origin). Mirror
  // that here so a stored `new Request('https://app.n3ary.com/foo')`
  // matches a lookup with the string `'/foo'`.
  const resolve = (req: Request | string): string => {
    if (typeof req === 'string') return new URL(req, 'https://app.n3ary.com').href;
    return req.url;
  };
  const match = vi.fn(async (req: Request | string) => store.get(resolve(req))?.response ?? null);
  const put = vi.fn(async (req: Request, res: Response) => {
    store.set(resolve(req), { request: req, response: res });
  });
  const mockCache = {
    _store: store,
    match,
    put,
    add: vi.fn(),
    addAll: vi.fn(),
    delete: vi.fn(async (req: Request | string) => store.delete(resolve(req))),
    // Insertion order mirrors the real Cache API's keys() ordering,
    // which the tile cache's FIFO trim relies on.
    keys: vi.fn(async () => [...store.values()].map((e) => e.request)),
  };
  return mockCache as unknown as Cache & { _store: Map<string, CacheEntry> };
}

function makeResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: new Headers({ 'content-type': 'text/html', ...headers }),
  });
}

beforeEach(() => {
  // Each test gets its own mock caches. Reset fetch too so
  // vi.fn()s don't leak state between tests.
  const cacheByName = new Map<string, ReturnType<typeof makeMockCache>>();
  const getOrCreate = (name: string) => {
    let c = cacheByName.get(name);
    if (!c) {
      c = makeMockCache();
      cacheByName.set(name, c);
    }
    return c;
  };
  globalThis.caches = {
    open: vi.fn(async (name: string) => getOrCreate(name)),
    // The other CacheStorage methods are unused by the handlers.
    delete: vi.fn(async () => true),
    has: vi.fn(async () => true),
    keys: vi.fn(async () => []),
    match: vi.fn(async () => null),
    add: vi.fn(async () => undefined),
    addAll: vi.fn(async () => undefined),
  } as unknown as CacheStorage;
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('networkFirstNavigation', () => {
  it('serves from cache immediately, refreshes cache in background', async () => {
    // SWR: serve cached HTML instantly, refresh in the background.
    // Seed the runtime cache with a stale response, mock network returning
    // fresh. The function should return the stale response immediately,
    // then update the cache with the fresh response.
    const req = new Request('https://app.n3ary.com/');
    const stale = makeResponse('<html>stale</html>');
    const fresh = makeResponse('<html>fresh</html>');
    const cache = await caches.open(RUNTIME_HTML);
    await cache.put(req, stale);
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(fresh);

    const result = await networkFirstNavigation(req, { precacheName: PRECACHE, runtimeHtmlCacheName: RUNTIME_HTML });

    // Stale served immediately.
    expect(await result.text()).toBe('<html>stale</html>');
    // Background refresh fired and cached the fresh response.
    const cached = await cache.match(req);
    expect(cached).not.toBeNull();
    expect(await cached!.text()).toBe('<html>fresh</html>');
  });

  it('hands the background refresh to waitUntil so the SW stays alive for it', async () => {
    // Without FetchEvent.waitUntil the browser may kill the SW the
    // instant respondWith settles (iOS does this aggressively) — the
    // refresh dies mid-flight and the cached shell stays stale
    // forever, which is what made the update banner reappear after
    // every reload. The handler must give its background work to the
    // caller's waitUntil.
    const req = new Request('https://app.n3ary.com/');
    const stale = makeResponse('<html>stale</html>');
    const fresh = makeResponse('<html>fresh</html>');
    const cache = await caches.open(RUNTIME_HTML);
    await cache.put(req, stale);
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(fresh);

    const pending: Promise<unknown>[] = [];
    const result = await networkFirstNavigation(req, {
      precacheName: PRECACHE,
      runtimeHtmlCacheName: RUNTIME_HTML,
      waitUntil: (p) => {
        pending.push(p);
      },
    });

    expect(await result.text()).toBe('<html>stale</html>');
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    const cached = await cache.match(req);
    expect(await cached!.text()).toBe('<html>fresh</html>');
  });

  it('uses cache: no-cache and AbortSignal.timeout on the background fetch', async () => {
    // The background refresh must bypass the HTTP cache and carry a
    // timeout so it never blocks the return path.
    const req = new Request('https://app.n3ary.com/');
    const stale = makeResponse('<html>stale</html>');
    const cache = await caches.open(RUNTIME_HTML);
    await cache.put(req, stale);
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(makeResponse('<html>fresh</html>'));

    await networkFirstNavigation(req, { precacheName: PRECACHE, runtimeHtmlCacheName: RUNTIME_HTML });

    const fetchMock = vi.mocked(globalThis.fetch);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.cache).toBe('no-cache');
    // A signal was passed (AbortSignal.timeout) so the background fetch
    // cannot hang indefinitely.
    expect(init?.signal).toBeDefined();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('falls back to the runtime cache when the network is unreachable', async () => {
    // Seed the runtime cache with a known response (as if from
    // a previous online visit). Then make the network throw.
    const req = new Request('https://app.n3ary.com/');
    const seed = makeResponse('<html>seeded</html>');
    const cache = await caches.open(RUNTIME_HTML);
    await cache.put(req, seed);
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new TypeError('Load failed'));

    const result = await networkFirstNavigation(req, { precacheName: PRECACHE, runtimeHtmlCacheName: RUNTIME_HTML });

    expect(await result.text()).toBe('<html>seeded</html>');
  });

  it('falls back to the precache bucket when the runtime cache is empty (first offline visit)', async () => {
    // The user has never been online since the SW installed, so
    // the runtime cache is empty. The precache bucket still
    // has the version of the HTML the SW shipped with. We open
    // the precache at '/' because the precache key is the bare
    // path (no query string), and the navigation request is '/'.
    const req = new Request('https://app.n3ary.com/');
    const precached = makeResponse('<html>precached</html>');
    const precache = await caches.open(PRECACHE);
    await precache.put(new Request('https://app.n3ary.com/'), precached);
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new TypeError('Load failed'));

    const result = await networkFirstNavigation(req, { precacheName: PRECACHE, runtimeHtmlCacheName: RUNTIME_HTML });

    expect(await result.text()).toBe('<html>precached</html>');
  });

  it('fetches in the foreground when both caches are cold (first online visit)', async () => {
    // Regression: the SWR conversion used to fire the fetch in the
    // background and throw on the cache miss while that fetch was
    // still in flight — failing every first SW-controlled load even
    // with a healthy network.
    const req = new Request('https://app.n3ary.com/');
    const fresh = makeResponse('<html>fresh</html>');
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(fresh);

    const result = await networkFirstNavigation(req, { precacheName: PRECACHE, runtimeHtmlCacheName: RUNTIME_HTML });

    expect(await result.text()).toBe('<html>fresh</html>');
    // The foreground response also warms the runtime cache for the
    // next offline read.
    const runtime = await caches.open(RUNTIME_HTML);
    const cached = await runtime.match(req);
    expect(cached).not.toBeNull();
    expect(await cached!.text()).toBe('<html>fresh</html>');
  });

  it('throws when offline with neither cache populated (browser shows its offline UI)', async () => {
    const req = new Request('https://app.n3ary.com/');
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new TypeError('Load failed'));

    await expect(networkFirstNavigation(req, { precacheName: PRECACHE, runtimeHtmlCacheName: RUNTIME_HTML })).rejects.toThrow(
      'navigation: no network and no cached HTML',
    );
  });

  it('prefers the runtime cache (most recent) over the precache (older)', async () => {
    // The runtime cache was populated by a newer online visit;
    // the precache was populated at SW install time. Online
    // freshness should win on offline reads too.
    const req = new Request('https://app.n3ary.com/');
    const precached = makeResponse('<html>old</html>');
    const fresh = makeResponse('<html>new</html>');
    const precache = await caches.open(PRECACHE);
    await precache.put(new Request('https://app.n3ary.com/'), precached);
    const runtime = await caches.open(RUNTIME_HTML);
    await runtime.put(req, fresh);
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new TypeError('Load failed'));

    const result = await networkFirstNavigation(req, { precacheName: PRECACHE, runtimeHtmlCacheName: RUNTIME_HTML });

    expect(await result.text()).toBe('<html>new</html>');
  });
});

describe('serveFromPrecache', () => {
  it('returns the cached response when the manifest entry is in the precache', async () => {
    const cached = makeResponse('<html>precached</html>');
    const precache = await caches.open(PRECACHE);
    await precache.put(new Request('https://app.n3ary.com/_app/'), cached);

    const result = await serveFromPrecache('/_app/', PRECACHE);

    expect(await result.text()).toBe('<html>precached</html>');
  });

  it('falls through to the network when the precache evicted the entry', async () => {
    // Browser cache eviction is real (quota pressure, user
    // clearing storage, etc). The SW must not 500 just because
    // the precache is empty -- fall through so the page still
    // loads over the network.
    const fetched = makeResponse('<html>fresh</html>');
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(fetched);

    const result = await serveFromPrecache('/_app/', PRECACHE);

    expect(await result.text()).toBe('<html>fresh</html>');
  });

  it('bounds the fallback fetch with an abort signal', async () => {
    // Browsers apply no timeout to respondWith: without an explicit
    // AbortSignal a wedged socket would hang the page forever. The
    // fallback fetch must therefore carry one, and its rejection must
    // propagate (so the browser shows its own error and the boot
    // watchdog can reload).
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));

    await expect(serveFromPrecache('/_app/', PRECACHE)).rejects.toThrow('timed out');
    const init = vi.mocked(globalThis.fetch).mock.calls[0]?.[1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('networkFirstFeedsJson', () => {
  it('serves from cache immediately, refreshes cache in background', async () => {
    // SWR: seed runtime cache with stale feeds.json, mock network returning
    // fresh. Function returns the stale version instantly; background
    // refresh updates the cache.
    const req = new Request('https://gtfs.n3ary.com/feeds.json');
    const stale = makeResponse('{"feeds":[]}', 200, { 'content-type': 'application/json' });
    const fresh = makeResponse('{"feeds":[{"id":"x"}]}', 200, { 'content-type': 'application/json' });
    const cache = await caches.open(RUNTIME_FEEDS);
    await cache.put(req, stale);
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(fresh);

    const result = await networkFirstFeedsJson(req, { runtimeFeedsCacheName: RUNTIME_FEEDS });

    // Stale served immediately.
    expect(await result.text()).toBe('{"feeds":[]}');
    // Background refresh cached the fresh response.
    const cached = await cache.match(req);
    expect(cached).not.toBeNull();
    expect(await cached!.text()).toBe('{"feeds":[{"id":"x"}]}');
  });

  it('hands the background refresh to waitUntil so the SW stays alive for it', async () => {
    const req = new Request('https://gtfs.n3ary.com/feeds.json');
    const stale = makeResponse('{"feeds":[]}', 200, { 'content-type': 'application/json' });
    const fresh = makeResponse('{"feeds":[{"id":"x"}]}', 200, { 'content-type': 'application/json' });
    const cache = await caches.open(RUNTIME_FEEDS);
    await cache.put(req, stale);
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(fresh);

    const pending: Promise<unknown>[] = [];
    const result = await networkFirstFeedsJson(req, {
      runtimeFeedsCacheName: RUNTIME_FEEDS,
      waitUntil: (p) => {
        pending.push(p);
      },
    });

    expect(await result.text()).toBe('{"feeds":[]}');
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(await (await cache.match(req))!.text()).toBe('{"feeds":[{"id":"x"}]}');
  });

  it('falls back to the runtime cache when the network is unreachable', async () => {
    const req = new Request('https://gtfs.n3ary.com/feeds.json');
    const seed = makeResponse('{"feeds":[]}', 200, { 'content-type': 'application/json' });
    const cache = await caches.open(RUNTIME_FEEDS);
    await cache.put(req, seed);
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new TypeError('Load failed'));

    const result = await networkFirstFeedsJson(req, { runtimeFeedsCacheName: RUNTIME_FEEDS });

    expect(await result.text()).toBe('{"feeds":[]}');
  });

  it('fetches in the foreground and caches when the cache is cold (online)', async () => {
    // Regression: a cold runtime cache used to throw while the
    // background fetch was still in flight, so the first
    // SW-controlled load of the registry always failed — online
    // included — and the feed bind never happened.
    const req = new Request('https://gtfs.n3ary.com/feeds.json');
    const fresh = makeResponse('{"feeds":[{"id":"x"}]}', 200, { 'content-type': 'application/json' });
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(fresh);

    const result = await networkFirstFeedsJson(req, { runtimeFeedsCacheName: RUNTIME_FEEDS });

    expect(await result.text()).toBe('{"feeds":[{"id":"x"}]}');
    const cache = await caches.open(RUNTIME_FEEDS);
    const cached = await cache.match(req);
    expect(cached).not.toBeNull();
    expect(await cached!.text()).toBe('{"feeds":[{"id":"x"}]}');
  });

  it('throws when offline with no cached copy (no network, no cache)', async () => {
    const req = new Request('https://gtfs.n3ary.com/feeds.json');
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new TypeError('Load failed'));

    await expect(networkFirstFeedsJson(req, { runtimeFeedsCacheName: RUNTIME_FEEDS })).rejects.toThrow(
      'feeds.json: no network and no cached copy',
    );
  });

  it('throws when the cold-path fetch returns a non-ok status', async () => {
    const req = new Request('https://gtfs.n3ary.com/feeds.json');
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(makeResponse('oops', 500));

    await expect(networkFirstFeedsJson(req, { runtimeFeedsCacheName: RUNTIME_FEEDS })).rejects.toThrow(
      'feeds.json: no network and no cached copy',
    );
  });
});

describe('cacheFirstOsmTile', () => {
  const TILE_URL = 'https://a.tile.openstreetmap.org/13/4633/2888.png';
  const tileReq = () => new Request(TILE_URL);
  const tileResponse = (body: string, cachedAt?: number) =>
    makeResponse(body, 200, {
      'content-type': 'image/png',
      ...(cachedAt !== undefined ? { 'x-sw-cached-at': String(cachedAt) } : {}),
    });

  it('serves a fresh cached tile without touching the network', async () => {
    const cache = await caches.open(OSM_TILE_CACHE_NAME);
    await cache.put(tileReq(), tileResponse('OLD', Date.now()));

    const result = await cacheFirstOsmTile(tileReq(), { cacheName: OSM_TILE_CACHE_NAME });

    expect(await result.text()).toBe('OLD');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('serves a stale cached tile and revalidates in the background', async () => {
    const cache = await caches.open(OSM_TILE_CACHE_NAME);
    await cache.put(tileReq(), tileResponse('OLD', Date.now() - OSM_TILE_MAX_AGE_MS - 1));
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(tileResponse('NEW'));

    const result = await cacheFirstOsmTile(tileReq(), { cacheName: OSM_TILE_CACHE_NAME });

    expect(await result.text()).toBe('OLD');
    // Background revalidate fired and replaced the stored copy.
    await new Promise((r) => setTimeout(r, 0));
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const stored = await cache.match(tileReq());
    expect(await stored!.text()).toBe('NEW');
  });

  it('miss: fetches, stamps put-time, caches, and serves', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(tileResponse('PNG'));

    const result = await cacheFirstOsmTile(tileReq(), { cacheName: OSM_TILE_CACHE_NAME });

    expect(await result.text()).toBe('PNG');
    const cache = await caches.open(OSM_TILE_CACHE_NAME);
    const stored = await cache.match(tileReq());
    expect(stored).not.toBeNull();
    expect(Number(stored!.headers.get('x-sw-cached-at'))).toBeGreaterThan(0);
  });

  it('miss with a non-ok response: returned but not cached', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(makeResponse('slow down', 429));

    const result = await cacheFirstOsmTile(tileReq(), { cacheName: OSM_TILE_CACHE_NAME });

    expect(result.status).toBe(429);
    const cache = await caches.open(OSM_TILE_CACHE_NAME);
    expect(await cache.match(tileReq())).toBeNull();
  });

  it('trims the oldest entries beyond the cap', async () => {
    const urls = [0, 1, 2].map(
      (i) => `https://b.tile.openstreetmap.org/12/100${i}/200${i}.png`,
    );
    for (const u of urls) {
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(tileResponse(`T-${u}`));
    }

    for (const u of urls) {
      await cacheFirstOsmTile(new Request(u), { cacheName: OSM_TILE_CACHE_NAME, maxEntries: 2 });
    }
    await new Promise((r) => setTimeout(r, 0));

    const cache = await caches.open(OSM_TILE_CACHE_NAME);
    const keys = await cache.keys();
    expect(keys.map((r) => r.url)).toEqual([urls[1], urls[2]]);
  });
});
