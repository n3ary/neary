<!--
  /favorites -- pick + manage favorited routes and stations.

  After #234 the page landed a shared FavoritesCard that combined
  routes + stations under one "Your favorites" header. #237 splits
  the two surfaces onto separate tabs (Routes / Stations), cascades
  the mode + network filters to the Stations tab, ranks each surface
  with context-aware ordering, and paginates the station catalog so
  national-scale feeds stay performant.

  #237 added a station-marker model (favorite / home / work /
  cityCenter) -- the heart button on each station card is now a
  dropdown picker; the "Your favorites" card sits above the tabs and
  shows both routes and stations, each with their marker badges.

  Tabs are scoped to /favorites -- the search overlay and home
  favorites card keep their merged layout. The active tab persists
  via `?tab=routes|stations` so a deep link or reload lands on the
  same surface. Scroll position is preserved per tab (stash on
  leave, restore on re-entry) so a tab swap doesn't yank the user
  to the top of the new tab.

  The "Your favorites" card ALWAYS renders all of the user's
  favorites regardless of the active tab or the filter cascade.
  Filters (marker / mode / network) only narrow the "All routes" /
   "All stations" catalog below the tabs -- they never hide or trim a
   favorited item from the pinned card. A favorited route also never
   reappears in the "All routes" catalog: the catalog subtracts the
   favorites set before rendering.

   All chips start active (everything visible). Deselecting a chip
   removes those items from the catalog. Deselecting all chips of a
   filter means nothing matches that filter. The marker filter applies
   to both Routes (routes serving marked stations) and Stations tabs.
