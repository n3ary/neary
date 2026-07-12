<!-- Full unified card for a station: avatar (bus icon), name (truncated), distance + drop-off-only chips (optional), route badges row, expand toggle -> VehicleCard list.
    - Route badges row
    - Expand toggle → VehicleCard list
  Replaces the legacy MUI StationList row.

  Expansion is controlled by the consumer (`expanded` + `ontoggle`) so a
  parent list can implement group behaviors (collapse-others) without
  fighting the card.
-->
<script lang="ts">
  import {
    ArrowDownLeft, ArrowUpRight, AlertTriangle, Bus, ChevronDown, Clock,
    MapPin, type Icon as LucideIcon,
  } from 'lucide-svelte';
  import type { Route, Station, Vehicle } from '$lib/domain/types';
  import { compareRouteShortName } from '$lib/domain/types';
  import {
    bucketLabel, etaUrgency, type ArrivalBucket,
  } from '$lib/domain/buckets';
  import type { BoardRow } from '$lib/domain/stationBoard';
  import type { ScheduleTripStop } from '$lib/data/gtfs/types';
  import type { StationMarker } from '$lib/stores/favoritesStore.svelte';
  import { favoritesStore, STATION_MARKER_ACCENT } from '$lib/stores/favoritesStore.svelte';
  import { feedsStore } from '$lib/stores/feedsStore.svelte';
  import Avatar from './Avatar.svelte';
  import Box from './Box.svelte';
  import Card from './Card.svelte';
  import CardContent from './CardContent.svelte';
  import Chip from './Chip.svelte';
  import Collapsible from './Collapsible.svelte';
  import IconButton from './IconButton.svelte';
  import RouteBadge from './RouteBadge.svelte';
  import Stack from './Stack.svelte';
  import StationMarkerDropdown from './StationMarkerDropdown.svelte';
  import Tooltip from './Tooltip.svelte';
  import TripStopList from './TripStopList.svelte';
  import Typography from './Typography.svelte';
  import VehicleCard from './VehicleCard.svelte';
  import { cn } from './cn';

  type Props = {
    station: Station;
    /** Bucketed vehicle rows for this station — already filtered + sorted
     *  by the domain layer. StationCard groups them into sections by
     *  bucket; the domain decides what's in / out, the card decides how
     *  the groups look. Routes serving the station are derived from these
     *  unless `allRoutes` is supplied. */
    rows: BoardRow[];
    /** Pre-filter / pre-cap vehicle count for this stop. When provided
     *  AND `rows` is empty, the empty-state body explains "X vehicles
     *  found but hidden — adjust Settings → Display" instead of the
     *  default "No more departures today." Consumers that don't want
     *  the hint (e.g. the showcase page) just omit it. */
    rawVehicleCount?: number;
    /** Full route list serving this station (pre-cap, pre-filter). When
     *  set, drives the header badge row instead of `rows`, so all routes
     *  through the station are visible even when capped out of the 5-row
     *  board below. Used by the Stations page. */
    allRoutes?: Route[];
    expanded: boolean;
    ontoggle: () => void;
    /** When true, station shows a "Drop off only" outlined chip. */
    dropOffOnly?: boolean;
    /** Selected route badge id. Visual hint only — marks the badge as
     *  pressed. Any actual row filtering must happen upstream so the
     *  domain pipeline (filter → bucket → cap) sees the full set. */
    selectedRouteId?: string | null;
    onRouteClick?: (routeId: string) => void;
    /** Optional set of route ids that are favorited. */
    favoriteRouteIds?: ReadonlySet<string>;
    /** Marker for the station. Defaults to looking up the station
     *  in favoritesStore so call sites don't have to pass it
     *  explicitly. Pass null to suppress. */
    marker?: StationMarker | null;
    /** Mutate the station's marker from within the card. When set,
     *  the marker icon becomes an interactive dropdown. null clears. */
    onChangeMarker?: (stopId: string, next: StationMarker | null) => void;
    /** Route ids for which this station is the first (origin) stop. When set,
     *  the corresponding badge shows the isStart ▶ wedge. */
    originRouteIds?: ReadonlySet<string>;
    /** When provided, tapping a vehicle's route badge fetches and shows the
     *  upcoming stops from this station to the end of the trip. The callback
     *  receives the trip id and current stop id; the caller slices the stop
     *  list so the first returned stop is the one after the current station. */
    getUpcomingStops?: (tripId: string, currentStopId: string) => Promise<ScheduleTripStop[]>;
    class?: string;
  };

  let {
    station,
    rows,
    rawVehicleCount,
    allRoutes,
    expanded,
    ontoggle,
    dropOffOnly = false,
    selectedRouteId = null,
    onRouteClick,
    favoriteRouteIds,
    originRouteIds,
    getUpcomingStops,
    marker,
    onChangeMarker,
    class: className,
  }: Props = $props();

  // Resolve the marker: explicit prop wins, otherwise look up in the
  // store so the badge renders without every call site plumbing it.
  // Callers that want to suppress (e.g. the showcase page) pass null.
  const resolvedMarker = $derived(
    marker === null
      ? null
      : (marker ?? favoritesStore.markerFor(station.id) ?? null),
  );

  // Accent for left-border on stations with a non-normal marker.
  const markerAccent = $derived(STATION_MARKER_ACCENT[resolvedMarker ?? 'none']);

  // Stop-list expansion state for vehicle route badge tap.
  let expandedVehicleId = $state<string | null>(null);
  let vehicleStops = $state<ScheduleTripStop[] | null>(null);
  // Tracks which vehicle is mid-fetch so the badge shows pressed during load.
  let loadingVehicleId = $state<string | null>(null);

  async function toggleStops(vehicle: Vehicle) {
    const tid = vehicle.schedule?.tripId;
    if (!tid || !getUpcomingStops) return;
    if (expandedVehicleId === vehicle.id) {
      expandedVehicleId = null;
      vehicleStops = null;
      return;
    }
    loadingVehicleId = vehicle.id;
    try {
      const stops = await getUpcomingStops(tid, station.id);
      if (loadingVehicleId !== vehicle.id) return; // superseded by another tap
      vehicleStops = stops;
      expandedVehicleId = vehicle.id;
    } finally {
      if (loadingVehicleId === vehicle.id) loadingVehicleId = null;
    }
  }

  function formatDistance(m: number | undefined): string {
    if (typeof m !== 'number') return '';
    return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
  }

  // Per-vehicle headsign markers: unique markers across the stops
  // the vehicle will visit AFTER this station. Reuses the same
  // `getUpcomingStops` helper that powers the expanded stops list,
  // called per vehicle (N+1) - acceptable for a typical board
  // (5-10 vehicles) and avoids introducing a parallel batched
  // helper for one consumer. Empty for vehicles at the trip's
  // last stop (no remaining).
  let vehicleHeadStopIds = $state<Map<string, string[]>>(new Map());

  $effect(() => {
    const fid = feedsStore.boundFeedId;
    if (!fid || rows.length === 0 || !getUpcomingStops) {
      vehicleHeadStopIds = new Map();
      return;
    }
    // Vehicles that have a trip and aren't at the last stop.
    const eligible = rows
      .map((r) => r.vehicle)
      .filter((v) => v.schedule?.tripId && !v.schedule?.isLastStop);
    if (eligible.length === 0) {
      vehicleHeadStopIds = new Map();
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const out = new Map<string, string[]>();
        await Promise.all(
          eligible.map(async (v) => {
            const stops = await getUpcomingStops!(v.schedule!.tripId!, station.id);
            if (cancelled) return;
            out.set(v.id, stops.map((s) => s.stopId));
          }),
        );
        if (cancelled) return;
        vehicleHeadStopIds = out;
      } catch {
        // Headsign markers are decorative; failures leave the previous
        // (or empty) map in place so the row still renders.
      }
    })();
    return () => { cancelled = true; };
  });

  // Dedup routes from `allRoutes` if supplied (so all routes serving the
  // station show even when capped out of the 5-row board), otherwise
  // fall back to deriving from the rows that survived filtering + cap.
  // Sort: favorites first, then the rest. Within each partition,
  // numeric short-names sort numerically; alpha after. Lives here (not
  // in the page) so every StationCard consumer gets the same badge-row
  // contract for free.
  const routes = $derived.by(() => {
    const map = new Map<string, Route>();
    if (allRoutes && allRoutes.length > 0) {
      for (const r of allRoutes) map.set(r.id, r);
    } else {
      for (const r of rows) map.set(r.vehicle.route.id, r.vehicle.route);
    }
    const favs = favoriteRouteIds;
    return Array.from(map.values()).sort((a, b) => {
      const aFav = favs?.has(a.id) ?? false;
      const bFav = favs?.has(b.id) ?? false;
      if (aFav !== bFav) return aFav ? -1 : 1;
      return compareRouteShortName(a.shortName, b.shortName);
    });
  });

  // Section grouping. The three now-group buckets (departing,
  // at-station, arriving) are merged into a single "At station"
  // section so a vehicle that re-classifies between them stays in
  // the same DOM row — the only thing that changes is the per-row
  // label and color (see `atStationLabel` on each BoardRow). Other
  // buckets stay separate. Empty sections are dropped so the UI
  // shows only headers that have content. The card does NOT filter
  // — the caller is expected to hand us only the rows that should
  // appear (route filter, prefs filter, etc. all belong upstream so
  // the cap operates on the already-filtered set).
  const groups = $derived.by(() => {
    const atStation: BoardRow[] = [];
    const others: Record<'incoming' | 'drop-off' | 'departed' | 'off-route', BoardRow[]> = {
      incoming: [],
      'drop-off': [],
      departed: [],
      'off-route': [],
    };
    for (const r of rows) {
      if (r.bucket === 'at-station') {
        atStation.push(r);
      } else {
        others[r.bucket].push(r);
      }
    }
    const out: { key: string; bucket: ArrivalBucket; label: string; rows: BoardRow[] }[] = [];
    if (atStation.length > 0) {
      out.push({ key: 'at-station', bucket: 'at-station', label: 'At station', rows: atStation });
    }
    for (const b of ['incoming', 'drop-off', 'departed', 'off-route'] as const) {
      const list = others[b];
      if (list.length === 0) continue;
      out.push({
        key: b,
        bucket: b,
        label: bucketLabel(b, list.map((r) => r.vehicle)),
        rows: list,
      });
    }
    return out;
  });
  const isEmpty = $derived(groups.length === 0);

  // Per-bucket section header styling. The icon mirrors the bucket
  // verb (incoming → clock, at-station → map pin, etc.) and the
  // accent color matches the urgency band the VehicleCards in that
  // section render with, so the eye reads them as one. Lives here
  // because it's purely visual mapping; the bucket itself and its
  // human-readable label are still the domain's call.
  const BUCKET_META: Record<ArrivalBucket, { icon: typeof LucideIcon; accent: 'success' | 'danger' | 'warning' | 'muted' }> = {
    'at-station': { icon: MapPin,         accent: 'success' },
    incoming:     { icon: Clock,          accent: 'success' },
    'drop-off':   { icon: ArrowDownLeft,  accent: 'danger' },
    departed:     { icon: ArrowUpRight,   accent: 'danger' },
    'off-route':  { icon: AlertTriangle,  accent: 'warning' },
  };
  const ACCENT_FG: Record<'success' | 'danger' | 'warning' | 'muted', string> = {
    success: 'text-[color:var(--color-success)]',
    danger:  'text-[color:var(--color-danger)]',
    warning: 'text-[color:var(--color-warning)]',
    muted:   'text-[color:var(--color-fg-muted)]',
  };

  // The header chrome (avatar + name + chips) doubles as the collapse/expand
  // tap target. False when callers pass a no-op `ontoggle` (e.g. the always-
  // expanded /station/[id] view) so the keyboard / a11y surface area matches
  // the actual toggle behavior — an inert click target would be confusing.
  const interactive = $derived(typeof ontoggle === 'function');
