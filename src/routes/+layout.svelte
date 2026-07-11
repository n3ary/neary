<!-- Root layout. Every route renders inside AppLayout (Header + StatusBar + scrollable main + BottomNavigation). Per-route title and refresh handler derive from the route path; health state comes from the stores the relevant routes populate. -->
<script lang="ts">
  import '$lib/styles/app.css';
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page, updated } from '$app/state';
  import { Heart, MapPin, Settings } from 'lucide-svelte';
  import * as Comlink from 'comlink';
  import { AppLayout, type HeaderHealth } from '$lib/ui';
  import { connectionStore } from '$lib/stores/connectionStore.svelte';
  import { feedsStore } from '$lib/stores/feedsStore.svelte';
  import { favoritesStore } from '$lib/stores/favoritesStore.svelte';
  import { reconciledVehiclesStore } from '$lib/stores/reconciledVehiclesStore.svelte';
  import { locationStore } from '$lib/stores/gps/locationStore.svelte';
  import { nowTicker } from '$lib/stores/nowTicker.svelte';
  import { refreshBus } from '$lib/stores/refreshBus.svelte';
  import { stationsViewStore } from '$lib/stores/stationsViewStore.svelte';
  import { statusBus } from '$lib/stores/statusBus.svelte';
  import { userPrefs } from '$lib/stores/userPrefs.svelte';
  import { getGtfsRepo } from '$lib/data/gtfs/repo';

  let { children } = $props();

  // App-update detection. SvelteKit's `updated.current` flips to true
  // when the client's poll of `_app/version.json` (interval set in
  // svelte.config.js `kit.version`) returns a name different from the
  // one this session booted with — i.e. a new deploy is live. Reload
  // so the next paint is from the new HTML + bundle. Transit views
  // have no form state to lose, so silent reload is the cleanest UX.
  $effect(() => {
    if (updated.current && typeof window !== 'undefined') {
      window.location.reload();
    }
  });

  // PWA service worker registration. Prod only — in dev the SW
  // would interfere with Vite HMR and the rebuild-on-save loop.
  // The SW itself lives at src/service-worker.ts; @vite-pwa/sveltekit
  // bundles it and emits it at /service-worker.js (vite.config.ts
  // config). The SW's `skipWaiting` + `clients.claim` make the
  // new shell take over the next paint, which is what fixes the
  // "saved PWA crashes on first open after a deploy" regression.
  //
  // `updateViaCache: 'none'` tells the browser to bypass its own
  // HTTP cache for the SW file itself. Without this the browser
  // can serve a 24h-cached sw.js and a new deploy is invisible
  // for a day. With it, the browser re-fetches sw.js on every
  // page load; the SW's own cache strategy then decides what
  // happens.
  $effect(() => {
    if (typeof window === 'undefined') return;
    if (!import.meta.env.PROD) return;
    if (!('serviceWorker' in navigator)) return;
    // Defer registration so it doesn't compete with the initial
    // route hydration. The SW will pick up the page on the next
    // navigation if it installs faster than the first paint.
    const handle = window.setTimeout(() => {
      void navigator.serviceWorker.register('/service-worker.js', {
        scope: '/',
        type: 'module',
        updateViaCache: 'none',
      }).catch((err) => {
        console.warn('[pwa] service worker registration failed', err);
      });
    }, 0);
    return () => window.clearTimeout(handle);
  });

