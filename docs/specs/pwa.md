# PWA

Reasoning behind the PWA setup. Implementation:
[svelte.config.js](../../svelte.config.js), [vite.config.ts](../../vite.config.ts),
[src/service-worker.ts](../../src/service-worker.ts),
[src/routes/+layout.svelte](../../src/routes/+layout.svelte),
[static/manifest.json](../../static/manifest.json).

## Goals

- Installable on iOS Safari and Android Chrome.
- Updates propagate without forcing the user to clear caches.
- The shell (HTML, JS, CSS) loads from cache after first online visit,
  including on the home-screen PWA after a deploy.
- Schedules from feeds.json + a previously downloaded sqlite stay
  accessible on a cold-start offline open.
- Safe-area aware on iPhone X+ (notch, home indicator).

## Single version source

`package.json#version` is the single source of truth for "what build is
this". It's:

- Bumped on every PR by the auto-version GitHub Action — see
  [ci-and-versioning.md](ci-and-versioning.md).
- Read at build time in [svelte.config.js](../../svelte.config.js) and passed
  to SvelteKit as `kit.version.name`.
- Emitted into `build/_app/version.json` (e.g. `{"version":"1.5.20"}`).
- Read by [src/service-worker.ts](../../src/service-worker.ts) via the
  Vite `define` (`__APP_VERSION__`) and used to namespace the
  precache bucket so old shells can be dropped on activate.
- Available to UI code via `import { version } from '$app/environment'` —
  use it anywhere a version string needs to be displayed.

> [!IMPORTANT]
> One version everywhere. Don't introduce a separate git-SHA, build
> timestamp, or PWA-only version string. The auto-bump action guarantees
> uniqueness per shipped bundle.

## Update propagation

Two layers, both keyed on the same `package.json` version.

### Service worker (primary)

The SW in [src/service-worker.ts](../../src/service-worker.ts) precaches
the app shell + manifest in a bucket named `precache-v<version>`.
On `activate`, every other `precache-v*` bucket is dropped, so an
outdated shell never gets served from cache. `skipWaiting` +
`clients.claim` make the new SW take over on the next paint — the
PWA staleness trap (saved app crashes / white-screens on first open
after a deploy) goes away because the new HTML is what's served,
not the old cached shell.

### SvelteKit version polling (secondary)

Belt-and-suspenders. The root layout
([src/routes/+layout.svelte](../../src/routes/+layout.svelte)) subscribes
to `updated.current` from `$app/state`. SvelteKit's client polls
`/_app/version.json` every 60 s; on mismatch it flips `updated.current`
to true. The layout never reloads a tab the rider is reading
([src/lib/sw/appUpdate.ts](../../src/lib/sw/appUpdate.ts)): a hidden
tab reloads immediately; a visible tab gets an "Update available"
banner with a Reload button, and the first backgrounding applies the
update silently. Catches the edge case where the SW itself fails to
claim (browser bug, private mode, etc.) — the update lands within a
minute either way, without yanking the board mid-read.

Two guards keep the banner honest:

- **Re-nag suppression.** After acting on an update (any reload path —
  the banner's Reload goes through the flow's own reload), the flow
  stays quiet for 30 min even if the poll still reports a mismatch:
  the served shell legitimately lags `version.json` while the new SW
  installs (precaching is slow on patchy signal), so an immediate
  re-prompt means "couldn't apply yet", not "another update". The
  timestamp lives in `sessionStorage` (survives the reload the flow
  triggers, resets on a new session).
- **`waitUntil` for background refreshes.** Every piece of SW
  background work (the runtime-HTML revalidate in particular) is
  handed to `FetchEvent.waitUntil`. Without it the browser can kill
  the SW the instant `respondWith` settles — iOS does this
  aggressively — the refresh dies mid-flight, the cached shell stays
  stale forever, and the banner reappears after every reload no
  matter how often the user updates.

```js
// svelte.config.js
kit: {
  version: {
    name: pkg.version,         // package.json version
    pollInterval: 60 * 1000,   // 60 s
  },
}
```

Why 60 s: long enough to be invisible in network panels and battery use,
short enough that a returning user catches a fresh deploy within a few
minutes.

## Service worker details

[src/service-worker.ts](../../src/service-worker.ts) is hand-rolled (not
workbox). It's ~100 lines and easy to audit. Two strategies:

### Precache (build-time)

