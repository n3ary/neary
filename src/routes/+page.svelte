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
    Box, Button, Card, CardContent, InfoCard, SelectFeedCard, Spinner, Stack, StationCard,
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
  import { searchOverlayStore } from '$lib/stores/searchOverlayStore.svelte';
  import { statusBus } from '$lib/stores/statusBus.svelte';
  import { stationsViewStore } from '$lib/stores/stationsViewStore.svelte';
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

  // Effective expansion - what the cards see:
  //   - if userHasExpandedChoice: their explicit pick (still in boards?)
  //   - else: the selector's auto-pick (closest of current boards)
  // The selector's auto-pick is computed lazily from the boards list
  // (same rule as `selectBoardsForView`: distance-ascending first entry)
  // so the store doesn't need a separate "autoExpandedStopId" field -
  // the boards are themselves the source of truth for the auto-pick.
  const effectiveExpandedStopId = $derived.by(() => {
    if (!boards) return null;
    const stopIds = new Set(boards.map((b) => b.stop.id));
    if (stationsViewStore.userHasExpandedChoice) {
      const picked = stationsViewStore.expandedStopId;
      // Pruned: user's choice is for a stop that's no longer in the
      // boards (they moved out of range). Drop to "no expansion" so the
      // card matches nothing rather than lying about a phantom pick.
      return picked && stopIds.has(picked) ? picked : null;
    }
    // Selector's auto-pick is "closest of the boards in distance order".
    const sorted = [...boards].sort(
      (a, b) => (a.stop.distance ?? Infinity) - (b.stop.distance ?? Infinity),
    );
    return sorted[0]?.stop.id ?? null;
  });

  // Shared controller owns shapes cache, the shape-sync $effect, and the
  // per-board assembly. We just hand it the boards we select and the
  // per-stop route filter getter; it exposes `assembled` + totals.
  const boardsController = createStationBoardsController({
    routeFilterFor: (stopId) =>
      stationsViewStore.routeFilterByStop[stopId] ?? null,
  });
  $effect(() => { boardsController.setBoards(boards); });

  // Surface GPS state on the global StatusBar instead of a page-level
  // card — the StatusBar already exists for cross-cutting loading info
  // and the schedule-bind effect in +layout.svelte uses the same channel.
  // KISS / DRY.
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

  // Tick gate. The header refresh button bumps `refreshBus.tick`; we
  // remember the last tick this effect applied so a GPS-driven re-run
  // (same tick) can hit the hysteresis gate while a manual refresh
  // (new tick) always re-queries - even if the user hasn't moved.
  let lastAppliedRefreshTick = 0;
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
    const tick = refreshBus.tick;
    const lat = queryLat;
    const lon = queryLon;
    // Manual refresh (tick advanced) always re-queries; otherwise we
    // skip the SQLite query unless the user moved >= `significantMoveM`
    // meters since the last successful query. The worker subscription
    // still updates per-vehicle ETAs / positions during the skipped
    // window - only the stop *selection* is frozen, which is the whole
    // point: a 15 s worker push never reflows the cards.
    const isManualRefresh = tick !== lastAppliedRefreshTick;
    if (!stationsViewStore.shouldRefetchByPosition(
      lat, lon, isManualRefresh,
    )) return;
    (async () => {
      try {
        const repo = getGtfsRepo();
        const candidates = await repo.getStationBoardsNear(
          lat, lon, SEARCH_RADIUS_M, MAX_STATIONS, Date.now(), ARRIVALS_WINDOW_MIN,
        );
        // The worker already filters out stops with zero scheduled
        // service ever (legacy / terminus-pad entries). Stops whose
        // last bus of the day has departed still flow through here
        // with an empty `vehicles` list - that's a real piece of
        // information ("the stop is here, no service right now"),
        // so the selector + card both handle empty vehicle lists.
        const selection = selectBoardsForView({
          candidates,
          config: DEFAULT_CONFIG,
          favoriteRouteIds: favoritesStore.routeIds,
        });
        // The store's `shouldRefetchByPosition` returns true either
        // because the rider moved >= significantMoveM, or because this
        // is a manual refresh. The two have different semantics:
        //   - move: they're in a new neighborhood; their previous
        //     expansion + route filter no longer apply.
        //   - manual refresh: they want fresher data, not a reset.
        // The store doesn't see the GPS at gate time, so we pass the
        // "moved" decision in. `lastQueryPosition` is null on the very
        // first run after a tab-swap reset - treat that as "moved" so
        // auto-expand kicks in for a fresh visit.
        const moved =
          stationsViewStore.lastQueryPosition === null ||
          stationsViewStore.shouldRefetchByPosition(lat, lon, false);
        if (moved) {
          stationsViewStore.resetUserChoices();
        }
        boards = selection.boards;
        // Cache the same boards on the store so a remount (e.g. tapping
        // a route badge into /schedule and pressing back) renders the
        // prior frame instead of the spinner.
        stationsViewStore.lastBoards = selection.boards;
        boardsError = null;
        // On the very first ever run, seed the user's expansion to
        // the selector's pick. After this point the effective-expansion
        // derived above takes over: it returns the user's explicit
        // choice (once they make one) or the boards' closest stop.
        // Subtle: if `moved` is true AND the user previously had an
        // expansion in the store, `resetUserChoices` already cleared it
        // - `userHasExpandedChoice` is false - so `effectiveExpandedStopId`
        // resolves to the boards' closest, no extra write needed.
        if (stationsViewStore.lastQueryPosition === null) {
          stationsViewStore.expandedStopId = selection.expandedStopId;
          stationsViewStore.userHasExpandedChoice = false;
        }
        stationsViewStore.recordQueryPosition(lat, lon);
        lastAppliedRefreshTick = tick;
      } catch (e) {
        boardsError = e instanceof Error ? e.message : String(e);
      }
    })();
  });

  // Permission-denied vs other-unavailable need different copy in the
  // location banner, so we expose denied explicitly.
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
  // Pre-emptive "wrong feed for your location" warning: fires whenever
  // the user has selected a feed but their GPS position falls outside
  // its bbox. Surfaces earlier than the empty-boards branch because
  // an outside-bbox query is almost guaranteed to return nothing, and
  // the empty state alone doesn't explain the cause.
  const wrongFeedFor = $derived.by(() => {
    if (!activeFeed || !userPos) return null;
    if (isPositionInFeedBbox(userPos, activeFeed)) return null;
    const distanceKm = Math.round(distanceToFeedBboxKm(userPos, activeFeed));
    const suggestion =
      nearestFeed && nearestFeed.feed.id !== activeFeed.id ? nearestFeed : null;
    return { distanceKm, suggestion };
  });

  function switchFeed(id: string) {
    userPrefs.feedId = id;
  }
