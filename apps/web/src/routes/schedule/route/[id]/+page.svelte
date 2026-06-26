<!--
  Schedule view — by-route, by-direction, optionally anchored to a stop
  and/or a specific trip. Single page covers four modes:

    1. anchored-trip: ?dir=…&stop=…&trip=…
       Left column shows TODAY's next departures from origin (focused
       trip highlighted). Right column shows that trip's full stop
       timeline origin → terminus, with the user's stop highlighted.
       This is the "tap the kind-badge on a station card" path.

    2. anchored-stop: ?dir=…&stop=…
       Same layout as (1) but no specific trip — right column shows
       the next-upcoming trip's timeline with the stop highlighted.

    3. unfocused: ?dir=…
       Single direction; right column shows the next-upcoming trip's
       timeline with no highlight. Useful when typed by URL.

    4. multi-direction: (no dir param)
       Two side-by-side departure lists (dir 0 and dir 1). No stop
       timeline. Used by /favorites deep-links.

  Day mode (?day=tomorrow) switches the data window: today shows from
  now until end-of-day (24h window so Cluj night routes' 24:00+ trips
  surface), tomorrow shows from 00:00 until 12:00.

  Anchor-stop deep-links to /station/[id] via the per-row ExternalLink.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { ArrowRightLeft, CalendarDays, ExternalLink, Moon } from 'lucide-svelte';
  import {
    Card, CardContent, Chip, IconButton, NoFeedState, RouteBadge, Spinner,
    Stack, ToggleGroup, Typography,
  } from '$lib/ui';
  import { getGtfsRepo } from '$lib/data/gtfs/repo';
  import type { Route } from '$lib/domain/types';
  import { vehicleTypeLabel } from '$lib/domain/types';
  import type { ScheduleTrip, ScheduleTripStop } from '$lib/data/gtfs/types';
  import {
    dateKeyInTz, minSinceMidnightInTz,
  } from '$lib/domain/pipeline/timeUtils';
  import { feedsStore } from '$lib/stores/feedsStore.svelte';
  import { favoritesStore } from '$lib/stores/favoritesStore.svelte';
  import { nowTicker } from '$lib/stores/nowTicker.svelte';
  import { refreshBus } from '$lib/stores/refreshBus.svelte';
  import { userPrefs } from '$lib/stores/userPrefs.svelte';

  // ── URL params ──────────────────────────────────────────────────────
  const routeId = $derived(Number(page.params.id));
  const routeIdValid = $derived(Number.isFinite(routeId) && routeId > 0);
  // Direction is optional — when omitted we render multi-direction mode.
  const directionParam = $derived(page.url.searchParams.get('dir'));
  const direction = $derived<0 | 1 | null>(
    directionParam === '0' ? 0 : directionParam === '1' ? 1 : null,
  );
  const anchorStopId = $derived.by(() => {
    const raw = page.url.searchParams.get('stop');
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  });
  const focusTripId = $derived(page.url.searchParams.get('trip'));
  const dayMode = $derived<'today' | 'tomorrow'>(
    page.url.searchParams.get('day') === 'tomorrow' ? 'tomorrow' : 'today',
  );

  // ── Data state ──────────────────────────────────────────────────────
  let route = $state<Route | null>(null);
  // Departures per direction. In single-direction mode only one is
  // populated; in multi-direction mode both are.
  let tripsByDir = $state<{ 0: ScheduleTrip[]; 1: ScheduleTrip[] }>({ 0: [], 1: [] });
  // Focus trip's stop timeline (single-direction mode only).
  let focusStops = $state<ScheduleTripStop[]>([]);
  let focusTrip = $state<ScheduleTrip | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(false);

  const tz = $derived(feedsStore.activeTimezone);

  // Night route: Cluj convention is shortName ending in 'N'. The check
  // is a single regex so other feeds following the same convention
  // get it for free. Used to extend today's query window so trips
  // scheduled past 24:00 (encoded as 24:00:00, 25:30:00 etc per GTFS)
  // still surface.
  const isNightRoute = $derived(route ? /n$/i.test(route.shortName) : false);

  // Window math per dayMode. Today: from now until end-of-day (24h to
  // catch night-route post-midnight trips). Tomorrow: from 00:00 to
  // 12:00 (the user just wants "what's running first thing").
  const queryParams = $derived.by(() => {
    const nowMs = nowTicker.ms;
    if (dayMode === 'today') {
      return {
        localDate: dateKeyInTz(nowMs, tz),
        fromMin: minSinceMidnightInTz(nowMs, tz),
        windowMin: isNightRoute ? 24 * 60 : 18 * 60,
      };
    }
    // Tomorrow: +24h gets us a timestamp solidly in tomorrow's date,
    // regardless of when "now" falls within today.
    const tomorrowMs = nowMs + 24 * 60 * 60 * 1000;
    return {
      localDate: dateKeyInTz(tomorrowMs, tz),
      fromMin: 0,
      windowMin: 12 * 60,
    };
  });

  $effect(() => {
    const fid = feedsStore.boundFeedId;
    if (!fid || !routeIdValid) return;
    refreshBus.tick;
    // Capture params at start so the async block isn't reactive on
    // later changes (the effect re-runs on real input change anyway).
    const rid = routeId;
    const dir = direction;
    const ftId = focusTripId;
    const qp = queryParams;
    (async () => {
      loading = true;
      try {
        const repo = getGtfsRepo();
        const r = await repo.getRouteById(rid);
        route = r;

        // Fetch departures. Multi-direction = both; single = the chosen.
        if (dir == null) {
          const [d0, d1] = await Promise.all([
            repo.getRouteSchedule(rid, 0, qp.localDate, qp.fromMin, qp.windowMin),
            repo.getRouteSchedule(rid, 1, qp.localDate, qp.fromMin, qp.windowMin),
          ]);
          tripsByDir = { 0: d0, 1: d1 };
          focusStops = [];
          focusTrip = null;
        } else {
          const trips = await repo.getRouteSchedule(rid, dir, qp.localDate, qp.fromMin, qp.windowMin);
          tripsByDir = dir === 0 ? { 0: trips, 1: [] } : { 0: [], 1: trips };
          // Right-column focus = the URL-pinned trip if present in the
          // result list, else the next-upcoming one, else null. Even
          // when the focus trip already left origin (so it's not in
          // `trips`), getStopsAlongTrip still works.
          const pinned = ftId ? trips.find((t) => t.tripId === ftId) ?? null : null;
          focusTrip = pinned ?? trips[0] ?? null;
          // If a trip_id was pinned but not in the window (e.g. it
          // already departed origin), still fetch its stops for the
          // right column.
          const stopsTripId = pinned?.tripId ?? ftId ?? focusTrip?.tripId ?? null;
          focusStops = stopsTripId ? await repo.getStopsAlongTrip(stopsTripId) : [];
          // Resolve display headsign for the focus trip even when only
          // its trip_id was URL-pinned (focusTrip would be null in
          // that case).
          if (!focusTrip && stopsTripId) {
            focusTrip = {
              tripId: stopsTripId,
              tripStartMin: focusStops[0]?.arrivalMin ?? 0,
              headsign: focusStops[focusStops.length - 1]?.stopName ?? null,
              serviceId: '',
            };
          }
        }
        error = null;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      } finally {
        loading = false;
      }
    })();
  });

  // ── Helpers ─────────────────────────────────────────────────────────
  function formatHHMM(min: number): string {
    const h = Math.floor(min / 60) % 24;
    const m = Math.round(min % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  function navigateWith(updates: Record<string, string | null>) {
    const params = new URLSearchParams(page.url.searchParams);
    for (const [k, v] of Object.entries(updates)) {
      if (v == null) params.delete(k);
      else params.set(k, v);
    }
    const qs = params.toString();
    goto(`/schedule/route/${routeId}${qs ? `?${qs}` : ''}`, { replaceState: false });
  }
  function swapDirection() {
    // Only meaningful when a direction is set. Multi-direction mode
    // exposes the button as disabled.
    if (direction == null) return;
    navigateWith({ dir: direction === 0 ? '1' : '0', trip: null });
  }
  function pickDay(d: 'today' | 'tomorrow') {
    // Tomorrow drops the pinned trip (it's a today-only artifact).
    navigateWith({ day: d === 'today' ? null : 'tomorrow', trip: d === 'tomorrow' ? null : focusTripId });
  }

  const isFav = $derived(route ? favoritesStore.has(route.id) : false);
  const headerTitle = $derived(
    route ? `${vehicleTypeLabel(route.type ?? 'unknown')} ${route.shortName}` : '',
  );
  const headerSubtitle = $derived(focusTrip?.headsign ?? '');
</script>

<div class="mx-auto max-w-5xl px-4 py-6">
  {#if userPrefs.feedId == null}
    <NoFeedState message="Pick a feed in Settings to view route schedules." />
  {:else if !routeIdValid}
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
      <!-- Header card: route + headsign + day toggle + dir-swap. -->
      <Card>
        <CardContent>
          <Stack direction="row" spacing={1.5} align="center" wrap>
            <RouteBadge route={route} size="large" isFavorite={isFav} />
            <Stack spacing={0.5} class="flex-1 min-w-0">
              <Stack direction="row" spacing={1} align="center" wrap>
                <Typography variant="h5" class="truncate">{headerTitle}</Typography>
                {#if isNightRoute}
                  <Chip size="small" variant="outlined">
                    {#snippet icon()}<Moon size={12} />{/snippet}
                    Night route
                  </Chip>
                {/if}
              </Stack>
              {#if headerSubtitle}
                <Typography variant="caption" class="text-[color:var(--color-fg-muted)] truncate">
                  → {headerSubtitle}
                </Typography>
              {/if}
            </Stack>
            <ToggleGroup
              value={dayMode}
              onchange={(v) => pickDay(v as 'today' | 'tomorrow')}
              items={[
                { value: 'today', label: 'Today' },
                { value: 'tomorrow', label: 'Tomorrow' },
              ]}
            />
            <IconButton
              aria-label="Swap direction"
              disabled={direction == null}
              onclick={swapDirection}
            >
              <ArrowRightLeft size={18} />
            </IconButton>
          </Stack>
        </CardContent>
      </Card>

      {#if direction != null}
        <!-- Single-direction view: two columns on desktop, stacked on mobile. -->
        {@const trips = direction === 0 ? tripsByDir[0] : tripsByDir[1]}
        {@const originStop = focusStops[0] ?? null}
        {@const terminusStop = focusStops[focusStops.length - 1] ?? null}
        {@const anchorOffset =
          anchorStopId != null && originStop
            ? (focusStops.find((s) => s.stopId === anchorStopId)?.arrivalMin ?? originStop.arrivalMin) - originStop.arrivalMin
            : 0}

        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <!-- LEFT: today/tomorrow departures from origin. -->
          <Card>
            <CardContent>
              <Stack spacing={0.5}>
                <Typography variant="overline" class="uppercase tracking-wide text-[color:var(--color-fg-muted)]">
                  Departures{originStop ? ` from ${originStop.stopName}` : ''}
                </Typography>
                {#if trips.length === 0}
                  <Typography variant="body2" class="text-[color:var(--color-fg-muted)] py-2">
                    No more departures {dayMode === 'today' ? 'today' : 'tomorrow morning'} on this direction.
                  </Typography>
                {:else}
                  {#each trips as t (t.tripId)}
                    {@const isFocused = focusTrip?.tripId === t.tripId}
                    {@const anchorArrivalMin = t.tripStartMin + anchorOffset}
                    <a
                      href={`/schedule/route/${routeId}?dir=${direction}${anchorStopId != null ? `&stop=${anchorStopId}` : ''}&trip=${encodeURIComponent(t.tripId)}${dayMode === 'tomorrow' ? '&day=tomorrow' : ''}`}
                      class={`flex items-center gap-2 px-2 py-1 rounded-md transition-colors no-underline text-[color:var(--color-fg)] hover:bg-[color:var(--color-border)]/30 ${isFocused ? 'bg-[color:var(--color-border)]/40 ring-1 ring-[color:var(--color-primary)]' : ''}`}
                    >
                      <Chip size="small" class="font-mono shrink-0">{formatHHMM(t.tripStartMin)}</Chip>
                      <span class="flex-1 min-w-0 truncate text-xs text-[color:var(--color-fg-muted)]">
                        {t.headsign ?? ''}
                      </span>
                      {#if anchorStopId != null && originStop}
                        <span class="text-xs font-mono text-[color:var(--color-fg-muted)] shrink-0">
                          @ {formatHHMM(anchorArrivalMin)}
                        </span>
                      {/if}
                    </a>
                  {/each}
                {/if}
              </Stack>
            </CardContent>
          </Card>

          <!-- RIGHT: focus trip's full stop timeline. -->
          {#if focusStops.length > 0}
            <Card>
              <CardContent>
                <Stack spacing={0.5}>
                  <Typography variant="overline" class="uppercase tracking-wide text-[color:var(--color-fg-muted)]">
                    This trip{focusTrip ? ` · departs ${formatHHMM(focusTrip.tripStartMin)}` : ''}
                  </Typography>
                  {#each focusStops as s, i (s.stopId)}
                    {@const isAnchor = anchorStopId === s.stopId}
                    {@const isOrigin = i === 0}
                    {@const isTerminus = i === focusStops.length - 1}
                    <Stack
                      direction="row"
                      spacing={1}
                      align="center"
                      class={`px-2 py-1 rounded-md ${isAnchor ? 'bg-[color:var(--color-primary)]/15 ring-1 ring-[color:var(--color-primary)]' : 'hover:bg-[color:var(--color-border)]/30'}`}
                    >
                      <Chip size="small" class="font-mono shrink-0">{i + 1}</Chip>
                      <Typography
                        variant="body2"
                        class={`flex-1 truncate ${isAnchor || isOrigin || isTerminus ? 'font-semibold' : ''}`}
                      >
                        {s.stopName}
                      </Typography>
                      <Typography variant="caption" class="text-[color:var(--color-fg-muted)] font-mono shrink-0">
                        {formatHHMM(s.arrivalMin)}
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
        </div>
      {:else}
        <!-- Multi-direction view: two side-by-side departure lists. -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          {#each [0, 1] as dir (dir)}
            {@const trips = dir === 0 ? tripsByDir[0] : tripsByDir[1]}
            {@const sampleHeadsign = trips[0]?.headsign ?? ''}
            <Card>
              <CardContent>
                <Stack spacing={0.5}>
                  <Stack direction="row" spacing={1} align="center" justify="between">
                    <Stack spacing={0.5}>
                      <Typography variant="overline" class="uppercase tracking-wide text-[color:var(--color-fg-muted)]">
                        Direction {dir}
                      </Typography>
                      {#if sampleHeadsign}
                        <Typography variant="body2" class="truncate font-medium">→ {sampleHeadsign}</Typography>
                      {/if}
                    </Stack>
                    <a
                      href={`/schedule/route/${routeId}?dir=${dir}${dayMode === 'tomorrow' ? '&day=tomorrow' : ''}`}
                      class="text-xs underline text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]"
                    >
                      Full view
                    </a>
                  </Stack>
                  {#if trips.length === 0}
                    <Typography variant="body2" class="text-[color:var(--color-fg-muted)] py-2">
                      No upcoming departures.
                    </Typography>
                  {:else}
                    {#each trips as t (t.tripId)}
                      <Stack direction="row" spacing={1} align="center" class="px-2 py-1">
                        <Chip size="small" class="font-mono shrink-0">{formatHHMM(t.tripStartMin)}</Chip>
                        <span class="flex-1 min-w-0 truncate text-xs text-[color:var(--color-fg-muted)]">
                          {t.headsign ?? ''}
                        </span>
                      </Stack>
                    {/each}
                  {/if}
                </Stack>
              </CardContent>
            </Card>
          {/each}
        </div>
      {/if}
    </Stack>
  {/if}
</div>

<style>
  /* Grid utilities. Tailwind doesn't ship the breakpoint classes in
     this project's setup — write the minimum we need inline. */
  .grid { display: grid; }
  .grid-cols-1 { grid-template-columns: 1fr; }
  .gap-3 { gap: 0.75rem; }
  @media (min-width: 768px) {
    .md\:grid-cols-2 { grid-template-columns: 1fr 1fr; }
  }
</style>