- App shell HTML, the SvelteKit-emitted JS/CSS chunks, the webmanifest,
  and `sqlite3.wasm` (the GTFS worker can't init without it offline).
  The SPA shell `/` isn't in the injected manifest (the glob can't see
  prerendered output), so the SW caches it explicitly at install time;
  `_redirects` rewrites every route to it, which makes any offline
  navigation bootable from the precache alone.
- Cross-origin assets (brand icons at `branding.n3ary.com`) are NOT
  precached — they're served from the brand CDN, which has its own
  cache headers.
- The sqlite_gz and the live GTFS-RT feed
  (`gtfs-rt.n3ary.com/rt/*`) are NOT precached — the OPFS bootstrap
  and the live pipeline handle their own offline behavior (see
  [data-lifecycle.md](multi-feed-data-lifecycle.md)).

### Runtime cache: OSM tiles

- `{s}.tile.openstreetmap.org` tiles are CacheFirst in a fixed-name
  bucket (`runtime-osm-tiles-v1`) that survives SW updates, capped at
  1200 entries (~25 MB, FIFO trim). Cached tiles revalidate in the
  background after 30 days; failures are never cached.
- After a feed binds, `lib/map/offlineTiles.ts` prefetches the feed's
  bbox at idle time — budget-capped at 600 tiles, picking the highest
  zooms z10–z14 that fit (city feeds get the full range; regional
  bboxes get coarse zooms only). Higher zooms are cached lazily as the
  user browses. The prefetch runs at most once per 24 h per feed, is
  skipped on Save-Data / 2g / offline, and re-arms on every `online`
  event. Budget + throttling keep this inside the OSM Tile Usage
  Policy; Leaflet loads tiles in CORS mode so the SW can stamp
  put-time and share entries with the prefetch.

### Runtime cache: feeds.json only

- `https://gtfs.n3ary.com/feeds.json` is served from the SW runtime
  cache when present (revalidated in the background); on a cache miss
  the SW fetches in the foreground and caches the response. The app
  also persists the last fetched registry in localStorage
  (`neary-feeds-registry`) and falls back to it when the fetch fails,
  so a cold-start offline open can still bind a feed whose sqlite is
  already in OPFS.
