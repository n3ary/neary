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
export async function networkFirstNavigation(
  req: Request,
  precacheName: string,
  runtimeHtmlCacheName: RuntimeCacheName,
): Promise<Response> {
  const cache = await caches.open(runtimeHtmlCacheName);
  // Stale-while-revalidate: serve cached HTML immediately so the
  // user never sees a blank screen on flaky networks. Refresh the
  // cache in the background, up to 10s. If the network is actually
  // down the user still gets the cached shell; no blank screen.
  void (async () => {
    try {
      const res = await fetch(req, { cache: 'no-cache', signal: AbortSignal.timeout(10_000) });
      if (res.ok) void cache.put(req, res.clone());
    } catch {
      // Background refresh failed — user already got the cached shell.
    }
  })();
  // Serve from cache first; fall back to precache on a cold start.
  const cached = await cache.match(req);
  if (cached) return cached;
  const precache = await caches.open(precacheName);
  const hit = await precache.match('/');
  if (hit) return hit;
  throw new Error('navigation: no network and no cached HTML');
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
  return fetch(pathname);
}

/**
 * NetworkFirst for feeds.json, with a runtime cache for
 * cold-start offline. 5 min edge TTL on the R2 side; we
 * cache the same on the client so opening the app with no
 * network still works as long as the user has visited at
 * least once.
 */
export async function networkFirstFeedsJson(
  req: Request,
  runtimeFeedsCacheName: RuntimeCacheName,
): Promise<Response> {
  const cache = await caches.open(runtimeFeedsCacheName);
  // Stale-while-revalidate: serve cached feeds.json immediately,
  // refresh in background. 5s timeout — if the network is slow
  // the cached feed list is still useful (5 min edge TTL means it
  // was fresh moments ago anyway).
  void (async () => {
    try {
      const res = await fetch(req, { cache: 'no-cache', signal: AbortSignal.timeout(5_000) });
      if (res.ok) void cache.put(req, res.clone());
    } catch {
      // Background refresh failed — user already got the cached list.
    }
  })();
  const cached = await cache.match(req);
  if (cached) return cached;
  throw new Error('feeds.json: no network and no cached copy');
}
