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
 *   - skipWaiting + clientsClaim: take over immediately. Stale
 *     shell = 500/white screen, so the trade-off is "existing tabs
 *     may reload mid-interaction" vs "app is broken". We pick the
 *     reload — and it's deliberate, not accidental: the layout
 *     listens for controllerchange and runs the hidden-first
 *     update flow (appUpdate.ts) the moment a new SW claims the
 *     page, so the swap never leaves a tab running on a pruned
 *     precache.
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
      // skipWaiting so the new SW activates immediately when the
      // user reopens the PWA. Without it, the user keeps running
      // the old SW (and the old shell) until all tabs close.
      await self.skipWaiting();
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
      // Take over existing clients so the new SW is in effect
      // without requiring the user to close and reopen.
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Navigations: NetworkFirst with cache fallback. The SW is
  // the gatekeeper for HTML so the browser's HTTP cache can
  // never serve a stale shell.
  if (req.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(req, PRECACHE_NAME, RUNTIME_HTML_CACHE));
    return;
  }

  // feeds.json: NetworkFirst with cache fallback.
  if (url.origin === 'https://gtfs.n3ary.com' && url.pathname === '/feeds.json') {
    event.respondWith(networkFirstFeedsJson(req, RUNTIME_FEEDS_CACHE));
    return;
  }

  // OSM map tiles: CacheFirst into a fixed-name bucket that survives
  // SW updates. The bbox prefetch (lib/map/offlineTiles.ts) and the
  // map view both flow through here.
  if (url.hostname.endsWith('.tile.openstreetmap.org')) {
    event.respondWith(cacheFirstOsmTile(req, OSM_TILE_CACHE_NAME));
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
