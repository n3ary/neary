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
    Card, CardContent, SelectFeedCard, Spinner, Stack, StationCard, Typography,
  } from '$lib/ui';
  import { getGtfsRepo } from '$lib/data/gtfs/repo';
  import { getUpcomingStops } from '$lib/data/gtfs/upcomingStops';
  import { createStationBoardsController } from '$lib/data/stationBoardsController.svelte';
  import type { StationBoardInput } from '$lib/data/stationBoardsController.svelte';
  import { DEFAULT_CONFIG } from '$lib/domain/config';
  import { feedsStore } from '$lib/stores/feedsStore.svelte';
  import { favoritesStore } from '$lib/stores/favoritesStore.svelte';
  import { refreshBus } from '$lib/stores/refreshBus.svelte';
  import { stationsViewStore } from '$lib/stores/stationsViewStore.svelte';
  import { userPrefs } from '$lib/stores/userPrefs.svelte';

  // Arrivals window owned by DEFAULT_CONFIG (shared with the
  // Stations / home view). 18 h from any wall-clock time covers
  // the rest of the GTFS service day.
  const ARRIVALS_WINDOW_MIN = DEFAULT_CONFIG.arrivalsWindowMin;

  const stopId = $derived(page.params.id ?? '');
  const stopIdValid = $derived(stopId.length > 0);

  let board = $state<StationBoardInput | null>(null);
  let originRouteIds = $state<Set<string>>(new Set());
  let error = $state<string | null>(null);
  let notFound = $state(false);

  // Shared controller - same shape as /+page.svelte. We feed it a
  // single-element array when board is loaded; it owns shape cache +
  // assembly. routeFilterFor reads from the cross-mount store so the
  // user's route-filter selection survives navigation back from
  // /map/... or /schedule/... (issue #203).
  const boardsController = createStationBoardsController({
    routeFilterFor: (sid) => stationsViewStore.routeFilterByStop[sid] ?? null,
  });
  $effect(() => { boardsController.setBoards(board ? [board] : null); });
  const assembled = $derived(boardsController.assembled[0] ?? null);

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
          // Per-stop route filter is shared via stationsViewStore and
          // persists across refreshes + remounts. Only re-populate
          // originRouteIds (cheap, derived from schedule).
          originRouteIds = new Set(await repo.getOriginRoutesAtStop(sid));
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    })();
  });
</script>

<div class="mx-auto max-w-3xl px-4 py-6">
  {#if userPrefs.feedId == null}
    <SelectFeedCard />
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
    {@const stopKey = board.stop.id}
    <StationCard
      station={{ id: stopKey, name: board.stop.name, lat: board.stop.lat, lon: board.stop.lon }}
      rows={assembled?.rows ?? []}
      allRoutes={assembled?.allRoutes ?? []}
      selectedRouteId={stationsViewStore.routeFilterByStop[stopKey] ?? null}
      onRouteClick={(rid) => stationsViewStore.toggleRouteFilter(stopKey, rid)}
      favoriteRouteIds={favoritesStore.routeIds}
      originRouteIds={originRouteIds}
      getUpcomingStops={getUpcomingStops}
      expanded={true}
      ontoggle={() => {}}
    />
  {/if}
</div>
