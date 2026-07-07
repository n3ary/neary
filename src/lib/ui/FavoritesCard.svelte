<!--
  FavoritesCard: shared "Your favorites" surface. Snippet overrides
  (`routeRow` / `stationRow`) let /favorites wrap routes in a stops-list
  Collapsible without forcing the same on home.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { goto } from '$app/navigation';
  import { Heart } from 'lucide-svelte';
  import type { Route } from '$lib/domain/types';
  import type { StopWithDistance } from '$lib/data/gtfs/types';
  import { getGtfsRepo } from '$lib/data/gtfs/repo';
  import {
    Button, Card, CardContent, FavoriteRouteRow, FavoriteStationRow,
    Spinner, Stack, Typography,
  } from '$lib/ui';
  import { favoritesStore } from '$lib/stores/favoritesStore.svelte';

  type Props = {
    routes: Route[];
    stations: StopWithDistance[];
    /** Undefined = show everything. When set, truncates with the
     *  View-all footer (only if `viewAllHref` is also set). */
    limit?: number;
    /** Footer only renders when truncated AND `viewAllHref` is set. */
    viewAllHref?: string;
    routesLoading?: boolean;
    /** Wins over loading + content. */
    routesError?: string | null;
    /** Wins over content. */
    stationsError?: string | null;
    /** e.g. wrap with a stops-list Collapsible on /favorites. */
    routeRow?: Snippet<[{ route: Route }]>;
    /** e.g. wrap with a custom row on a different surface. */
    stationRow?: Snippet<[{ stop: StopWithDistance }]>;
    /** 'compact' = Heart icon + h6 (home card-in-card);
     *  'standalone' = plain h5 (/favorites picker). */
    headerStyle?: 'compact' | 'standalone';
  };

  let {
    routes, stations,
    limit,
    viewAllHref,
    routesLoading = false,
    routesError = null,
    stationsError = null,
    routeRow,
    stationRow,
    headerStyle = 'compact',
  }: Props = $props();

  const visibleRoutes = $derived(limit ? routes.slice(0, limit) : routes);
  const visibleStations = $derived(limit ? stations.slice(0, limit) : stations);
  const total = $derived(routes.length + stations.length);
  const shown = $derived(visibleRoutes.length + visibleStations.length);
  const truncated = $derived(!!limit && shown < total);
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
  // Subheaders only when both sections exist -- a single section
  // self-labels, two stacked "Routes" would just repeat.
  const showRoutesHeader = $derived(
    visibleRoutes.length > 0 && visibleStations.length > 0,
  );
  const showStationsHeader = $derived(
    visibleStations.length > 0 && visibleRoutes.length > 0,
  );
</script>

<Card>
  <CardContent>
    <Stack spacing={1}>
      {#if headerStyle === 'compact'}
        <Stack direction="row" spacing={1} align="center">
          <Heart size={16} class="shrink-0 text-[color:var(--color-fg-muted)]" />
          <Typography variant="h6">Your favorites</Typography>
        </Stack>
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
              {@render routeRow({ route })}
            {:else}
              <FavoriteRouteRow
                {route}
                isFav={favoritesStore.hasRoute(route.id)}
                onToggleFavorite={() => favoritesStore.toggleRoute(route.id)}
                variant="card"
                class="mt-1"
              />
            {/if}
          {/each}
        </Stack>
      {/if}

      {#if visibleStations.length > 0}
        {#if stationsError}
          <Typography variant="caption" class="px-2 py-1 text-[color:var(--color-danger)]">
            {stationsError}
          </Typography>
        {/if}
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
                {stop}
                isFav={favoritesStore.hasStation(stop.id)}
                onToggleFavorite={() => favoritesStore.toggleStation(stop.id)}
                onbodyclick={() => goto(`/station/${stop.id}`)}
                routes={stopRoutes[stop.id]}
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