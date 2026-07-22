/*
 * service-worker.ts — PWA shell + version-aware cache invalidation.
 *
 * The hand-rolled bits: why not workbox? Because the only runtime
 * strategies we need are NetworkFirst for navigations + NetworkFirst
 * for feeds.json, plus CacheFirst for the content-addressed shell --
 * and a ~120-line SW is easier to audit than a workbox build that
 * imports its own router.
 *
 *   - Precache: app shell + manifest (injected by @vite-pwa/sveltekit
 *     via self.__WB_MANIFEST at build time). Used for offline
 *     shell + first-paint assets.
 *   - Runtime cache: gtfs.n3ary.com/feeds.json (NetworkFirst) AND
 *     a runtime HTML cache (NetworkFirst, separate bucket). The
  *     runtime HTML cache holds the most recent online HTML, so
  *     offline reads serve what the user had online last.
  *   - Versioning: precache bucket name is `precache-v<version>`. On
  *     activate, any other `precache-v*` cache is deleted so an
  *     outdated shell never gets served from cache.
  *   - Navigation requests (req.mode === 'navigate') are
 *     NetworkFirst, with the precache bucket as a fallback. This
 *     bypasses the browser's HTTP cache for HTML -- the staleness
 *     class of bug we just shipped (cached old HTML pointing at
 *     asset hashes that no longer exist) is gone because the SW
 *     is the gatekeeper for HTML, not the browser.
 *
 *   - The precache install uses Promise.allSettled + individual
 *     cache.add() calls instead of cache.addAll(). addAll() aborts
 *     the whole batch on a single failure (deploy race, partial
 *     R2 upload), which would leave the new SW un-activatable and
 *     the user stuck on the old shell. allSettled means a single
 *     bad entry logs a warning but doesn't fail the install.
 *
 *   - SW registration is manual (in src/routes/+layout.svelte)
 *     with `updateViaCache: 'none'` so the browser re-checks the
 *     SW itself on every visit instead of caching it for 24h.
 *     One less staleness vector.
 *
 *   - SQLite: stored in OPFS (Origin Private File System), NOT in
 *     any SW cache. OPFS persists across SW versions, so an
 *     already-downloaded feed survives deploys. The SW's job is
 *     to get the shell to the OPFS bootstrap; the bootstrap
 *     itself decides what to do based on what's in OPFS.
 */

/// <reference lib="webworker" />
/// <reference types="@sveltejs/kit" />

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision?: string | null }>;
};

// Vite replaces `__APP_VERSION__` at build time via `define` in
// vite.config.ts. See the comment there for why we use `define`
// instead of importing package.json (the SW is built by a separate
// Vite pass that doesn't get the same module graph).
declare const __APP_VERSION__: string;

const VERSION: string = __APP_VERSION__;
const PRECACHE_NAME = `precache-v${VERSION}`;
const RUNTIME_FEEDS_CACHE = 'runtime-feeds-json-v1' as const;
const RUNTIME_HTML_CACHE = `runtime-html-v${VERSION}-v1` as const;

import {
  networkFirstNavigation,
  serveFromPrecache,
  networkFirstFeedsJson,
  cacheFirstOsmTile,
  OSM_TILE_CACHE_NAME,
} from './lib/sw/handlers.js';

/** Precache the shell entries the plugin injected. */
const manifest = self.__WB_MANIFEST ?? [];

