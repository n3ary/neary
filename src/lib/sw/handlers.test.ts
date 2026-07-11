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
    delete: vi.fn(),
    keys: vi.fn(async () => []),
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
  it('returns the network response and caches it on success', async () => {
    const req = new Request('https://app.n3ary.com/');
    const fresh = makeResponse('<html>fresh</html>');
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(fresh);

    const result = await networkFirstNavigation(req, PRECACHE, RUNTIME_HTML);

    expect(await result.text()).toBe('<html>fresh</html>');
    const cache = await caches.open(RUNTIME_HTML);
    const cached = await cache.match(req);
    expect(cached).not.toBeNull();
    expect(await cached!.text()).toBe('<html>fresh</html>');
  });

  it('uses cache: no-cache on the fetch so HTTP cache does not serve stale HTML', async () => {
    // The whole point of NetworkFirst for HTML is to bypass the
    // browser's HTTP cache. If the handler falls back to the
    // default fetch cache, we re-introduce the staleness the
    // strategy exists to avoid.
    const req = new Request('https://app.n3ary.com/');
    const fresh = makeResponse('<html>fresh</html>');
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(fresh);

    await networkFirstNavigation(req, PRECACHE, RUNTIME_HTML);

    const fetchMock = vi.mocked(globalThis.fetch);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.cache).toBe('no-cache');
  });

  it('falls back to the runtime cache when the network is unreachable', async () => {
    // Seed the runtime cache with a known response (as if from
    // a previous online visit). Then make the network throw.
    const req = new Request('https://app.n3ary.com/');
    const seed = makeResponse('<html>seeded</html>');
    const cache = await caches.open(RUNTIME_HTML);
    await cache.put(req, seed);
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new TypeError('Load failed'));

    const result = await networkFirstNavigation(req, PRECACHE, RUNTIME_HTML);

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

    const result = await networkFirstNavigation(req, PRECACHE, RUNTIME_HTML);

    expect(await result.text()).toBe('<html>precached</html>');
  });

  it('throws when offline with neither cache populated (browser shows its offline UI)', async () => {
    const req = new Request('https://app.n3ary.com/');
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new TypeError('Load failed'));

    await expect(networkFirstNavigation(req, PRECACHE, RUNTIME_HTML)).rejects.toThrow(
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

    const result = await networkFirstNavigation(req, PRECACHE, RUNTIME_HTML);

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
});

describe('networkFirstFeedsJson', () => {
  it('returns the network response and caches it on success', async () => {
    const req = new Request('https://gtfs.n3ary.com/feeds.json');
    const fresh = makeResponse('{"feeds":[]}', 200, { 'content-type': 'application/json' });
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(fresh);

    const result = await networkFirstFeedsJson(req, RUNTIME_FEEDS);

    expect(await result.text()).toBe('{"feeds":[]}');
    const cache = await caches.open(RUNTIME_FEEDS);
    const cached = await cache.match(req);
    expect(cached).not.toBeNull();
  });

  it('falls back to the runtime cache when the network is unreachable', async () => {
    const req = new Request('https://gtfs.n3ary.com/feeds.json');
    const seed = makeResponse('{"feeds":[]}', 200, { 'content-type': 'application/json' });
    const cache = await caches.open(RUNTIME_FEEDS);
    await cache.put(req, seed);
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new TypeError('Load failed'));

    const result = await networkFirstFeedsJson(req, RUNTIME_FEEDS);

    expect(await result.text()).toBe('{"feeds":[]}');
  });

  it('throws when offline with no cached copy (no network, no cache)', async () => {
    const req = new Request('https://gtfs.n3ary.com/feeds.json');
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new TypeError('Load failed'));

    await expect(networkFirstFeedsJson(req, RUNTIME_FEEDS)).rejects.toThrow(
      'feeds.json: no network and no cached copy',
    );
  });
});
