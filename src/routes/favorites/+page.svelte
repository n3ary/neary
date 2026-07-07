<!-- Single picker view listing every route in the bound feed with a heart toggle per row. Favorited rows float to the top, otherwise sorted by short-name (numeric-first, alpha after). No separate "add" surface — this IS the picker. Stations view also shows hearts on favorited badges as visual reinforcement. -->
<script lang="ts">
  import { goto } from '$app/navigation';
  import {
    Card, CardContent, Chip, Collapsible, FavoritesCard, FavoriteRouteRow,
    FavoriteStationRow, SelectFeedCard, Spinner, Stack,
    TripStopList, Typography, TypeBadge, networkIcon, networkTextColor,
  } from '$lib/ui';
  import { getGtfsRepo } from '$lib/data/gtfs/repo';
  import type { ScheduleTripStop, StopWithDistance } from '$lib/data/gtfs/types';
  import type { Network, Route, VehicleType } from '$lib/domain/types';
  import { compareRouteShortName, vehicleTypeLabel } from '$lib/domain/types';
  import { scheduleWindowFor } from '$lib/domain/pipeline/timeUtils';
  import { feedsStore } from '$lib/stores/feedsStore.svelte';
  import { favoritesStore } from '$lib/stores/favoritesStore.svelte';
  import { nowTicker } from '$lib/stores/nowTicker.svelte';
  import { userPrefs } from '$lib/stores/userPrefs.svelte';

  let allRoutes = $state<Route[] | null>(null);
  let allNetworks = $state<Network[]>([]);
  // Lazy: users with no station favorites skip the worker round-trip.
  let favoriteStations = $state<StopWithDistance[]>([]);
  let stationsError = $state<string | null>(null);
  let error = $state<string | null>(null);
  // null = no filter; clicking the active entry deselects.
  let typeFilter = $state<VehicleType | null>(null);
  let networkFilter = $state<string | null>(null);

  // One row open at a time; stops fetched lazily on first expand and
  // cached so collapse + re-expand is instant.
  let expandedRouteId = $state<string | null>(null);
  let routeStops = $state<Map<string, ScheduleTripStop[]>>(new Map());
  let loadingRouteId = $state<string | null>(null);
  let stopsErrorRouteId = $state<string | null>(null);

  const tz = $derived(feedsStore.activeTimezone);

  function toggleType(t: VehicleType) {
    typeFilter = typeFilter === t ? null : t;
  }
  function toggleNetwork(id: string) {
    networkFilter = networkFilter === id ? null : id;
  }
  function selectStation(id: string) {
    goto(`/station/${id}`);
  }

  // GTFS allows different trips on the same route to serve different
  // stop sequences (rare but spec-valid), so we show the sequence of
  // *some* trip running today, not a canonical shape. Same heuristic
  // the schedule view uses for its first-trip stops panel.
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
      // Prefer direction 0 today; fall back to direction 1 today;
      // then to a full-day window in case the user opened a route
      // whose service ended hours ago.
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

  $effect(() => {
    const fid = feedsStore.boundFeedId;
    if (!fid) return;
    (async () => {
      try {
        const repo = getGtfsRepo();
        [allRoutes, allNetworks] = await Promise.all([
          repo.getRoutes(),
          repo.getNetworks(),
        ]);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    })();
  });

  // Sorted alphabetically so the order is stable across remounts.
  $effect(() => {
    const fid = feedsStore.boundFeedId;
    if (!fid) return;
    const ids = favoritesStore.stationIds;
    if (ids.size === 0) {
      favoriteStations = [];
      return;
    }
    (async () => {
      try {
        const repo = getGtfsRepo();
        const resolved = await repo.getStopsByIds(Array.from(ids));
        favoriteStations = resolved.sort((a, b) => a.name.localeCompare(b.name));
        stationsError = null;
      } catch (e) {
        stationsError = e instanceof Error ? e.message : String(e);
      }
    })();
  });

  // Don't render filter bubbles for modes with zero routes (would
  // just be noise). Ordered by label so the row reads alphabetically.
  const presentTypes = $derived.by<VehicleType[]>(() => {
    if (!allRoutes) return [];
    const set = new Set<VehicleType>();
    for (const r of allRoutes) set.add(r.type ?? 'unknown');
    return Array.from(set).sort((a, b) =>
      vehicleTypeLabel(a).localeCompare(vehicleTypeLabel(b)),
    );
  });

  // Per-type accent: the first route's color straight from GTFS. No
  // overrides -- whatever the feed shipped is what the chip shows.
  // Missing route_color is substituted to a neutral fallback by the
  // data layer; that flows through here.
  const colorByType = $derived.by<Map<VehicleType, string>>(() => {
    const m = new Map<VehicleType, string>();
    if (!allRoutes) return m;
    for (const r of allRoutes) {
      const t = r.type ?? 'unknown';
      if (!m.has(t)) m.set(t, r.color);
    }
    return m;
  });

  function sortRoutes(list: Route[]): Route[] {
    return [...list].sort((a, b) => compareRouteShortName(a.shortName, b.shortName));
  }
  const filteredRoutes = $derived.by<Route[]>(() => {
    if (!allRoutes) return [];
    return allRoutes.filter((r) => {
      if (typeFilter !== null && (r.type ?? 'unknown') !== typeFilter) return false;
      if (networkFilter !== null && !(r.networks?.includes(networkFilter) ?? false)) return false;
      return true;
    });
  });
  const favRoutes = $derived(
    sortRoutes(filteredRoutes.filter((r) => favoritesStore.hasRoute(r.id))),
  );
  const otherRoutes = $derived(
    sortRoutes(filteredRoutes.filter((r) => !favoritesStore.hasRoute(r.id) && r.hasSchedule !== false)),
  );
  const noScheduleRoutes = $derived(
    sortRoutes(filteredRoutes.filter((r) => !favoritesStore.hasRoute(r.id) && r.hasSchedule === false)),
  );


</script>

<!-- expandableRouteRow: route row + stops-list Collapsible. Routes
     with no schedule have no representative trip, so the card is
     non-expandable. -->
{#snippet expandableRouteRow({ route }: { route: Route })}
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
            <TripStopList {stops} />
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
      {#if presentTypes.length > 1 || allNetworks.length > 0}
        <Card>
          <CardContent>
            <Stack spacing={1.5}>
              {#if presentTypes.length > 1}
                <Stack spacing={0.5}>
                  <Typography variant="h5">Filter by mode</Typography>
                  <Typography variant="caption" class="text-[color:var(--color-fg-muted)]">
                    {typeFilter === null
                      ? `Showing all ${allRoutes.length} routes. Tap a mode to narrow down.`
                      : `${filteredRoutes.length} of ${allRoutes.length} routes match.`}
                  </Typography>
                  <Stack direction="row" spacing={1} align="center" wrap>
                    {#each presentTypes as t (t)}
                      <TypeBadge type={t} color={colorByType.get(t)} active={typeFilter === t} onclick={() => toggleType(t)} />
                    {/each}
                  </Stack>
                </Stack>
              {/if}

              {#if allNetworks.length > 0}
                <Stack spacing={0.5}>
                  <Typography variant="h5">Filter by network</Typography>
                  <Typography variant="caption" class="text-[color:var(--color-fg-muted)]">
                    {networkFilter === null
                      ? 'Tap a network to narrow down.'
                      : `Showing ${filteredRoutes.length} route${filteredRoutes.length !== 1 ? 's' : ''} in this network.`}
                  </Typography>
                  <Stack direction="row" spacing={1} align="center" wrap>
                    {#each allNetworks as net (net.id)}
                      {@const Icon = networkIcon(net.id)}
                      {@const active = networkFilter === net.id}
                      <Chip
                        size="small"
                        hex={net.color}
                        fg={networkTextColor(net.color)}
                        onclick={() => toggleNetwork(net.id)}
                        class={active ? '' : 'opacity-50'}
                      >
                        {#snippet icon()}<Icon size={12} />{/snippet}
                        {net.name}
                      </Chip>
                    {/each}
                  </Stack>
                </Stack>
              {/if}
            </Stack>
          </CardContent>
        </Card>
      {/if}

      {#if favRoutes.length > 0 || favoriteStations.length > 0}
        <FavoritesCard
          routes={favRoutes}
          stations={favoriteStations}
          headerStyle="standalone"
          {stationsError}
        >
          {#snippet routeRow(args: { route: Route })}
            {@render expandableRouteRow(args)}
          {/snippet}
        </FavoritesCard>
      {/if}

      {#if otherRoutes.length > 0}
        <Card>
          <CardContent>
            <Stack spacing={1}>
              <Stack spacing={0.5}>
                <Typography variant="h5">
                  {(favRoutes.length > 0 || favoriteStations.length > 0) ? 'All other routes' : 'All routes'}
                </Typography>
                <Typography variant="caption" class="text-[color:var(--color-fg-muted)]">
                  {otherRoutes.length} more to choose from. Tap the heart to favorite.
                </Typography>
              </Stack>
              <Stack spacing={1}>
                {#each otherRoutes as route (route.id)}
                  {@render expandableRouteRow({ route })}
                {/each}
              </Stack>
            </Stack>
          </CardContent>
        </Card>
      {/if}

      {#if noScheduleRoutes.length > 0}
        <Card>
          <CardContent>
            <Stack spacing={1}>
              <Stack spacing={0.5}>
                <Typography variant="h5">All other routes (no schedule available)</Typography>
                <Typography variant="caption" class="text-[color:var(--color-fg-muted)]">
                  {noScheduleRoutes.length} route{noScheduleRoutes.length !== 1 ? 's' : ''} without timetable data. Tap the heart to favorite.
                </Typography>
              </Stack>
              <Stack spacing={1}>
                {#each noScheduleRoutes as route (route.id)}
                  {@render expandableRouteRow({ route })}
                {/each}
              </Stack>
            </Stack>
          </CardContent>
        </Card>
      {/if}
    </Stack>
  {/if}
</div>