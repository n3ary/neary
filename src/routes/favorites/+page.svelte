<!-- Single picker view listing every route in the bound feed with a heart toggle per row. Favorited rows float to the top, otherwise sorted by short-name (numeric-first, alpha after). No separate "add" surface — this IS the picker. Stations view also shows hearts on favorited badges as visual reinforcement. -->
<script lang="ts">
  import { Calendar, Heart } from 'lucide-svelte';
  import {
    Card, CardContent, Chip, Collapsible, RouteBadge, SelectFeedCard, Spinner, Stack,
    TripStopList, Typography, TypeBadge, cn, iconButtonClass, networkIcon, networkTextColor,
  } from '$lib/ui';
  import { getGtfsRepo } from '$lib/data/gtfs/repo';
  import type { ScheduleTripStop } from '$lib/data/gtfs/types';
  import type { Network, Route, VehicleType } from '$lib/domain/types';
  import { compareRouteShortName, vehicleTypeLabel } from '$lib/domain/types';
  import { scheduleWindowFor } from '$lib/domain/pipeline/timeUtils';
  import { feedsStore } from '$lib/stores/feedsStore.svelte';
  import { favoritesStore } from '$lib/stores/favoritesStore.svelte';
  import { nowTicker } from '$lib/stores/nowTicker.svelte';
  import { userPrefs } from '$lib/stores/userPrefs.svelte';

  let allRoutes = $state<Route[] | null>(null);
  let allNetworks = $state<Network[]>([]);
  let error = $state<string | null>(null);
  // Single-select type filter. null = no filter (show all).
  // Clicking the active type deselects; clicking another selects only that one.
  let typeFilter = $state<VehicleType | null>(null);
  // Single-select network filter. null = no filter.
  let networkFilter = $state<string | null>(null);

  // Expand-stops state. One row open at a time, keyed by route_id.
  // Stops are fetched lazily on first expand and cached per route so
  // collapse + re-expand is instant.
  let expandedRouteId = $state<string | null>(null);
  let routeStops = $state<Map<string, ScheduleTripStop[]>>(new Map());
  let loadingRouteId = $state<string | null>(null);
  let stopsErrorRouteId = $state<string | null>(null);

  const tz = $derived(feedsStore.activeTimezone);

  function toggleType(t: VehicleType) {
    typeFilter = typeFilter === t ? null : t;
  }
  function toggleNetwork(id: string) {
    networkFilter = networkFilter === id ? null : id;
  }

  // Pick a representative trip for the route+direction and fetch its
  // ordered stop list. GTFS allows different trips on the same route
  // to serve different stop sequences (rare but spec-valid), so this
  // shows the sequence of *some* trip running today rather than a
  // canonical route shape. Same heuristic the schedule view uses to
  // warm its first-trip stops panel.
  async function toggleRouteStops(route: Route) {
    if (route.hasSchedule === false) return;
    if (expandedRouteId === route.id) {
      expandedRouteId = null;
      return;
    }
    expandedRouteId = route.id;
    stopsErrorRouteId = null;
    if (routeStops.has(route.id)) return;
    loadingRouteId = route.id;
    try {
      const repo = getGtfsRepo();
      const qp = scheduleWindowFor({
        view: 'today',
        isNight: false,
        nowMs: nowTicker.ms,
        timeZone: tz,
      });
      // Prefer direction 0 today; fall back to direction 1 today;
      // then to a full-day window in case the user opened a route
      // whose service ended hours ago.
      let trips = await repo.getRouteSchedule(route.id, 0, qp.localDate, qp.fromMin, qp.windowMin);
      if (trips.length === 0) {
        trips = await repo.getRouteSchedule(route.id, 1, qp.localDate, qp.fromMin, qp.windowMin);
      }
      if (trips.length === 0) {
        trips = await repo.getRouteSchedule(route.id, 0, qp.localDate, 0, 24 * 60);
      }
      const tripId = trips[0]?.tripId;
      if (!tripId) {
        stopsErrorRouteId = route.id;
        return;
      }
      const stops = await repo.getStopsAlongTrip(tripId);
      const next = new Map(routeStops);
      next.set(route.id, stops);
      routeStops = next;
    } catch {
      stopsErrorRouteId = route.id;
    } finally {
      loadingRouteId = null;
    }
  }

  $effect(() => {
    const fid = feedsStore.boundFeedId;
    if (!fid) return;
    (async () => {
      try {
        const repo = getGtfsRepo();
        [allRoutes, allNetworks] = await Promise.all([
          repo.getRoutes(),
          repo.getNetworks(),
        ]);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    })();
  });

  // Set of types actually present in the feed — we don't render filter
  // bubbles for modes that have zero routes (would just be noise).
  // Ordered by vehicleTypeLabel so the row reads alphabetically.
  const presentTypes = $derived.by<VehicleType[]>(() => {
    if (!allRoutes) return [];
    const set = new Set<VehicleType>();
    for (const r of allRoutes) set.add(r.type ?? 'unknown');
    return Array.from(set).sort((a, b) =>
      vehicleTypeLabel(a).localeCompare(vehicleTypeLabel(b)),
    );
  });

  // Per-type accent for the mode filter chips: just the color of the
  // first route of that type, straight from GTFS. No selection logic,
  // no fallback overrides — whatever the feed shipped is what the
  // chip shows. The data layer substitutes a single neutral fallback
  // (#F3513C, the anchor gtfs uses for feeds with no usable
  // colors) when route_color is missing; that flows through here.
  const colorByType = $derived.by<Map<VehicleType, string>>(() => {
    const m = new Map<VehicleType, string>();
    if (!allRoutes) return m;
    for (const r of allRoutes) {
      const t = r.type ?? 'unknown';
      if (!m.has(t)) m.set(t, r.color);
    }
    return m;
  });

  // Apply both filters, then split into the two cards. Within
  // each section, sort numeric-first then alpha.
  function sortRoutes(list: Route[]): Route[] {
    return [...list].sort((a, b) => compareRouteShortName(a.shortName, b.shortName));
  }
  const filteredRoutes = $derived.by<Route[]>(() => {
    if (!allRoutes) return [];
    return allRoutes.filter((r) => {
      if (typeFilter !== null && (r.type ?? 'unknown') !== typeFilter) return false;
      if (networkFilter !== null && !(r.networks?.includes(networkFilter) ?? false)) return false;
      return true;
    });
  });
  const favRoutes = $derived(
    sortRoutes(filteredRoutes.filter((r) => favoritesStore.has(r.id))),
  );
  const otherRoutes = $derived(
    sortRoutes(filteredRoutes.filter((r) => !favoritesStore.has(r.id) && r.hasSchedule !== false)),
  );
  const noScheduleRoutes = $derived(
    sortRoutes(filteredRoutes.filter((r) => !favoritesStore.has(r.id) && r.hasSchedule === false)),
  );


</script>

<!-- One row-renderer shared by all three sections so the layout stays
     identical between favorited and other routes (KISS / DRY).

     Card chrome mirrors `VehicleCard` so the favorites view reads as
     "rows of route cards" — bordered, padded, distinct — instead of
     a tight list. Tap targets:

       - badge anchor (the largest target on the row) -> map
       - card body                                    -> toggle stops
       - Calendar icon (only when route has schedule) -> schedule view
       - Heart icon                                   -> favorite toggle

     The stops list under the card uses `TripStopList` — same per-stop
     row component the station card renders below a vehicle. Stops are
     fetched lazily on first expand (representative trip of the day in
     direction 0; see `toggleRouteStops`). Routes shipping no schedule
     have no representative trip, so the card is non-expandable. -->
{#snippet routeRow(route: Route)}
  {@const isFav = favoritesStore.has(route.id)}
  {@const type = route.type ?? 'unknown'}
  {@const typeLabel = vehicleTypeLabel(type)}
  {@const primaryLabel = route.longName ?? typeLabel}
  {@const hasSchedule = route.hasSchedule !== false}
  {@const scheduleHref = hasSchedule ? `/schedule/route/${route.id}_0` : null}
  {@const mapHref = `/map/route/${route.id}_0`}
  {@const expandable = hasSchedule}
  {@const expanded = expandedRouteId === route.id}
  {@const stops = routeStops.get(route.id)}
  {@const loading = loadingRouteId === route.id}
  {@const failed = stopsErrorRouteId === route.id && expanded && !loading}
  <div>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      role={expandable ? 'button' : undefined}
      tabindex={expandable ? 0 : undefined}
      aria-expanded={expandable ? expanded : undefined}
      onclick={expandable
        ? (e) => {
            // Bail when the click came from an inner link/button so
            // the badge anchor + Calendar link + Heart button don't
            // also flip the expansion. NB: deliberately no
            // stopPropagation on inner anchors — SvelteKit's client
            // router intercepts at document level during bubble, so
            // stopping it forces a full page reload.
            if ((e.target as Element | null)?.closest('a, button')) return;
            toggleRouteStops(route);
          }
        : undefined}
      onkeydown={expandable
        ? (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              if ((e.target as Element | null)?.closest('a, button')) return;
              e.preventDefault();
              toggleRouteStops(route);
            }
          }
        : undefined}
      class={cn(
        'flex items-center gap-3 px-3 py-2 border-2 border-solid rounded-md transition-colors',
        'border-[color:var(--color-border)]',
        expandable && 'cursor-pointer hover:bg-[color:var(--color-border)]/30',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary)]',
      )}
    >
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
    {#if expandable}
      <Collapsible in={expanded} reduced>
        <div class="px-1 pt-1">
          {#if loading}
            <Stack direction="row" spacing={1} align="center" class="px-2 py-1">
              <Spinner size={14} />
              <Typography variant="caption">Loading stops…</Typography>
            </Stack>
          {:else if failed || (expanded && stops != null && stops.length === 0)}
            <Typography variant="caption" class="px-2 py-1 text-[color:var(--color-fg-muted)]">
              No stops published for this route today.
            </Typography>
          {:else if stops != null}
            <TripStopList {stops} />
          {/if}
        </div>
      </Collapsible>
    {/if}
  </div>
{/snippet}

<div class="mx-auto max-w-3xl px-4 py-6">
  {#if userPrefs.feedId == null}
    <SelectFeedCard fallbackBody="Pick a feed in Settings to star routes here." />
  {:else if error}
    <Card>
      <CardContent>
        <Typography variant="h6" class="text-[color:var(--color-danger)]">Failed to load routes</Typography>
        <Typography variant="caption">{error}</Typography>
      </CardContent>
    </Card>
  {:else if allRoutes == null}
    <Card>
      <CardContent>
        <Stack direction="row" spacing={1} align="center">
          <Spinner size={16} />
          <Typography variant="caption">Loading routes…</Typography>
        </Stack>
      </CardContent>
    </Card>
  {:else}
    <Stack spacing={2}>
      {#if presentTypes.length > 1 || allNetworks.length > 0}
        <Card>
          <CardContent>
            <Stack spacing={1.5}>
              {#if presentTypes.length > 1}
                <Stack spacing={0.5}>
                  <Typography variant="h5">Filter by mode</Typography>
                  <Typography variant="caption" class="text-[color:var(--color-fg-muted)]">
                    {typeFilter === null
                      ? `Showing all ${allRoutes.length} routes. Tap a mode to narrow down.`
                      : `${filteredRoutes.length} of ${allRoutes.length} routes match.`}
                  </Typography>
                  <Stack direction="row" spacing={1} align="center" wrap>
                    {#each presentTypes as t (t)}
                      <TypeBadge type={t} color={colorByType.get(t)} active={typeFilter === t} onclick={() => toggleType(t)} />
                    {/each}
                  </Stack>
                </Stack>
              {/if}

              {#if allNetworks.length > 0}
                <Stack spacing={0.5}>
                  <Typography variant="h5">Filter by network</Typography>
                  <Typography variant="caption" class="text-[color:var(--color-fg-muted)]">
                    {networkFilter === null
                      ? 'Tap a network to narrow down.'
                      : `Showing ${filteredRoutes.length} route${filteredRoutes.length !== 1 ? 's' : ''} in this network.`}
                  </Typography>
                  <Stack direction="row" spacing={1} align="center" wrap>
                    {#each allNetworks as net (net.id)}
                      {@const Icon = networkIcon(net.id)}
                      {@const active = networkFilter === net.id}
                      <Chip
                        size="small"
                        hex={net.color}
                        fg={networkTextColor(net.color)}
                        onclick={() => toggleNetwork(net.id)}
                        class={active ? '' : 'opacity-50'}
                      >
                        {#snippet icon()}<Icon size={12} />{/snippet}
                        {net.name}
                      </Chip>
                    {/each}
                  </Stack>
                </Stack>
              {/if}
            </Stack>
          </CardContent>
        </Card>
      {/if}

      {#if favRoutes.length > 0}
        <Card>
          <CardContent>
            <Stack spacing={1}>
              <Stack spacing={0.5}>
                <Typography variant="h5">Your favorites</Typography>
                <Typography variant="caption" class="text-[color:var(--color-fg-muted)]">
                  {favRoutes.length} starred. Tap the heart to remove.
                </Typography>
              </Stack>
              <Stack spacing={1}>
                {#each favRoutes as route (route.id)}
                  {@render routeRow(route)}
                {/each}
              </Stack>
            </Stack>
          </CardContent>
        </Card>
      {/if}

      {#if otherRoutes.length > 0}
        <Card>
          <CardContent>
            <Stack spacing={1}>
              <Stack spacing={0.5}>
                <Typography variant="h5">
                  {favRoutes.length > 0 ? 'All other routes' : 'All routes'}
                </Typography>
                <Typography variant="caption" class="text-[color:var(--color-fg-muted)]">
                  {favRoutes.length > 0
                    ? `${otherRoutes.length} more to choose from. Tap the heart to favorite.`
                    : `${otherRoutes.length} routes available. Tap the heart to favorite.`}
                </Typography>
              </Stack>
              <Stack spacing={1}>
                {#each otherRoutes as route (route.id)}
                  {@render routeRow(route)}
                {/each}
              </Stack>
            </Stack>
          </CardContent>
        </Card>
      {/if}

      {#if noScheduleRoutes.length > 0}
        <Card>
          <CardContent>
            <Stack spacing={1}>
              <Stack spacing={0.5}>
                <Typography variant="h5">All other routes (no schedule available)</Typography>
                <Typography variant="caption" class="text-[color:var(--color-fg-muted)]">
                  {noScheduleRoutes.length} route{noScheduleRoutes.length !== 1 ? 's' : ''} without timetable data. Tap the heart to favorite.
                </Typography>
              </Stack>
              <Stack spacing={1}>
                {#each noScheduleRoutes as route (route.id)}
                  {@render routeRow(route)}
                {/each}
              </Stack>
            </Stack>
          </CardContent>
        </Card>
      {/if}
    </Stack>
  {/if}
</div>