// Dev/debug console hooks. Lets the user pin a fake GPS location from
  // the browser console - useful in Safari where DevTools doesn't have a
  // built-in location override. Always installed (cheap, no harm in
  // production) so internal users can exercise different neighborhoods.
  //
  //   neary.setLocation(<lat>, <lon>)        // pin a mock GPS fix
  //   neary.clearLocation()                  // resume real GPS
  $effect(() => {
    if (typeof window === 'undefined') return;
    (window as unknown as { neary?: unknown }).neary = {
      setLocation: (lat: number, lon: number, accuracy = 25) =>
        locationStore.setMockPosition(lat, lon, accuracy),
      clearLocation: () => locationStore.clearMockPosition(),
      stores: {
        locationStore, feedsStore, statusBus, userPrefs, refreshBus,
        reconciledVehiclesStore, favoritesStore, stationsViewStore,
      },
    };
  });

  // Tab-swap reset: deliberately NOT wired. Returning from /favorites
  // or /settings back to / should restore the rider's previous
  // expansion + route filter rather than wipe them - that's the same
  // preservation semantics we already use for drilldown navigation
  // (/map/..., /schedule/...). Issue #203.

  // Persist user prefs on any change. Browser-only — $effect doesn't run on
  // the server during prerender.
  $effect(() => {
    const snap = userPrefs.snapshot();
    try {
      localStorage.setItem('neary-user-prefs', JSON.stringify(snap));
    } catch {
      // localStorage may be unavailable (privacy mode); silent fallback.
    }
  });

  // Resume the GPS watch on app start when the user previously opted in.
  // GPS is strictly opt-in (#110) — the in-page banner / header dot are
  // the only paths to flip `userPrefs.gpsOptedIn`. We never prompt for
  // permission without that flag, so a returning user doesn't see the
  // browser dialog every time they open the app.
  $effect(() => {
    if (userPrefs.gpsOptedIn) locationStore.start();
  });

  // Reflect the user's chosen theme on the root element so theme.css overrides
  // pick up immediately. Idempotent — setting the same value is a no-op.
  $effect(() => {
    document.documentElement.dataset.theme = userPrefs.theme;
  });

  // Auto-bind the GTFS worker to the user's selected feed. The repo is
  // lazily constructed; this effect only spawns the worker once a feed
  // exists in both userPrefs AND the loaded registry, then re-runs when
  // EITHER the id changes (user switched feeds) or the registry refresh
  // surfaces a new hash for the same feed (upstream zip changed, OPFS
  // needs the newer .sqlite3). Progress + errors are surfaced through
  // the global StatusBar so the user sees them regardless of route.
  let lastBoundFeedKey = $state<string | null>(null);
  $effect(() => {
    void feedsStore.load();
  });
  $effect(() => {
    const id = userPrefs.feedId;
    if (id == null) {
      // User deselected (e.g. deleted the active feed from Settings).
      // closeCurrent() ran in the worker but feedsStore.boundFeedId is
      // still the previous truthy id — any page that gates queries on
      // it would fire them against a worker with currentDb=null and
      // throw "GTFS worker not bound to a feed yet". Clear it here so
      // page effects stay in their loading state until the user picks
      // a new feed (which resets lastBoundFeedKey and rebinds).
      feedsStore.boundFeedId = null;
      return;
    }
    const feed = feedsStore.byId(id);
    if (!feed) return; // registry not loaded yet; effect will re-fire when it is
    // Key by (id, hash) so a new hash on the same id triggers re-bind.
    // The hash is the sha256 of the published sqlite_gz — when the daily
    // pipeline publishes a fresher build, the hash changes, opfsFileFor()
    // computes a new filename, bootstrap() downloads the new blob.
    const key = `${id}@${feed.hash ?? ''}`;
    if (key === lastBoundFeedKey) return;
    // Same defensive clear as the deselect branch — if we're switching
    // to a different feed (or a new hash on the same id) the previous
    // bind is no longer authoritative. The page-level $effect that
    // watches boundFeedId needs to see null until the new setFeed
    // resolves, otherwise it fires queries during the bind window.
    feedsStore.boundFeedId = null;
    // New feed = new geography. Drop the previous selection so the
    // user doesn't land on a stale "expanded stop" that isn't in the
    // new feed's stop table (issue #203: state should not leak across
    // feed swaps).
    stationsViewStore.reset();
    lastBoundFeedKey = key;
    const repo = getGtfsRepo();
    // Mark this feed as in-flight so the Settings feed row can render
    // a download spinner instead of a (false) "delete local data"
    // affordance. Cleared on success and failure below.
    feedsStore.bindingFeedId = feed.id;
    feedsStore.bindingProgress = 0;
    // statusBus.push reads `entries` (findIndex for dedupe), so calls
    // from inside a $effect must be wrapped in untrack to avoid
    // effect_update_depth loops. Matches the pattern at
    // routes/+page.svelte for the gps-pending push.
    untrack(() => {
      statusBus.push({
        id: 'gtfs-bind',
        kind: 'progress',
        message: `Loading schedule for ${feed.name}…`,
        progress: 0,
      });
    });
    // Callback that surfaces byte-level download progress from the
    // worker as a percentage on the same status entry. Wrapped in
    // Comlink.proxy so it can cross the worker boundary. Fires at
    // most every ~250 ms (throttled worker-side). When the upstream
    // omits Content-Length (totalBytes is null) we leave the bar at
    // its last determinate value rather than jumping around.
    const onProgress = Comlink.proxy((bytes: number, total: number | null) => {
      if (total && total > 0) {
        const pct = Math.min(100, Math.round((bytes / total) * 100));
        untrack(() => {
          statusBus.progress('gtfs-bind', pct);
        });
        feedsStore.bindingProgress = pct;
      }
    });
    repo
      .setFeed($state.snapshot(feed) as typeof feed, onProgress)
      .then(() => {
        feedsStore.boundFeedId = feed.id;
        feedsStore.bindingFeedId = null;
        feedsStore.bindingProgress = null;
        // Subscribe to the worker's reconciliation broadcast. The worker
        // owns the live poll loop (started in setFeed); this just wires
        // the main-thread store to receive every tick. Idempotent across
        // feed switches.
        reconciledVehiclesStore.bind();
        untrack(() => {
          statusBus.push({
            id: 'gtfs-bind',
            kind: 'success',
            message: 'Schedule ready.',
          });
        });
      })
      .catch((e: Error) => {
        feedsStore.bindingFeedId = null;
        feedsStore.bindingProgress = null;
        untrack(() => {
          statusBus.push({
            id: 'gtfs-bind',
            kind: 'error',
            message: e?.message ?? 'Failed to load schedule.',
            ttlMs: 0,
          });
        });
        // Keep lastBoundFeedKey set to the failed key so the effect
        // doesn't re-fire in an infinite loop. `lastBoundFeedKey` is
        // read by this same effect at the top; nulling it here would
        // re-trigger the effect, which would call setFeed again, fail
        // again, null again — a self-driving retry storm. To retry the
        // same feed the user reloads the page; to try another they
        // pick it from Settings (different key → effect fires normally).
        feedsStore.boundFeedId = null;
      });
  });

  type NavValue = '/' | '/favorites' | '/settings';

  const NAV_ITEMS = [
    { value: '/', label: 'Stations', icon: stationsIcon },
    { value: '/favorites', label: 'Favorites', icon: favoritesIcon },
    { value: '/settings', label: 'Settings', icon: settingsIcon },
  ] as const;

  const TITLES: Record<NavValue, string> = {
    '/': 'Stations',
    '/favorites': 'Favorites',
    '/settings': 'Settings',
  };

  // Active tab = first nav prefix match. Drill-down routes (/schedule/...,
  // /map/...) currently inherit "Stations" — refined when those routes ship.
  const activeNav = $derived<NavValue>(
    (NAV_ITEMS.find((n) => page.url.pathname === n.value)?.value ?? '/') as NavValue,
  );

  const title = $derived(TITLES[activeNav]);

  // Refresh-button feedback. On press, capture the current lastFetchMs
  // snapshot and push a loading entry into the StatusBar. A $effect
  // watches the reconciled store; when either lastFetchMs advances
  // past the snapshot OR error changes, we resolve the loading entry:
  //   - error      → red error entry with the message
  //   - success    → info entry with the new live-vehicle count
  // A safety timeout (`REFRESH_TIMEOUT_MS`) covers the case where the
  // worker never responds — the loading state would otherwise hang
  // forever. Touch users can't read the dot tooltips, so this is how
  // they know whether their refresh actually did anything.
  const REFRESH_ID = 'refresh';
  const REFRESH_TIMEOUT_MS = 8_000;
  let pendingRefreshSinceMs = $state<number | null>(null);
  let pendingRefreshSnapMs = $state<number | null>(null);
  let pendingRefreshSnapError = $state<string | null>(null);
  let pendingRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  function clearPendingRefresh() {
    pendingRefreshSinceMs = null;
    pendingRefreshSnapMs = null;
    pendingRefreshSnapError = null;
    if (pendingRefreshTimer) {
      clearTimeout(pendingRefreshTimer);
      pendingRefreshTimer = null;
    }
  }

  function startRefresh() {
    if (pendingRefreshSinceMs != null) return; // ignore re-taps while in flight
    pendingRefreshSinceMs = Date.now();
    pendingRefreshSnapMs = reconciledVehiclesStore.lastFetchMs;
    pendingRefreshSnapError = reconciledVehiclesStore.error;
    statusBus.push({ id: REFRESH_ID, kind: 'loading', message: 'Refreshing live data…' });
    pendingRefreshTimer = setTimeout(() => {
      if (pendingRefreshSinceMs == null) return;
      clearPendingRefresh();
      statusBus.push({
        id: REFRESH_ID,
        kind: 'warning',
        message: 'No response — showing cached data',
      });
    }, REFRESH_TIMEOUT_MS);
    refreshBus.fire();
    reconciledVehiclesStore.refresh();
    nowTicker.bump();
  }

  $effect(() => {
    if (pendingRefreshSinceMs == null) return;
    const nowFetch = reconciledVehiclesStore.lastFetchMs;
    const nowError = reconciledVehiclesStore.error;
    const fetchAdvanced = nowFetch != null && nowFetch !== pendingRefreshSnapMs;
    const errorChanged = nowError !== pendingRefreshSnapError;
    if (!fetchAdvanced && !errorChanged) return;
    // untrack: statusBus.push reads `entries` for dedupe; without
    // wrapping, the push would add it as a dep and re-fire this
    // effect, looping until effect_update_depth. clearPendingRefresh()
    // below would normally break the cycle, but untrack makes the
    // safety explicit. See routes/+page.svelte for the matching pattern.
    if (nowError && !fetchAdvanced) {
      untrack(() => {
        statusBus.push({ id: REFRESH_ID, kind: 'error', message: `Refresh failed: ${nowError}` });
      });
    } else {
      const stats = reconciledVehiclesStore.stats;
      const count = stats ? stats.matched + stats.live : 0;
      untrack(() => {
        statusBus.push({
          id: REFRESH_ID,
          kind: 'success',
          message: count > 0 ? `Updated — ${count} live vehicles` : 'Updated — no live vehicles',
        });
      });
    }
    clearPendingRefresh();
  });

  // Schedule and Live dots both reflect the single GTFS worker. Schedule
  // lights up when the worker has a feed bound; Live reflects the
  // worker's reconciliation broadcast (lastFetchMs / error). GPS and
  // Connection are real — see locationStore + connectionStore. The GPS
  // watch starts in the resume-effect above when the user has previously
  // opted in (#110); otherwise the Stations view drives the opt-in flow.
  const health: HeaderHealth = $derived({
    gps: {
      state: locationStore.freshness,
      tooltip: locationStore.tooltip,
    },
    connection: {
      state: connectionStore.online ? 'ok' : 'error',
      tooltip: connectionStore.online ? 'Online' : 'Offline',
    },
    schedule: {
      state: userPrefs.feedId == null ? 'idle' : 'ok',
      tooltip: userPrefs.feedId == null ? 'No feed selected' : 'Schedule loaded',
    },
    live: (() => {
      // Health of the GTFS-RT poller.
      //   no feed bound yet            -> idle
      //   error and never succeeded    -> error
      //   last successful fetch < 30s  -> ok
      //   last successful fetch < 2min -> stale
      //   older                        -> error
      if (reconciledVehiclesStore.error && reconciledVehiclesStore.lastFetchMs == null) {
        return { state: 'error', tooltip: `Live feed error: ${reconciledVehiclesStore.error}` };
      }
      if (reconciledVehiclesStore.lastFetchMs == null) {
        return { state: 'idle', tooltip: 'Live feed not started' };
      }
      const age = Date.now() - reconciledVehiclesStore.lastFetchMs;
      // "live vehicles seen" = matched (reconciled) + orphan live obs.
      // Scheduled-only rows in the snapshot aren't "live".
      const stats = reconciledVehiclesStore.stats;
      const count = stats ? stats.matched + stats.live : 0;
      if (age < 30_000) return { state: 'ok', tooltip: `${count} live vehicles · just now` };
      if (age < 2 * 60_000) return { state: 'stale', tooltip: `${count} live vehicles · ${Math.round(age / 1000)}s ago` };
      return { state: 'error', tooltip: `Live feed last fetched ${Math.round(age / 60_000)} min ago` };
    })(),
  });
</script>

{#snippet stationsIcon()}<MapPin size={20} />{/snippet}
{#snippet favoritesIcon()}<Heart size={20} />{/snippet}
{#snippet settingsIcon()}<Settings size={20} />{/snippet}

<AppLayout
  {title}
  {health}
  navItems={NAV_ITEMS}
  {activeNav}
  onnav={(to) => goto(to)}
  onrefresh={startRefresh}
  // Search icon is the global entry point to the station/route picker
  // overlay; available on every page that has a bound feed.
  showSearch={userPrefs.feedId != null}
>
  {@render children()}
</AppLayout>

