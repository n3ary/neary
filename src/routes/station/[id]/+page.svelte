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
  import { syncTripShapeCache } from '$lib/data/gtfs/tripShapeCache';
  import { getUpcomingStops } from '$lib/data/gtfs/upcomingStops';
  import { assembleLiveBoard, routesFromVehicles } from '$lib/domain/stationBoard';
  import { DEFAULT_CONFIG } from '$lib/domain/config';
  import { tripIdsFromVehicles } from '$lib/domain/tripIdsFromVehicles';
  import type { Vehicle } from '$lib/domain/types';
  import { feedsStore } from '$lib/stores/feedsStore.svelte';
  import { reconciledVehiclesStore } from '$lib/stores/reconciledVehiclesStore.svelte';
  import { favoritesStore } from '$lib/stores/favoritesStore.svelte';
  import { nowTicker } from '$lib/stores/nowTicker.svelte';
  import { refreshBus } from '$lib/stores/refreshBus.svelte';
  import { userPrefs } from '$lib/stores/userPrefs.svelte';

  // Arrivals window owned by DEFAULT_CONFIG (shared with the
  // Stations / home view). 18 h from any wall-clock time covers
  // the rest of the GTFS service day.
  const ARRIVALS_WINDOW_MIN = DEFAULT_CONFIG.arrivalsWindowMin;

  const stopId = $derived(Number(page.params.id));
  const stopIdValid = $derived(Number.isFinite(stopId) && stopId > 0);

  let board = $state<{ stop: StopWithDistance; vehicles: Vehicle[] } | null>(null);
  let shapes = $state<Record<string, Array<{ lat: number; lon: number }>>>({});
  let stopDistancesByTrip = $state<Record<string, number[]>>({});
  let originRouteIds = $state<Set<string>>(new Set());
  let error = $state<string | null>(null);
  let notFound = $state(false);
  let routeFilter = $state<string | null>(null);

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
          // Shapes + stop_distances: diff fetch via shared helper
          // so steady-state polls don't re-marshal the full payload
          // across the worker IPC (~3 s/tick on Cluj before this,
          // Chrome trace 2026-06-30). originRouteIds is independent.
          const visibleTrips = tripIdsFromVehicles(result.vehicles);
          const [next, originIds] = await Promise.all([
            syncTripShapeCache(repo, visibleTrips, { shapes, stopDistances: stopDistancesByTrip }),
            repo.getOriginRoutesAtStop(sid),
          ]);
          shapes = next.shapes;
          stopDistancesByTrip = next.stopDistances;
          originRouteIds = new Set(originIds);
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    })();
  });

  // Top up `shapes` with any live-observation trip_ids that aren't
  // already covered. Reconciler emits kind:'gps-only' orphans for live
  // observations on (route, direction) pairs the schedule scanner
  // returned; fetch shapes for those whose route appears on this
  // station's board so applyGpsEta can project them onto the right
  // polyline.
  $effect(() => {
    if (!board) return;
    const visibleRouteIds = new Set<string>();
    for (const v of board.vehicles) visibleRouteIds.add(v.route.id);
    const orphanTripIds = new Set<string>();
    for (const v of reconciledVehiclesStore.vehicles) {
      if (v.kind !== 'gps-only') continue;
      if (v.tripId == null) continue;
      if (!visibleRouteIds.has(v.route.id)) continue;
      if (v.tripId in shapes) continue;
      orphanTripIds.add(v.tripId);
    }
    if (orphanTripIds.size === 0) return;
    // Pass the union of (already-cached scheduled trips) + (new
    // orphan trips) as "visible" so the helper's prune step leaves
    // the scheduled cache intact while adding the orphans.
    const visibleUnion: string[] = [...Object.keys(shapes), ...orphanTripIds];
    (async () => {
      try {
        const repo = getGtfsRepo();
        const next = await syncTripShapeCache(repo, visibleUnion, { shapes, stopDistances: stopDistancesByTrip });
        shapes = next.shapes;
        stopDistancesByTrip = next.stopDistances;
      } catch {
        // Soft-fail: orphan ETAs fall back to the sibling shape via
        // assembleLiveBoard's shapesByRouteDir, or stay as "Live".
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
      reconciledVehicles: reconciledVehiclesStore.vehicles,
      shapes,
      stopDistancesByTrip,
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
      originRouteIds={originRouteIds}
      getUpcomingStops={getUpcomingStops}
      expanded={true}
      ontoggle={() => {}}
    />
  {/if}
</div>
