<!--
  Station detail view — by-id entry point. Same render path as the
  Stations landing page (assembleLiveBoard → StationCard) but the stop
  is resolved by URL param instead of GPS + selector. Used today by
  type-the-id, in the future by map tap-to-inspect.

  No GPS dependency, no location store touched. Refresh + live polling
  flow exactly as on /.
-->
<script lang="ts">
  import { page } from '$app/state';
  import {
    Card, CardContent, NoFeedState, Spinner, Stack, StationCard, Typography,
  } from '$lib/ui';
  import { getGtfsRepo } from '$lib/data/gtfs/repo';
  import type { StopWithDistance } from '$lib/data/gtfs/types';
  import { assembleLiveBoard, routesFromVehicles } from '$lib/domain/stationBoard';
  import type { Vehicle } from '$lib/domain/types';
  import { feedsStore } from '$lib/stores/feedsStore.svelte';
  import { liveVehiclesStore } from '$lib/stores/liveVehiclesStore.svelte';
  import { favoritesStore } from '$lib/stores/favoritesStore.svelte';
  import { nowTicker } from '$lib/stores/nowTicker.svelte';
  import { refreshBus } from '$lib/stores/refreshBus.svelte';
  import { userPrefs } from '$lib/stores/userPrefs.svelte';

  const ARRIVALS_WINDOW_MIN = 240;

  const stopId = $derived(Number(page.params.id));
  const stopIdValid = $derived(Number.isFinite(stopId) && stopId > 0);

  let board = $state<{ stop: StopWithDistance; vehicles: Vehicle[] } | null>(null);
  let shapes = $state<Record<string, Array<{ lat: number; lon: number }>>>({});
  let error = $state<string | null>(null);
  let notFound = $state(false);
  let routeFilter = $state<number | null>(null);

  // Feed tz + wall clock both live in shared stores (feedsStore /
  // nowTicker) so every consumer pages on a single source.
  const feedTimezone = $derived(feedsStore.activeTimezone);
  const nowMs = $derived(nowTicker.ms);

  $effect(() => {
    const fid = feedsStore.boundFeedId;
    if (!fid) return;
    if (!stopIdValid) return;
    // Subscribe to manual-refresh ticks (header refresh button).
    refreshBus.tick;
    const sid = stopId;
    (async () => {
      try {
        const repo = getGtfsRepo();
        const result = await repo.getStationBoard(sid, Date.now(), ARRIVALS_WINDOW_MIN);
        if (!result) {
          notFound = true;
          board = null;
        } else {
          notFound = false;
          board = result;
          error = null;
          routeFilter = null; // reset on every refresh
          // Fetch shapes for this stop's trips so the composer can
          // run the GPS-derived ETA predictor.
          const tripIds = result.vehicles
            .map((v) => v.schedule?.tripId)
            .filter((x): x is string => !!x);
          shapes = tripIds.length > 0 ? await repo.getShapesForTrips(tripIds) : {};
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    })();
  });
</script>

<div class="mx-auto max-w-3xl px-4 py-6">
  {#if userPrefs.feedId == null}
    <NoFeedState />
  {:else if !stopIdValid}
    <Card>
      <CardContent>
        <Typography variant="h6" class="text-[color:var(--color-danger)]">Invalid stop id</Typography>
      </CardContent>
    </Card>
  {:else if error}
    <Card>
      <CardContent>
        <Stack spacing={1}>
          <Typography variant="h6" class="text-[color:var(--color-danger)]">Failed to load station</Typography>
          <Typography variant="caption">{error}</Typography>
        </Stack>
      </CardContent>
    </Card>
  {:else if notFound}
    <Card>
      <CardContent>
        <Typography variant="h6">Station #{stopId} not found in the current feed.</Typography>
      </CardContent>
    </Card>
  {:else if !board}
    <Card>
      <CardContent>
        <Stack direction="row" spacing={1} align="center">
          <Spinner size={16} />
          <Typography variant="caption">Loading station…</Typography>
        </Stack>
      </CardContent>
    </Card>
  {:else}
    {@const rows = assembleLiveBoard({
      vehicles: board.vehicles,
      stop: board.stop,
      liveObservations: liveVehiclesStore.observations,
      shapes,
      prefs: userPrefs,
      nowMs,
      timezone: feedTimezone,
      routeFilterId: routeFilter,
    })}
    <StationCard
      station={{ id: board.stop.id, name: board.stop.name, lat: board.stop.lat, lon: board.stop.lon }}
      rows={rows}
      allRoutes={routesFromVehicles(board.vehicles)}
      selectedRouteId={routeFilter}
      onRouteClick={(rid) => (routeFilter = routeFilter === rid ? null : rid)}
      favoriteRouteIds={favoritesStore.routeIds}
      expanded={true}
      ontoggle={() => {}}
    />
  {/if}
</div>
