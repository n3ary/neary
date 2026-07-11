<!--
  /favorites — pick + manage favorited routes and stations.

  After #234 the page landed a shared FavoritesCard that combined
  routes + stations under one "Your favorites" header. #237 splits
  the two surfaces onto separate tabs (Routes / Stations), cascades
  the mode + network filters to the Stations tab, ranks each surface
  with context-aware ordering, and paginates the station catalog so
  national-scale feeds stay performant.

  #237 added a station-marker model (favorite / home / work /
  cityCenter) — the heart button on each station card is now a
  dropdown picker; the "Your favorites" card sits above the tabs and
  shows both routes and stations, each with their marker badges.

  Tabs are scoped to /favorites — the search overlay and home
  favorites card keep their merged layout. The active tab persists
  via `?tab=routes|stations` so a deep link or reload lands on the
  same surface. Scroll position is preserved per tab (stash on
  leave, restore on re-entry) so a tab swap doesn't yank the user
  to the top of the new tab.

  The "Your favorites" card ALWAYS renders all of the user's
  favorites regardless of the active tab or the filter cascade.
  Filters (mode / network / marker) only narrow the "All other
  routes" / "All other stations" catalog below the tabs — they
  never hide or trim a favorited item from the pinned card. A
  favorited route also never reappears in the "All other routes"
  catalog: the catalog subtracts the favorites set before
  rendering.

  The marker filter (All / Favorite / Home / Work / City center)
  is the first row in the filter card, but only on the Routes tab.
  On the Stations tab the row is hidden: the "All other stations"
  catalog already excludes marked stations (they're in Your
  favorites), so the filter would have nothing to act on. On the
  Routes tab the filter narrows the catalog to routes serving at
  least one marked station of the active type.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { untrack } from 'svelte';
  import { Heart } from 'lucide-svelte';
  import {
    Card, CardContent, Chip, Collapsible, FavoriteRouteRow, FavoriteStationRow,
    FavoritesCard, SelectFeedCard, Spinner, Stack, Tabs, TripStopList, Typography,
    TypeBadge, networkIcon, networkTextColor,
  } from '$lib/ui';
  import { getGtfsRepo } from '$lib/data/gtfs/repo';
  import type { ScheduleTripStop, StopWithDistance } from '$lib/data/gtfs/types';
  import type { Network, Route, VehicleType } from '$lib/domain/types';
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
  import { favoritesStore, STATION_MARKERS } from '$lib/stores/favoritesStore.svelte';
  import { locationStore } from '$lib/stores/gps/locationStore.svelte';
  import { nowTicker } from '$lib/stores/nowTicker.svelte';
  import { userPrefs } from '$lib/stores/userPrefs.svelte';

  // ── Tab state + URL deep-link ───────────────────────────────────

  let activeTab = $state<FavoritesTab>(initialTab());

  function initialTab(): FavoritesTab {
    return parseFavoritesTab(page.url.searchParams.get('tab')) ?? 'routes';
  }

  $effect(() => {
    const fromUrl = parseFavoritesTab(page.url.searchParams.get('tab'));
    if (fromUrl && fromUrl !== activeTab) {
      activeTab = fromUrl;
    }
  });

  function setTab(next: FavoritesTab) {
    if (next === activeTab) return;
    stashScroll(activeTab);
    activeTab = next;
    const url = new URL(page.url);
    if (next === 'routes') url.searchParams.delete('tab');
    else url.searchParams.set('tab', next);
    void goto(url, { replaceState: true, noScroll: true, keepFocus: true });
    requestAnimationFrame(() => restoreScroll(next));
  }

  // ── Scroll preservation per tab ─────────────────────────────────

  const scrollByTab = new Map<FavoritesTab, number>();
  function stashScroll(tab: FavoritesTab) {
    if (typeof window === 'undefined') return;
    scrollByTab.set(tab, window.scrollY);
  }
  function restoreScroll(tab: FavoritesTab) {
    if (typeof window === 'undefined') return;
    const y = scrollByTab.get(tab) ?? 0;
    window.scrollTo({ top: y, behavior: 'auto' });
  }

  // ── Shared filter state (visible on both tabs) ──────────────────

  let allRoutes = $state<Route[] | null>(null);
  let allNetworks = $state<Network[]>([]);
  let error = $state<string | null>(null);
  let typeFilter = $state<VehicleType | null>(null);
  let networkFilter = $state<string | null>(null);

  function toggleType(t: VehicleType) {
    typeFilter = typeFilter === t ? null : t;
  }
  function toggleNetwork(id: string) {
    networkFilter = networkFilter === id ? null : id;
  }

  const tz = $derived(feedsStore.activeTimezone);

  // ── Routes tab state ────────────────────────────────────────────

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

  // ── Stations tab state ──────────────────────────────────────────

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

  // Marker-type filter for the Routes tab. Multi-select: a route
  // is shown if it serves at least one station carrying a marker in
  // the set. The All chip deselects everything. Client-side only -
  // the marker map is small. State persists across tab switches; on
  // the Stations tab the chips are hidden and the filter is dormant.
  let activeMarkerFilter = $state<ReadonlySet<StationMarker>>(new Set());

  function toggleMarkerFilter(m: StationMarker) {
    const next = new Set(activeMarkerFilter);
    if (next.has(m)) next.delete(m);
    else next.add(m);
    activeMarkerFilter = next;
  }
  function clearMarkerFilter() {
    activeMarkerFilter = new Set();
  }

  // Route filter cascade marker pass: when the marker filter is set,
  // fetch the routes serving each marker-bearing stop and intersect.
  // `null` (no filter) skips the worker round-trip; `Set` (filter set)
  // narrows the route list. Filters by mode + network apply first
  // (in `filteredRoutes`); this marker pass applies on top.
  $effect(() => {
    if (activeMarkerFilter.size === 0) {
      routeIdsForMarker = null;
      return;
    }
    const stopIds = Array.from(favoritesStore.markers.entries())
      .filter(([, m]) => activeMarkerFilter.has(m))
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
        // Network failure: leave the previous (or null) state in place.
      }
    })();
    return () => { cancelled = true; };
  });

  const stationAnchor = $derived.by(() => {
    if (locationStore.position) {
      // Plain object literal — already cloneable through postMessage.
      return {
        lat: locationStore.position.coords.latitude,
        lon: locationStore.position.coords.longitude,
      };
    }
    const feed = feedsStore.byId(feedsStore.boundFeedId);
    if (!feed) return null;
    // Manual copy from the proxied Feed.center — Svelte 5's $state
    // proxies are not always structured-cloneable, and feeding a
    // proxied anchor into the worker was throwing "The object can
    // not be cloned" on the stations tab pagination call.
    return { lat: feed.center.lat, lon: feed.center.lon };
  });

  // ── Effects: initial loads ──────────────────────────────────────

  $effect(() => {
    const fid = feedsStore.boundFeedId;
    if (!fid) return;
    (async () => {
      try {
        const repo = getGtfsRepo();
        const [routes, networks] = await Promise.all([
          repo.getRoutes(),
          repo.getNetworks(),
        ]);
        allRoutes = routes;
        allNetworks = networks;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    })();
  });

  // Stations with any marker (favorite / home / work / cityCenter).
  // Routes-per-station is loaded by FavoritesCard itself — no need to
  // duplicate that worker call here.
  $effect(() => {
    const fid = feedsStore.boundFeedId;
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
  // mode or network filter changes.
  $effect(() => {
    const fid = feedsStore.boundFeedId;
    if (!fid) return;
    const modes = typeFilter === null ? undefined : [typeFilter];
    const networks = networkFilter === null ? undefined : [networkFilter];
    (async () => {
      try {
        const repo = getGtfsRepo();
        stationsScope = await repo.getRoutesThroughStations({ modes, networks });
        stationsScopeError = null;
      } catch (e) {
        stationsScopeError = e instanceof Error ? e.message : String(e);
      }
    })();
  });

  // Routes "active right now" set (one worker round-trip).
  $effect(() => {
    const fid = feedsStore.boundFeedId;
    if (!fid) return;
    const now = nowTicker.ms;
    (async () => {
      try {
        const repo = getGtfsRepo();
        const qp = scheduleWindowFor({
          view: 'today',
          isNight: false,
          nowMs: now,
          timeZone: tz,
        });
        const ids = await repo.getActiveRouteIdsInWindow(qp.localDate, qp.fromMin, 60);
        activeRouteIds = new Set(ids);
      } catch {
        // Best-effort.
      }
    })();
  });

  // ── Stations tab: paginated "other stations" ────────────────────

  $effect(() => {
    // Touch the inputs so the effect re-runs on cascade or anchor change.
    // The whole body is wrapped in untrack: the writes to
    // otherStationsPage/Total happen here AND the call to
    // fetchNextStationsPage — that function synchronously reads
    // otherStationsPage.length to decide the next offset, so leaving
    // it inside the tracked run would add otherStationsPage as a dep.
    // When the async work then writes to otherStationsPage the
    // effect re-runs, the untrack resets it to [], and we loop
    // forever fetching page 0.
    const _scope = stationsScope;
    const _anchor = stationAnchor;
    void _scope;
    void _anchor;
    untrack(() => {
      otherStationsPage = [];
      otherStationsTotal = 0;
      otherStationsError = null;
      void fetchNextStationsPage();
    });
  });

  let sentinelEl = $state<HTMLElement | null>(null);
  $effect(() => {
    if (!sentinelEl) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          if (otherStationsLoading) continue;
          if (otherStationsPage.length >= otherStationsTotal) continue;
          void fetchNextStationsPage();
        }
      },
      { rootMargin: '0px 0px 1000px 0px', threshold: 0 },
    );
    observer.observe(sentinelEl);
    return () => observer.disconnect();
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
      otherStationsTotal = result.total;
    } catch (e) {
      otherStationsError = e instanceof Error ? e.message : String(e);
    } finally {
      otherStationsLoading = false;
    }
  }

  // ── Derived: routes + stations lists ────────────────────────────

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
      if (typeFilter !== null && (r.type ?? 'unknown') !== typeFilter) return false;
      if (networkFilter !== null && !(r.networks?.includes(networkFilter) ?? false)) return false;
      // Marker filter: route qualifies iff it serves at least one
      // station carrying a marker in the active filter set. Routes
      // with no overlap are excluded. Skipped entirely when no
      // filter is active (routeIdsForMarker stays null).
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
  const otherRoutes = $derived.by<Route[]>(() => {
    return sortRoutesForPicker(
      filteredRoutes.filter((r) => !favoritesStore.hasRoute(r.id) && r.hasSchedule !== false),
      activeRouteIds,
    );
  });
  const noScheduleRoutes = $derived.by<Route[]>(() => {
    return sortRoutesForPicker(
      filteredRoutes.filter((r) => !favoritesStore.hasRoute(r.id) && r.hasSchedule === false),
      activeRouteIds,
    );
  });

  // Catalog rows combined - one fetch covers both scheduled + no-schedule.
  const catalogRouteIds = $derived([
    ...otherRoutes.map((r) => r.id),
    ...noScheduleRoutes.map((r) => r.id),
  ]);

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

  // "All other stations": the stations that AREN'T in the favorites
  // card above. Filter cascade (mode + network) trims the page at
  // the worker via stationsScope. Stations with any marker are
  // always excluded - they already appear in the "Your favorites"
  // card, so duplicating them here is noise. The marker filter no
  // longer applies here: its chips live on the Routes tab only, so
  // on this tab the filter is always empty and the old "look up
  // marker match" pass was always a no-op anyway.
  const otherStationsSorted = $derived.by<StopWithDistance[]>(() => {
    const list = otherStationsPage.filter((s) => favoritesStore.markerFor(s.id) === undefined);
    return sortStationsForPicker(list, stationAnchor);
  });

  const stationsScopeCount = $derived(Object.keys(stationsScope).length);
  const filtersActive = $derived(typeFilter !== null || networkFilter !== null);
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
  // Marker filter chip colors. Matches the marker-icon palette used
  // elsewhere (favorite = danger; home / work / cityCenter = primary).
  // Foregrounds are the theme's matching `-fg` tokens so the contrast
  // follows light/dark mode.
  const MARKER_COLORS: Record<StationMarker, { bg: string; fg: string }> = {
    favorite: { bg: 'var(--color-danger)', fg: 'var(--color-danger-fg, #fff)' },
    home: { bg: 'var(--color-primary)', fg: 'var(--color-primary-fg)' },
    work: { bg: 'var(--color-primary)', fg: 'var(--color-primary-fg)' },
    cityCenter: { bg: 'var(--color-primary)', fg: 'var(--color-primary-fg)' },
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

  function changeStationMarker(stopId: string, next: StationMarker | null) {
    if (next === null) {
      if (favoritesStore.markerFor(stopId) === undefined) return;
      favoritesStore.setMarker(stopId, null);
    } else {
      favoritesStore.setMarker(stopId, next);
    }
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
              <Typography variant="caption">Loading stops…</Typography>
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

<div class="mx-auto max-w-3xl px-4 py-6">
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
          <Typography variant="caption">Loading routes…</Typography>
        </Stack>
      </CardContent>
    </Card>
  {:else}
    <Stack spacing={2}>
      <!-- Combined "Your favorites" card. Always visible regardless of
           active tab. Lists favorited routes AND marked stations, with
           their marker badges. The routeRow snippet wraps each row in
           expandableRouteRow so a tap on the row expands to show the
           station list (TripStopList) — same as the catalog rows below.

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
          stationMarkers={favoritesStore.markers}
          onChangeStationMarker={changeStationMarker}
          headerStyle="standalone"
        >
          {#snippet routeRow(args: { route: Route; markerStopIds: readonly string[] })}
            {@render expandableRouteRow(args)}
          {/snippet}
        </FavoritesCard>
      {/if}

      <!-- Filter card: shared across both tabs. Mode + network cascade
           to the Stations tab; on the Routes tab they just narrow the
           catalog shown below. Sits between the favorites card and the
           catalog so the user's pinned items render first, keeping
           catalog controls out of the way until they scroll. -->
      {#if presentTypes.length > 1 || allNetworks.length > 0 || activeTab === 'routes'}
        <Card>
          <CardContent>
            <!--
              Filter rows, no titles or captions -- the chip labels
              (All/Favorite/Home/Work/City center, Bus/Tram/...,
              network name) are self-evident. Hairlines separate the
              rows. See #257.

              Order: marker filter is first when on the Routes tab --
              it's the most specific ("which stations do you care
              about") and narrows the route catalog to routes serving
              those stations. On the Stations tab the marker row is
              hidden because the catalog already excludes marked
              stations (they're in Your favorites), so the filter
              would have nothing to act on.
            -->
            <Stack spacing={1.5}>
              {#if activeTab === 'routes'}
                <Stack direction="row" spacing={1} align="center" wrap>
                  <TypeBadge
                    size="small"
                    label="All"
                    active={activeMarkerFilter.size === 0}
                    onclick={clearMarkerFilter}
                  />
                  {#each STATION_MARKERS as m (m)}
                    <TypeBadge
                      size="small"
                      label={MARKER_LABELS[m]}
                      color={MARKER_COLORS[m].bg}
                      fg={MARKER_COLORS[m].fg}
                      active={activeMarkerFilter.has(m)}
                      onclick={() => toggleMarkerFilter(m)}
                    />
                  {/each}
                </Stack>
              {/if}

              {#if presentTypes.length > 1}
                <Stack
                  direction="row"
                  spacing={1}
                  align="center"
                  wrap
                  class={activeTab === 'routes' ? 'pt-2 border-t border-[color:var(--color-border)]' : ''}
                >
                  {#each presentTypes as t (t)}
                    <TypeBadge type={t} color={colorByType.get(t)} active={typeFilter === t} onclick={() => toggleType(t)} />
                  {/each}
                </Stack>
              {/if}

              {#if allNetworks.length > 0}
                <Stack direction="row" spacing={1} align="center" wrap class="pt-2 border-t border-[color:var(--color-border)]">
                  {#each allNetworks as net (net.id)}
                    {@const active = networkFilter === net.id}
                    <TypeBadge
                      size="small"
                      label={net.name}
                      color={net.color}
                      {active}
                      onclick={() => toggleNetwork(net.id)}
                    />
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

        {#if activeTab === 'routes'}
          <!-- ── Routes tab: All other routes ──────────────────── -->
          {#if otherRoutes.length > 0 || noScheduleRoutes.length > 0}
            <Card class="rounded-none border-0 border-t border-[color:var(--color-border)] shadow-none">
              <CardContent>
                <Stack spacing={1}>
                  <Stack spacing={0.5}>
                    <Typography variant="h5">
                      {favRoutes.length > 0 ? 'All other routes' : 'All routes'}
                    </Typography>
                    <Typography variant="caption" class="text-[color:var(--color-fg-muted)]">
                      Routes running in the next hour float to the top.
                    </Typography>
                  </Stack>
                  <Stack spacing={1}>
                    {#each otherRoutes as route (route.id)}
                      {@render expandableRouteRow({ route, markerStopIds: catalogRouteStopIds[route.id] ?? [] })}
                    {/each}
                    {#each noScheduleRoutes as route (route.id)}
                      {@render expandableRouteRow({ route, markerStopIds: catalogRouteStopIds[route.id] ?? [] })}
                    {/each}
                  </Stack>
                </Stack>
              </CardContent>
            </Card>
          {/if}
        {:else}
          <!-- "All other stations" - paginated catalog. -->
          {#if otherStationsPage.length > 0 || otherStationsLoading || otherStationsError}
            <Card class="rounded-none border-0 border-t border-[color:var(--color-border)] shadow-none">
              <CardContent>
                <Stack spacing={1}>
                  <Stack spacing={0.5}>
                    <Typography variant="h5">
                      {favStationsSorted.length > 0 ? 'All other stations' : 'All stations'}
                    </Typography>
                    <Typography variant="caption" class="text-[color:var(--color-fg-muted)]">
                      {#if otherStationsLoading && otherStationsPage.length === 0}
                        Loading…
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
                        marker={favoritesStore.markerFor(stop.id)}
                        onChangeMarker={(next) => changeStationMarker(stop.id, next)}
                        onbodyclick={() => selectStation(stop.id)}
                        routes={stationsScope[stop.id]}
                        hasGps={!!locationStore.position && stop.distance != null}
                        variant="card"
                        class="mt-1"
                      />
                    {/each}
                  </Stack>

                  <div bind:this={sentinelEl} aria-hidden="true" class="h-1"></div>

                  {#if otherStationsLoading}
                    <Stack direction="row" spacing={1} align="center" class="py-2">
                      <Spinner size={14} />
                      <Typography variant="caption">Loading more stations…</Typography>
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
        {/if}
      </div>
</Stack>
{/if}
</div>
