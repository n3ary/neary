<!--
  Stations — the default landing route. Until a feed is selected, shows
  an empty state pointing to Settings. With a feed selected, fetches the
  nearest stops (GPS if the user has opted in, else the active feed's
  published center) and renders a StationCard list with the bucketed
  arrivals board for each.

  GPS is strictly opt-in (#110). The browser permission dialog is never
  triggered without an explicit user gesture — the in-page banner below
  is one entry point, the header GPS dot is the other. Returning users
  who opted in previously have the watch auto-resumed by +layout.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { AlertTriangle, MapPin } from 'lucide-svelte';
  import {
    Box, Button, Card, CardContent, InfoCard, NoFeedState, Spinner, Stack, StationCard,
    Typography,
  } from '$lib/ui';
  import { getGtfsRepo } from '$lib/data/gtfs/repo';
  import { getUpcomingStops } from '$lib/data/gtfs/upcomingStops';
  import { createStationBoardsController } from '$lib/data/stationBoardsController.svelte';
  import type { StationBoardInput } from '$lib/data/stationBoardsController.svelte';
  import { selectBoardsForView } from '$lib/domain/stationSelection';
  import { DEFAULT_CONFIG } from '$lib/domain/config';
  import { isPositionInFeedBbox, distanceToFeedBboxKm, findNearestFeed } from '$lib/domain/feedCoverage';
  import { feedsStore } from '$lib/stores/feedsStore.svelte';
  import { locationStore } from '$lib/stores/locationStore.svelte';
  import { favoritesStore } from '$lib/stores/favoritesStore.svelte';
  import { refreshBus } from '$lib/stores/refreshBus.svelte';
  import { statusBus } from '$lib/stores/statusBus.svelte';
  import { userPrefs } from '$lib/stores/userPrefs.svelte';

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

  // GPS state, four-way:
  //   not-opted-in — user has never tapped Enable; banner drives opt-in.
  //   pending      — opted in, watch active, no first fix yet.
  //   available    — we have a position.
  //   unavailable  — geolocation unsupported, or permission denied / errored.
  type GpsState = 'not-opted-in' | 'pending' | 'available' | 'unavailable';
  const gpsState = $derived.by<GpsState>(() => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return 'unavailable';
    if (locationStore.position) return 'available';
    if (locationStore.permission === 'denied') return 'unavailable';
    if (locationStore.error && !locationStore.position) return 'unavailable';
    if (!userPrefs.gpsOptedIn) return 'not-opted-in';
    return 'pending';
  });

  // Active feed — used for the bbox-distance hint in the empty state
  // (rendered only when GPS is available and the user is outside it).
  const activeFeed = $derived(feedsStore.byId(feedsStore.boundFeedId));

  // Round to 4 decimals so GPS jitter doesn't refire the SQLite query.
  // No GPS means no boards — see the gpsState gate in the boards effect.
  const queryLat = $derived(
    locationStore.position
      ? Math.round(locationStore.position.coords.latitude * 1e4) / 1e4
      : null,
  );
  const queryLon = $derived(
    locationStore.position
      ? Math.round(locationStore.position.coords.longitude * 1e4) / 1e4
      : null,
  );

  let boards = $state<StationBoardInput[] | null>(null);
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

  // Shared controller owns shapes cache, the shape-sync $effect, and the
  // per-board assembly. We just hand it the boards we select and the
  // per-stop route filter getter; it exposes `assembled` + totals.
  const boardsController = createStationBoardsController({
    routeFilterFor: (stopId) => routeFilters[stopId] ?? null,
  });
  $effect(() => { boardsController.setBoards(boards); });

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

  $effect(() => {
    // Wait until the worker has actually been bound to the user's chosen
    // feed (set by +layout after repo.setFeed resolves). Without this gate
    // the page can race the bind and briefly flash a 'not bound' error.
    const fid = feedsStore.boundFeedId;
    if (!fid) return;
    // Nearby boards require GPS. Without it the page shows the
    // opt-in / denied card instead — see the markup below. We don't
    // fall back to the feed centroid: distance from a bbox center
    // isn't rider-useful and seeded a confusing 'no stations within
    // 2 km of the fallback location' message.
    if (gpsState !== 'available') return;
    if (queryLat == null || queryLon == null) return;
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
        expandedStopId = selection.expandedStopId;
      } catch (e) {
        boardsError = e instanceof Error ? e.message : String(e);
      }
    })();
  });

  // Single source of truth for the GPS-required card: when the user
  // hasn't enabled location (either never opted in, or permission is
  // denied / unsupported), the page can't show nearby stations. We
  // render one card in the boards area explaining that, with an
  // Enable button when opt-in is still possible.
  const needsLocation = $derived(gpsState === 'not-opted-in' || gpsState === 'unavailable');
  const denied = $derived(
    gpsState === 'unavailable' && locationStore.permission === 'denied',
  );

  // For the "wrong feed" empty state: find the closest published feed
  // to the user's position so we can offer to switch. Only meaningful
  // when GPS is available; safe to compute eagerly because feeds list
  // is tiny.
  const userPos = $derived(
    locationStore.position
      ? { lat: locationStore.position.coords.latitude, lon: locationStore.position.coords.longitude }
      : null,
  );
  const nearestFeed = $derived.by(() => {
    if (!userPos || !feedsStore.feeds) return null;
    return findNearestFeed(userPos, feedsStore.feeds);
  });

  function switchFeed(id: string) {
    userPrefs.feedId = id;
  }
