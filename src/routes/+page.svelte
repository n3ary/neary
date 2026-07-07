<!-- Default landing route. Empty state points to Settings until a feed is selected; with a feed bound, fetches nearest stops (GPS if opted in, else the feed's published center) and renders a StationCard list per stop. GPS is strictly opt-in — browser prompt is never triggered without a user gesture. -->
<script lang="ts">
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { AlertTriangle, Calendar, Heart, Locate, MapPin, Search, X } from 'lucide-svelte';
  import {
    Box, Button, Card, CardContent, IconButton, InfoCard, NoLocationCard, RouteBadge, SelectFeedCard, Spinner, Stack, StationCard,
    Typography, iconButtonClass,
  } from '$lib/ui';
  import { getGtfsRepo } from '$lib/data/gtfs/repo';
  import { getUpcomingStops } from '$lib/data/gtfs/upcomingStops';
  import { createStationBoardsController } from '$lib/data/stationBoardsController.svelte';
  import type { StationBoardInput } from '$lib/data/stationBoardsController.svelte';
  import { compareRouteShortName, vehicleTypeLabel } from '$lib/domain/types';
  import type { Route } from '$lib/domain/types';
  import { selectBoardsForView } from '$lib/domain/stationSelection';
  import { DEFAULT_CONFIG } from '$lib/domain/config';
  import { isPositionInFeedBbox, distanceToFeedBboxKm, findNearestFeed } from '$lib/domain/feedCoverage';
  import { feedsStore } from '$lib/stores/feedsStore.svelte';
  import { locationStore } from '$lib/stores/gps/locationStore.svelte';
  import { enableLocationPromptDismissedStore } from '$lib/stores/gps/enableLocationPromptDismissedStore.svelte';
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

  // Seed `boards` from the cross-mount cache so a remount (returning from
  // /settings or /favorites) renders the prior frame instead of the
  // spinner. The fetch effect's GPS-hysteresis gate would otherwise skip
  // the SQLite query when the rider hasn't moved >= significantMoveM,
  // which is the common case after a settings toggle — leaving boards
  // null until a manual refresh bumps the tick. Mirrors the cache
  // discipline documented at stationsViewStore.lastBoards.
  let boards = $state<StationBoardInput[] | null>(stationsViewStore.lastBoards);
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

  // Per-view 15 s GPS polling. The +layout watchPosition alone can
  // stall on iOS Safari with enableHighAccuracy:false (battery-mode
  // throttling), pinning the nearest-stops view to a stale fix for
  // minutes. Polling here is the safety net — every 15 s we ask the
  // OS for a (cache-friendly) fix regardless of whether watch fired.
  // Polling lifecycle is bound to this view's $effect cleanup, so
  // navigating to /settings or /favorites naturally stops it. The
  // underlying watchPosition stays alive so other views (and the
  // header dot) keep reading a live freshness state. Issue #206.
  $effect(() => {
    if (!userPrefs.gpsOptedIn) return;
    locationStore.startPolling();
    return () => locationStore.stopPolling();
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
  // Genuine no-API-support case. Distinct from "transient error":
  // when geolocation exists but the watch errored with no position
  // (unavailable && !denied && isSupported) we don't show the
  // Location-not-supported card - the header dot is the only signal.
  const gpsUnsupported = $derived(
    !locationStore.isSupported && gpsState === 'unavailable' && !denied,
  );

  // Banner-stack gates. Named derived flags so the markup below reads
  // as "show X when Y" instead of inlining conditionals. See
  // docs/concepts/gps-states.md for the full state machine + per-surface
  // visibility matrix.
  const showEnablePrompt = $derived(
    gpsState === 'not-opted-in'
    && !userPrefs.hasEverEnabledGPS
    && !enableLocationPromptDismissedStore.dismissed,
  );
  const showSearchAndFavorites = $derived(
    gpsState === 'not-opted-in' || denied,
  );
  const showNoLocationCard = $derived(denied);
  const showLocationUnsupported = $derived(gpsUnsupported);

  // Issue #226: render the user's favorited routes inline on the
  // Favorites card instead of a "go to /favorites" CTA. The fetch is
  // gated on `favoritesStore.routeIds.size` so users on the GPS-allowed
  // path don't pay for a route catalog they never look at.
  const MAX_INLINE_FAVORITES = 5;
  let allRoutesForFavorites = $state<Route[] | null>(null);
  let routesError = $state<string | null>(null);
  $effect(() => {
    const fid = feedsStore.boundFeedId;
    if (!fid) return;
    if (favoritesStore.routeIds.size === 0) return;
    (async () => {
      try {
        const repo = getGtfsRepo();
        allRoutesForFavorites = await repo.getRoutes();
      } catch (e) {
        routesError = e instanceof Error ? e.message : String(e);
      }
    })();
  });
  const favoriteRoutes = $derived.by<Route[]>(() => {
    if (!allRoutesForFavorites) return [];
    return allRoutesForFavorites
      .filter((r) => favoritesStore.has(r.id))
      .sort((a, b) => compareRouteShortName(a.shortName, b.shortName));
  });

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

    {#if showEnablePrompt}
      <!-- First-time Enable prompt. Shows when the user has never
           enabled location AND hasn't dismissed the prompt AND hasn't
           engaged with GPS at any point (hasEverEnabledGPS captures
           the "user enabled then disabled from Settings" case so we
           don't re-nag them). The X button persists the dismissal;
           once the user actually enables location, this branch
           falls through to 'pending' / 'available' and the prompt
           disappears naturally. -->
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
              Search
            </Button>
          {/if}
        {/snippet}
      </InfoCard>
    {/if}

    {#if showSearchAndFavorites}
      {#snippet searchIcon()}<Search size={16} />{/snippet}
      {#snippet searchCard()}
        {#if userPrefs.feedId != null}
          <InfoCard variant="primary" title="Where to?">
            {#snippet icon()}<MapPin size={16} />{/snippet}
            {#snippet body()}
              Tap to search any station or route by name or number.
            {/snippet}
            {#snippet actions()}
              <Button variant="contained" startIcon={searchIcon} onclick={() => searchOverlayStore.open()}>
                Search
              </Button>
            {/snippet}
          </InfoCard>
        {/if}
      {/snippet}
      {#snippet favoritesCard()}
        {#if userPrefs.feedId != null && favoritesStore.routeIds.size > 0}
          <Card>
            <CardContent>
              <Stack direction="row" spacing={1} align="center">
                <Heart size={16} class="shrink-0 text-[color:var(--color-fg-muted)]" />
                <Typography variant="h6">Your favorites</Typography>
              </Stack>
              {#if routesError}
                <Typography variant="caption" class="block pt-1">
                  Couldn't load your favorites.
                </Typography>
              {:else if !allRoutesForFavorites}
                <Stack direction="row" spacing={1} align="center" class="pt-3">
                  <Spinner size={14} />
                  <Typography variant="caption">Loading...</Typography>
                </Stack>
              {:else if favoriteRoutes.length === 0}
                <Typography variant="caption" class="block pt-1">
                  Your saved routes aren't in this feed.
                </Typography>
              {:else}
                {#each favoriteRoutes.slice(0, MAX_INLINE_FAVORITES) as route (route.id)}
                  {@const isFav = favoritesStore.has(route.id)}
                  {@const typeLabel = vehicleTypeLabel(route.type ?? 'unknown')}
                  {@const primaryLabel = route.longName ?? typeLabel}
                  {@const hasSchedule = route.hasSchedule !== false}
                  {@const scheduleHref = hasSchedule ? `/schedule/route/${route.id}_0` : null}
                  {@const mapHref = `/map/route/${route.id}_0`}
                  <div class="mt-1 flex items-center gap-3 px-1 py-1.5 -mx-1 rounded-md hover:bg-[color:var(--color-border)]/20 transition-colors">
                    <a
                      href={mapHref}
                      aria-label={`Open map for ${typeLabel.toLowerCase()} ${route.shortName}`}
                      title="Open route map"
                      class="shrink-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary)]"
                    >
                      <RouteBadge {route} size="medium" class="min-w-14" />
                    </a>
                    <div class="min-w-0 flex-1">
                      <div class="text-sm font-medium truncate">{primaryLabel}</div>
                      {#if route.description}
                        <div class="text-xs truncate text-[color:var(--color-fg-muted)]">{route.description}</div>
                      {/if}
                    </div>
                    <div class="flex items-center gap-1 shrink-0">
                      {#if scheduleHref}
                        <a
                          href={scheduleHref}
                          aria-label={`Open schedule for ${typeLabel.toLowerCase()} ${route.shortName}`}
                          title="Open route schedule"
                          class={iconButtonClass}
                        >
                          <Calendar size={16} strokeWidth={2.25} />
                        </a>
                      {/if}
                      <button
                        type="button"
                        aria-label={`${isFav ? 'Unfavorite' : 'Favorite'} ${typeLabel.toLowerCase()} ${route.shortName}`}
                        aria-pressed={isFav}
                        onclick={(e) => { e.stopPropagation(); favoritesStore.toggle(route.id); }}
                        class={iconButtonClass}
                      >
                        <Heart
                          size={16}
                          strokeWidth={2.25}
                          fill={isFav ? 'currentColor' : 'none'}
                          class={isFav ? 'text-[color:var(--color-danger)]' : 'text-[color:var(--color-fg-muted)]'}
                        />
                      </button>
                    </div>
                  </div>
                {/each}
                {#if favoritesStore.routeIds.size > MAX_INLINE_FAVORITES}
                  <Stack direction="row" spacing={1} align="center" class="pt-2 border-t border-[color:var(--color-border)] mt-1">
                    <Button variant="text" size="small" onclick={() => goto('/favorites')}>
                      View all {favoritesStore.routeIds.size} in Favorites
                    </Button>
                  </Stack>
                {/if}
              {/if}
            </CardContent>
          </Card>
        {/if}
      {/snippet}
      {@render searchCard()}
      {@render favoritesCard()}
    {/if}

    {#if showNoLocationCard}
      <NoLocationCard dismissible />
    {/if}

    {#if gpsUnsupported}
      <!-- Only the genuine no-API-support case. The denied state
           covers permission-denied above (Search + Favorites +
           NoLocation). A transient watch error (unavailable &&
           !denied && isSupported) shows nothing on home - the header
           dot is the only signal, since the next GPS attempt may
           succeed. -->
      <InfoCard title="Location not supported">
        {#snippet icon()}<MapPin size={16} />{/snippet}
        {#snippet body()}
          Your browser doesn't expose a geolocation API. Search for a station by
          name to find what you're looking for.
        {/snippet}
        {#snippet actions()}
          {#if userPrefs.feedId != null}
            <Button variant="contained" size="small" onclick={() => searchOverlayStore.open()}>
              Search
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

<!-- "Position me" escape hatch (issue #206). Visible only when GPS is
     on AND we have a position to anchor from — opt-in flow stays
     exclusive to the Enable banner above. Anchored above the bottom
     nav (which is z-30 in BottomNavigation.svelte) at z-40 so a
     transit StatusBar entry — handled by the AppLayout's sticky
     strip — can never paint over it. Tap triggers a one-shot
     high-accuracy getCurrentPosition with no cache, bypassing the
     throttle that leaves the cached fix stale for the rider's
     whole wait. -->
{#if gpsState === 'available'}
  <button
    type="button"
    onclick={() => locationStore.forceFreshFix()}
    aria-label="Position me"
    title="Position me"
    class="fixed left-4 z-40 w-12 h-12 rounded-full bg-[color:var(--color-surface)]
           border border-[color:var(--color-border)] shadow-md
           flex items-center justify-center text-[color:var(--color-primary)]
           hover:bg-[color:var(--color-primary)]/10 active:scale-95
           transition-[transform,background-color]
           focus-visible:outline-none focus-visible:ring-2
           focus-visible:ring-[color:var(--color-primary)]"
    style="bottom: calc(3.5rem + env(safe-area-inset-bottom, 0px))"
  >
    <Locate size={20} />
  </button>
{/if}
