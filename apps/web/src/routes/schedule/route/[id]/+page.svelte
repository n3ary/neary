<!--
  Schedule view — by-route, by-direction, with three tabbed sub-views.

  URL: /schedule/route/[id]?dir=0&stop=18&trip=<id>&view=this-trip|today|tomorrow

  Tabs:
    - 'this-trip': stop timeline for a specific trip, origin → terminus,
      with the user's anchor stop highlighted. Enabled only when a
      direction is set.
    - 'today': today's remaining departures from origin.
    - 'tomorrow': tomorrow's morning departures (00:00 → noon).

  The header carries the route badge + origin → headsign in one line;
  the tabs swap a single content card below, so we never duplicate
  headsign or departure-station info on every row.

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
    minSinceMidnightInTz, scheduleWindowFor,
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

  const anchorStopId = $derived.by<number | null>(() => {
    const raw = page.url.searchParams.get('stop');
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  });

  const focusTripId = $derived(page.url.searchParams.get('trip'));

  type View = 'this-trip' | 'today' | 'tomorrow' | 'week';
  const view = $derived.by<View>(() => {
    const v = page.url.searchParams.get('view');
    if (v === 'today' || v === 'tomorrow' || v === 'this-trip' || v === 'week') return v;
    // Default: 'this-trip' if a trip is pinned, otherwise 'today'.
    return focusTripId ? 'this-trip' : 'today';
  });

  // ── Data state ──────────────────────────────────────────────────────
  let route = $state<Route | null>(null);
  // Departures for the day the user is currently viewing. Empty array
  // means "no data fetched yet" OR "no service today" — both render
  // the same empty-state row.
  let tripsByDir = $state<{ 0: ScheduleTrip[]; 1: ScheduleTrip[] }>({ 0: [], 1: [] });
  // Per-trip stop timelines. One source of truth for both the
  // "This trip" tab and inline row expansion in Today/Tomorrow.
  let tripStops = $state<Map<string, ScheduleTripStop[]>>(new Map());
  // Which row is open in the Today/Tomorrow accordion. Seeded from
  // ?trip= so deep-links auto-expand.
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
    const ftId = focusTripId;
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
          // Single-direction: schedule for the day + the focused
          // trip's stop list (URL-pinned or next-upcoming). Fetched
          // in parallel for the same reason.
          const trips = await repo.getRouteSchedule(rid, dir, qp.localDate, qp.fromMin, qp.windowMin);
          tripsByDir = dir === 0 ? { 0: trips, 1: [] } : { 0: [], 1: trips };
          const stopsTripId = ftId ?? trips[0]?.tripId ?? null;
          if (stopsTripId) await loadTripStops(stopsTripId);
        }
        error = null;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    })();
  });

  // Auto-expand the row pinned by ?trip= so deep links from a
  // vehicle row land on a pre-opened accordion.
  $effect(() => {
    expandedTripId = focusTripId;
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
  // The trip whose timeline drives the header (origin name + headsign).
  // Falls back to the next-upcoming trip when no `?trip=` is pinned.
  const headerTripId = $derived(focusTripId ?? trips[0]?.tripId ?? null);
  const focusStops = $derived(headerTripId ? tripStops.get(headerTripId) ?? [] : []);
  const originStopName = $derived(focusStops[0]?.stopName ?? null);
  const headsign = $derived(focusStops[focusStops.length - 1]?.stopName ?? null);
  const nowMin = $derived(minSinceMidnightInTz(nowTicker.ms, tz));

  // Tab availability: 'this-trip' needs a direction + at least one
  // trip resolved; disable otherwise so the user can't click into
  // an empty content area.
  const canShowThisTrip = $derived(direction != null && focusStops.length > 0);
  // 'This trip' label only applies when a specific trip was pinned via
  // ?trip= (i.e. the user came from a vehicle row on a station). When
  // no trip is pinned we're really previewing the next upcoming trip,
  // so the label reads accordingly.
  const thisTripLabel = $derived(focusTripId ? 'This trip' : 'Next trip');
  const tabItems = $derived(
    canShowThisTrip
      ? [
          { value: 'this-trip', label: thisTripLabel },
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
    // Dropping `stop` is intentional: the anchor stop only exists in
    // the original direction's stop list. Forward/back keeps the user
    // oriented if they want to return.
    navigateWith({ dir: direction === 0 ? '1' : '0', trip: null, stop: null });
  }
  function pickView(v: View) {
    // Switching AWAY from 'this-trip' drops the trip pin so the URL
    // stays meaningful (you're no longer viewing a specific bus).
    // Switching TO 'this-trip' keeps the existing pin if any.
    navigateWith({
      view: v === 'today' ? null : v,
      trip: v === 'this-trip' ? focusTripId : null,
    });
  }
</script>

<!-- One stop-timeline renderer reused by the "This trip" tab AND the
     expanded rows of the Today/Tomorrow accordion. Row 1 is the
     origin departure; the rest are arrivals. The anchor stop (the
     one the user came from on a vehicle row) is the focal point. -->
{#snippet tripTimeline(stops: ScheduleTripStop[], anchorId: number | null)}
  <Stack spacing={0.5}>
    {#each stops as s, i (s.stopId)}
      {@const isAnchor = anchorId === s.stopId}
      {@const isOrigin = i === 0}
      <Stack
        direction="row"
        spacing={1}
        align="center"
        class={`px-2 py-1 rounded-md ${isAnchor ? 'bg-[color:var(--color-primary)]/20 ring-2 ring-[color:var(--color-primary)]' : 'hover:bg-[color:var(--color-border)]/30'}`}
      >
        <Chip size="small" class="font-mono shrink-0">{i + 1}</Chip>
        <Typography
          variant="body2"
          class={`flex-1 truncate ${isAnchor ? 'font-bold' : ''}`}
        >
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

<!-- Weekly schedule view: Mon-Fri / Sat / Sun side by side. Empty
     columns get a dash so missing service is explicit instead of
     hidden. Times use formatHHMM (wraps 24h+ for night routes). -->
{#snippet weekColumns()}
  {#if weekly == null}
    <Stack direction="row" spacing={1} align="center" class="py-2">
      <Spinner size={14} />
      <Typography variant="caption" class="text-[color:var(--color-fg-muted)]">
        Loading weekly schedule…
      </Typography>
    </Stack>
  {:else}
    <div class="grid grid-cols-3 gap-3">
      {#each [
        { label: 'Mon–Fri', times: weekly.weekday },
        { label: 'Saturday', times: weekly.saturday },
        { label: 'Sunday', times: weekly.sunday },
      ] as col (col.label)}
        <Stack spacing={0.5}>
          <Typography variant="overline" class="uppercase tracking-wide text-[color:var(--color-fg-muted)]">
            {col.label} {col.times.length > 0 ? `(${col.times.length})` : ''}
          </Typography>
          {#if col.times.length === 0}
            <Typography variant="caption" class="text-[color:var(--color-fg-muted)] py-1">
              No service
            </Typography>
          {:else}
            {#each col.times as min (min)}
              <Typography variant="caption" class="font-mono">
                {formatHHMM(min)}
              </Typography>
            {/each}
          {/if}
        </Stack>
      {/each}
    </div>
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
            {#if view === 'this-trip' && focusStops.length > 0}
              <!-- The anchor stop the user came from is the focal point. -->
              {@render tripTimeline(focusStops, anchorStopId)}
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
                            {@render tripTimeline(stops, anchorStopId)}
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
  .grid-cols-3 { grid-template-columns: 1fr 1fr 1fr; }
  .gap-3 { gap: 0.75rem; }
  @media (min-width: 768px) {
    .md\:grid-cols-2 { grid-template-columns: 1fr 1fr; }
  }
</style>