// The plugin emits manifest URLs in two forms — absolute ('/foo')
// and relative ('foo') — while FetchEvent's `url.pathname` always
// carries the leading slash. Normalize once to pathnames so the
// fetch-time guard below actually matches. Without this the guard
// silently never matches, the precache is never consulted, and the
// shell depends on the browser HTTP cache — which iOS evicts
// aggressively, producing offline white screens on chunk loads.
const manifestPaths = new Set(
  manifest.map((m) => new URL(m.url, self.location.origin).pathname),
);

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PRECACHE_NAME);
      // Filter to same-origin GETs only. Cross-origin entries
      // (icons from the brand CDN) would fail cache.addAll.
      // The plugin emits URLs in two forms: absolute ('/foo') and
      // relative ('foo'). Normalize both to absolute so the
      // request has a stable cache key.
      const swOrigin = self.location.origin;
      const sameOrigin = manifest
        .map((m) => new URL(m.url, swOrigin).href)
        .filter((url) => new URL(url).origin === swOrigin);
      // The SPA shell: _redirects rewrites every route to index.html,
      // so the deployed '/' boots ANY route client-side. It isn't in
      // the injected manifest (the glob can't see prerendered output),
      // so cache it explicitly — otherwise offline navigations fall
      // back to precache.match('/') below and miss, and the shell's
      // availability depends on the browser HTTP cache (which iOS
      // evicts aggressively → white screens).
      sameOrigin.push(new URL('/', swOrigin).href);
      // Promise.allSettled so a single failed entry doesn't fail
      // the whole install. cache.addAll would abort the batch on
      // any one failure, leaving the new SW un-activatable and
      // the user stuck on the old shell.
      const results = await Promise.allSettled(
        sameOrigin.map((url) => cache.add(new Request(url, { cache: 'reload' }))),
      );
      for (let i = 0; i < results.length; i++) {
        if (results[i]!.status === 'rejected') {
          const reason = (results[i] as PromiseRejectedResult).reason;
          console.warn(
            `[sw] precache add failed for ${sameOrigin[i]}: ${
              reason?.message ?? String(reason)
            }`,
          );
        }
      }
      // The SW deliberately does NOT call skipWaiting() here. Instead it
      // waits for the app to send 'CHECK_VERSION'. See the 'message'
      // handler below — the SW compares versions and decides whether to
      // activate immediately or stay waiting for the next navigation.
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          // Old precache buckets from previous SW versions.
          .filter((k) => k.startsWith('precache-v') && k !== PRECACHE_NAME)
          // Old runtime HTML cache buckets (versioned by the SW
          // version, so a new SW version can drop the old). The
          // runtime FEEDS cache is intentionally NOT pruned here
          // because it has a fixed name (not versioned) -- it's
          // feed data, not shell code.
          .concat(
            keys.filter((k) => k.startsWith('runtime-html-v') && k !== RUNTIME_HTML_CACHE),
          )
          .map((k) => caches.delete(k)),
      );
      // Deliberately NO clients.claim(): the app sends 'CHECK_VERSION'
      // and the SW decides whether to activate. The SKIP_WAITING call
      // (if versions differ) happens in the message handler instead of here.
    })(),
  );
});

