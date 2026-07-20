/**
 * sw/handlers.ts — Service Worker fetch handler logic, extracted from
 * service-worker.ts so each strategy is unit-testable in isolation.
 *
 * Why a separate file: the SW is a top-level module with side
 * effects (self.addEventListener at module load), which makes it
 * hard to import in tests. The handlers here are pure functions
 * over the standard Cache + Fetch APIs; the SW file wires them
 * into its install / activate / fetch events.
 *
 * Cache names are passed in by the caller (the SW owns the
 * versioned names). The handlers don't reach into module-level
 * state, which makes them testable with a single `caches` /
 * `fetch` mock.
 */

export type RuntimeCacheName = `runtime-${string}`;

/** FetchEvent.waitUntil, threaded through so background work survives
 *  past respondWith (the SW can otherwise be killed the instant the
 *  response settles — see networkFirstNavigation). Optional for tests
 *  and fire-and-forget callers; the SW must always pass it. */
export type WaitUntil = (p: Promise<unknown>) => void;

/* Handler parameter convention in this module: at most two required
 * params stay positional (serveFromPrecache); anything carrying an
 * optional param goes in an options bag — positional optionals force
 * callers to spell out defaults just to reach a later slot, which is
 * how the waitUntil addition ended up looking worse than it is. */

/**
 * NetworkFirst for HTML navigations.
 *
 *   online  -> fetch fresh HTML, return it, cache for next offline
 *   offline -> serve cached HTML from the runtime cache
 *   offline + runtime cache empty -> fall back to the precache
 *     bucket (the version that was current when the SW installed)
 *   offline + no cached copy at all -> throw; the browser shows
 *     its own offline page
 *
 * Why this is the right shape for our app: the SvelteKit shell
 * is content-addressed (the version's hash is in every asset
 * URL), so the HTML itself is the only thing that meaningfully
 * changes between deploys. NetworkFirst for HTML means online
 * = always the latest shell, with the preloads pointing at
 * assets that match the new hashes. Offline = the precache
 * from the most recent install, which is the same shell the
 * user had online the last time they were online.
 *
  * Falls back to the precache bucket (not just the runtime
  * cache) because the runtime cache is only populated after
  * the first online visit. A user who opens the app for the
  * first time while offline has nothing in the runtime cache;
  * the precache is the only thing they have.
  */
export interface NetworkFirstNavigationOptions {
  precacheName: string;
  runtimeHtmlCacheName: RuntimeCacheName;
  waitUntil?: WaitUntil;
}