</script>

<Card
  variant="station"
  class={className}
  accentColor={markerAccent !== 'transparent' ? markerAccent : undefined}
>
  <CardContent>
    <Stack direction="row" spacing={1.5} align="center">
      <!-- Avatar doubles as the dropdown trigger: tapping it opens the
           marker dropdown. Shows the Bus icon (the station default avatar)
           as the trigger regardless of marker state. -->
      {#if onChangeMarker}
        <StationMarkerDropdown
          stationId={station.id}
          marker={resolvedMarker ?? undefined}
          onChange={(next) => onChangeMarker(station.id, next)}
          label={station.name}
          size={20}
          class="w-10 h-10 sm:w-12 sm:h-12 rounded-md"
        />
      {:else}
        <Avatar variant="square" class="w-10 h-10 sm:w-12 sm:h-12">
          <Bus size={20} />
        </Avatar>
      {/if}

      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div
        role={interactive ? 'button' : undefined}
        tabindex={interactive ? 0 : undefined}
        aria-expanded={interactive ? expanded : undefined}
        aria-label={interactive ? `${expanded ? 'Collapse' : 'Expand'} ${station.name}` : undefined}
        onclick={interactive ? ontoggle : undefined}
        onkeydown={interactive
          ? (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ontoggle(); } }
          : undefined}
        class={cn(
          'flex-1 min-w-0 rounded',
          interactive && 'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary)]',
        )}
      >
        <Stack spacing={0.5}>
          <Typography variant="h6" class="truncate">{station.name}</Typography>

          <Stack direction="row" spacing={1} align="center" wrap>
            {#if typeof station.distance === 'number'}
              <Tooltip
                title={`Station ID: ${station.id}${station.lat && station.lon ? ` | GPS: ${station.lat}, ${station.lon}` : ''}`}
              >
                <Chip size="small">
                  {#snippet icon()}<MapPin size={12} />{/snippet}
                  {formatDistance(station.distance)}
                </Chip>
              </Tooltip>
            {/if}
            {#if dropOffOnly}
              <Chip size="small" variant="outlined" color="danger">Drop off only</Chip>
            {/if}
          </Stack>

          {#if routes.length > 0}
            <Stack direction="row" spacing={1} align="center" wrap class="mt-1">
              {#each routes as route (route.id)}
                <RouteBadge
                  {route}
                  size="medium"
                  colorMode="route"
                  isStart={originRouteIds?.has(route.id) ?? false}
                  selected={selectedRouteId === route.id}
                  onclick={onRouteClick
                    ? (e: MouseEvent) => { e.stopPropagation(); onRouteClick(route.id); }
                    : undefined}
                />
              {/each}
            </Stack>
          {/if}
        </Stack>
      </div>

      <IconButton
        onclick={ontoggle}
        aria-label={expanded ? 'Collapse' : 'Expand'}
        class={cn('transition-transform duration-200', expanded ? 'rotate-180' : 'rotate-0')}
      >
        <ChevronDown size={20} />
      </IconButton>
    </Stack>

    <Collapsible in={expanded} class="mt-2">
      {#if isEmpty}
        {#if rawVehicleCount && rawVehicleCount > 0}
          <Box class="px-3 py-3 text-sm text-[color:var(--color-warning)]">
            {rawVehicleCount} vehicle{rawVehicleCount === 1 ? '' : 's'} found but hidden
            — adjust in Settings → Display.
          </Box>
        {:else}
          <Box class="px-3 py-3 text-sm text-[color:var(--color-fg-muted)]">
            No more departures today.
          </Box>
        {/if}
      {:else}
        <Stack spacing={1.5} class="pt-1">
          {#each groups as group (group.key)}
            {@const meta = BUCKET_META[group.bucket]}
            {@const HeaderIcon = meta.icon}
            <Box>
              <Stack
                direction="row"
                spacing={1}
                align="center"
                class="px-1 py-1 border-b border-[color:var(--color-border)]/40"
              >
                <HeaderIcon size={14} class={`shrink-0 ${ACCENT_FG[meta.accent]}`} />
                <Typography
                  variant="caption"
                  class={`font-semibold tracking-tight ${meta.accent === 'danger' ? ACCENT_FG.danger : ''}`}
                >
                  {group.label}
                </Typography>
              </Stack>
              <Stack spacing={0.5} class="pt-1">
                {#each group.rows as row (row.vehicle.id)}
                  {@const vehicle = row.vehicle}
                  {@const hasTripId = vehicle.schedule?.tripId != null}
                  {@const phase = vehicle.schedule?.tripPhase}
                  <!-- A row is "actionable" when it represents a trip
                       the rider can still do something with: it has a
                       tripId, and it isn't a future-but-not-next
                       departure (those rows sit beside a `next` of
                       the same route which already exposes the same
                       schedule, map, and stops list). All three of
                       schedule, map, and stops-expansion gate off
                       this — same predicate, one name.
                       The schedule link additionally requires the
                       route to have a usable schedule (false for
                       adapter-emitted live-only `_NT*` fallback trips
                       where arrival_time is empty — see
                       routesWithSchedule.ts). -->
                  {@const actionable = hasTripId && phase !== 'later'}
                  {@const hasSchedule = vehicle.route.hasSchedule !== false}
                  {@const stopsEligible = getUpcomingStops != null
                    && actionable
                    && !vehicle.schedule?.isLastStop}
                  <Box class="flex flex-col gap-1">
                    <VehicleCard
                      {vehicle}
                      urgency={etaUrgency(row.bucket, vehicle.eta?.minutes ?? 0)}
                      atStationLabel={row.atStationLabel}
                      scheduleHref={actionable && hasSchedule ? `/schedule/route/${vehicle.route.id}_${vehicle.schedule?.directionId ?? 0}` : undefined}
                      mapHref={actionable
                        ? `/map/route/${vehicle.route.id}_${vehicle.schedule?.directionId ?? 0}${vehicle.schedule?.tripId ? `/${encodeURIComponent(vehicle.schedule.tripId)}` : ''}?from=${station.id}`
                        : undefined}
                      onStopsExpand={stopsEligible ? () => toggleStops(vehicle) : undefined}
                      stopsExpanded={expandedVehicleId === vehicle.id || loadingVehicleId === vehicle.id}
                      headsignStopIds={vehicleHeadStopIds.get(vehicle.id)}
                    />
                    {#if stopsEligible}
                      <!-- reduced=true: skip Collapsible's
                           `grid-template-rows: 0fr → 1fr` height
                           animation. It triggers full layout +
                           paint of every child each frame; with
                           30+ stop rows inside, Safari profiling
                           showed ~50ms paint per frame sustained
                           for ~200ms (verified 2026-06-30,
                           localhost-recording.json). The stops
                           are async-fetched anyway, so the user
                           already sees a brief loading state —
                           the slide adds little, costs a lot. -->
                      <Collapsible in={expandedVehicleId === vehicle.id} reduced>
                        {#if vehicleStops != null && expandedVehicleId === vehicle.id}
                          <div class="rounded-md border border-[color:var(--color-border)]/40 bg-[color:var(--color-surface-raised,var(--color-surface))] overflow-hidden">
                            <TripStopList stops={vehicleStops} markers={favoritesStore.markers} class="py-1" />
                          </div>
                        {/if}
                      </Collapsible>
                    {/if}
                  </Box>
                {/each}
              </Stack>
            </Box>
          {/each}
        </Stack>
      {/if}
    </Collapsible>
  </CardContent>
</Card>