// The app sends CHECK_VERSION with its __APP_VERSION__. The SW compares
// it against its own VERSION (baked at build time) and decides:
//   - match     → stays waiting, activates on next navigation
//   - mismatch  → sends RELOAD_APP message, app calls location.reload()
// Replies to the app with its VERSION so the app can log it.
//
// Why not skipWaiting + clients.claim() here? Because that triggers a reload
// controlled by the OLD SW's fetch handler, which serves from the old SW's
// runtime-html cache first (causing the "update banner persists" bug). By
// messaging the app to reload with a __sw_reload query param, the OLD SW's
// navigation handler detects the param, bypasses its own cache, and fetches
// fresh HTML. The new SW then caches the fresh HTML in its own bucket.
self.addEventListener('message', (event) => {
  if (!event.source) return;
  if (event.data?.type === 'CHECK_VERSION') {
    const { appVersion } = event.data as { type: string; appVersion: string };
    console.info(`[sw] CHECK_VERSION: app=${appVersion} sw=${VERSION} match=${appVersion === VERSION}`);
    if (appVersion !== VERSION) {
      void fetch('/_app/version.json', { cache: 'no-cache' })
        .then((r) => r?.ok ? r.json() : null)
        .then((data: { version?: string } | null) => {
          const deployedVersion = data?.version ?? null;
          console.info(`[sw] version.json=${deployedVersion} vs sw=${VERSION}`);
          if (deployedVersion !== VERSION) {
            // version.json not yet updated — partial deploy window. Do NOT
            // reload; the app's mount-time updated.check() will retry.
            console.info('[sw] partial deploy — skipping reload');
            return;
          }
          console.info('[sw] full deploy confirmed — requesting app reload');
          // Signal the app to reload. The app adds ?__sw_reload= to the URL,
          // which the navigation handler detects to bypass the old runtime
          // HTML cache on this post-update reload.
          void event.source.postMessage({ type: 'RELOAD_APP', timestamp: Date.now() });
        })
        .catch(() => {
          // version.json fetch failed — reload anyway, the mount-time
          // updated.check() will sort it out.
          console.info('[sw] version.json fetch failed — requesting app reload');
          void event.source.postMessage({ type: 'RELOAD_APP', timestamp: Date.now() });
        });
    }
    void event.source.postMessage({ type: 'VERSION_CHECKED', swVersion: VERSION });
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Navigations: NetworkFirst with cache fallback. The SW is
  // the gatekeeper for HTML so the browser's HTTP cache can
  // never serve a stale shell.
  if (req.mode === 'navigate') {
    // Detect a post-update reload triggered by RELOAD_APP. The
    // ?__sw_reload=<timestamp> param forces this SW (the old one,
    // still intercepting during the reload) to bypass its runtime
    // HTML cache and fetch fresh HTML. The param is stripped from
    // the stored URL so subsequent navigations hit the normal
    // stale-while-revalidate path.
    if (url.searchParams.has('__sw_reload')) {
      url.searchParams.delete('__sw_reload');
      event.respondWith(
        fetch(new Request(url.href, { ...req, signal: AbortSignal.timeout(15_000) }), { cache: 'no-cache' })
          .then((res) => {
            caches.open(RUNTIME_HTML_CACHE).then((c) => c.put(req, res.clone()));
            return res;
          })
          .catch(() => {
            // Network down on post-update reload — fall back to precache.
            return caches.open(PRECACHE_NAME).then((c) => c.match('/') ?? Response.error());
          }),
      );
      return;
    }
    // waitUntil is load-bearing for the background HTML refresh —
    // without it the SW can be killed the moment respondWith settles
    // and the cached shell stays stale forever (the "update banner
    // insists after updating" bug).
    event.respondWith(
      networkFirstNavigation(req, {
        precacheName: PRECACHE_NAME,
        runtimeHtmlCacheName: RUNTIME_HTML_CACHE,
        waitUntil: event.waitUntil.bind(event),
      }),
    );
    return;
  }

  // feeds.json: NetworkFirst with cache fallback.
  if (url.origin === 'https://gtfs.n3ary.com' && url.pathname === '/feeds.json') {
    event.respondWith(
      networkFirstFeedsJson(req, {
        runtimeFeedsCacheName: RUNTIME_FEEDS_CACHE,
        waitUntil: event.waitUntil.bind(event),
      }),
    );
    return;
  }

  // OSM map tiles: CacheFirst into a fixed-name bucket that survives
  // SW updates. The bbox prefetch (lib/map/offlineTiles.ts) and the
  // map view both flow through here.
  if (url.hostname.endsWith('.tile.openstreetmap.org')) {
    event.respondWith(
      cacheFirstOsmTile(req, {
        cacheName: OSM_TILE_CACHE_NAME,
        waitUntil: event.waitUntil.bind(event),
      }),
    );
    return;
  }

  // Same-origin precache lookup for the app shell. The plugin's
  // manifest is the source of truth for which URLs are precached.
  if (
    url.origin === self.location.origin &&
    !url.search &&
    manifestPaths.has(url.pathname)
  ) {
    event.respondWith(serveFromPrecache(url.pathname, PRECACHE_NAME));
    return;
  }

  // Everything else: pass through. The OPFS bootstrap reads its
  // own sqlite via its own fetch (which falls through here, so the
  // SW doesn't double-cache large files). gtfs-rt.n3ary.com/rt/*
  // is also pass-through -- the live pipeline handles its own
  // offline fallback to the last good snapshot.
});