export async function networkFirstNavigation(
  req: Request,
  opts: NetworkFirstNavigationOptions,
): Promise<Response> {
  const { precacheName, runtimeHtmlCacheName, waitUntil = () => {} } = opts;
  const cache = await caches.open(runtimeHtmlCacheName);
  // Stale-while-revalidate: serve cached HTML immediately so the
  // user never sees a blank screen on flaky networks. Refresh the
  // cache in the background, up to 10s. If the network is actually
  // down the user still gets the cached shell; no blank screen.
  //
  // The refresh MUST be handed to FetchEvent.waitUntil: without it
  // the browser may kill the SW the instant respondWith settles
  // (iOS does this aggressively), the refresh dies mid-flight, and
  // the cached shell stays stale forever — the served version then
  // lags the live version.json permanently and the update banner
  // reappears after every reload no matter how often the user
  // actually updates.
  const refreshInBackground = async () => {
    try {
      const res = await fetch(req, { cache: 'no-cache', signal: AbortSignal.timeout(10_000) });
      if (res.ok) await cache.put(req, res.clone());
    } catch {
      // Background refresh failed — user already got the cached shell.
    }
  };
  // Serve from cache first; fall back to precache on a cold start.
  const cached = await cache.match(req);
  if (cached) {
    waitUntil(refreshInBackground());
    return cached;
  }
  // Fall back to the precache bucket when the runtime cache is empty.
  // The precache was populated at SW install time, so it holds the HTML
  // from the version the user last had online.
  const precache = await caches.open(precacheName);
  const hit = await precache.match('/');
  if (hit) {
    // Warm the runtime cache so the next offline read serves the
    // most recent online HTML instead of the install-time shell.
    waitUntil(refreshInBackground());
    return hit;
  }
  // Both caches cold: the foreground request is the only remaining
  // source of HTML. Firing it in the background and throwing here
  // would fail the navigation even with a healthy network. 15s
  // timeout so lie-fi hangs surface as an error the browser can
  // render its own offline UI for.
  try {
    const res = await fetch(req, { cache: 'no-cache', signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    waitUntil(cache.put(req, res.clone()));
    return res;
  } catch {
    throw new Error('navigation: no network and no cached HTML');
  }
}

/**
 * CacheFirst for same-origin precache manifest entries. The
 * manifest URLs are content-addressed (the build emits URLs
 * with the asset hash in the path), so a cached copy at the
 * right URL is by construction still correct for that URL.
 * If the precache doesn't have it (browser evicted, or the
 * install was partial), fall through to the network.
 */
export async function serveFromPrecache(
  pathname: string,
  precacheName: string,
): Promise<Response> {
  const cache = await caches.open(precacheName);
  const hit = await cache.match(pathname);
  if (hit) return hit;
  // The SW should have precached this on install. If the
  // browser evicted between install and fetch, fall through
  // to the network so the page still loads.
  //
  // Timeout is load-bearing: browsers apply NO timeout to a SW's
  // respondWith, so a wedged socket here (flaky radio, captive
  // portal) would hang the render-blocking asset request — and with
  // it the whole page — forever. Fail fast instead so the browser
  // can surface its own error and the boot watchdog can reload.
  // 15 s matches the other foreground fetches in this file and leaves
  // headroom for honestly-slow 2G links.
  return fetch(pathname, { signal: AbortSignal.timeout(15_000) });
}

/**
 * NetworkFirst for feeds.json, with a runtime cache for
 * cold-start offline. 5 min edge TTL on the R2 side; we
 * cache the same on the client so opening the app with no
 * network still works as long as the user has visited at
 * least once.
 */
export interface NetworkFirstFeedsJsonOptions {
  runtimeFeedsCacheName: RuntimeCacheName;
  waitUntil?: WaitUntil;
}

export async function networkFirstFeedsJson(
  req: Request,
  { runtimeFeedsCacheName, waitUntil = () => {} }: NetworkFirstFeedsJsonOptions,
): Promise<Response> {
  const cache = await caches.open(runtimeFeedsCacheName);
  const cached = await cache.match(req);
  if (cached) {
    // Stale-while-revalidate: serve cached feeds.json immediately,
    // refresh in background. 5s timeout — if the network is slow
    // the cached feed list is still useful (5 min edge TTL means it
    // was fresh moments ago anyway). waitUntil keeps the SW alive
    // until the refresh lands (see networkFirstNavigation).
    waitUntil(
      (async () => {
        try {
          const res = await fetch(req, { cache: 'no-cache', signal: AbortSignal.timeout(5_000) });
          if (res.ok) await cache.put(req, res.clone());
        } catch {
          // Background refresh failed — user already got the cached list.
        }
      })(),
    );
    return cached;
  }
  // Cold cache: the foreground request is the ONLY chance to get the
  // registry. An earlier version fired the fetch in the background and
  // threw on the cache miss while that fetch was still in flight —
  // which failed every first SW-controlled load, online included.
  // 15s timeout so lie-fi hangs surface as an error instead of a
  // forever-pending request.
  try {
    const res = await fetch(req, { cache: 'no-cache', signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    waitUntil(cache.put(req, res.clone()));
    return res;
  } catch {
    throw new Error('feeds.json: no network and no cached copy');
  }
}

/* ------------------------------------------------------------------ */
/* OSM map tiles: CacheFirst with a bounded FIFO bucket.              */
/* ------------------------------------------------------------------ */

/** Fixed cache name (not versioned by app version) so tiles survive
 *  SW updates — tile imagery is data, not shell code. The activate
 *  prune only deletes `precache-v*` and `runtime-html-v*` buckets. */
export const OSM_TILE_CACHE_NAME = 'runtime-osm-tiles-v1';

/** Storage cap. At ~10–30 KB per PNG this bounds the bucket around
 *  ~25 MB; the bbox prefetch budget (see lib/map/offlineTiles.ts)
 *  stays well under it, and cache-on-view fills the rest. */
export const OSM_TILE_CACHE_MAX_ENTRIES = 1200;

/** Re-fetch a cached tile in the background once it's older than
 *  this. OSM tiles are immutable enough that stale-while-revalidate
 *  is always the right trade; 30 days tracks map improvements
 *  without churning mobile data. */
export const OSM_TILE_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

async function fetchAndStampTile(req: Request, cache: Cache): Promise<Response> {
  const res = await fetch(req);
  // Don't cache failures — a 429/404 served now would otherwise be
  // replayed offline for 30 days.
  if (!res.ok) return res;
  // Stamp the put-time on the stored copy. The tile servers' own
  // Expires/ETag can't be trusted to reflect data changes, and the
  // freshness check below needs SOME clock; Date.now() at put is the
  // only honest one available in a SW.
  const body = await res.clone().blob();
  const headers = new Headers(res.headers);
  headers.set('x-sw-cached-at', String(Date.now()));
  await cache.put(
    req,
    new Response(body, { status: res.status, statusText: res.statusText, headers }),
  );
  return res;
}

/** Drop the oldest-inserted entries beyond the cap. Cache API keys()
 *  come back in insertion order, so this is a cheap FIFO — crude
 *  (a frequently viewed old tile can get evicted), but the
 *  alternative (an IDB LRU index) is a lot of machinery to guard a
 *  25 MB bucket. */
async function trimTileCache(cache: Cache, maxEntries: number): Promise<void> {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - maxEntries; i++) {
    await cache.delete(keys[i]!);
  }
}

/**
 * CacheFirst for {s}.tile.openstreetmap.org.
 *   cached + fresh  -> serve from cache, no network at all (offline OK)
 *   cached + stale  -> serve from cache, revalidate in background
 *   miss            -> fetch, cache stamped copy, trim bucket
 */
export interface CacheFirstOsmTileOptions {
  cacheName: string;
  maxEntries?: number;
  waitUntil?: WaitUntil;
}

export async function cacheFirstOsmTile(
  req: Request,
  {
    cacheName,
    maxEntries = OSM_TILE_CACHE_MAX_ENTRIES,
    waitUntil = () => {},
  }: CacheFirstOsmTileOptions,
): Promise<Response> {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) {
    const cachedAt = Number(cached.headers.get('x-sw-cached-at') ?? 0);
    if (Date.now() - cachedAt > OSM_TILE_MAX_AGE_MS) {
      waitUntil(
        fetchAndStampTile(req, cache).catch(() => {
          // Background revalidate failed — user keeps the stale tile.
        }),
      );
    }
    return cached;
  }
  const res = await fetchAndStampTile(req, cache);
  if (res.ok) waitUntil(trimTileCache(cache, maxEntries));
  return res;
}
