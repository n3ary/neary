<!--
  Stations — the default landing route. Until a feed is selected, shows
  an empty state pointing to Settings. With a feed selected, fetches the
  nearest stops (GPS or default location) and renders a StationCard list
  with the bucketed arrivals board for each.

  Side effect: starts the location watch on mount so the header's GPS dot
  lights up immediately (any other route doesn't need GPS so the prompt
  doesn't appear until you've at least visited /).
-->
<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { MapPin } from 'lucide-svelte';
  import {
    Box, Card, CardContent, NoFeedState, Spinner, Stack, StationCard, Typography,
  } from '$lib/ui';
  import { getGtfsRepo } from '$lib/data/gtfs/repo';
  import type { StopWithDistance } from '$lib/data/gtfs/types';
  import { getUpcomingStops } from '$lib/data/gtfs/upcomingStops';
  import { assembleLiveBoard, routesFromVehicles } from '$lib/domain/stationBoard';
  import { selectBoardsForView } from '$lib/domain/stationSelection';
  import { DEFAULT_CONFIG } from '$lib/domain/config';
  import { tripIdsFromVehicles } from '$lib/domain/tripIdsFromVehicles';
  import type { Vehicle } from '$lib/domain/types';
  import { feedsStore } from '$lib/stores/feedsStore.svelte';
  import { liveVehiclesStore } from '$lib/stores/liveVehiclesStore.svelte';
  import { locationStore } from '$lib/stores/locationStore.svelte';
  import { favoritesStore } from '$lib/stores/favoritesStore.svelte';
  import { nowTicker } from '$lib/stores/nowTicker.svelte';
  import { refreshBus } from '$lib/stores/refreshBus.svelte';
  import { statusBus } from '$lib/stores/statusBus.svelte';
  import { userPrefs } from '$lib/stores/userPrefs.svelte';

  // Demo fallback location when GPS is unavailable / not yet granted:
  // Piața Mihai Viteazul, central Cluj. Lets the page work in dev /
  // offline / before the location prompt is accepted.
  const FALLBACK_LAT = 46.7712;
  const FALLBACK_LON = 23.6236;
  // Query a single, wide radius that covers BOTH the primary nearby
  // search and the favorite-route fallback. The domain selector then
  // narrows to 1–2 stops per the rules in lib/domain/stationSelection.
  // KISS: one round-trip; the selector handles which to show.
  const SEARCH_RADIUS_M = Math.max(
    DEFAULT_CONFIG.nearbyRadiusM,
    DEFAULT_CONFIG.favoriteFallbackRadiusM,
  );
  const MAX_STATIONS = 25;
  // Arrivals window owned by DEFAULT_CONFIG (shared with the
  // Station-detail view) — 18 h from any wall-clock time covers the
  // rest of the GTFS service day; StationCard caps display rows so
  // overshoot is free.
  const ARRIVALS_WINDOW_MIN = DEFAULT_CONFIG.arrivalsWindowMin;

  onMount(() => locationStore.start());

  // Three-way GPS state: pending (waiting for first fix), available
  // (we have a position), or unavailable (denied / errored / geolocation
  // unsupported). The boards-fetch effect gates on this so we never
  // briefly query the fallback location while GPS is just slow to resolve.
  type GpsState = 'pending' | 'available' | 'unavailable';
  const gpsState = $derived.by<GpsState>(() => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return 'unavailable';
    if (locationStore.position) return 'available';
    if (locationStore.permission === 'denied') return 'unavailable';
    if (locationStore.error && !locationStore.position) return 'unavailable';
    return 'pending';
  });

  // Round to 4 decimals so GPS jitter doesn't refire the SQLite query.
  const queryLat = $derived(
    Math.round((locationStore.position?.coords.latitude ?? FALLBACK_LAT) * 1e4) / 1e4,
  );
  const queryLon = $derived(
    Math.round((locationStore.position?.coords.longitude ?? FALLBACK_LON) * 1e4) / 1e4,
  );

  let boards = $state<{ stop: StopWithDistance; vehicles: Vehicle[] }[] | null>(null);
  let shapes = $state<Record<string, Array<{ lat: number; lon: number }>>>({});
  let boardsError = $state<string | null>(null);
  let expandedStopId = $state<number | null>(null);
  // Per-stop route filter — click a route badge on a StationCard to scope
  // its board to that route; click again to clear. Lives in page state
  // (not in a store) because the spec is: temporary, view-only, cleared
  // on view-swap (this component remounts) or refresh (we reset below).
  let routeFilters = $state<Record<number, string | null>>({});
  function toggleRouteFilter(stopId: number, routeId: string) {
    routeFilters[stopId] = routeFilters[stopId] === routeId ? null : routeId;
  }