-->
<script lang="ts">
  import { goto, replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import { untrack } from 'svelte';
  import { Heart } from 'lucide-svelte';
  import {
    Card, CardContent, Chip, Collapsible, FavoriteRouteRow, FavoriteStationRow,
    FavoritesCard, SelectFeedCard, Spinner, Stack, Tabs, TripStopList, Typography,
    TypeBadge, tagIcon, hasTagIcon,
  } from '$lib/ui';
  import { getGtfsRepo } from '$lib/data/gtfs/repo';
  import type { ScheduleTripStop, StopWithDistance } from '$lib/data/gtfs/types';
  import type { Network, Route, RouteTag, VehicleType } from '$lib/domain/types';
  import { vehicleTypeLabel } from '$lib/domain/types';
  import type { StationMarker } from '$lib/stores/favoritesStore.svelte';
  import { STATIONS_PAGE_SIZE } from '$lib/ui/favoritesListConstants';
  import {
    parseFavoritesTab,
    sortRoutesForPicker,
    sortStationsAlphabetically,
    sortStationsForPicker,
    type FavoritesTab,
  } from '$lib/domain/favoritesListLayout';
  import { scheduleWindowFor } from '$lib/domain/pipeline/timeUtils';
  import { feedsStore } from '$lib/stores/feedsStore.svelte';
  import { favoritesStore, STATION_MARKERS, STATION_MARKER_ICONS } from '$lib/stores/favoritesStore.svelte';
  import { locationStore } from '$lib/stores/gps/locationStore.svelte';
  import { nowTicker } from '$lib/stores/nowTicker.svelte';
  import { userPrefs } from '$lib/stores/userPrefs.svelte';

  // ------ Tab state + URL deep-link ---------------------------------------------------------------------------------------------------------

  let activeTab = $state<FavoritesTab>(initialTab());

  function initialTab(): FavoritesTab {
    return parseFavoritesTab(page.url.searchParams.get('tab')) ?? 'routes';
  }

  // No URL -> state sync effect. setTab is the only writer of
  // activeTab after mount; initialTab() seeds it from the URL on
  // mount; browser back/forward triggers a re-mount of the page
  // component, which re-calls initialTab(). Earlier we had a
  // `fromUrl !== activeTab` sync effect, but it raced with
  // replaceState: SvelteKit's replaceState updates the browser
  // history and `page.state` but not `page.url` synchronously,
  // so on the same tick the effect saw the old URL and clobbered
  // activeTab back to it -- which is why a click on the Routes
  // tab was silently ignored.

  function setTab(next: FavoritesTab) {
    if (next === activeTab) return;
    const y = window.scrollY;
    stashScroll(activeTab);
    activeTab = next;
    const url = new URL(page.url);
    if (next === 'routes') url.searchParams.delete('tab');
    else url.searchParams.set('tab', next);
    // Use SvelteKit's replaceState (not the raw history API and
    // not goto) so the page store stays in sync without triggering
    // a full navigation. With both tabs always mounted (visibility:
    // hidden on the inactive one), the document height is stable
    // across tab swaps so `window.scrollY` is preserved naturally
    // -- no manual scroll restore is needed (issue #344). `goto`
    // with `noScroll: true` was resetting scrollY to 0 on same-page
    // query changes despite the noScroll option, and the raw
    // `window.history.replaceState` triggers a SvelteKit dev-mode
    // warning that it conflicts with the router.
    replaceState(url, {});
    // The browser's "scroll focused element into view" behavior
    // fires on the click that activated the tab trigger (the
    // tab is at the top of the page, the user is mid-list, so
    // the browser scrolls to y=0). One rAF is enough to restore:
    // the document height is stable across the swap (visibility-
    // based mounting), so there's no second paint commit to
    // invalidate the restore.
    requestAnimationFrame(() => window.scrollTo({ top: y, behavior: 'auto' }));
  }

  // ------ Scroll preservation per tab ---------------------------------------------------------------------------------------------------

  // Scroll preservation across tab swaps. Both tabs are always
  // mounted in the catalog area (the inactive one is
  // `visibility: hidden`); the document height is the max of both
  // tabs' content. Because the height doesn't change on tab swap,
  // the user's `window.scrollY` is preserved naturally -- no
  // `scrollByTab` map, no rAF restore loop, no race with a second
  // paint commit invalidating the restored y. Filtering (which can
  // shrink the visible tab's height) doesn't change the document
  // height either, because the OTHER tab's content is still in
  // the layout and still contributing.
  const scrollByTab = new Map<FavoritesTab, number>();
  function stashScroll(tab: FavoritesTab) {
    if (typeof window === 'undefined') return;
    scrollByTab.set(tab, window.scrollY);
  }

  // ------ Shared filter state (visible on both tabs) ------------------------------------------------------

  let allRoutes = $state<Route[] | null>(null);
  let allNetworks = $state<Network[]>([]);
  let allTags = $state<RouteTag[]>([]);
  let error = $state<string | null>(null);
  // Single-select-with-deselect filter rows. Each filter type
  // (marker, mode, network, tag) holds at most one active chip;
  // `null` means no chip is selected and the filter is inactive
  // (catalog shows everything). Tapping the active chip again
  // deselects it. All chips render at full color regardless of
  // active state -- the white ring is the only visual cue, so the
  // available filter set stays readable when nothing is selected.
  let activeMarkerFilter = $state<StationMarker | null>(null);
  let typeFilter = $state<VehicleType | null>(null);
  let networkFilter = $state<string | null>(null);
  let tagFilter = $state<string | null>(null);

  function toggleMarkerFilter(m: StationMarker) {
    activeMarkerFilter = activeMarkerFilter === m ? null : m;
  }

  function toggleType(t: VehicleType) {
    typeFilter = typeFilter === t ? null : t;
  }

  function toggleNetwork(id: string) {
    networkFilter = networkFilter === id ? null : id;
  }

  function toggleTag(id: string) {
    tagFilter = tagFilter === id ? null : id;
  }

  const tz = $derived(feedsStore.activeTimezone);

  // ------ Routes tab state ------------------------------------------------------------------------------------------------------------------------------------

  let activeRouteIds = $state<Set<string>>(new Set());
  let expandedRouteId = $state<string | null>(null);
  let routeStops = $state<Map<string, ScheduleTripStop[]>>(new Map());
  let loadingRouteId = $state<string | null>(null);
  let stopsErrorRouteId = $state<string | null>(null);

  async function toggleRouteStops(route: Route) {
    if (route.hasSchedule === false) return;
    if (expandedRouteId === route.id) {
      expandedRouteId = null;
      return;
    }
    expandedRouteId = route.id;
    stopsErrorRouteId = null;
    if (routeStops.has(route.id)) return;
    loadingRouteId = route.id;
    try {
      const repo = getGtfsRepo();
      const qp = scheduleWindowFor({
        view: 'today',
        isNight: false,
        nowMs: nowTicker.ms,
        timeZone: tz,
      });
      let trips = await repo.getRouteSchedule(route.id, 0, qp.localDate, qp.fromMin, qp.windowMin);
      if (trips.length === 0) {
        trips = await repo.getRouteSchedule(route.id, 1, qp.localDate, qp.fromMin, qp.windowMin);
      }
      if (trips.length === 0) {
        trips = await repo.getRouteSchedule(route.id, 0, qp.localDate, 0, 24 * 60);
      }
      const tripId = trips[0]?.tripId;
      if (!tripId) {
        stopsErrorRouteId = route.id;
        return;
      }
      const stops = await repo.getStopsAlongTrip(tripId);
      const next = new Map(routeStops);
      next.set(route.id, stops);
      routeStops = next;
    } catch {
      stopsErrorRouteId = route.id;
    } finally {
      loadingRouteId = null;
    }
  }

  // ------ Stations tab state ------------------------------------------------------------------------------------------------------------------------------

  let favoriteStations = $state<StopWithDistance[]>([]);
  let favoriteStationsError = $state<string | null>(null);

  // Routes that serve at least one station carrying a marker in the
  // active marker filter. `null` = no marker filter (filter unused,
  // all routes pass). An empty Set means the filter is set but no
  // routes qualify (filter excludes everything).
  let routeIdsForMarker = $state<Set<string> | null>(null);

  // Stop IDs the catalog's "All other routes" rows serve, used to
  // render marker badges on each row. Batched in one worker round-trip
  // for the visible catalog routes, kept separate from FavoritesCard's
  // own routeStopIds (which covers the favorited subset).
  let catalogRouteStopIds = $state<Record<string, string[]>>({});

  let stationsScope = $state<Record<string, Route[]>>({});
  let stationsScopeError = $state<string | null>(null);

  let otherStationsPage = $state<StopWithDistance[]>([]);
  let otherStationsTotal = $state<number>(0);
  let otherStationsLoading = $state<boolean>(false);
  let otherStationsError = $state<string | null>(null);

  // Marker-type filter for the Routes and Stations tabs. All markers
  // start selected (everything visible). Deselecting a marker hides
  // routes/stations with that marker. Deselecting all = empty catalog.
  // Client-side only - the marker map is small.

  // Route filter cascade marker pass: when no marker is selected the
  // filter is dormant (null = no constraint). When exactly one
  // marker is selected, fetch the routes serving those marker-
  // bearing stops and intersect.
  $effect(() => {
    // No marker selected = no filter applied.
    if (activeMarkerFilter === null) {
      routeIdsForMarker = null;
      return;
    }
    const stopIds = Array.from(favoritesStore.markers.entries())
      .filter(([, m]) => m === activeMarkerFilter)
      .map(([id]) => id);
    if (stopIds.length === 0) {
      routeIdsForMarker = new Set();
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const repo = getGtfsRepo();
        const stopRoutes = await repo.getRoutesForStops(stopIds);
        if (cancelled) return;
        const ids = new Set<string>();
        for (const list of Object.values(stopRoutes)) {
          for (const r of list) ids.add(r.id);
        }
        routeIdsForMarker = ids;
      } catch {
        // Marker fetch failure: leave the previous (or null) state in place.
      }
    })();
    return () => { cancelled = true; };
  });

  const stationAnchor = $derived.by(() => {
    if (locationStore.position) {
      // Plain object literal -- already cloneable through postMessage.
      return {
        lat: locationStore.position.coords.latitude,
        lon: locationStore.position.coords.longitude,
      };
    }
    const feed = feedsStore.byId(feedsStore.boundFeedId);
    if (!feed) return null;
    // Manual copy from the proxied Feed.center -- Svelte 5's $state
    // proxies are not always structured-cloneable, and feeding a
    // proxied anchor into the worker was throwing "The object can
    // not be cloned" on the stations tab pagination call.
    return { lat: feed.center.lat, lon: feed.center.lon };
  });

  // ------ Effects: initial loads ------------------------------------------------------------------------------------------------------------------

  $effect(() => {
    const fid = feedsStore.boundFeedId;
    if (!fid) return;
    (async () => {
      try {
        const repo = getGtfsRepo();
        const [routes, networks, tags] = await Promise.all([
          repo.getRoutes(),
          repo.getNetworks(),
          repo.getRouteTags(),
        ]);
        allRoutes = routes;
        allNetworks = networks;
        allTags = tags;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    })();
  });

  // Stations with any marker (favorite / home / work / cityCenter).
  // Routes-per-station is loaded by FavoritesCard itself -- no need to
  // duplicate that worker call here.
  $effect(() => {
    const fid = feedsStore.boundFeedId;
    void fid;
    if (!fid) return;
    const ids = Array.from(favoritesStore.markers.keys());
    if (ids.length === 0) {
      favoriteStations = [];
      return;
    }
    (async () => {
      try {
        const repo = getGtfsRepo();
        const resolved = await repo.getStopsByIds(ids);
        favoriteStations = sortStationsAlphabetically(resolved);
        favoriteStationsError = null;
      } catch (e) {
        favoriteStationsError = e instanceof Error ? e.message : String(e);
      }
    })();
  });

  // Filter-cascade scope for the Stations tab. Recomputed when
  // mode, network, or tag filter changes. Each filter is single-
  // value or null; `undefined` = no filter.
  $effect(() => {
    const fid = feedsStore.boundFeedId;
    void fid;
    if (!fid) return;
    (async () => {
      try {
        const repo = getGtfsRepo();
        stationsScope = await repo.getRoutesThroughStations({
          modes: typeFilter ?? undefined,
          networks: networkFilter ?? undefined,
          tags: tagFilter ?? undefined,
        });
        stationsScopeError = null;
        // Trigger catalog fetch after stationsScope is populated.
        // The catalog effect tracks stationsScope, but if it ran before
        // this async resolves (boundFeedId changes first), it would read
        // an empty stationsScope and return early. Moving the trigger
        // here ensures the fetch fires with fresh data.
        otherStationsPage = [];
        otherStationsTotal = 0;
        otherStationsError = null;
        await fetchNextStationsPage();
      } catch (e) {
        stationsScopeError = e instanceof Error ? e.message : String(e);
      }
    })();
  });

  // Routes "active right now" set (one worker round-trip).
  // Track a stable `windowKey` derived from the current schedule
  // window rather than nowTicker.ms directly. nowTicker pulses
  // every 15s; the active route set only changes when the schedule
  // window's `fromMin` ticks over (once a minute). Tracking the
  // raw `ms` meant the effect re-ran on every 15s tick and hit
  // the worker four times per window for nothing. The dedup at
  // the bottom of the body still guards against a no-op write
  // (e.g. when the worker returns a Set with identical contents
  // but a fresh reference); the difference is the worker isn't
  // called at all when the window hasn't moved (issue #306
  // follow-up: the visible "refresh" on /favorites was the
  // worker round-trip itself, not the sort).
  const activeWindowKey = $derived.by(() => {
    const fid = feedsStore.boundFeedId;
    if (!fid) return null;
    const qp = scheduleWindowFor({
      view: 'today',
      isNight: false,
      nowMs: nowTicker.ms,
      timeZone: tz,
    });
    return `${qp.localDate}|${qp.fromMin}`;
  });
  $effect(() => {
    const key = activeWindowKey;
    if (!key) return;
    (async () => {
      try {
        const repo = getGtfsRepo();
        const [localDate, fromMin] = key.split('|');
        const ids = await repo.getActiveRouteIdsInWindow(localDate, Number(fromMin), 60);
        const next = new Set(ids);
        // Skip the write when the active set hasn't actually changed.
        // Without this, every nowTicker pulse produces a fresh Set
        // reference (even with identical contents) and re-triggers
        // sortRoutesForPicker, which floats routes to the top of
        // the catalog and shifts the user's view (issue #306,
        // idle-drift on Routes).
        const cur = activeRouteIds;
        if (cur.size === next.size && [...next].every((id) => cur.has(id))) return;
        activeRouteIds = next;
      } catch {
        // Best-effort.
      }
    })();
  });

  // ------ Stations tab: paginated "other stations" ------------------------------------------------------------

  $effect(() => {
    // Touch the inputs so the effect re-runs on cascade or anchor change.
    // The whole body is wrapped in untrack: the writes to
    // otherStationsPage/Total happen here AND the call to
    // fetchNextStationsPage -- that function synchronously reads
    // otherStationsPage.length to decide the next offset, so leaving
    // it inside the tracked run would add otherStationsPage as a dep.
    // When the async work then writes to otherStationsPage the
    // effect re-runs, the untrack resets it to [], and we loop
    // forever fetching page 0.
    const _scope = stationsScope;
    const _anchor = stationAnchor;
    const _fid = feedsStore.boundFeedId;
    void _scope;
    void _anchor;
    void _fid;
    // Skip the very first run of this effect, which fires before
    // /+layout has set the feed. Without this guard, the worker
    // throws "not bound to a feed yet" and the error gets stored
    // in `otherStationsError`, which paints "GTFS worker not bound
    // to a feed yet" inside the catalog card -- the user reads it
    // as "data isn't loading". The next run (after boundFeedId is
    // set) will fire and actually load the data.
    if (!feedsStore.boundFeedId) return;
    untrack(() => {
      otherStationsPage = [];
      otherStationsTotal = 0;
      otherStationsError = null;
      void fetchNextStationsPage();
    });
  });

  // Paginate on a real user scroll, not on a layout reflow. The previous
  // IntersectionObserver fired whenever the sentinel crossed the 1000px
  // rootMargin edge -- including reflows from stationsScope / stationAnchor
  // changes, row-grow on marker-chip population, and viewport resizes --
  // which silently appended pages and shifted the user's mid-list view
  // (issue #328). A `scroll` event only fires on real input, so the page
  // can no longer grow beneath the user. Reads inside `onScroll` are
  // ordinary closure captures, not $effect-tracked -- the listener is
  // registered once at mount, the handler reads the current state at
  // fire-time.
  $effect(() => {
    if (typeof window === 'undefined') return;
    const onScroll = () => {
      if (otherStationsLoading) return;
      if (otherStationsTotal > 0 && otherStationsPage.length >= otherStationsTotal) return;
      const distanceToBottom =
        document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
      if (distanceToBottom < 200) {
        void fetchNextStationsPage();
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  });
  async function fetchNextStationsPage() {
    if (otherStationsLoading) return;
    if (otherStationsTotal > 0 && otherStationsPage.length >= otherStationsTotal) return;
    otherStationsLoading = true;
    otherStationsError = null;
    const offset = otherStationsPage.length;
    try {
      const repo = getGtfsRepo();
      const scopeArr = Object.keys(stationsScope);
      const result = await repo.getStationsPage({
        offset,
        limit: STATIONS_PAGE_SIZE,
        sortBy: 'distance',
        anchor: stationAnchor ?? undefined,
        scope: scopeArr.length === 0 ? undefined : scopeArr,
      });
      const seen = new Set(otherStationsPage.map((s) => s.id));
      const filtered = result.rows.filter((s) => !seen.has(s.id));
      otherStationsPage = [...otherStationsPage, ...filtered];
      // Cap `otherStationsTotal` at the current page length when
      // the worker returned no new rows. Otherwise the button stays
      // visible forever (issue follow-up to #328 / #344 -- the
      // worker can report `total > 0` even when the page slice
      // overlaps with what's already in the page; the dedup above
      // strips the overlap and the page never grows, but the
      // unconditional `otherStationsTotal = result.total` keeps
      // the button live). When that happens, treat the catalog
      // as exhausted at the current page length.
      if (filtered.length === 0) {
        otherStationsTotal = otherStationsPage.length;
      } else {
        otherStationsTotal = result.total;
      }
    } catch (e) {
      otherStationsError = e instanceof Error ? e.message : String(e);
    } finally {
      otherStationsLoading = false;
    }
  }

  // ------ Derived: routes + stations lists ------------------------------------------------------------------------------------

  const presentTypes = $derived.by<VehicleType[]>(() => {
    if (!allRoutes) return [];
    const set = new Set<VehicleType>();
    for (const r of allRoutes) set.add(r.type ?? 'unknown');
    return Array.from(set).sort((a, b) =>
      vehicleTypeLabel(a).localeCompare(vehicleTypeLabel(b)),
    );
  });
  const colorByType = $derived.by<Map<VehicleType, string>>(() => {
    const m = new Map<VehicleType, string>();
    if (!allRoutes) return m;
    for (const r of allRoutes) {
      const t = r.type ?? 'unknown';
      if (!m.has(t)) m.set(t, r.color);
    }
    return m;
  });

  const filteredRoutes = $derived.by<Route[]>(() => {
    if (!allRoutes) return [];
    return allRoutes.filter((r) => {
      if (typeFilter !== null && r.type !== typeFilter) return false;
      if (networkFilter !== null && !(r.networks?.includes(networkFilter) ?? false)) return false;
      if (tagFilter !== null && !(r.tags?.includes(tagFilter) ?? false)) return false;
      // Marker filter: route qualifies iff it serves at least one
      // station carrying the active marker. Routes with no overlap
      // are excluded. Skipped entirely when no filter is active
      // (routeIdsForMarker stays null).
      if (routeIdsForMarker !== null && !routeIdsForMarker.has(r.id)) return false;
      return true;
    });
  });

  // Favorited routes bypass the filter cascade.
  const favRoutes = $derived.by<Route[]>(() => {
    if (!allRoutes) return [];
    const set = new Set(favoritesStore.routeIds);
    return sortRoutesForPicker(allRoutes.filter((r) => set.has(r.id)), activeRouteIds);
  });
  // All routes passing the filter cascade (including routes whose
  // schedule is empty - the Tranzy fallback for routes with no CSV
  // coverage ships trips with empty arrival_time, which surfaces
  // here as `hasSchedule === false`). The filter is single-value
  // per row (mode/network/tag/marker), so a route qualifies iff it
  // matches the active filter for that row OR no filter is set.
  // No visual sub-grouping by hasSchedule: a route the user
  // filtered for should be visible, even if it has no schedule to
  // show. Favorited routes also appear here AND in the pinned
  // FavoritesCard above.
  const catalogRoutes = $derived.by<Route[]>(() => {
    return sortRoutesForPicker(filteredRoutes, activeRouteIds);
  });

  // Catalog row ids - one fetch covers the full filtered set.
  const catalogRouteIds = $derived(catalogRoutes.map((r) => r.id));

  // Per-route stop lists for the catalog rows' marker badges.
  // Batched in one worker call. Tracked on catalogRouteIds so the
  // badges follow the same filter cascade + cap as the rows.
  $effect(() => {
    if (catalogRouteIds.length === 0) {
      catalogRouteStopIds = {};
      return;
    }
    const ids = catalogRouteIds;
    const currentIds = new Set(ids);
    let cancelled = false;
    (async () => {
      try {
        const repo = getGtfsRepo();
        const result = await repo.getStopsForRoutes(ids);
        if (cancelled) return;
        if (catalogRouteIds.some((id) => !currentIds.has(id))) return;
        catalogRouteStopIds = result;
      } catch {
        // Marker badges are decorative; an empty map keeps the row renderable.
      }
    })();
    return () => { cancelled = true; };
  });

  // Favorited stations, already alphabetical from the source effect
  // (sortStationsAlphabetically). Marker type does not influence
  // order - home / work / cityCenter / favorite stations interleave
  // alphabetically, same as on the home FavoritesCard.
  const favStationsSorted = $derived<StopWithDistance[]>(favoriteStations);

  // "All stations": stations that AREN'T in the favorites card above.
  // When a marker is selected, only stations carrying that marker
  // show; otherwise the full catalog renders.
  const otherStationsSorted = $derived.by<StopWithDistance[]>(() => {
    let list = otherStationsPage;
    if (activeMarkerFilter !== null) {
      list = list.filter((s) => favoritesStore.markerFor(s.id) === activeMarkerFilter);
    }
    return sortStationsForPicker(list, stationAnchor);
  });

  const stationsScopeCount = $derived(Object.keys(stationsScope).length);
  const filtersActive = $derived(
    typeFilter !== null
    || networkFilter !== null
    || tagFilter !== null
    || activeMarkerFilter !== null
  );
  const otherStationsHasMore = $derived(
    otherStationsTotal === 0 || otherStationsPage.length < otherStationsTotal,
  );

  // Marker labels for the filter chips. "All" clears the filter.
  const MARKER_LABELS: Record<StationMarker, string> = {
    favorite: 'Favorite',
    home: 'Home',
    work: 'Work',
    cityCenter: 'City center',
  };
  // Marker filter chip colors. All markers use amber (--color-favorite)
  // for consistency. Foregrounds are the theme's matching `-fg` tokens
  // so the contrast follows light/dark mode.
  const MARKER_COLORS: Record<StationMarker, { bg: string; fg: string }> = {
    favorite: { bg: 'var(--color-favorite)', fg: 'var(--color-favorite-fg, #fff)' },
    home: { bg: 'var(--color-favorite)', fg: 'var(--color-favorite-fg, #fff)' },
    work: { bg: 'var(--color-favorite)', fg: 'var(--color-favorite-fg, #fff)' },
    cityCenter: { bg: 'var(--color-favorite)', fg: 'var(--color-favorite-fg, #fff)' },
  };

  // Per-stop marker map for the expanded route view.
  const routeStopMarkers = $derived.by<ReadonlyMap<string, StationMarker>>(() => {
    const m = new Map<string, StationMarker>();
    for (const stop of routeStops.values()) {
      for (const s of stop) {
        const marker = favoritesStore.markerFor(s.stopId);
        if (marker !== undefined && !m.has(s.stopId)) m.set(s.stopId, marker);
      }
    }
    return m;
  });

  function selectStation(id: string) {
    goto(`/station/${id}`);
  }


</script>

<!-- expandableRouteRow: route row + stops-list Collapsible. Routes
     with no schedule have no representative trip, so the card is
     non-expandable. The expanded stop list picks up the markers map
     so each stop shows its badge when set. -->
{#snippet expandableRouteRow({ route, markerStopIds }: { route: Route; markerStopIds: readonly string[] })}
  {@const expandable = route.hasSchedule !== false}
  {@const expanded = expandedRouteId === route.id}
  {@const stops = routeStops.get(route.id)}
  {@const loading = loadingRouteId === route.id}
  {@const failed = stopsErrorRouteId === route.id && expanded && !loading}
  <div>
    <FavoriteRouteRow
      {route}
      isFav={favoritesStore.hasRoute(route.id)}
      onToggleFavorite={() => favoritesStore.toggleRoute(route.id)}
      onbodyclick={() => toggleRouteStops(route)}
      {markerStopIds}
    />
    {#if expandable}
      <Collapsible in={expanded} reduced>
        <div class="px-1 pt-1">
          {#if loading}
            <Stack direction="row" spacing={1} align="center" class="px-2 py-1">
              <Spinner size={14} />
              <Typography variant="caption">Loading stops...</Typography>
            </Stack>
          {:else if failed || (expanded && stops != null && stops.length === 0)}
            <Typography variant="caption" class="px-2 py-1 text-[color:var(--color-fg-muted)]">
              No stops published for this route today.
            </Typography>
          {:else if stops != null}
            <TripStopList {stops} markers={routeStopMarkers} />
          {/if}
        </div>
      </Collapsible>
    {/if}
  </div>
{/snippet}

<!--
  Short-view wrapper: `flex flex-col min-h-[calc(100svh-3.5rem-3rem)]` pins the
  column to a definite minimum height (viewport minus header strip minus nav)
  and the `flex-1 aria-hidden` spacer at the end fills any leftover space, so
  the visible bottom of the page sits flush with the nav instead of leaving
  a `--color-surface` void between the last card and the fixed BottomNavigation.
  Same pattern as home / station / schedule / map (PR #322).
-->
<div class="mx-auto max-w-3xl w-full px-4 py-6 flex flex-col min-h-[calc(100svh-3.5rem-3rem)]">
  {#if userPrefs.feedId == null}
    <SelectFeedCard fallbackBody="Pick a feed in Settings to star routes here." />
  {:else if error}
    <Card>
      <CardContent>
        <Typography variant="h6" class="text-[color:var(--color-danger)]">Failed to load routes</Typography>
        <Typography variant="caption">{error}</Typography>
      </CardContent>
    </Card>
  {:else if allRoutes == null}
    <Card>
      <CardContent>
        <Stack direction="row" spacing={1} align="center">
          <Spinner size={16} />
          <Typography variant="caption">Loading routes...</Typography>
        </Stack>
      </CardContent>
    </Card>
  {:else}
    <Stack spacing={2}>
      <!-- Combined "Your favorites" card. Always visible regardless of
           active tab. Lists favorited routes AND marked stations, with
           their marker badges. The routeRow snippet wraps each row in
           expandableRouteRow so a tap on the row expands to show the
           station list (TripStopList) -- same as the catalog rows below.

           Invariant: this card is the user's pinned surface and is
           NEVER affected by the filter cascade. `favRoutes` and
           `favStationsSorted` read from the unfiltered allRoutes /
           favoritesStore, so a mode / network / marker filter
           applied below cannot hide or trim a pinned item. If you
           add a new filter, double-check it stays out of this card. -->
      {#if favRoutes.length > 0 || favStationsSorted.length > 0}
        <FavoritesCard
          routes={favRoutes}
          stations={favStationsSorted}
          headerStyle="standalone"
          onChangeStationMarker={(stopId: string, next) => favoritesStore.setMarker(stopId, next)}
        >
          {#snippet routeRow(args: { route: Route; markerStopIds: readonly string[] })}
            {@render expandableRouteRow(args)}
          {/snippet}
        </FavoritesCard>
      {/if}

      <!-- Filter card: marker + mode + network + tag filters, shared
           across both tabs. All cascade to the catalog below. -->
      {#if favoritesStore.markers.size > 0 || presentTypes.length > 1 || allNetworks.length > 0 || allTags.length > 0}
        <Card>
          <CardContent>
            <!--
              Filter rows, no titles or captions -- the chip labels
              (All/Favorite/Home/Work/City center, Bus/Tram/...,
              network name) are self-evident. Hairlines separate the
              rows. See #257.

              Order: marker filter first, then mode (Bus/Tram/...),
              then network (1:1 school/normal), then tag (1:many
              night/metroline/...). Applied to both Routes and
              Stations tabs.
            -->
            <Stack spacing={1.5}>
              {#if favoritesStore.markers.size > 0}
                <Stack direction="row" spacing={1} align="center" wrap class="pt-2">
                  {#each STATION_MARKERS as m (m)}
                    {@const MarkerIcon = STATION_MARKER_ICONS[m]}
                    <TypeBadge
                      size="small"
                      label={MARKER_LABELS[m]}
                      color={MARKER_COLORS[m].bg}
                      fg={MARKER_COLORS[m].fg}
                      active={activeMarkerFilter === m}
                      onclick={() => toggleMarkerFilter(m)}
                    >
                      {#snippet icon()}
                        <MarkerIcon size={12} strokeWidth={2.25} class="shrink-0" />
                      {/snippet}
                    </TypeBadge>
                  {/each}
                </Stack>
              {/if}

              {#if presentTypes.length > 1}
                <Stack
                  direction="row"
                  spacing={1}
                  align="center"
                  wrap
                  class="pt-2"
                >
                  {#each presentTypes as t (t)}
                    <TypeBadge type={t} color={colorByType.get(t)} active={typeFilter === t} onclick={() => toggleType(t)} />
                  {/each}
                </Stack>
              {/if}

              {#if allNetworks.length > 0}
                <Stack direction="row" spacing={1} align="center" wrap class="pt-2">
                  {#each allNetworks as net (net.id)}
                    <TypeBadge
                      size="small"
                      label={net.name}
                      color={net.color}
                      active={networkFilter === net.id}
                      onclick={() => toggleNetwork(net.id)}
                    />
                  {/each}
                </Stack>
              {/if}

              {#if allTags.length > 0}
                <Stack direction="row" spacing={1} align="center" wrap class="pt-2">
                  {#each allTags as tag (tag.id)}
                    <TypeBadge
                      size="small"
                      label={tag.name}
                      active={tagFilter === tag.id}
                      onclick={() => toggleTag(tag.id)}
                      color={tag.color ? `#${tag.color}` : undefined}
                    >
                      {#snippet icon()}
                        {#if hasTagIcon(tag.icon)}
                          {@const Icon = tagIcon(tag.icon)}
                          <Icon size={12} strokeWidth={2.25} class="shrink-0" />
                        {/if}
                      {/snippet}
                    </TypeBadge>
                  {/each}
                </Stack>
              {/if}
            </Stack>
          </CardContent>
        </Card>
      {/if}

      <!-- Page-width tabs sit BELOW the combined Your favorites card.
           They only control the catalog (All other routes / All other
           stations) below. Tabs + catalog card share a single border
           so the tab reads as the section header of the catalog, not
           a free-floating row. -->
      <div class="rounded-md border border-[color:var(--color-border)] overflow-hidden">
        <Tabs
          value={activeTab}
          items={[
            { value: 'routes', label: 'Routes' },
            { value: 'stations', label: 'Stations' },
          ]}
          onchange={setTab}
          variant="block"
        />

        <!--
          Both tab panels use `display: none` for the inactive one.
          The filter card above is a separate sibling — no stacking
          from hidden content, no gap under the tab strip. (issue #344)
        -->
        <div class="border-t border-[color:var(--color-border)]"></div>

        <div
          style:display={activeTab === 'routes' ? 'block' : 'none'}
          aria-hidden={activeTab !== 'routes' ? 'true' : undefined}
        >
          {#if catalogRoutes.length > 0}
            <Card class="rounded-none border-0 border-t-0 shadow-none">
              <CardContent>
                <Stack spacing={1}>
                  <Stack spacing={0.5}>
                    <Typography variant="h5">
                      All routes
                    </Typography>
                    <Typography variant="caption" class="text-[color:var(--color-fg-muted)]">
                      Routes running in the next hour float to the top.
                    </Typography>
                  </Stack>
                  <Stack spacing={1}>
                    {#each catalogRoutes as route (route.id)}
                      {@render expandableRouteRow({ route, markerStopIds: catalogRouteStopIds[route.id] ?? [] })}
                    {/each}
                  </Stack>
                </Stack>
              </CardContent>
            </Card>
          {/if}
        </div>

        <div
          style:display={activeTab === 'stations' ? 'block' : 'none'}
          aria-hidden={activeTab !== 'stations' ? 'true' : undefined}
        >
          {#if otherStationsPage.length > 0 || otherStationsLoading || otherStationsError}
            <Card class="rounded-none border-0 border-t-0 shadow-none">
              <CardContent>
                <Stack spacing={1}>
                  <Stack spacing={0.5}>
                    <Typography variant="h5">
                      All stations
                    </Typography>
                    <Typography variant="caption" class="text-[color:var(--color-fg-muted)]">
                      {#if otherStationsLoading && otherStationsPage.length === 0}
                        Loading...
                      {:else if otherStationsError}
                        {otherStationsError}
                      {:else if otherStationsTotal > 0}
                        {#if filtersActive}
                          Showing {otherStationsPage.length} of {otherStationsTotal} stations matching the filter.
                        {:else}
                          Showing {otherStationsPage.length} of {otherStationsTotal} stations.
                        {/if}
                        {#if locationStore.position}
                          Nearest first.
                        {/if}
                      {:else}
                        {filtersActive
                          ? 'No stations match the current filter.'
                          : 'No stations in this feed.'}
                      {/if}
                    </Typography>
                  </Stack>
                  <Stack spacing={1}>
                    {#each otherStationsSorted as stop (stop.id)}
                      <FavoriteStationRow
                        stop={stop}
                        onbodyclick={() => selectStation(stop.id)}
                        routes={stationsScope[stop.id]}
                        hasGps={!!locationStore.position && stop.distance != null}
                        variant="card"
                        marker={favoritesStore.markerFor(stop.id) ?? undefined}
                        onChangeMarker={(stopId, next) => favoritesStore.setMarker(stopId, next)}
                        class="mt-1"
                      />
                    {/each}
                  </Stack>

                  {#if otherStationsLoading}
                    <Stack direction="row" spacing={1} align="center" class="py-2">
                      <Spinner size={14} />
                      <Typography variant="caption">Loading more stations...</Typography>
                    </Stack>
                  {:else if otherStationsHasMore}
                    <Stack direction="row" spacing={1} align="center" class="py-2">
                      <button
                        type="button"
                        class="text-xs text-[color:var(--color-fg-muted)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary)] rounded"
                        onclick={() => fetchNextStationsPage()}
                      >
                        Load more
                      </button>
                    </Stack>
                  {:else if otherStationsPage.length > 0}
                    <Typography variant="caption" class="text-[color:var(--color-fg-muted)] py-2">
                      End of stations.
                    </Typography>
                  {/if}
                </Stack>
              </CardContent>
            </Card>
          {/if}
        </div>
      </div>
    </Stack>
  {/if}
  <div class="flex-1" aria-hidden="true"></div>
</div>
