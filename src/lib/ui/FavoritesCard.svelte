<!--
  FavoritesCard - shared "Your favorites" surface used by the home
  page (compact, loading + error states, View-all footer) and the
  /favorites view (standalone, no limit, per-row stops-expansion
  Collapsible). One component so a change to the header, the
  Routes/Stations subheaders, or the View-all CTA propagates to
  every screen that surfaces a user's favorites.

  Caller can override the row markup via the `routeRow` / `stationRow`
  snippets (e.g. /favorites wraps routes in a stops-list
  Collapsible). When not provided, rows render as plain
  variant="card" Favorite{Route,Station}Row entries.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { goto } from '$app/navigation';
  import { Heart } from 'lucide-svelte';
  import type { Route } from '$lib/domain/types';
  import type { StopWithDistance } from '$lib/data/gtfs/types';
  import {
    Button, Card, CardContent, FavoriteRouteRow, FavoriteStationRow,
    Spinner, Stack, Typography,
  } from '$lib/ui';
  import { favoritesStore } from '$lib/stores/favoritesStore.svelte';

  type Props = {
    routes: Route[];
    stations: StopWithDistance[];
    /** Max rows per section before truncating with the View-all
     *  footer. Undefined = show everything. */
    limit?: number;
    /** Where the View-all button links. Footer only renders when
     *  both `viewAllHref` is set and the sections were truncated. */
    viewAllHref?: string;
    /** Show a spinner above the routes section while the route
     *  catalogue is loading. */
    routesLoading?: boolean;
    /** Surface this string above the routes section. Wins over
     *  loading + content. */
    routesError?: string | null;
    /** Surface this string above the stations section. */
    stationsError?: string | null;
    /** Override the per-route-row markup (e.g. to wrap with a
     *  Collapsible stops list). */
    routeRow?: Snippet<[{ route: Route }]>;
    /** Override the per-station-row markup. */
    stationRow?: Snippet<[{ stop: StopWithDistance }]>;
    /** 'compact' shows Heart icon + h6 (home page card-in-card);
     *  'standalone' shows plain h5 (/favorites picker view). */
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
  // Show "Routes" / "Stations" subheaders only when both sections
  // exist - a single section already labels itself by being the only
  // thing on screen, and two stacked "Routes" labels would just repeat
  // themselves.
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
                isFav={favoritesStore.has(route.id)}
                onToggleFavorite={() => favoritesStore.toggle(route.id)}
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