// Feed tz + wall clock both live in shared stores (feedsStore /
  // nowTicker) so every consumer pages on a single source. See those
  // files for the rationale.
  const feedTimezone = $derived(feedsStore.activeTimezone);

  // Surface GPS state on the global StatusBar instead of a page-level
  // card — the StatusBar already exists for cross-cutting loading info
  // (per plan §4) and the schedule-bind effect in +layout.svelte uses
  // the same channel. KISS / DRY.
  //
  // `untrack` is required around the bus calls because `push` reads
  // `entries` (findIndex for dedupe), so without it the effect would
  // re-run on every push and loop infinitely — effect_update_depth.
  $effect(() => {
    const pending = gpsState === 'pending';
    untrack(() => {
      if (pending) {
        statusBus.push({
          id: 'gps-pending',
          kind: 'loading',
          message: 'Determining your location…',
        });
      } else {
        statusBus.dismiss('gps-pending');
      }
    });
  });

  // Wall clock for ETA/bucket recompute — single shared ticker, see
  // nowTicker.svelte.ts.
  const nowMs = $derived(nowTicker.ms);

  $effect(() => {
    // Wait until the worker has actually been bound to the user's chosen
    // feed (set by +layout after repo.setFeed resolves). Without this gate
    // the page can race the bind and briefly flash a 'not bound' error.
    const fid = feedsStore.boundFeedId;
    if (!fid) return;
    // Wait for GPS to resolve in one direction or the other so we don't
    // briefly render the fallback list during the pre-fix window.
    if (gpsState === 'pending') return;
    // Subscribe to manual-refresh ticks so the header refresh button
    // re-fires this effect.
    refreshBus.tick;
    const lat = queryLat;
    const lon = queryLon;
    (async () => {
      try {
        const repo = getGtfsRepo();
        const candidates = await repo.getStationBoardsNear(
          lat, lon, SEARCH_RADIUS_M, MAX_STATIONS, Date.now(), ARRIVALS_WINDOW_MIN,
        );
        // The worker already filters out stops with zero scheduled
        // service ever (legacy / terminus-pad entries). Stops whose
        // last bus of the day has departed still flow through here
        // with an empty `vehicles` list — that's a real piece of
        // information ("the stop is here, no service right now"),
        // so the selector + card both handle empty vehicle lists.
        const selection = selectBoardsForView({
          candidates,
          config: DEFAULT_CONFIG,
          favoriteRouteIds: favoritesStore.routeIds,
        });
        boards = selection.boards;
        boardsError = null;
        // Route filters are view-only: reset on every refresh / re-fetch.
        routeFilters = {};
        // Fetch route shapes for every visible scheduled trip. The
        // composer uses them to derive GPS-based ETAs for reconciled
        // rows at intermediate stops. Worker caches by shape_id so
        // re-fetching across renders is O(1). Orphan shapes are
        // topped up by a separate effect below as live observations
        // arrive.
        const tripIds = selection.boards.flatMap((b) => tripIdsFromVehicles(b.vehicles));
        if (tripIds.length > 0) {
          shapes = await repo.getShapesForTrips(tripIds);
        } else {
          shapes = {};
        }
        expandedStopId = selection.expandedStopId;
      } catch (e) {
        boardsError = e instanceof Error ? e.message : String(e);
      }
    })();
  });

  // Top up `shapes` with any live-observation trip_ids that aren't
  // already covered. Reconciler emits kind:'live' orphans for live
  // obs on (route, direction) pairs the schedule scanner returned;
  // applyGpsEta then needs the orphan's polyline (or a sibling's
  // via shapesByRouteDir, but we want the orphan's own first).
  // Filter to live obs whose route appears on a visible board so we
  // don't fetch shapes for the entire city's live fleet.
  $effect(() => {
    if (!boards) return;
    const visibleRouteIds = new Set<string>();
    for (const b of boards) for (const v of b.vehicles) visibleRouteIds.add(v.route.id);
    const missing = Array.from(
      new Set(
        liveVehiclesStore.observations
          .filter((o) => o.tripId && visibleRouteIds.has(o.routeId) && !(o.tripId in shapes))
          .map((o) => o.tripId),
      ),
    );
    if (missing.length === 0) return;
    (async () => {
      try {
        const repo = getGtfsRepo();
        const extra = await repo.getShapesForTrips(missing);
        shapes = { ...shapes, ...extra };
      } catch {
        // Soft-fail: orphan ETAs fall back to the sibling shape via
        // assembleLiveBoard's shapesByRouteDir, or stay as "Live".
      }
    })();
  });
