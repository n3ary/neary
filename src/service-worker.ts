/*
 * service-worker.ts — PWA shell + version-aware cache invalidation.
 *
 * The hand-rolled bits: why not workbox? Because the only runtime
 * strategy we need is "NetworkFirst, 5s timeout, fall back to cache
 * for feeds.json" — and a ~100-line SW is easier to audit than a
 * workbox build that imports its own router.
 *
 *   - Precache: app shell + manifest (injected by @vite-pwa/sveltekit
 *     via self.__WB_MANIFEST at build time).
 *   - Runtime cache: gtfs.n3ary.com/feeds.json only. SQLite bootstrap
 *     and the live GTFS-RT feed (gtfs-rt.n3ary.com/rt/*) are
 *     intentionally NOT cached here — the OPFS bootstrap already
 *     short-circuits when the file is local, and the live pipeline
 *     already keeps the last good snapshot when the network fails.
 *     Caching them at the SW layer would serve stale vehicles,
 *     which is wrong.
 *   - Versioning: precache bucket name is `precache-v<version>`. On
 *     activate, any other `precache-v*` cache is deleted so an
 *     outdated shell never gets served from cache.
 *   - skipWaiting + clientsClaim: take over immediately. Stale
 *     shell = 500/white screen, so the trade-off is "existing tabs
 *     may reload mid-interaction" vs "app is broken". We pick the
 *     reload. Belt-and-suspenders: the SvelteKit version polling
 *     (svelte.config.js `kit.version`) also reloads on version
 *     mismatch, so even if the SW fails to claim, the app
 *     eventually self-heals.
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
const RUNTIME_FEEDS_CACHE = 'runtime-feeds-json-v1';

/** Precache the shell entries the plugin injected. */
const manifest = self.__WB_MANIFEST ?? [];

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
      await cache.addAll(sameOrigin);
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
          .filter((k) => k.startsWith('precache-v') && k !== PRECACHE_NAME)
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

  // NetworkFirst for feeds.json — fresh on every online visit,
  // cached on cold-start offline.
  if (url.origin === 'https://gtfs.n3ary.com' && url.pathname === '/feeds.json') {
    event.respondWith(networkFirstFeedsJson(req));
    return;
  }

  // Same-origin precache lookup for the app shell. The plugin's
  // manifest is the source of truth for which URLs are precached.
  if (
    url.origin === self.location.origin &&
    !url.search &&
    manifest.some((m) => m.url === url.pathname)
  ) {
    event.respondWith(serveFromPrecache(url.pathname));
    return;
  }

  // Everything else: pass through. The OPFS bootstrap reads its
  // own sqlite via its own fetch (which falls through here, so the
  // SW doesn't double-cache large files). gtfs-rt.n3ary.com/rt/*
  // is also pass-through — the live pipeline handles its own
  // offline fallback to the last good snapshot.
});

async function serveFromPrecache(pathname: string): Promise<Response> {
  const cache = await caches.open(PRECACHE_NAME);
  const hit = await cache.match(pathname);
  if (hit) return hit;
  // Shouldn't happen — we cache.addAll'd it on install. But the
  // browser cache might evict between install and fetch; fall
  // through to the network so the page still loads.
  return fetch(pathname);
}

async function networkFirstFeedsJson(req: Request): Promise<Response> {
  const cache = await caches.open(RUNTIME_FEEDS_CACHE);
  try {
    const res = await fetch(req, { cache: 'no-cache' });
    if (res.ok) {
      // Background update — don't await so the response returns
      // as fast as possible. If cache.put throws (quota), the
      // next visit will still fetch from network and try again.
      void cache.put(req, res.clone());
    }
    return res;
  } catch {
    const cached = await cache.match(req);
    if (cached) return cached;
    // No cached copy AND no network — let the original fetch
    // failure bubble up to the app. StatusBar shows "Refresh
    // failed" and the user picks a feed once they're back online.
    throw new Error('feeds.json: no network and no cached copy');
  }
}