</script>

<div class="mx-auto max-w-3xl px-4 py-6">
  <Stack spacing={1}>

    <!-- ── Setup banners ─────────────────────────────────────────────
         Stack what's missing at the top so the user can see all the
         setup work in one glance. Each banner owns its primary
         action; the page below it shows nothing until both feed AND
         GPS are resolved.

         Location goes first so opting in can flip the feed banner
         below into the "Use {coveringFeed}" one-tap state in the same
         render pass. -->

    {#if gpsState === 'not-opted-in'}
      <InfoCard variant="primary" title="Stops near you">
        {#snippet icon()}<MapPin size={16} />{/snippet}
        {#snippet body()}
          Allow location and we'll surface stops near you automatically. Your
          position stays on your device. You can also jump straight to a station
          by name.
        {/snippet}
        {#snippet actions()}
          <Button variant="contained" size="small" onclick={() => locationStore.enable()}>
            Enable location
          </Button>
          {#if userPrefs.feedId != null}
            <Button variant="text" size="small" onclick={() => searchOverlayStore.open()}>
              Search a station
            </Button>
          {/if}
        {/snippet}
      </InfoCard>
    {:else if denied}
      <InfoCard title="No location — search instead">
        {#snippet icon()}<MapPin size={16} />{/snippet}
        {#snippet body()}
          Your browser is blocking location for this site, so we can't suggest
          stops near you. Search for a station by name to keep going. To get
          auto-suggestions later, allow location in your browser's site
          settings, then tap <strong>Try again</strong>.
        {/snippet}
        {#snippet actions()}
          {#if userPrefs.feedId != null}
            <Button variant="contained" size="small" onclick={() => searchOverlayStore.open()}>
              Search a station
            </Button>
          {/if}
          <Button variant="text" size="small" onclick={() => locationStore.enable()}>
            Try again
          </Button>
        {/snippet}
      </InfoCard>
    {:else if gpsState === 'unavailable'}
      <InfoCard title="Location not supported">
        {#snippet icon()}<MapPin size={16} />{/snippet}
        {#snippet body()}
          Your browser doesn't expose a geolocation API. Search for a station by
          name to find what you're looking for.
        {/snippet}
        {#snippet actions()}
          {#if userPrefs.feedId != null}
            <Button variant="contained" size="small" onclick={() => searchOverlayStore.open()}>
              Search a station
            </Button>
          {/if}
        {/snippet}
      </InfoCard>
    {/if}

    {#if userPrefs.feedId == null}
      <SelectFeedCard />
    {/if}

    {#if wrongFeedFor && activeFeed}
      <InfoCard variant="warning" title="Wrong feed for your location">
        {#snippet icon()}<MapPin size={16} />{/snippet}
        {#snippet body()}
          Your selected feed <strong>{activeFeed.name}</strong> is about
          {wrongFeedFor.distanceKm} km away, so nearby stops won't be available.
          {#if wrongFeedFor.suggestion}
            <strong>{wrongFeedFor.suggestion.feed.name}</strong> covers your
            current location — switch with one tap.
          {:else}
            None of the feeds we publish cover your current location.
            You can still browse <strong>{activeFeed.name}</strong>'s routes
            from the other tabs.
          {/if}
        {/snippet}
        {#snippet actions()}
          {#if wrongFeedFor.suggestion}
            {@const suggested = wrongFeedFor.suggestion.feed}
            <Button
              variant="contained"
              size="small"
              onclick={() => switchFeed(suggested.id)}
            >
              Switch to {suggested.name}
            </Button>
            <Button variant="text" size="small" onclick={() => goto('/settings')}>
              Open Settings
            </Button>
          {:else}
            <Button variant="text" size="small" onclick={() => goto('/settings')}>
              Open Settings
            </Button>
          {/if}
        {/snippet}
      </InfoCard>
    {/if}

    <!-- ── Nearby stations ──────────────────────────────────────────
         Only renders once both prerequisites (feed AND GPS) are
         satisfied AND the user is inside the selected feed's bbox.
         Otherwise the banners above carry the page. -->

    {#if userPrefs.feedId != null && gpsState === 'available' && !wrongFeedFor}
      {#if boardsError}
        <InfoCard variant="danger" title="Failed to load nearby stations">
          {#snippet icon()}<AlertTriangle size={16} />{/snippet}
          {#snippet body()}{boardsError}{/snippet}
        </InfoCard>
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
        <InfoCard title="No stops near you">
          {#snippet icon()}<MapPin size={16} />{/snippet}
          {#snippet body()}
            No stops within {DEFAULT_CONFIG.favoriteFallbackRadiusM} m of your current position.
            Try searching for a specific station instead.
          {/snippet}
          {#snippet actions()}
            <Button variant="contained" size="small" onclick={() => searchOverlayStore.open()}>
              Search stations
            </Button>
          {/snippet}
        </InfoCard>
      {:else}
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
            selectedRouteId={stationsViewStore.routeFilterByStop[stop.id] ?? null}
            onRouteClick={(rid) => stationsViewStore.toggleRouteFilter(stop.id, rid)}
            favoriteRouteIds={favoritesStore.routeIds}
            getUpcomingStops={getUpcomingStops}
            expanded={effectiveExpandedStopId === stop.id}
            ontoggle={() => stationsViewStore.pickExpand(
              effectiveExpandedStopId === stop.id ? null : stop.id,
            )}
          />
        {/each}
      {/if}
    {:else if userPrefs.feedId != null && gpsState === 'pending'}
      <Card>
        <CardContent>
          <Stack direction="row" spacing={1} align="center">
            <Spinner size={16} />
            <Typography variant="caption">Determining your location…</Typography>
          </Stack>
        </CardContent>
      </Card>
    {/if}

  </Stack>
</div>
