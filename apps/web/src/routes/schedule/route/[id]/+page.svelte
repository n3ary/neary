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
  import { ArrowRightLeft, ExternalLink, Moon } from 'lucide-svelte';
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

  type View = 'this-trip' | 'today' | 'tomorrow';
  const view = $derived<View>(() => {
    const v = page.url.searchParams.get('view');
    if (v === 'today' || v === 'tomorrow' || v === 'this-trip') return v;
    // Default: 'this-trip' if a trip is pinned, otherwise 'today'.
    return focusTripId ? 'this-trip' : 'today';
  });

  // ── Data state ──────────────────────────────────────────────────────
  let route = $state<Route | null>(null);
  // Departures for the day the user is currently viewing. Empty array
  // means "no data fetched yet" OR "no service today" — both render
  // the same empty-state row.
  let tripsByDir = $state<{ 0: ScheduleTrip[]; 1: ScheduleTrip[] }>({ 0: [], 1: [] });
  // Stop timeline for the focused trip. Drives header origin name +
  // origin departure time + the 'this trip' tab.
  let focusStops = $state<ScheduleTripStop[]>([]);
  let error = $state<string | null>(null);

  const tz = $derived(feedsStore.activeTimezone);

  // Night route: Cluj convention is shortName ending in 'N'. Other
  // feeds following the same convention get it for free.
  const isNightRoute = $derived(route ? /n$/i.test(route.shortName) : false);

  // Departures window for the currently-selected view's day.
  const queryParams = $derived.by(() => {
    const nowMs = nowTicker.ms;
    if (view !== 'tomorrow') {
      return {
        localDate: dateKeyInTz(nowMs, tz),
        fromMin: minSinceMidnightInTz(nowMs, tz),
        // Today: 24h window so night routes' 24:00+ trips surface.
        windowMin: isNightRoute ? 24 * 60 : 18 * 60,
      };
    }
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
          focusStops = [];
        } else {
          // Single-direction: schedule for the day + the focused
          // trip's stop list (URL-pinned or next-upcoming). Fetched
          // in parallel for the same reason.
          const trips = await repo.getRouteSchedule(rid, dir, qp.localDate, qp.fromMin, qp.windowMin);
          tripsByDir = dir === 0 ? { 0: trips, 1: [] } : { 0: [], 1: trips };
          const stopsTripId = ftId ?? trips[0]?.tripId ?? null;
          focusStops = stopsTripId ? await repo.getStopsAlongTrip(stopsTripId) : [];
        }
        error = null;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    })();
  });

  // ── Derived view-model ──────────────────────────────────────────────
  const trips = $derived(
    direction === 0 ? tripsByDir[0]
    : direction === 1 ? tripsByDir[1]
    : [],
  );
  const originStopName = $derived(focusStops[0]?.stopName ?? null);
  const headsign = $derived(focusStops[focusStops.length - 1]?.stopName ?? null);
  const focusStartMin = $derived(focusStops[0]?.arrivalMin ?? null);
  const nowMin = $derived(minSinceMidnightInTz(nowTicker.ms, tz));

  // Tab availability: 'this-trip' needs a direction + at least one
  // trip resolved; disable otherwise so the user can't click into
  // an empty content area.
  const canShowThisTrip = $derived(direction != null && focusStops.length > 0);
  const tabItems = $derived(
    canShowThisTrip
      ? [
          { value: 'this-trip', label: 'This trip' },
          { value: 'today', label: 'Today' },
          { value: 'tomorrow', label: 'Tomorrow' },
        ]
      : [
          { value: 'today', label: 'Today' },
          { value: 'tomorrow', label: 'Tomorrow' },
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

  // ── Helpers ─────────────────────────────────────────────────────────
  function formatHHMM(min: number): string {
    const h = Math.floor(min / 60) % 24;
    const m = Math.round(min % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  /** Relative time ('in 12 min', 'departed 3 min ago', 'now') for a
   *  given today-local minute. Tomorrow trips never call this. */
  function formatRelative(min: number): string {
    const delta = min - nowMin;
    if (delta < -1) return `departed ${-delta} min ago`;
    if (delta < 1) return 'now';
    if (delta < 60) return `in ${delta} min`;
    const h = Math.floor(delta / 60);
    const m = delta % 60;
    return m === 0 ? `in ${h}h` : `in ${h}h ${m}m`;
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
                {#if isNightRoute}
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
              <!-- Trip timeline. Anchor stop (the one the user came
                   from) is the visual focal point. -->
              <Stack spacing={0.5}>
                <Typography variant="overline" class="uppercase tracking-wide text-[color:var(--color-fg-muted)]">
                  This trip
                  {#if focusStartMin != null}
                    · departs {formatHHMM(focusStartMin)} · {formatRelative(focusStartMin)}
                  {/if}
                </Typography>
                {#each focusStops as s, i (s.stopId)}
                  {@const isAnchor = anchorStopId === s.stopId}
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
            {:else}
              <!-- Today / Tomorrow departures list. -->
              <Stack spacing={0.5}>
                {#if trips.length === 0}
                  <Typography variant="body2" class="text-[color:var(--color-fg-muted)] py-2">
                    No more departures {view === 'tomorrow' ? 'tomorrow morning' : 'today'}.
                  </Typography>
                {:else}
                  {#each trips as t (t.tripId)}
                    <a
                      href={`/schedule/route/${routeId}?dir=${direction}${anchorStopId != null ? `&stop=${anchorStopId}` : ''}&trip=${encodeURIComponent(t.tripId)}&view=this-trip`}
                      class="flex items-center gap-2 px-2 py-1 rounded-md transition-colors no-underline text-[color:var(--color-fg)] hover:bg-[color:var(--color-border)]/30"
                    >
                      <Chip size="small" class="font-mono shrink-0">{formatHHMM(t.tripStartMin)}</Chip>
                      <span class="flex-1 min-w-0 text-xs text-[color:var(--color-fg-muted)]">
                        {#if view === 'today'}{formatRelative(t.tripStartMin)}{/if}
                      </span>
                    </a>
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
                        <span class="flex-1 min-w-0 text-xs text-[color:var(--color-fg-muted)]">
                          {formatRelative(t.tripStartMin)}
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
</style>
