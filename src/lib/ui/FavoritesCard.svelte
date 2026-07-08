<!--
  FavoritesCard: shared "Your favorites" surface. Snippet overrides
  (`routeRow` / `stationRow`) let /favorites wrap routes in a stops-list
  Collapsible without forcing the same on home.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { goto } from '$app/navigation';
  import type { Route } from '$lib/domain/types';
  import type { StopWithDistance } from '$lib/data/gtfs/types';
  import { favoritesStore, type StationMarker } from '$lib/stores/favoritesStore.svelte';
  import { getGtfsRepo } from '$lib/data/gtfs/repo';
  import {
    Button, Card, CardContent, FavoriteRouteRow, FavoriteStationRow,
    Spinner, Stack, Typography,
  } from '$lib/ui';

  type Props = {
    routes: Route[];
    stations: StopWithDistance[];
    /** Marker assignments keyed by stop id. Omitted ids default to
     *  undefined (unstarred). */
    stationMarkers?: ReadonlyMap<string, StationMarker>;
    /** Mutate a station's marker. `null` clears. */
    onChangeStationMarker?: (stopId: string, next: StationMarker | null) => void;
    /** Max routes to show before truncating with the View-all
     *  footer. Undefined = show all. */
    routeLimit?: number;
    /** Max stations to show before truncating with the View-all
     *  footer. Undefined = show all. */
    stationLimit?: number;
    /** Footer only renders when truncated AND `viewAllHref` is set. */
    viewAllHref?: string;
    routesLoading?: boolean;
    /** Wins over loading + content. */
    routesError?: string | null;
    /** e.g. wrap with a stops-list Collapsible on /favorites. The
     *  snippet receives the route plus its stopIds so it can render
     *  marker badges without re-fetching. */
    routeRow?: Snippet<[{ route: Route; markerStopIds: readonly string[] }]>;
    /** e.g. wrap with a custom row on a different surface. */
    stationRow?: Snippet<[{ stop: StopWithDistance }]>;
    /** 'compact' = Heart icon + h6 (home card-in-card);
     *  'standalone' = plain h5 (/favorites picker). */
    headerStyle?: 'compact' | 'standalone';
  };

  let {
    routes, stations,
    stationMarkers,
    onChangeStationMarker,
    routeLimit,
    stationLimit,
    viewAllHref,
    routesLoading = false,
    routesError = null,
    routeRow,
    stationRow,
    headerStyle = 'compact',
  }: Props = $props();

  const visibleRoutes = $derived(routeLimit != null ? routes.slice(0, routeLimit) : routes);
  const visibleStations = $derived(stationLimit != null ? stations.slice(0, stationLimit) : stations);
  // Stop IDs each visible route serves, batched in one worker call.
  // Used to render marker badges inline on each row (unique markers
  // for the route's marked stations). Empty when there are no routes
  // to look up - matches the existing stopRoutes pattern.
  let routeStopIds = $state<Record<string, string[]>>({});
  const total = $derived(routes.length + stations.length);
  const shown = $derived(visibleRoutes.length + visibleStations.length);
  const truncated = $derived(
    (routeLimit != null && visibleRoutes.length < routes.length) ||
    (stationLimit != null && visibleStations.length < stations.length),
  );
  // One batched worker round-trip so the home limit and /favorites
  // picker view share the same routes-per-station lookup.
  let stopRoutes = $state<Record<string, Route[]>>({});
  $effect(() => {
    if (visibleStations.length === 0) {
      stopRoutes = {};
      return;
    }
    const ids = visibleStations.map((s) => s.id);
    const currentIds = new Set(ids);
    let cancelled = false;
    (async () => {
      try {
        const repo = getGtfsRepo();
        const routes = await repo.getRoutesForStops(ids);
        // Out-of-order guard: skip if the visible set changed mid-flight
        // (e.g. the user just unfavorited a station).
        if (cancelled) return;
        if (visibleStations.some((s) => !currentIds.has(s.id))) return;
        // A chip that opens a dead-end schedule is worse than no chip.
        const filtered: Record<string, Route[]> = {};
        for (const id of Object.keys(routes)) {
          if (!currentIds.has(id)) continue;
          const scheduled = routes[id].filter((r) => r.hasSchedule !== false);
          if (scheduled.length > 0) filtered[id] = scheduled;
        }
        stopRoutes = filtered;
      } catch {
        // Chips are supplementary; an empty map keeps the row renderable.
      }
    })();
    return () => { cancelled = true; };
  });

  // Per-route stop lists for marker badges. One worker round-trip
  // for the visible routes; tracked on `visibleRoutes` so the
  // marker badges follow the same limit + ordering as the rows.
  $effect(() => {
    if (visibleRoutes.length === 0) {
      routeStopIds = {};
      return;
    }
    const ids = visibleRoutes.map((r) => r.id);
    const currentIds = new Set(ids);
    let cancelled = false;
    (async () => {
      try {
        const repo = getGtfsRepo();
        const result = await repo.getStopsForRoutes(ids);
        if (cancelled) return;
        if (visibleRoutes.some((r) => !currentIds.has(r.id))) return;
        routeStopIds = result;
      } catch {
        // Marker badges are decorative; an empty map keeps the row renderable.
      }
    })();
    return () => { cancelled = true; };
  });
  // Subheaders only when both sections exist -- a single section
  // self-labels, two stacked "Routes" would just repeat.
  const showRoutesHeader = $derived(
    visibleRoutes.length > 0 && visibleStations.length > 0,
  );
  const showStationsHeader = $derived(
    visibleStations.length > 0 && visibleRoutes.length > 0,
  );

  function defaultChangeMarker(stopId: string, next: StationMarker | null): void {
    if (next === null) {
      const current = favoritesStore.markerFor(stopId);
      if (current === undefined) return;
      favoritesStore.setMarker(stopId, null);
    } else {
      favoritesStore.setMarker(stopId, next);
    }
  }