</script>

<div class="mx-auto max-w-3xl px-4 py-6">
  {#if userPrefs.feedId == null}
    <NoFeedState
      message="Neary needs a transit feed to load schedules and routes. Pick one in Settings to get started. The data downloads once and is cached for offline use — no account needed."
    />
  {:else if needsLocation}
    <InfoCard variant="primary" title="Location needed">
      {#snippet icon()}<MapPin size={16} />{/snippet}
      {#snippet body()}
        {#if denied}
          Location is off in your browser settings, so we can't suggest stations near you.
          Open your browser's Settings → Site permissions → Location to allow it for this site,
          then tap <strong>Try again</strong>. You can also pick a station from the
          search icon in the header.
        {:else}
          Neary needs your location to suggest stations near you. We never store it, never
          send it to a server, and never track you in the background. You can also pick a
          station from the search icon in the header.
        {/if}
      {/snippet}
      {#snippet actions()}
        <Button variant="contained" size="small" onclick={() => locationStore.enable()}>
          {denied ? 'Try again' : 'Enable location'}
        </Button>
      {/snippet}
    </InfoCard>
  {:else if boardsError}
    <InfoCard variant="danger" title="Failed to load nearby stations">
      {#snippet icon()}<AlertTriangle size={16} />{/snippet}
      {#snippet body()}{boardsError}{/snippet}
    </InfoCard>
  {:else if !boards}
    <Card>
      <CardContent>
        <Stack direction="row" spacing={1} align="center">
          <Spinner size={16} />
          <Typography variant="caption">
            {gpsState === 'pending' ? 'Determining your location…' : 'Loading nearby stations…'}
          </Typography>
        </Stack>
      </CardContent>
    </Card>
  {:else if boards.length === 0}
    {@const outsideBbox = activeFeed && userPos
      ? !isPositionInFeedBbox(userPos, activeFeed)
      : false}
    {@const distanceKm = outsideBbox && activeFeed && userPos
      ? Math.round(distanceToFeedBboxKm(userPos, activeFeed))
      : 0}
    {@const suggestion = outsideBbox && nearestFeed && nearestFeed.feed.id !== activeFeed?.id
      ? nearestFeed
      : null}
    {#if outsideBbox && activeFeed}
      <InfoCard variant="warning" title="Wrong feed for your location">
        {#snippet icon()}<MapPin size={16} />{/snippet}
        {#snippet body()}
          You're about {distanceKm} km from the <strong>{activeFeed.name}</strong> service area.
          {#if suggestion}
            The closest feed we publish is <strong>{suggestion.feed.name}</strong>
            ({suggestion.distanceKm === 0
              ? 'covers your location'
              : `${Math.round(suggestion.distanceKm)} km away`}).
          {:else}
            None of the feeds we publish cover your location.
            Pick one in <a href="/settings" class="underline">Settings</a>.
          {/if}
        {/snippet}
        {#snippet actions()}
          {#if suggestion}
            <Button
              variant="contained"
              size="small"
              onclick={() => switchFeed(suggestion.feed.id)}
            >
              Switch to {suggestion.feed.name}
            </Button>
            <Button variant="text" size="small" onclick={() => goto('/settings')}>
              Open Settings
            </Button>
          {:else}
            <Button variant="contained" size="small" onclick={() => goto('/settings')}>
              Open Settings
            </Button>
          {/if}
        {/snippet}
      </InfoCard>
    {:else}
      <InfoCard title="No nearby stations">
        {#snippet icon()}<MapPin size={16} />{/snippet}
        {#snippet body()}
          No stops within {DEFAULT_CONFIG.favoriteFallbackRadiusM} m of your current position.
          Try moving closer to a transit corridor.
        {/snippet}
      </InfoCard>
    {/if}
  {:else}
    <Stack spacing={1}>
      {#if boardsController.rawTotal > 0 && boardsController.filteredTotal === 0}
        <Box class="px-2 py-1 text-xs text-[color:var(--color-warning)]">
          {boardsController.rawTotal} vehicles found but all hidden by your filters
          (check Settings → Display: drop-off-only, schedule-only,
          departed).
        </Box>
      {/if}
      {#each boardsController.assembled as { stop, vehicles, rows, allRoutes } (stop.id)}
        <StationCard
          station={{ id: stop.id, name: stop.name, distance: stop.distance, lat: stop.lat, lon: stop.lon }}
          rows={rows}
          allRoutes={allRoutes}
          selectedRouteId={routeFilters[stop.id] ?? null}
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