</script>

<div class="mx-auto max-w-3xl px-4 py-6">
  {#if userPrefs.feedId == null}
    <NoFeedState
      message="Neary needs a transit feed to load schedules and routes. Pick one in Settings to get started. The data downloads once and is cached for offline use — no account needed."
    />
  {:else if boardsError}
    <Card>
      <CardContent>
        <Stack spacing={1}>
          <Typography variant="h6" class="text-[color:var(--color-danger)]">Failed to load nearby stations</Typography>
          <Typography variant="caption">{boardsError}</Typography>
        </Stack>
      </CardContent>
    </Card>
  {:else if !boards}
    <Card>
      <CardContent>
        <Stack direction="row" spacing={1} align="center">
          <Spinner size={16} />
          <Typography variant="caption">Loading nearby stations…</Typography>
        </Stack>
      </CardContent>
    </Card>
  {:else if boards.length === 0}
    <Card>
      <CardContent>
        <Stack spacing={1}>
          <Typography variant="h6">No nearby stations</Typography>
          <Typography variant="caption">
            No stops within {DEFAULT_CONFIG.favoriteFallbackRadiusM} m of {gpsState === 'available' ? 'your current position' : 'the fallback location'}.
            Try moving closer to a transit corridor or enabling location.
          </Typography>
        </Stack>
      </CardContent>
    </Card>
  {:else}
    <Stack spacing={1}>
      {#if gpsState === 'unavailable'}
        <Box class="px-2 py-1 text-xs text-[color:var(--color-fg-muted)]">
          <Stack direction="row" spacing={1} align="center">
            <MapPin size={12} />
            <span>No GPS — showing stations near a fallback location ({FALLBACK_LAT}, {FALLBACK_LON}).</span>
          </Stack>
        </Box>
      {/if}
      {@const rawTotal = boards.reduce((n, b) => n + b.vehicles.length, 0)}
      {@const filteredTotal = boards.reduce(
        (n, b) => n + assembleLiveBoard({
          vehicles: b.vehicles,
          stop: b.stop,
          liveObservations: liveVehiclesStore.observations,
          shapes,
          prefs: userPrefs,
          nowMs,
          timezone: feedTimezone,
        }).length,
        0,
      )}
      {#if rawTotal > 0 && filteredTotal === 0}
        <Box class="px-2 py-1 text-xs text-[color:var(--color-warning)]">
          {rawTotal} vehicles found but all hidden by your filters
          (check Settings → Display: drop-off-only, schedule-only,
          departed).
        </Box>
      {/if}
      {#each boards as { stop, vehicles } (stop.id)}
        {@const routeFilter = routeFilters[stop.id] ?? null}
        {@const board = assembleLiveBoard({
          vehicles,
          stop,
          liveObservations: liveVehiclesStore.observations,
          shapes,
          prefs: userPrefs,
          nowMs,
          timezone: feedTimezone,
          routeFilterId: routeFilter,
        })}
        <StationCard
          station={{ id: stop.id, name: stop.name, distance: stop.distance, lat: stop.lat, lon: stop.lon }}
          rows={board}
          allRoutes={routesFromVehicles(vehicles)}
          selectedRouteId={routeFilter}
          onRouteClick={(rid) => toggleRouteFilter(stop.id, rid)}
          favoriteRouteIds={favoritesStore.routeIds}
          getUpcomingStops={getUpcomingStops}
          expanded={expandedStopId === stop.id}
          ontoggle={() => (expandedStopId = expandedStopId === stop.id ? null : stop.id)}
        />
      {/each}
    </Stack>
  {/if}
</div>