</script>

<Card>
  <CardContent>
    <Stack spacing={1}>
      {#if headerStyle === 'compact'}
        <Typography variant="h6">Your favorites</Typography>
      {:else}
        <Typography variant="h5">Your favorites</Typography>
      {/if}

      {#if routesError}
        <Typography variant="caption" class="block pt-1">
          Couldn't load your favorites.
        </Typography>
      {:else if routesLoading}
        <Stack direction="row" spacing={1} align="center" class="pt-3">
          <Spinner size={14} />
          <Typography variant="caption">Loading...</Typography>
        </Stack>
      {/if}

      {#if visibleRoutes.length > 0}
        {#if showRoutesHeader}
          <Typography variant="caption" class="block pt-2 px-1 text-[color:var(--color-fg-muted)]">
            Routes
          </Typography>
        {/if}
        <Stack spacing={1}>
          {#each visibleRoutes as route (route.id)}
            {#if routeRow}
              {@render routeRow({ route, markerStopIds: routeStopIds[route.id] ?? [] })}
            {:else}
              <FavoriteRouteRow
                {route}
                isFav={favoritesStore.hasRoute(route.id)}
                onToggleFavorite={() => favoritesStore.toggleRoute(route.id)}
                markerStopIds={routeStopIds[route.id]}
                variant="card"
                class="mt-1"
              />
            {/if}
          {/each}
        </Stack>
      {/if}

      {#if visibleStations.length > 0}
        {#if showStationsHeader}
          <Typography variant="caption" class="block pt-2 px-1 text-[color:var(--color-fg-muted)]">
            Stations
          </Typography>
        {/if}
        <Stack spacing={1}>
          {#each visibleStations as stop (stop.id)}
            {#if stationRow}
              {@render stationRow({ stop })}
            {:else}
              <FavoriteStationRow
                stop={stop}
                marker={stationMarkers?.get(stop.id)}
                onChangeMarker={(next) => onChangeStationMarker
                  ? onChangeStationMarker(stop.id, next)
                  : defaultChangeMarker(stop.id, next)}
                onbodyclick={() => goto(`/station/${stop.id}`)}
                routes={stopRoutes[stop.id]}
                hasGps={false}
                variant="card"
                class="mt-1"
              />
            {/if}
          {/each}
        </Stack>
      {/if}

      {#if truncated && viewAllHref}
        <Stack direction="row" spacing={1} align="center" class="pt-2 border-t border-[color:var(--color-border)] mt-1">
          <Button variant="text" size="small" onclick={() => goto(viewAllHref)}>
            View all {total} in Favorites
          </Button>
        </Stack>
      {/if}
    </Stack>
  </CardContent>
</Card>