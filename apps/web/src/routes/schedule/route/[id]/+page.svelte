<!--
  Schedule view — by-route, by-direction.

  URL: /schedule/route/[id]?dir=0&view=next-trip|today|tomorrow|week

  Tabs:
    - 'next-trip': stop timeline for the next upcoming trip in the
      selected direction. Enabled only when a direction is set.
    - 'today':    today's remaining departures from origin.
    - 'tomorrow': tomorrow's morning departures (00:00 → noon).
    - 'week':     recurring weekly pattern (Mon-Fri / Sat / Sun).

  The header carries route badge + origin → headsign + dir-swap. We
  intentionally do NOT track an anchor stop or a pinned trip in the
  URL: the schedule is for the route in a given direction, regardless
  of which station the user was looking at when they navigated here.

  Multi-direction mode (no `dir` param) keeps a two-column side-by-side
  layout, one direction per card, no stop timeline. Used by /favorites.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { ArrowRightLeft, ChevronDown, ExternalLink, Moon } from 'lucide-svelte';
  import {
    Card, CardContent, Chip, IconButton, NoFeedState, RouteBadge, Spinner,
    Stack, ToggleGroup, Typography,
  } from '$lib/ui';
  import { getGtfsRepo } from '$lib/data/gtfs/repo';
  import type { Route } from '$lib/domain/types';
  import {
    formatHHMM, formatRelativeMin, isNightRoute, vehicleTypeLabel,
  } from '$lib/domain/types';
  import { scheduleUrgency } from '$lib/domain/buckets';
  import { urgencyClass } from '$lib/ui/urgencyClass';
  import type { ScheduleTrip, ScheduleTripStop, WeeklySchedule } from '$lib/data/gtfs/types';
  import {
    dayOfWeekInTz, minSinceMidnightInTz, scheduleWindowFor,
  } from '$lib/domain/pipeline/timeUtils';
  import { feedsStore } from '$lib/stores/feedsStore.svelte';
  import { favoritesStore } from '$lib/stores/favoritesStore.svelte';
  import { nowTicker } from '$lib/stores/nowTicker.svelte';
  import { refreshBus } from '$lib/stores/refreshBus.svelte';
  import { userPrefs } from '$lib/stores/userPrefs.svelte';

  // ── URL params ──────────────────────────────────────────────────────
  const routeId = $derived(Number(page.params.id));
  const routeIdValid = $derived(Number.isFinite(routeId) && routeId > 0);

  const direction = $derived<0 | 1 | null>(
    page.url.searchParams.get('dir') === '0' ? 0
    : page.url.searchParams.get('dir') === '1' ? 1
    : null,
  );

  type View = 'next-trip' | 'today' | 'tomorrow' | 'week';
  const view = $derived.by<View>(() => {
    const v = page.url.searchParams.get('view');
    if (v === 'today' || v === 'tomorrow' || v === 'next-trip' || v === 'week') return v;
    // Back-compat: old links used 'this-trip' for the same concept.
    if (v === 'this-trip') return 'next-trip';
    // 'today' is the canonical default — `pickView` strips the
    // query string for it, so the URL with no ?view= must also
    // resolve here.
    return 'today';
  });

  // ── Data state ──────────────────────────────────────────────────────
  let route = $state<Route | null>(null);
  // Departures for the day the user is currently viewing. Empty array
  // means "no data fetched yet" OR "no service today" — both render
  // the same empty-state row.
  let tripsByDir = $state<{ 0: ScheduleTrip[]; 1: ScheduleTrip[] }>({ 0: [], 1: [] });
  // Per-trip stop timelines. Drives the 'Next trip' tab AND the
  // inline row expansion in Today/Tomorrow.
  let tripStops = $state<Map<string, ScheduleTripStop[]>>(new Map());
  // Which row is open in the Today/Tomorrow accordion. Local state
  // only — the URL no longer carries a trip pin.
  let expandedTripId = $state<string | null>(null);
  // Weekly pattern (Mon-Fri / Sat / Sun). Fetched on demand the first
  // time the user opens the Week tab for a given direction. Keyed by
  // direction so swapping direction triggers a refetch.
  let weekly = $state<WeeklySchedule | null>(null);
  let weeklyDirection = $state<0 | 1 | null>(null);
  let weeklyLoading = $state(false);
  let error = $state<string | null>(null);

  const tz = $derived(feedsStore.activeTimezone);

  // Night-route flag drives the today-window width and the header chip.
  // Heuristic + future per-feed override live in the domain layer.
  const nightRoute = $derived(route ? isNightRoute(route) : false);

  // Departures window for the currently-selected view's day.
  // Logic owned by `scheduleWindowFor` so this view is pure markup +
  // reactive glue. The Week tab uses its own dedicated query and
  // doesn't need a window — fall back to 'today' so the effect that
  // populates Today/Tomorrow keeps the list warm for fast tab swaps.
  const queryParams = $derived(
    scheduleWindowFor({
      view: view === 'week' ? 'today' : view,
      isNight: nightRoute,
      nowMs: nowTicker.ms,
      timeZone: tz,
    }),
  );

  $effect(() => {
    const fid = feedsStore.boundFeedId;
    if (!fid || !routeIdValid) return;
    refreshBus.tick;
    const rid = routeId;
    const dir = direction;
    const qp = queryParams;
    (async () => {
      try {
        const repo = getGtfsRepo();
        const r = await repo.getRouteById(rid);
        route = r;

        if (dir == null) {
          // Multi-direction: both schedules in parallel; no trip timeline.
          const [d0, d1] = await Promise.all([
            repo.getRouteSchedule(rid, 0, qp.localDate, qp.fromMin, qp.windowMin),
            repo.getRouteSchedule(rid, 1, qp.localDate, qp.fromMin, qp.windowMin),
          ]);
          tripsByDir = { 0: d0, 1: d1 };
        } else {
          // Single-direction: schedule for the day + warm the
          // next-upcoming trip's stop list so the Next trip tab
          // renders without an extra round-trip.
          const trips = await repo.getRouteSchedule(rid, dir, qp.localDate, qp.fromMin, qp.windowMin);
          tripsByDir = dir === 0 ? { 0: trips, 1: [] } : { 0: [], 1: trips };
          const stopsTripId = trips[0]?.tripId ?? null;
          if (stopsTripId) await loadTripStops(stopsTripId);
        }
        error = null;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    })();
  });

  async function loadTripStops(tripId: string) {
    if (tripStops.has(tripId)) return;
    const repo = getGtfsRepo();
    const stops = await repo.getStopsAlongTrip(tripId);
    const next = new Map(tripStops);
    next.set(tripId, stops);
    tripStops = next;
  }

  function toggleExpand(tripId: string) {
    if (expandedTripId === tripId) {
      expandedTripId = null;
      return;
    }
    expandedTripId = tripId;
    loadTripStops(tripId);
  }

  // Lazy-load the weekly pattern on first Week-tab open or on
  // direction change. Direction is captured in `weeklyDirection`
  // so we know when to invalidate.
  $effect(() => {
    if (view !== 'week') return;
    if (direction == null) return;
    if (weeklyDirection === direction && weekly != null) return;
    if (weeklyLoading) return;
    weeklyLoading = true;
    weekly = null;
    weeklyDirection = direction;
    const rid = routeId;
    const dir = direction;
    (async () => {
      try {
        const repo = getGtfsRepo();
        weekly = await repo.getWeeklySchedule(rid, dir);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      } finally {
        weeklyLoading = false;
      }
    })();
  });

  // ── Derived view-model ──────────────────────────────────────────────
  const trips = $derived(
    direction === 0 ? tripsByDir[0]
    : direction === 1 ? tripsByDir[1]
    : [],
  );
  // The trip whose timeline drives the header (origin name + headsign)
  // and the 'Next trip' tab.
  const nextTripId = $derived(trips[0]?.tripId ?? null);
  const focusStops = $derived(nextTripId ? tripStops.get(nextTripId) ?? [] : []);
  const originStopName = $derived(focusStops[0]?.stopName ?? null);
  const headsign = $derived(focusStops[focusStops.length - 1]?.stopName ?? null);
  const nowMin = $derived(minSinceMidnightInTz(nowTicker.ms, tz));
  // Which day-of-week column (Mon–Fri / Saturday / Sunday) corresponds
  // to 'today' in the feed's timezone. Used by the Week table to keep
  // today's column full-color and grey the other two.
  const todayCol = $derived.by<'weekday' | 'saturday' | 'sunday'>(() => {
    const dow = dayOfWeekInTz(nowTicker.ms, tz);
    if (dow === 0) return 'sunday';
    if (dow === 6) return 'saturday';
    return 'weekday';
  });

  // Tab availability: 'next-trip' needs a direction + a resolved
  // next-trip stop list; otherwise the row would be empty.
  const canShowNextTrip = $derived(direction != null && focusStops.length > 0);
  const tabItems = $derived(
    canShowNextTrip
      ? [
          { value: 'next-trip', label: 'Next trip' },
          { value: 'today', label: 'Today' },
          { value: 'tomorrow', label: 'Tomorrow' },
          { value: 'week', label: 'Week' },
        ]
      : [
          { value: 'today', label: 'Today' },
          { value: 'tomorrow', label: 'Tomorrow' },
          { value: 'week', label: 'Week' },
        ],
  );

  const isFav = $derived(route ? favoritesStore.has(route.id) : false);

  // ── Title / subtitle ────────────────────────────────────────────────
  // Title is the origin station — that's what THIS schedule is about
  // ("departures from Biserica Câmpului"). The route badge on the
  // left already carries the route identity; the subtitle confirms
  // the destination.
  const headerTitle = $derived(
    originStopName
    ?? (route ? `${vehicleTypeLabel(route.type ?? 'unknown')} ${route.shortName}` : ''),
  );
  const headerSubtitle = $derived(
    direction != null && headsign ? `→ ${headsign}` : null,
  );

  // ── Helpers (UI-only) ───────────────────────────────────────────────
  // Relative-time text + urgency class for a scheduled minute-since-
  // midnight value. Urgency rule lives in the domain (`scheduleUrgency`);
  // the 'Departing' label is the same convention StationCard uses for
  // the departing-bucket vehicle row.
  function relText(min: number): string {
    const delta = min - nowMin;
    if (delta < 1 && delta > -1) return 'Departing';
    return formatRelativeMin(delta);
  }
  function relClass(min: number): string {
    return urgencyClass(scheduleUrgency(min - nowMin));
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
    if (direction == null) return;
    navigateWith({ dir: direction === 0 ? '1' : '0' });
  }
  function pickView(v: View) {
    // 'today' is the default — don't pollute the URL with it.
    navigateWith({ view: v === 'today' ? null : v });
  }
</script>

<!-- One stop-timeline renderer reused by the 'Next trip' tab AND the
     expanded rows of the Today/Tomorrow accordion. Row 1 is the
     origin departure; the rest are arrivals. -->
{#snippet tripTimeline(stops: ScheduleTripStop[])}
  <Stack spacing={0.5}>
    {#each stops as s, i (s.stopId)}
      {@const isOrigin = i === 0}
      <Stack
        direction="row"
        spacing={1}
        align="center"
        class="px-2 py-1 rounded-md hover:bg-[color:var(--color-border)]/30"
      >
        <Chip size="small" class="font-mono shrink-0">{i + 1}</Chip>
        <Typography variant="body2" class="flex-1 truncate">
          {s.stopName}
        </Typography>
        {#if isOrigin}
          <Typography variant="caption" class={`font-mono shrink-0 ${relClass(s.arrivalMin)}`}>
            {relText(s.arrivalMin)}
          </Typography>
        {/if}
        <Typography variant="caption" class="text-[color:var(--color-fg-muted)] font-mono shrink-0">
          {isOrigin ? 'dep' : 'arr'} {formatHHMM(s.arrivalMin)}
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
{/snippet}

<!-- Weekly schedule view: rendered as a true matrix table so a
     given clock time lines up horizontally across day columns.
     Today's column stays full-color; the other two are greyed so
     the user reads 'this is what runs today' at a glance. Within
     today's column, times that have already passed are also greyed. -->
{#snippet weekColumns()}
  {#if weekly == null}
    <Stack direction="row" spacing={1} align="center" class="py-2">
      <Spinner size={14} />
      <Typography variant="caption" class="text-[color:var(--color-fg-muted)]">
        Loading weekly schedule…
      </Typography>
    </Stack>
  {:else}
    {@const allTimes = Array.from(new Set([
      ...weekly.weekday, ...weekly.saturday, ...weekly.sunday,
    ])).sort((a, b) => a - b)}
    {@const weekdaySet = new Set(weekly.weekday)}
    {@const saturdaySet = new Set(weekly.saturday)}
    {@const sundaySet = new Set(weekly.sunday)}
    {#if allTimes.length === 0}
      <Typography variant="caption" class="text-[color:var(--color-fg-muted)] py-2">
        No service defined for this direction in calendar.txt.
      </Typography>
    {:else}
      <table class="week-table">
        <thead>
          <tr>
            <th class={todayCol === 'weekday' ? 'today' : 'other'}>
              Mon–Fri
              <span class="count">({weekly.weekday.length})</span>
            </th>
            <th class={todayCol === 'saturday' ? 'today' : 'other'}>
              Saturday
              <span class="count">({weekly.saturday.length})</span>
            </th>
            <th class={todayCol === 'sunday' ? 'today' : 'other'}>
              Sunday
              <span class="count">({weekly.sunday.length})</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {#each allTimes as t (t)}
            <tr>
              {#each [
                { col: 'weekday', has: weekdaySet.has(t) },
                { col: 'saturday', has: saturdaySet.has(t) },
                { col: 'sunday', has: sundaySet.has(t) },
              ] as cell (cell.col)}
                {@const isToday = cell.col === todayCol}
                {@const isPast = isToday && t < nowMin - 1}
                <td class={`${isToday ? 'today' : 'other'} ${isPast ? 'past' : ''}`}>
                  {cell.has ? formatHHMM(t) : '—'}
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  {/if}
{/snippet}

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
  {:else if route == null}
    <Card><CardContent>
      <Stack direction="row" spacing={1} align="center">
        <Spinner size={16} />
        <Typography variant="caption">Loading schedule…</Typography>
      </Stack>
    </CardContent></Card>
  {:else}
    <Stack spacing={2}>
      <!-- Header: route badge + origin title + headsign subtitle +
           night chip + dir-swap. -->
      <Card>
        <CardContent>
          <Stack direction="row" spacing={1.5} align="center" wrap>
            <RouteBadge route={route} size="large" isFavorite={isFav} />
            <Stack spacing={0.25} class="flex-1 min-w-0">
              <Stack direction="row" spacing={1} align="center" wrap>
                <Typography variant="h5" class="truncate">{headerTitle}</Typography>
                {#if nightRoute}
                  <Chip size="small" variant="outlined">
                    {#snippet icon()}<Moon size={12} />{/snippet}
                    Night
                  </Chip>
                {/if}
              </Stack>
              {#if headerSubtitle}
                <Typography variant="caption" class="text-[color:var(--color-fg-muted)] truncate">
                  {headerSubtitle}
                </Typography>
              {/if}
            </Stack>
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
        <!-- Single-direction: tabs + one content card. -->
        <ToggleGroup
          value={view}
          onchange={(v) => pickView(v as View)}
          items={tabItems}
        />

        <Card>
          <CardContent>
            {#if view === 'next-trip' && focusStops.length > 0}
              <!-- Stop timeline for the next upcoming trip. -->
              {@render tripTimeline(focusStops)}
            {:else if view === 'week'}
              <!-- Weekly pattern: three columns for Mon–Fri / Sat / Sun
                   showing every scheduled departure from the origin in
                   the selected direction. Recurring pattern, not a
                   specific date — calendar_dates exceptions are
                   ignored by design. -->
              {@render weekColumns()}
            {:else}
              <!-- Today / Tomorrow: one row per trip, click to expand
                   the stop timeline below the row. Tomorrow gets a
                   first/last summary above the list so the card
                   isn't a wall of times with no orientation. -->
              <Stack spacing={0.5}>
                {#if trips.length === 0}
                  <Typography variant="body2" class="text-[color:var(--color-fg-muted)] py-2">
                    No more departures {view === 'tomorrow' ? 'tomorrow morning' : 'today'}.
                  </Typography>
                {:else}
                  {#if view === 'tomorrow'}
                    <Typography variant="caption" class="text-[color:var(--color-fg-muted)] pb-1">
                      Showing morning only (until 12:00) ·
                      {trips.length} departure{trips.length === 1 ? '' : 's'} ·
                      {formatHHMM(trips[0].tripStartMin)}–{formatHHMM(trips[trips.length - 1].tripStartMin)}
                    </Typography>
                  {/if}
                  {#each trips as t (t.tripId)}
                    {@const isOpen = expandedTripId === t.tripId}
                    {@const stops = tripStops.get(t.tripId)}
                    <Stack spacing={0}>
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        onclick={() => toggleExpand(t.tripId)}
                        class="flex items-center gap-2 px-2 py-1 rounded-md transition-colors text-left text-[color:var(--color-fg)] hover:bg-[color:var(--color-border)]/30"
                      >
                        <Chip size="small" class="font-mono shrink-0">{formatHHMM(t.tripStartMin)}</Chip>
                        <span class={`flex-1 min-w-0 text-xs ${relClass(t.tripStartMin)}`}>
                          {#if view === 'today'}{relText(t.tripStartMin)}{/if}
                        </span>
                        <ChevronDown
                          size={16}
                          class={`shrink-0 transition-transform text-[color:var(--color-fg-muted)] ${isOpen ? 'rotate-180' : ''}`}
                        />
                      </button>
                      {#if isOpen}
                        <div class="pl-2 pr-1 pb-2 pt-1">
                          {#if stops == null}
                            <Stack direction="row" spacing={1} align="center" class="px-2 py-1">
                              <Spinner size={14} />
                              <Typography variant="caption" class="text-[color:var(--color-fg-muted)]">
                                Loading stops…
                              </Typography>
                            </Stack>
                          {:else}
                            {@render tripTimeline(stops)}
                          {/if}
                        </div>
                      {/if}
                    </Stack>
                  {/each}
                {/if}
              </Stack>
            {/if}
          </CardContent>
        </Card>
      {:else}
        <!-- Multi-direction view: keep two-column side-by-side, same
             compact row design as the single-direction Today list. -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          {#each [0, 1] as dir (dir)}
            {@const dirTrips = dir === 0 ? tripsByDir[0] : tripsByDir[1]}
            {@const dirHeadsign = dirTrips[0]?.headsign ?? null}
            <Card>
              <CardContent>
                <Stack spacing={0.5}>
                  <Stack direction="row" spacing={1} align="center" justify="between">
                    <Typography variant="h6" class="truncate flex-1 min-w-0">
                      {dirHeadsign ? `→ ${dirHeadsign}` : `Direction ${dir}`}
                    </Typography>
                    <a
                      href={`/schedule/route/${routeId}?dir=${dir}`}
                      class="text-xs underline text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)] shrink-0"
                    >
                      Full view
                    </a>
                  </Stack>
                  {#if dirTrips.length === 0}
                    <Typography variant="body2" class="text-[color:var(--color-fg-muted)] py-2">
                      No upcoming departures.
                    </Typography>
                  {:else}
                    {#each dirTrips as t (t.tripId)}
                      <Stack direction="row" spacing={1} align="center" class="px-2 py-1">
                        <Chip size="small" class="font-mono shrink-0">{formatHHMM(t.tripStartMin)}</Chip>
                        <span class={`flex-1 min-w-0 text-xs ${relClass(t.tripStartMin)}`}>
                          {relText(t.tripStartMin)}
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
  /* Grid utilities — Tailwind doesn't ship the breakpoint classes in
     this project's setup, write the minimum we need inline. */
  .grid { display: grid; }
  .grid-cols-1 { grid-template-columns: 1fr; }
  .gap-3 { gap: 0.75rem; }
  @media (min-width: 768px) {
    .md\:grid-cols-2 { grid-template-columns: 1fr 1fr; }
  }

  /* Weekly schedule matrix table. Rows are unique HH:MM values across
     all three day-columns; a missing cell shows an em-dash so the
     pattern reads at a glance. Today's column stays at full opacity
     and uses the foreground color; the other two columns plus any
     already-passed time in today's column are muted. */
  .week-table {
    width: 100%;
    border-collapse: collapse;
    font-variant-numeric: tabular-nums;
  }
  .week-table th,
  .week-table td {
    text-align: center;
    padding: 0.25rem 0.5rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.8125rem;
  }
  .week-table th {
    font-weight: 600;
    border-bottom: 1px solid color-mix(in srgb, var(--color-border) 70%, transparent);
    position: sticky;
    top: 0;
    background: var(--color-surface);
  }
  .week-table th .count {
    color: var(--color-fg-muted);
    font-weight: 400;
    margin-left: 0.25rem;
  }
  .week-table tbody tr:nth-child(even) td {
    background: color-mix(in srgb, var(--color-border) 18%, transparent);
  }
  .week-table .today {
    color: var(--color-fg);
  }
  .week-table .other {
    color: var(--color-fg-muted);
    opacity: 0.55;
  }
  .week-table .past {
    color: var(--color-fg-muted);
    text-decoration: line-through;
    text-decoration-color: color-mix(in srgb, var(--color-fg-muted) 50%, transparent);
    opacity: 0.7;
  }
</style>
