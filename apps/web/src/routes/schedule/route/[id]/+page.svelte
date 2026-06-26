<!--
  Schedule view — by-route, by-direction, optionally anchored to a stop.

  URL: /schedule/route/[id]?dir=0&stop=18

  Modes (this commit):
    - With `stop`: shows the strip of stations from the trip's ORIGIN
      up to (and including) the user's stop, with a "link from here"
      icon per row that deep-links into /station/[id]. Also shows the
      next N origin-departures with the predicted arrival time at the
      user's stop alongside.
    - Without `stop`: shows the trip strip from the most-recent /
      next-upcoming trip and the next N origin-departures, no per-row
      arrival annotation.

  Direction-swap button toggles dir=0 ↔ dir=1 in the URL (keeps stop).

  Deferred to Pass B (see /memories/session for plan): tomorrow toggle,
  night-route handling, favorites side-by-side, "show on map" button.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { ArrowRightLeft, ExternalLink, MapPin } from 'lucide-svelte';
  import {
    Card, CardContent, Chip, IconButton, NoFeedState, RouteBadge, Spinner,
    Stack, Typography,
  } from '$lib/ui';
  import { getGtfsRepo } from '$lib/data/gtfs/repo';
  import type { Route } from '$lib/domain/types';
  import type { ScheduleTrip, ScheduleTripStop } from '$lib/data/gtfs/types';
  import { minSinceMidnightInTz } from '$lib/domain/pipeline/timeUtils';
  import { feedsStore } from '$lib/stores/feedsStore.svelte';
  import { favoritesStore } from '$lib/stores/favoritesStore.svelte';
  import { nowTicker } from '$lib/stores/nowTicker.svelte';
  import { refreshBus } from '$lib/stores/refreshBus.svelte';
  import { userPrefs } from '$lib/stores/userPrefs.svelte';

  // 18h window means "rest of today" for a normal-service feed query
  // around lunchtime, and "next ~few-hours" if opened late evening.
  // Bigger isn't useful — schedules far ahead are noise.
  const SCHEDULE_WINDOW_MIN = 18 * 60;
  const NEXT_DEPARTURES_TO_SHOW = 12;

  const routeId = $derived(Number(page.params.id));
  const direction = $derived<0 | 1>(page.url.searchParams.get('dir') === '1' ? 1 : 0);
  const anchorStopId = $derived.by(() => {
    const raw = page.url.searchParams.get('stop');
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  });

  let route = $state<Route | null>(null);
  let trips = $state<ScheduleTrip[]>([]);
  let stripStops = $state<ScheduleTripStop[]>([]);
  let stripTripId = $state<string | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(false);

  $effect(() => {
    const fid = feedsStore.boundFeedId;
    if (!fid || !Number.isFinite(routeId)) return;
    refreshBus.tick; // re-fire on manual refresh
    const rid = routeId;
    const dir = direction;
    (async () => {
      loading = true;
      try {
        const repo = getGtfsRepo();
        const [r, ts] = await Promise.all([
          repo.getRouteById(rid),
          repo.getRouteSchedule(rid, dir, Date.now(), SCHEDULE_WINDOW_MIN),
        ]);
        route = r;
        trips = ts;
        // Strip = the stop-list of whichever trip is most useful right
        // now: the next-upcoming, or fall back to the most-recent
        // (purely so an evening-of view still has something to show).
        const stripTrip = ts[0] ?? null;
        stripTripId = stripTrip?.tripId ?? null;
        stripStops = stripTrip ? await repo.getStopsAlongTrip(stripTrip.tripId) : [];
        error = null;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      } finally {
        loading = false;
      }
    })();
  });

  // Stops to render: when anchored to a stop, take origin → anchor
  // (inclusive). Otherwise show all stops on the strip trip.
  const visibleStops = $derived.by<ScheduleTripStop[]>(() => {
    if (stripStops.length === 0) return [];
    if (anchorStopId == null) return stripStops;
    const idx = stripStops.findIndex((s) => s.stopId === anchorStopId);
    return idx >= 0 ? stripStops.slice(0, idx + 1) : stripStops;
  });

  // For each upcoming origin departure, compute the anchor stop's
  // predicted arrival = tripStartMin + (anchorArrivalMin - originDepartureMin).
  // Origin departure on stripStops is index 0's arrival in feed-local
  // minutes (close enough to departure for KISS; the worker's
  // tripStartMin uses departure_time explicitly so it's tighter).
  const anchorStop = $derived(
    anchorStopId == null ? null : stripStops.find((s) => s.stopId === anchorStopId) ?? null,
  );
  const originStop = $derived(stripStops[0] ?? null);
  const anchorOffsetMin = $derived(
    anchorStop && originStop ? anchorStop.arrivalMin - originStop.arrivalMin : 0,
  );

  // ETA at anchor for each departure, in minutes from now.
  const tz = $derived(feedsStore.activeTimezone);
  const nowMin = $derived(minSinceMidnightInTz(nowTicker.ms, tz));

  function swapDirection() {
    const params = new URLSearchParams(page.url.searchParams);
    params.set('dir', direction === 0 ? '1' : '0');
    goto(`/schedule/route/${routeId}?${params.toString()}`, { replaceState: false });
  }

  function formatMinutes(min: number): string {
    const h = Math.floor(min / 60) % 24;
    const m = Math.round(min % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  function formatEta(min: number): string {
    if (min < 0) return `${-min} min ago`;
    if (min === 0) return 'now';
    return `in ${min} min`;
  }

  const isFav = $derived(route ? favoritesStore.has(route.id) : false);
</script>

<div class="mx-auto max-w-3xl px-4 py-6">
  {#if userPrefs.feedId == null}
    <NoFeedState message="Pick a feed in Settings to view route schedules." />
  {:else if !Number.isFinite(routeId)}
    <Card><CardContent>
      <Typography variant="h6" class="text-[color:var(--color-danger)]">Invalid route id</Typography>
    </CardContent></Card>
  {:else if error}
    <Card><CardContent>
      <Stack spacing={1}>
        <Typography variant="h6" class="text-[color:var(--color-danger)]">Failed to load schedule</Typography>
        <Typography variant="caption">{error}</Typography>
      </Stack>
    </CardContent></Card>
  {:else if loading && route == null}
    <Card><CardContent>
      <Stack direction="row" spacing={1} align="center">
        <Spinner size={16} />
        <Typography variant="caption">Loading schedule…</Typography>
      </Stack>
    </CardContent></Card>
  {:else if route == null}
    <Card><CardContent>
      <Typography variant="h6">Route #{routeId} not found in the current feed.</Typography>
    </CardContent></Card>
  {:else}
    <Stack spacing={2}>
      <!-- Header: route badge + headsign hint + dir-swap + favorite. -->
      <Card>
        <CardContent>
          <Stack direction="row" spacing={1.5} align="center">
            <RouteBadge route={route} size="large" isFavorite={isFav} />
            <Stack spacing={0.25} class="flex-1 min-w-0">
              <Typography variant="h5" class="truncate">
                {stripStops[stripStops.length - 1]?.stopName ?? `Route ${route.shortName}`}
              </Typography>
              <Typography variant="caption" class="text-[color:var(--color-fg-muted)]">
                {anchorStop ? `Today's schedule from origin to ${anchorStop.stopName}` : "Today's schedule"}
              </Typography>
            </Stack>
            <IconButton aria-label="Swap direction" onclick={swapDirection}>
              <ArrowRightLeft size={18} />
            </IconButton>
          </Stack>
        </CardContent>
      </Card>

      <!-- Stops strip: origin → anchor (inclusive), with deep-link per row. -->
      {#if visibleStops.length > 0}
        <Card>
          <CardContent>
            <Stack spacing={0.5}>
              <Typography variant="overline" class="uppercase tracking-wide text-[color:var(--color-fg-muted)]">
                Stops on this trip {anchorStop ? '(up to your stop)' : ''}
              </Typography>
              {#each visibleStops as s, i (s.stopId)}
                {@const isAnchor = anchorStopId === s.stopId}
                <Stack direction="row" spacing={1} align="center" class="px-1 py-1 rounded-md hover:bg-[color:var(--color-border)]/30">
                  <Chip size="small" class="font-mono">{i + 1}</Chip>
                  <Typography
                    variant="body2"
                    class={`flex-1 truncate ${isAnchor ? 'font-semibold' : ''}`}
                  >
                    {s.stopName}
                  </Typography>
                  <Typography variant="caption" class="text-[color:var(--color-fg-muted)] font-mono">
                    {formatMinutes(s.arrivalMin)}
                  </Typography>
                  <IconButton
                    aria-label={`Open station ${s.stopName}`}
                    onclick={() => goto(`/station/${s.stopId}`)}
                  >
                    <ExternalLink size={16} />
                  </IconButton>
                </Stack>
              {/each}
            </Stack>
          </CardContent>
        </Card>
      {/if}

      <!-- Next departures from origin. -->
      <Card>
        <CardContent>
          <Stack spacing={0.5}>
            <Typography variant="overline" class="uppercase tracking-wide text-[color:var(--color-fg-muted)]">
              Next departures from {originStop?.stopName ?? 'origin'}
            </Typography>
            {#if trips.length === 0}
              <Typography variant="body2" class="text-[color:var(--color-fg-muted)] py-2">
                No more departures today on this direction.
              </Typography>
            {:else}
              {#each trips.slice(0, NEXT_DEPARTURES_TO_SHOW) as t (t.tripId)}
                {@const anchorMin = t.tripStartMin + anchorOffsetMin}
                {@const etaMin = anchorMin - nowMin}
                <Stack direction="row" spacing={1} align="center" class="px-1 py-1 rounded-md">
                  <Chip size="small" class="font-mono">{formatMinutes(t.tripStartMin)}</Chip>
                  <Typography variant="body2" class="flex-1 truncate text-[color:var(--color-fg-muted)]">
                    {t.headsign ?? ''}
                  </Typography>
                  {#if anchorStop}
                    <Stack direction="row" spacing={0.5} align="center">
                      <MapPin size={12} class="text-[color:var(--color-fg-muted)]" />
                      <Typography variant="caption" class="font-mono">
                        {formatMinutes(anchorMin)} · {formatEta(etaMin)}
                      </Typography>
                    </Stack>
                  {/if}
                </Stack>
              {/each}
            {/if}
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  {/if}
</div>
