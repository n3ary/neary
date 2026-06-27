<!--
  Schedule view — by-route, by-direction.

  URL shape (path segments only — no query string):
    /schedule/route/[id]                       multi-direction view
    /schedule/route/[id]_0|[id]_1              single-direction view, today
    /schedule/route/[id]_0|[id]_1/[view]       single-direction, explicit tab

  Where [view] is one of: tomorrow | week. 'today' is the default and
  never appears in the URL.

  Path-based instead of ?dir=&view= because query strings tripped the
  dev WebSocket suspension on iOS Safari and because deep links read
  cleanly without the extra punctuation. The trailing _0/_1 suffix on
  the id segment is a pragmatic compromise: GTFS allows any text in
  route_id, but the Cluj feed (and most agencies) don't use underscores
  in ids. If a feed ever does, we'll switch the separator.

  Tabs:
    - 'today':    today's remaining departures + last departed row (default).
    - 'tomorrow': tomorrow's morning departures (00:00 → noon).
    - 'week':     recurring weekly pattern (Mon-Fri / Sat / Sun).

  Multi-direction mode (no dir suffix) keeps a two-column side-by-side
  layout. Used by /favorites.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { ArrowRightLeft, ChevronDown, Map as MapIcon, Moon } from 'lucide-svelte';
  import {
    BackButton, Card, CardContent, Chip, IconButton, NoFeedState, RouteBadge, Spinner,
    Stack, ToggleGroup, TripStopList, Typography,
  } from '$lib/ui';
  import { getGtfsRepo } from '$lib/data/gtfs/repo';
  import { useOtherDirectionExists } from '$lib/data/gtfs/otherDirectionExists.svelte';
  import { parseRouteIdWithDirection } from '$lib/data/gtfs/parseRouteIdWithDirection';
  import type { Route } from '$lib/domain/types';
  import {
    formatHHMM, formatRelativeMin, isNightRoute, vehicleTypeLabel,
  } from '$lib/domain/types';
  import { scheduleUrgency } from '$lib/domain/buckets';
  import { urgencyClass } from '$lib/ui/urgencyClass';
  import type {
    RouteDirectionEndpoints, ScheduleTrip, ScheduleTripStop, WeeklySchedule,
  } from '$lib/data/gtfs/types';
  import {
    dayOfWeekInTz, minSinceMidnightInTz, scheduleWindowFor,
  } from '$lib/domain/pipeline/timeUtils';
  import { feedsStore } from '$lib/stores/feedsStore.svelte';
  import { favoritesStore } from '$lib/stores/favoritesStore.svelte';
  import { nowTicker } from '$lib/stores/nowTicker.svelte';
  import { refreshBus } from '$lib/stores/refreshBus.svelte';
  import { userPrefs } from '$lib/stores/userPrefs.svelte';

  // ── URL params ──────────────────────────────────────────────────────
  // The `id` segment carries both route id and (optional) direction:
  //   '40'    → route 40, multi-direction
  //   '40_0'  → route 40, direction 0
  //   '40_1'  → route 40, direction 1
  // Anything else (or no suffix) means multi-direction, so a malformed
  // URL never half-renders a single-direction view.
  const idSegment = $derived(page.params.id ?? '');
  const parsed = $derived(parseRouteIdWithDirection(idSegment));
  const routeId = $derived(parsed.routeId);
  const direction = $derived(parsed.direction);
  const routeIdValid = $derived(routeId.length > 0);

  type View = 'today' | 'tomorrow' | 'week';
  const view = $derived.by<View>(() => {
    const v = page.params.view;
    if (v === 'today' || v === 'tomorrow' || v === 'week') return v;
    // Back-compat for old links that used ?view=next-trip or ?view=this-trip.
    return 'today';
  });

  // ── Data state ──────────────────────────────────────────────────────
  let route = $state<Route | null>(null);
  // Departures for the day the user is currently viewing. Empty array
  // means "no data fetched yet" OR "no service today" — both render
  // the same empty-state row.
  let tripsByDir = $state<{ 0: ScheduleTrip[]; 1: ScheduleTrip[] }>({ 0: [], 1: [] });
  // Which view's window the trips above came from. Lets the
  // auto-swap effect tell 'today returned empty' apart from
  // 'fetch hasn't run yet'. Reset to null on each new request,
  // set to the view at the end of the IIFE.
  let fetchedView = $state<View | null>(null);
  // One-shot guard so the auto-redirect doesn't fight the user if
  // they manually navigate back to today after we swapped them.
  let autoSwapped = $state(false);
  // Per-trip stop timelines. Drives the inline row expansion in Today/Tomorrow.
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
  // Last departed trip on today's tab: non-expandable separator row shown above upcoming trips.
  let lastDepartedTrip = $state<ScheduleTrip | null>(null);
  // Whether the week table is fully expanded (showing all times including past ones).
  let weekExpanded = $state(false);
  // Guard kept for back-compat but auto-expand is intentionally disabled — trips start collapsed.
  let todayAutoExpanded = $state(true);
  // Whether the today list is expanded past the initial visible window.
  let todayListExpanded = $state(false);
  // Max upcoming trips shown before the "show more" button appears.
  const TODAY_TRIP_LIMIT = 5;

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
      view: view === 'week' ? 'today' : (view as 'today' | 'tomorrow'),
      isNight: nightRoute,
      nowMs: nowTicker.ms,
      timeZone: tz,
    }),
  );

  // Reset expansion state whenever view or direction changes.
  $effect(() => {
    view; direction; // reactive dependencies only — no logic here
    todayListExpanded = false;
    lastDepartedTrip = null;
  });

  $effect(() => {
    const fid = feedsStore.boundFeedId;
    if (!fid || !routeIdValid) return;
    refreshBus.tick;
    const rid = routeId;
    const dir = direction;
    const qp = queryParams;
    const v = view;
    fetchedView = null;
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
          // Single-direction: fetch upcoming trips + warm the first trip's stops.
          const trips = await repo.getRouteSchedule(rid, dir, qp.localDate, qp.fromMin, qp.windowMin);
          tripsByDir = dir === 0 ? { 0: trips, 1: [] } : { 0: [], 1: trips };
          const stopsTripId = trips[0]?.tripId ?? null;
          if (stopsTripId) await loadTripStops(stopsTripId);

          if (v === 'today') {
            // Fetch the most recently departed trip (up to 2 h back) to show
            // as the non-expandable "Departed" separator row above upcoming trips.
            if (qp.fromMin > 0) {
              const pastWindow = Math.min(120, qp.fromMin);
              const pastFrom = qp.fromMin - pastWindow;
              const pastTrips = await repo.getRouteSchedule(rid, dir, qp.localDate, pastFrom, pastWindow);
              lastDepartedTrip = pastTrips.filter(t => t.tripStartMin < qp.fromMin).pop() ?? null;
            }
          }
        }
        fetchedView = v;
        error = null;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    })();
  });

  // Smart default: when the user lands without an explicit ?view in
  // the URL AND today returned no remaining departures, swap them
  // to tomorrow once. Skips when the user explicitly chose 'today'
  // (page.params.view !== undefined) so we don't override an
  // intentional click. One-shot via `autoSwapped` so a later manual
  // navigation back to today is respected.
  $effect(() => {
    if (autoSwapped) return;
    if (direction == null) return;
    if (page.params.view != null) return;
    if (view !== 'today') return;
    if (fetchedView !== 'today') return; // wait for today's fetch
    if (tripsByDir[direction].length > 0) return;
    autoSwapped = true;
    goto(`/schedule/route/${routeId}_${direction}/tomorrow`, { replaceState: true });
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
    weekExpanded = false;
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
  // First upcoming trip's stops — used as a fallback for the header when
  // the endpoints query hasn't returned yet.
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

  const tabItems = [
    { value: 'today', label: 'Today' },
    { value: 'tomorrow', label: 'Tomorrow' },
    { value: 'week', label: 'Week' },
  ];

  // Today: only first TODAY_TRIP_LIMIT upcoming trips are shown initially.
  // Derived here so the template stays free of slicing / comparison logic.
  const todayVisibleTrips = $derived(
    view === 'today' && !todayListExpanded ? trips.slice(0, TODAY_TRIP_LIMIT) : trips,
  );
  const todayHiddenCount = $derived(
    view === 'today' ? Math.max(0, trips.length - TODAY_TRIP_LIMIT) : 0,
  );

  const isFav = $derived(route ? favoritesStore.has(route.id) : false);

  // ── Week-table derived ──────────────────────────────────────────────
  // All unique departure minutes across the three day-patterns, sorted.
  // Lives in the script so the weekColumns snippet is pure markup.
  const weekAllTimes = $derived.by<number[]>(() => {
    if (!weekly) return [];
    return Array.from(new Set([...weekly.weekday, ...weekly.saturday, ...weekly.sunday]))
      .sort((a, b) => a - b);
  });
  const weekdaySet = $derived(new Set(weekly?.weekday ?? []));
  const saturdaySet = $derived(new Set(weekly?.saturday ?? []));
  const sundaySet  = $derived(new Set(weekly?.sunday  ?? []));
  // The set for today's column — drives the "first upcoming" search.
  const weekTodaySet = $derived<Set<number>>(
    todayCol === 'weekday' ? weekdaySet : todayCol === 'saturday' ? saturdaySet : sundaySet,
  );
  // Index of the first time in today's column that is ≥ nowMin.
  // When no such time exists (service over for today), collapse to 0
  // so the full table is visible rather than collapsing to an empty tail.
  const weekCollapseAt = $derived.by(() => {
    const idx = weekAllTimes.findIndex(t => weekTodaySet.has(t) && t >= nowMin);
    return idx <= 0 ? 0 : idx;
  });
  const weekHiddenCount = $derived(weekCollapseAt);
  const weekVisibleTimes = $derived(weekExpanded ? weekAllTimes : weekAllTimes.slice(weekCollapseAt));

  // ── Title / subtitle ────────────────────────────────────────────────
  // Title is the origin station — that's what THIS schedule is about
  // ("departures from Biserica Câmpului"). The route badge on the
  // left already carries the route identity; the subtitle confirms
  // the destination.
  //
  // Endpoints come from a dedicated worker call keyed on
  // (routeId, direction) — they're stable across days / windows so
  // the header paints the moment the page mounts, before (and
  // independent of) the day's trip fetches. focusStops is the
  // fallback in the unlikely case the endpoints query returns null
  // (e.g. a route+direction with zero trips defined in calendar).
  let endpoints = $state<RouteDirectionEndpoints | null>(null);
  $effect(() => {
    const fid = feedsStore.boundFeedId;
    if (!fid || direction == null || !routeIdValid) {
      endpoints = null;
      return;
    }
    const rid = routeId;
    const dir = direction;
    endpoints = null;
    (async () => {
      try {
        const repo = getGtfsRepo();
        endpoints = await repo.getRouteDirectionEndpoints(rid, dir);
      } catch {
        // Header just falls back to focusStops + the route-badge label.
      }
    })();
  });

  const displayOrigin = $derived(endpoints?.originName ?? originStopName ?? null);
  const displayHeadsign = $derived(endpoints?.terminusName ?? headsign ?? null);
  const headerTitle = $derived(
    displayOrigin
    ?? (route ? `${vehicleTypeLabel(route.type ?? 'unknown')} ${route.shortName}` : ''),
  );
  const headerSubtitle = $derived(
    direction != null && displayHeadsign ? `→ ${displayHeadsign}` : null,
  );

  // ── Helpers (UI-only) ───────────────────────────────────────────────
  // Relative-time text + urgency class for a scheduled minute-since-
  // midnight value. Urgency rule lives in the domain (`scheduleUrgency`);
  // the 'Departing' label is the same convention StationCard uses for
  // the departing-bucket vehicle row.
  //
  // Trip start times are minutes-since-midnight of the view's *target*
  // calendar day, which is tomorrow for the Tomorrow tab. nowMin is
  // always today's frame, so we shift the trip value by 24h when the
  // view is Tomorrow before computing the delta \u2014 otherwise a
  // tomorrow-23:00 trip displays as '16 min ago' against a
  // today-23:16 clock instead of the ~24h-away truth.
  const viewDayOffsetMin = $derived(view === 'tomorrow' ? 24 * 60 : 0);
  function relText(min: number): string {
    const delta = min + viewDayOffsetMin - nowMin;
    if (delta < 1 && delta > -1) return 'Departing';
    return formatRelativeMin(delta, min);
  }
  function relClass(min: number): string {
    return urgencyClass(scheduleUrgency(min + viewDayOffsetMin - nowMin));
  }

  // Build a /schedule/route/... URL from the structured params and
  // navigate. Any null direction collapses to multi-direction mode;
  // 'today' view collapses to the bare URL.
  //
  // History rule: navigating WITHIN the same route (tab swap, dir
  // swap) replaces the current history entry, so the page-level
  // BackButton walks the user back to wherever they came from
  // BEFORE entering this schedule view — not through every tab
  // they touched. Cross-route nav (rare here) pushes a new entry.
  function navigateTo(opts: { routeId?: string; direction?: 0 | 1 | null; view?: View }) {
    const rId = opts.routeId ?? routeId;
    const dir = opts.direction !== undefined ? opts.direction : direction;
    const v = opts.view ?? view;
    const id = dir == null ? rId : `${rId}_${dir}`;
    const path = v === 'today' || dir == null ? `/schedule/route/${id}` : `/schedule/route/${id}/${v}`;
    const sameRoute = rId === routeId;
    goto(path, { replaceState: sameRoute });
  }
  function swapDirection() {
    if (direction == null) return;
    navigateTo({ direction: direction === 0 ? 1 : 0 });
  }
  function pickView(v: View) {
    navigateTo({ view: v });
  }

  // Reactive gate for the Swap-direction button: greys out when the
  // opposite direction has no trips on this route (one-way loops
  // like 15). Shared with the map view via the helper in
  // lib/data/gtfs/otherDirectionExists.svelte.ts.
  const otherDirection = useOtherDirectionExists(
    () => routeId,
    () => direction,
  );
</script>


<!-- Weekly schedule view: rendered as a true matrix table so a
     given clock time lines up horizontally across day columns.
     Today's column stays full-color; the other two are greyed so
     the user reads 'this is what runs today' at a glance. Within
     today's column, times that have already passed are also greyed.
     Rows before today's first upcoming departure are hidden by default;
     an expand button above the table reveals the full history. -->
{#snippet weekColumns()}
  {#if weekly == null}
    <Stack direction="row" spacing={1} align="center" class="py-2">
      <Spinner size={14} />
      <Typography variant="caption" class="text-[color:var(--color-fg-muted)]">
        Loading weekly schedule…
      </Typography>
    </Stack>
  {:else if weekAllTimes.length === 0}
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
        {#if !weekExpanded && weekHiddenCount > 0}
          <tr class="week-expand-row">
            <td colspan="3">
              <button
                type="button"
                onclick={() => { weekExpanded = true; }}
                class="w-full text-xs text-[color:var(--color-primary)] hover:text-[color:var(--color-fg)] py-1"
              >
                ↑ Show {weekHiddenCount} earlier departure{weekHiddenCount !== 1 ? 's' : ''}
              </button>
            </td>
          </tr>
        {/if}
        {#each weekVisibleTimes as t (t)}
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
            <BackButton />
            <RouteBadge route={route} size="large" isFavorite={isFav} />
            <Stack spacing={0.5} class="flex-1 min-w-0">
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
            {#if otherDirection.value !== false}
              <IconButton
                aria-label="Swap direction"
                disabled={direction == null}
                onclick={swapDirection}
              >
                <ArrowRightLeft size={18} />
              </IconButton>
            {/if}
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
            {#if view === 'week'}
              <!-- Weekly pattern: three columns for Mon–Fri / Sat / Sun
                   showing every scheduled departure from the origin in
                   the selected direction. Recurring pattern, not a
                   specific date — calendar_dates exceptions are
                   ignored by design. -->
              {@render weekColumns()}
            {:else}
              <!-- Today / Tomorrow: one row per trip, click to expand
                   the stop timeline below the row. Today also shows a
                   non-expandable "Departed" row at the top for the most
                   recently departed trip. -->
              <Stack spacing={0.5}>
                {#if view === 'today' && lastDepartedTrip != null}
                  <!-- Last departed trip: non-interactive, heavily muted. -->
                  <div class="flex items-center gap-2 px-2 py-1 rounded-md departed-row">
                    <Chip size="small" class="font-mono shrink-0 opacity-50">{formatHHMM(lastDepartedTrip.tripStartMin)}</Chip>
                    <span class="flex-1 min-w-0 text-xs text-[color:var(--color-fg-muted)] italic">Departed</span>
                  </div>
                {/if}
                {#if trips.length === 0}
                  <Stack spacing={1} class="py-1">
                    <Typography variant="body2" class="text-[color:var(--color-fg-muted)]">
                      {view === 'tomorrow' ? 'No departures scheduled tomorrow.' : 'No more departures today.'}
                    </Typography>
                    {#if view === 'today'}
                      <button
                        type="button"
                        onclick={() => pickView('tomorrow')}
                        class="text-sm underline text-[color:var(--color-primary)] hover:text-[color:var(--color-fg)] self-start"
                      >
                        Show tomorrow's schedule →
                      </button>
                    {/if}
                  </Stack>
                {:else}
                  {#each todayVisibleTrips as t, tripIdx (t.tripId)}
                    {@const isOpen = expandedTripId === t.tripId}
                    {@const stops = tripStops.get(t.tripId)}
                    {@const isNext = tripIdx === 0}
                    <Stack spacing={0}>
                      <div class="flex items-center gap-1">
                        <button
                          type="button"
                          aria-expanded={isOpen}
                          onclick={() => toggleExpand(t.tripId)}
                          class="flex flex-1 items-center gap-2 px-2 py-1 rounded-md transition-colors text-left text-[color:var(--color-fg)] hover:bg-[color:var(--color-border)]/30 min-w-0"
                        >
                          <Chip size="small" class="font-mono shrink-0">{formatHHMM(t.tripStartMin)}</Chip>
                          <span class={`flex-1 min-w-0 text-xs ${relClass(t.tripStartMin)}`}>
                            {relText(t.tripStartMin)}
                          </span>
                          <ChevronDown
                            size={16}
                            class={`shrink-0 transition-transform text-[color:var(--color-fg-muted)] ${isOpen ? 'rotate-180' : ''}`}
                          />
                        </button>
                        {#if isNext && direction != null}
                          <a
                            href={`/map/route/${routeId}_${direction}/${encodeURIComponent(t.tripId)}`}
                            aria-label="View on map"
                            title="View on map"
                            class="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-md text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)] hover:bg-[color:var(--color-border)]/40 transition-colors"
                          >
                            <MapIcon size={15} />
                          </a>
                        {/if}
                      </div>
                      {#if isOpen}
                        <div class="mt-1 mb-1 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface-raised,var(--color-surface))] py-1">
                          {#if stops == null}
                            <Stack direction="row" spacing={1} align="center" class="px-2 py-1">
                              <Spinner size={14} />
                              <Typography variant="caption" class="text-[color:var(--color-fg-muted)]">
                                Loading stops…
                              </Typography>
                            </Stack>
                          {:else}
                            <TripStopList stops={stops} showDepartureMarker />
                          {/if}
                        </div>
                      {/if}
                    </Stack>
                  {/each}
                  {#if todayHiddenCount > 0 && !todayListExpanded}
                    <button
                      type="button"
                      onclick={() => { todayListExpanded = true; }}
                      class="text-sm underline text-[color:var(--color-primary)] hover:text-[color:var(--color-fg)] px-2 py-1 text-left"
                    >
                      Show {todayHiddenCount} more departure{todayHiddenCount !== 1 ? 's' : ''}
                    </button>
                  {:else if todayListExpanded && todayHiddenCount > 0}
                    <button
                      type="button"
                      onclick={() => { todayListExpanded = false; }}
                      class="text-sm underline text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)] px-2 py-1 text-left"
                    >
                      Show fewer
                    </button>
                  {/if}
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
                      href={`/schedule/route/${routeId}_${dir}`}
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

  /* Non-expandable "Departed" separator row in the Today list. Visually
     mirrors the week-table .other/.past treatment: heavily muted so it
     reads as background context rather than an actionable item. */
  .departed-row {
    opacity: 0.45;
    pointer-events: none;
    user-select: none;
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
  .week-table .week-expand-row td {
    padding: 0;
    border-bottom: 1px solid var(--color-border);
  }
</style>