- /api/rt/* was a same-origin Pages Function in the old
  architecture; now removed. The app calls
  `gtfs-rt.n3ary.com/rt/<feed>/vehicle_positions` directly from
  `feeds.json.realtime.vehicle_positions`. The new proxy host
  is explicitly NOT cached at the SW
  layer. The live pipeline (see [live-pipeline.md](live-data-pipeline.md))
  already keeps the last good vehicle snapshot when the network
  fails, and the OPFS bootstrap already short-circuits when the
  sqlite is local. Caching at the SW would serve stale vehicles or
  double-cache large files; we don't.

### Activation

- `install` → precache, then `skipWaiting` so the new SW activates
  on the next open without waiting for existing tabs to close.
- `activate` → delete any other `precache-v*` cache, then
  `clients.claim` so the new SW takes over the current page.
  The next paint uses the new shell, fixing the saved-PWA crash
  on first open after a deploy. Because claiming also deletes the
  running page's precache out from under it, the layout listens for
  `controllerchange` and runs the hidden-first update flow
  ([appUpdate.ts](../../src/lib/sw/appUpdate.ts)) the moment a new SW
  takes over — a claimed page never keeps running on pruned assets.
  First-install claims are ignored (nothing of ours was pruned).

### Registration

Registered in [src/routes/+layout.svelte](../../src/routes/+layout.svelte)
on the client only, in production only. Dev mode skips registration
so Vite HMR isn't fighting the SW cache.

## Boot-stall recovery

The failure class this guards against: a wedged start that never
reaches first content — a stalled SW fetch (browsers apply no timeout
to `respondWith`), a missing chunk after cache eviction, a frozen
zombie session holding the OPFS access handles, a hung socket. Every
one of these used to present as a permanent black (pre-paint) or
white (post-paint, unstyled) screen that only a full app kill
cleared. Four mechanisms, each covering a different wedge:

- **Watchdog** (inline script in
  [src/app.html](../../src/app.html), decision logic in
  [src/lib/sw/bootWatchdog.ts](../../src/lib/sw/bootWatchdog.ts)).
  Inline and dependency-free so it runs even when the bundle itself
  fails to load. The layout reports a healthy state
  (`window.__nearyBoot.done()`) once nothing can hang silently — feed
  bound, feed picker shown, or a bind error surfaced — and beats on
  download progress. Otherwise, after 15 s the watchdog auto-reloads,
  bounded to 2 reloads per 10 min (crash-loop budget), then shows a
  blocking overlay with a manual Reload. It re-arms on every
  background-resume re-bind. The stall window widens to 60 s while a
  feed bind is in flight, so an honestly-retrying seed download on
  patchy signal never triggers a progress-destroying reload (beats
  fire per downloaded chunk; the worst honest beat gap is the 20 s
  per-read stall bound plus retry backoff).
- **Background suspend / resume** (+layout ↔
  `suspendForBackground()` in
  [bootstrap.ts](../../src/lib/workers/gtfs/bootstrap.ts)). On
  `visibilitychange`→hidden / `pagehide` / the Page Lifecycle
  `freeze` event, the worker closes the DB and `pauseVfs()`-releases
  the SAH pool's OPFS sync-access handles — Android *freezes*
  standalone PWAs within seconds of backgrounding rather than
  killing them, and a frozen holder blocks every future bootstrap
  until process death. (`freeze` is Chromium-only; on iOS the
  `visibilitychange`/`pagehide` pair covers the same transition, and
  the suspend message is processed on thaw ahead of the resume
  re-bind if the process was frozen first.) Resume unpauses and
  re-opens the already-seeded OPFS file: pool re-acquire + DB open,
  no re-download.
- **SAH acquisition timeout** (bootstrap.ts). A contested
  `createSyncAccessHandle` stays pending forever; both the initial
  pool install and the resume-side `unpauseVfs()` are bounded to
  10 s, after which the bootstrap rejects into the existing
  user-readable error instead of hanging.
- **Precache fallback fetch timeout**
  ([handlers.ts](../../src/lib/sw/handlers.ts)). The
  `serveFromPrecache` network fall-through carries a 15 s
  `AbortSignal`, so a wedged socket fails the request (and lets the
  watchdog reload) instead of hanging the page forever.

- **Seed-download resilience** (bootstrap.ts). The whole download —
  not just the connect — retries on failure (5 attempts, backoff),
  and every stream read is bounded to 20 s, so a socket that dies
  mid-body on patchy signal fails one attempt and retries on a fresh
  connection instead of hanging to the 10-minute overall timeout.

## Offline behavior

What's offline-safe and what isn't:

| Scenario | Outcome |
| --- | --- |
| User has OPFS sqlite for a feed, opens app offline | **Works.** SW precache serves the shell, OPFS read returns the schedule (the previous snapshot when the registry has advanced past the downloaded sqlite). Live data shows the last good snapshot. StatusBar shows "Refresh failed." |
| User has feeds.json cached, never picked a feed, opens offline | **Partial.** Shell + feed picker load, but no sqlite is downloaded. They can't pick a feed. |
| Map view, offline | **Works** for the feed's bbox at prefetched zooms and for any tile the user previously viewed; uncached areas show the gray grid. Route shapes, stops and vehicles are local data and always render. |
| User has never visited, opens offline | **Fails.** No shell, no data, no fallback. |
| Saved PWA user, post-deploy, opens online | **Works.** SW detects new version, activates, claims clients, next paint uses new shell. |
| Saved PWA user, post-deploy, opens offline (new shell not yet precached) | **Degraded but recoverable.** Old shell loads, points at asset paths the network can't serve. The boot watchdog auto-reloads twice, then shows a blocking Reload overlay instead of a dead white screen; once reconnected the next open repairs itself. |

## Cache headers

[static/_headers](../../static/_headers) explicitly excludes `version.json`,
the service worker, and `index.html` from CDN caching. Without these
overrides the version poll would lag the CDN TTL and the update story
silently breaks.

## iOS safe-area

`AppLayout` applies `env(safe-area-inset-*)` so the header and bottom
navigation don't get cut by the notch / home indicator when launched
from the home screen.

## What we deliberately don't do

- No custom install prompt UI — rely on the browser's native install affordance.
- No background sync — re-fetch on focus instead.
- No push notifications — out of scope.
- No SW-level cache for live data
  (`gtfs-rt.n3ary.com/rt/*`). Caching would serve stale vehicles,
  which is wrong.
- No SW-level cache for the sqlite. The OPFS layer is the durable
  store; the SW doesn't need to duplicate it.

## Manifest

[static/manifest.json](../../static/manifest.json) is the source. Update
icons + name there; the PWA plugin picks it up at build time.

## Test

[tests/pwa.spec.ts](../../tests/pwa.spec.ts) is a Playwright smoke test.
It serves the production build, asserts the SW is generated and
registers, and verifies the precache bucket name matches the current
version. Run locally with `pnpm exec playwright test`.
