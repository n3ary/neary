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
to true and the layout calls `window.location.reload()`. Catches the
edge case where the SW itself fails to claim (browser bug, private
mode, etc.) — the user reloads manually within a minute either way.

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

- App shell HTML, the SvelteKit-emitted JS/CSS chunks, the webmanifest.
- Cross-origin assets (brand icons at `branding.n3ary.com`) are NOT
  precached — they're served from the brand CDN, which has its own
  cache headers.
- The sqlite_gz and the live GTFS-RT feed
  (`gtfs-rt.n3ary.com/rt/*`) are NOT precached — the OPFS bootstrap
  and the live pipeline handle their own offline behavior (see
  [data-lifecycle.md](multi-feed-data-lifecycle.md)).

### Runtime cache: feeds.json only

- `https://gtfs.n3ary.com/feeds.json` is served NetworkFirst with a
  background cache update. Cold-start offline (no network, no SW
  cache yet) then falls back to the cached copy from a prior visit.
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
  on first open after a deploy.

### Registration

Registered in [src/routes/+layout.svelte](../../src/routes/+layout.svelte)
on the client only, in production only. Dev mode skips registration
so Vite HMR isn't fighting the SW cache.

## Offline behavior

What's offline-safe and what isn't:

| Scenario | Outcome |
| --- | --- |
| User has OPFS sqlite for a feed, opens app offline | **Works.** SW precache serves the shell, OPFS read returns the schedule. Live data shows the last good snapshot. StatusBar shows "Refresh failed." |
| User has feeds.json cached, never picked a feed, opens offline | **Partial.** Shell + feed picker load, but no sqlite is downloaded. They can't pick a feed. |
| User has never visited, opens offline | **Fails.** No shell, no data, no fallback. |
| Saved PWA user, post-deploy, opens online | **Works.** SW detects new version, activates, claims clients, next paint uses new shell. |
| Saved PWA user, post-deploy, opens offline (new shell not yet precached) | **Degraded but recoverable.** Old shell from HTTP cache loads, points at asset paths the network can't serve. User sees 500/white screen until they reconnect and refresh. The new SW fixes this on the next online open. |

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
