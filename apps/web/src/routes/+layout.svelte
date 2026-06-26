<!--
  Root layout — every route renders inside AppLayout (Header + StatusBar +
  scrollable main + BottomNavigation). Per-route title and refresh handler
  are derived from the route path; agency / health state come from stores
  that the relevant routes populate.
-->
<script lang="ts">
  import '$lib/styles/app.css';
  import { goto } from '$app/navigation';
  import { page, updated } from '$app/state';
  import { Heart, Home, MapPin, Settings } from 'lucide-svelte';
  import { AppLayout, type HeaderHealth } from '$lib/ui';
  import { connectionStore } from '$lib/stores/connectionStore.svelte';
  import { feedsStore } from '$lib/stores/feedsStore.svelte';
  import { favoritesStore } from '$lib/stores/favoritesStore.svelte';
  import { liveVehiclesStore } from '$lib/stores/liveVehiclesStore.svelte';
  import { locationStore } from '$lib/stores/locationStore.svelte';
  import { refreshBus } from '$lib/stores/refreshBus.svelte';
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

  // Dev/debug console hooks. Lets the user pin a fake GPS location from
  // the browser console — useful in Safari where DevTools doesn't have a
  // built-in location override. Always installed (cheap, no harm in
  // production) so internal users can exercise different neighborhoods.
  //
  //   neary.setLocation(46.7712, 23.6236)   // Pia\u021ba Mihai Viteazul, Cluj
  //   neary.clearLocation()                  // resume real GPS
  $effect(() => {
    if (typeof window === 'undefined') return;
    (window as unknown as { neary?: unknown }).neary = {
      setLocation: (lat: number, lon: number, accuracy = 25) =>
        locationStore.setMockPosition(lat, lon, accuracy),
      clearLocation: () => locationStore.clearMockPosition(),
      stores: { locationStore, feedsStore, statusBus, userPrefs, refreshBus, liveVehiclesStore, favoritesStore },
    };
  });

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

  // Reflect the user's chosen theme on the root element so theme.css overrides
  // pick up immediately. Idempotent — setting the same value is a no-op.
  $effect(() => {
    document.documentElement.dataset.theme = userPrefs.theme;
  });

  // Auto-bind the GTFS worker to the user's selected feed. The repo is
  // lazily constructed; this effect only spawns the worker once a feed
  // exists in both userPrefs AND the loaded registry, then re-runs only
  // when the id changes. Progress + errors are surfaced through the global
  // StatusBar so the user sees them regardless of which route they're on.
  let lastBoundFeedId = $state<string | null>(null);
  $effect(() => {
    void feedsStore.load();
  });
  $effect(() => {
    const id = userPrefs.feedId;
    if (id == null || id === lastBoundFeedId) return;
    const feed = feedsStore.byId(id);
    if (!feed) return; // registry not loaded yet; effect will re-fire when it is
    lastBoundFeedId = id;
    const repo = getGtfsRepo();
    statusBus.push({
      id: 'gtfs-bind',
      kind: 'loading',
      message: `Loading schedule for ${feed.name}…`,
    });
    repo
      .setFeed($state.snapshot(feed) as typeof feed)
      .then(() => {
        feedsStore.boundFeedId = feed.id;
        // Kick off live-data polling for this feed. Idempotent across
        // feed switches; rebinds to the new id when applicable.
        liveVehiclesStore.bind(feed.id);
        statusBus.push({
          id: 'gtfs-bind',
          kind: 'success',
          message: 'Schedule ready.',
        });
      })
      .catch((e: Error) => {
        statusBus.push({
          id: 'gtfs-bind',
          kind: 'error',
          message: e?.message ?? 'Failed to load schedule.',
          ttlMs: 0,
        });
        // Roll back the binding tracker so the user can retry by re-selecting.
        lastBoundFeedId = null;
        feedsStore.boundFeedId = null;
      });
  });

  type NavValue = '/' | '/favorites' | '/planner' | '/settings';

  const NAV_ITEMS = [
    { value: '/', label: 'Stations', icon: stationsIcon },
    { value: '/favorites', label: 'Favorites', icon: favoritesIcon },
    { value: '/planner', label: 'Planner', icon: plannerIcon },
    { value: '/settings', label: 'Settings', icon: settingsIcon },
  ] as const;

  const TITLES: Record<NavValue, string> = {
    '/': 'Stations',
    '/favorites': 'Favorites',
    '/planner': 'Planner',
    '/settings': 'Settings',
  };

  // Active tab = first nav prefix match. Drill-down routes (/schedule/...,
  // /map/...) currently inherit "Stations" — refined when those routes ship.
  const activeNav = $derived<NavValue>(
    (NAV_ITEMS.find((n) => page.url.pathname === n.value)?.value ?? '/') as NavValue,
  );

  const title = $derived(TITLES[activeNav]);

  // Phase 3 ships placeholder Schedule and Live states (real wiring lands in
  // Phase 4 / 5). GPS and Connection are real — see locationStore + connection
  // Store. The GPS watch isn't started by the layout itself; the Stations
  // route calls locationStore.start() on mount so we don't prompt for
  // permission on routes that don't need it.
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
      if (liveVehiclesStore.error && liveVehiclesStore.lastFetchMs == null) {
        return { state: 'error', tooltip: `Live feed error: ${liveVehiclesStore.error}` };
      }
      if (liveVehiclesStore.lastFetchMs == null) {
        return { state: 'idle', tooltip: 'Live feed not started' };
      }
      const age = Date.now() - liveVehiclesStore.lastFetchMs;
      const count = liveVehiclesStore.observations.length;
      if (age < 30_000) return { state: 'ok', tooltip: `${count} live vehicles · just now` };
      if (age < 2 * 60_000) return { state: 'stale', tooltip: `${count} live vehicles · ${Math.round(age / 1000)}s ago` };
      return { state: 'error', tooltip: `Live feed last fetched ${Math.round(age / 60_000)} min ago` };
    })(),
  });
</script>

{#snippet stationsIcon()}<MapPin size={20} />{/snippet}
{#snippet favoritesIcon()}<Heart size={20} />{/snippet}
{#snippet plannerIcon()}<Home size={20} />{/snippet}
{#snippet settingsIcon()}<Settings size={20} />{/snippet}

<AppLayout
  {title}
  {health}
  navItems={NAV_ITEMS}
  {activeNav}
  onnav={(to) => goto(to)}
  onrefresh={() => {
    refreshBus.fire();
    liveVehiclesStore.refresh();
  }}
>
  {@render children()}
</AppLayout>

