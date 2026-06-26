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
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { Bus, MapPin, Settings } from 'lucide-svelte';
  import {
    Box, Button, Card, CardContent, Spinner, Stack, StationCard, Typography,
  } from '$lib/ui';
  import { getGtfsRepo } from '$lib/data/gtfs/repo';
  import type { StopWithDistance } from '$lib/data/gtfs/types';
  import { assembleStationBoard, dedupRoutes } from '$lib/domain/stationBoard';
  import type { Vehicle } from '$lib/domain/types';
  import { feedsStore } from '$lib/stores/feedsStore.svelte';
  import { locationStore } from '$lib/stores/locationStore.svelte';
  import { userPrefs } from '$lib/stores/userPrefs.svelte';

  // Demo fallback location when GPS is unavailable / not yet granted:
  // Piața Mihai Viteazul, central Cluj. Lets the page work in dev /
  // offline / before the location prompt is accepted.
  const FALLBACK_LAT = 46.7712;
  const FALLBACK_LON = 23.6236;
  const SEARCH_RADIUS_M = 500;
  const MAX_STATIONS = 8;
  const ARRIVALS_WINDOW_MIN = 60;

  onMount(() => locationStore.start());

  const hasGps = $derived(locationStore.position != null);
  // Round to 4 decimals so GPS jitter doesn't refire the SQLite query.
  const queryLat = $derived(
    Math.round((locationStore.position?.coords.latitude ?? FALLBACK_LAT) * 1e4) / 1e4,
  );
  const queryLon = $derived(
    Math.round((locationStore.position?.coords.longitude ?? FALLBACK_LON) * 1e4) / 1e4,
  );

  let boards = $state<{ stop: StopWithDistance; vehicles: Vehicle[] }[] | null>(null);
  let boardsError = $state<string | null>(null);
  let expandedStopId = $state<number | null>(null);

  // Tick once a minute so ETAs/buckets refresh without re-querying SQLite.
  let nowMs = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (nowMs = Date.now()), 30_000);
    return () => clearInterval(t);
  });

  $effect(() => {
    // Wait until the worker has actually been bound to the user's chosen
    // feed (set by +layout after repo.setFeed resolves). Without this gate
    // the page can race the bind and briefly flash a 'not bound' error.
    const fid = feedsStore.boundFeedId;
    if (!fid) return;
    const lat = queryLat;
    const lon = queryLon;
    (async () => {
      try {
        const repo = getGtfsRepo();
        boards = await repo.getStationBoardsNear(
          lat, lon, SEARCH_RADIUS_M, MAX_STATIONS, Date.now(), ARRIVALS_WINDOW_MIN,
        );
        boardsError = null;
        // Auto-expand if there's exactly one station — saves a tap.
        if (boards.length === 1) expandedStopId = boards[0].stop.id;
      } catch (e) {
        boardsError = e instanceof Error ? e.message : String(e);
      }
    })();
  });
</script>

<div class="mx-auto max-w-3xl px-4 py-6">
  {#if userPrefs.feedId == null}
    <Card class="text-center">
      <CardContent>
        <Stack spacing={2} align="center">
          <div class="inline-flex items-center justify-center w-12 h-12 rounded-full bg-[color:var(--color-primary)]/10 text-[color:var(--color-primary)]">
            <Bus size={24} />
          </div>
          <Typography variant="h4">Select your transit feed</Typography>
          <Typography variant="body2" class="max-w-prose text-[color:var(--color-fg-muted)]">
            Neary needs a transit feed to load schedules and routes. Pick
            one in Settings to get started. The data downloads once and is
            cached for offline use — no account needed.
          </Typography>
          {#snippet settingsIcon()}<Settings size={16} />{/snippet}
          <Button startIcon={settingsIcon} onclick={() => goto('/settings')}>
            Open Settings
          </Button>
        </Stack>
      </CardContent>
    </Card>
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
            No stops within {SEARCH_RADIUS_M} m of {hasGps ? 'your current position' : 'the fallback location'}.
            Try moving closer to a transit corridor or enabling location.
          </Typography>
        </Stack>
      </CardContent>
    </Card>
  {:else}
    <Stack spacing={1}>
      {#if !hasGps}
        <Box class="px-2 py-1 text-xs text-[color:var(--color-fg-muted)]">
          <Stack direction="row" spacing={1} align="center">
            <MapPin size={12} />
            <span>No GPS — showing stations near a fallback location ({FALLBACK_LAT}, {FALLBACK_LON}).</span>
          </Stack>
        </Box>
      {/if}
      {@const rawTotal = boards.reduce((n, b) => n + b.vehicles.length, 0)}
      {@const filteredTotal = boards.reduce(
        (n, b) => n + assembleStationBoard(b.vehicles, userPrefs, nowMs).length, 0)}
      {#if rawTotal === 0}
        <Box class="px-2 py-1 text-xs text-[color:var(--color-warning)]">
          No upcoming vehicles found in any of the {boards.length} nearby
          stations within the next {ARRIVALS_WINDOW_MIN} min. This usually
          means the GTFS calendar has no active service for today, or your
          system clock disagrees with the feed timezone — check
          <a href="/data-test" class="underline">/data-test</a> for a raw
          query against a known stop.
        </Box>
      {:else if filteredTotal === 0}
        <Box class="px-2 py-1 text-xs text-[color:var(--color-warning)]">
          {rawTotal} vehicles found but all hidden by your filters
          (check Settings → Display: drop-off-only, schedule-only,
          departed).
        </Box>
      {/if}
      {#each boards as { stop, vehicles } (stop.id)}
        {@const board = assembleStationBoard(vehicles, userPrefs, nowMs)}
        <StationCard
          station={{ id: stop.id, name: stop.name, distance: stop.distance, lat: stop.lat, lon: stop.lon }}
          routes={dedupRoutes(vehicles)}
          rows={board}
          expanded={expandedStopId === stop.id}
          ontoggle={() => (expandedStopId = expandedStopId === stop.id ? null : stop.id)}
        />
      {/each}
    </Stack>
  {/if}
</div>
