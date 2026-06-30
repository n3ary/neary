<!--
  StationCard — full unified card for a station. Composes:
    - Avatar (Bus icon)
    - Station name (truncated)
    - Distance chip + drop-off-only chip (optional)
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
    BUCKET_ORDER, bucketLabel, etaUrgency, type ArrivalBucket,
  } from '$lib/domain/buckets';
  import type { BoardRow } from '$lib/domain/stationBoard';
  import type { ScheduleTripStop } from '$lib/data/gtfs/types';
  import Avatar from './Avatar.svelte';
  import Box from './Box.svelte';
  import Card from './Card.svelte';
  import CardContent from './CardContent.svelte';
  import Chip from './Chip.svelte';
  import Collapsible from './Collapsible.svelte';
  import IconButton from './IconButton.svelte';
  import RouteBadge from './RouteBadge.svelte';
  import Stack from './Stack.svelte';
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
    /** Route ids for which this station is the first (origin) stop. When set,
     *  the corresponding badge shows the isStart ▶ wedge. */
    originRouteIds?: ReadonlySet<string>;
    /** When provided, tapping a vehicle's route badge fetches and shows the
     *  upcoming stops from this station to the end of the trip. The callback
     *  receives the trip id and current stop id; the caller slices the stop
     *  list so the first returned stop is the one after the current station. */
    getUpcomingStops?: (tripId: string, currentStopId: number) => Promise<ScheduleTripStop[]>;
    class?: string;
  };

  let {
    station,
    rows,
    allRoutes,
    expanded,
    ontoggle,
    dropOffOnly = false,
    selectedRouteId,
    onRouteClick,
    favoriteRouteIds,
    originRouteIds,
    getUpcomingStops,
    class: className,
  }: Props = $props();

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

  // Group rows by bucket while preserving the domain-sorted order. Empty
  // buckets are dropped so the UI shows only headers that have content.
  // The card does NOT filter — the caller is expected to hand us only
  // the rows that should appear (route filter, prefs filter, etc. all
  // belong upstream so the cap operates on the already-filtered set).
  // `selectedRouteId` here is purely a visual prop: it tells the badge
  // row which pill to render as pressed.
  const groups = $derived.by(() => {
    const byBucket = new Map<ArrivalBucket, Vehicle[]>();
    for (const r of rows) {
      const list = byBucket.get(r.bucket) ?? [];
      list.push(r.vehicle);
      byBucket.set(r.bucket, list);
    }
    return Array.from(byBucket.entries())
      .sort(([a], [b]) => BUCKET_ORDER[a] - BUCKET_ORDER[b])
      .map(([bucket, vehicles]) => ({
        bucket,
        label: bucketLabel(bucket, vehicles),
        vehicles,
      }));
  });
  const isEmpty = $derived(groups.length === 0);

  // Per-bucket section header styling. The icon mirrors the bucket
  // verb (incoming → clock, departing → outbound arrow, etc.) and
  // the accent color matches the urgency band the VehicleCards in
  // that section already render with, so the eye reads them as one.
  // Lives here because it's purely visual mapping; the bucket itself
  // and its human-readable label are still the domain's call.
  const BUCKET_META: Record<ArrivalBucket, { icon: typeof LucideIcon; accent: 'success' | 'danger' | 'warning' | 'muted' }> = {
    departing:    { icon: ArrowUpRight,   accent: 'danger' },
    'at-station': { icon: MapPin,         accent: 'success' },
    arriving:     { icon: ArrowDownLeft,  accent: 'success' },
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
</script>

<Card variant="station" class={className}>
  <CardContent>
    <Stack direction="row" spacing={1.5} align="center">
      <Avatar variant="square" class="w-10 h-10 sm:w-12 sm:h-12">
        <Bus size={20} />
      </Avatar>

      <Box class="flex-1 min-w-0">
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
                  onclick={onRouteClick ? () => onRouteClick(route.id) : undefined}
                />
              {/each}
            </Stack>
          {/if}
        </Stack>
      </Box>

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
        <Box class="px-3 py-3 text-sm text-[color:var(--color-fg-muted)]">
          No more departures today.
        </Box>
      {:else}
        <Stack spacing={1.5} class="pt-1">
          {#each groups as group (group.bucket)}
            {@const meta = BUCKET_META[group.bucket]}
            {@const HeaderIcon = meta.icon}
            <Box>
              <Stack
                direction="row"
                spacing={1}
                align="center"
                class="px-1 py-1 border-b border-[color:var(--color-border)]/60"
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
                {#each group.vehicles as vehicle (vehicle.id)}
                  {@const hasTripId = vehicle.schedule?.tripId != null}
                  {@const phase = vehicle.schedule?.tripPhase}
                  <!-- A row is "actionable" when it represents a trip
                       the rider can still do something with: it has a
                       tripId, and it isn't a future-but-not-next
                       departure (those rows sit beside a `next` of
                       the same route which already exposes the same
                       schedule, map, and stops list). All three of
                       schedule, map, and stops-expansion gate off
                       this — same predicate, one name. -->
                  {@const actionable = hasTripId && phase !== 'later'}
                  {@const stopsEligible = getUpcomingStops != null
                    && actionable
                    && !vehicle.schedule?.isLastStop}
                  <Box class="flex flex-col gap-1">
                    <VehicleCard
                      {vehicle}
                      urgency={etaUrgency(group.bucket, vehicle.eta?.minutes ?? 0)}
                      scheduleHref={actionable ? `/schedule/route/${vehicle.route.id}_${vehicle.schedule?.directionId ?? 0}` : undefined}
                      mapHref={actionable
                        ? `/map/route/${vehicle.route.id}_${vehicle.schedule?.directionId ?? 0}${vehicle.schedule?.tripId ? `/${encodeURIComponent(vehicle.schedule.tripId)}` : ''}?from=${station.id}`
                        : undefined}
                      onStopsExpand={stopsEligible ? () => toggleStops(vehicle) : undefined}
                      stopsExpanded={expandedVehicleId === vehicle.id || loadingVehicleId === vehicle.id}
                    />
                    {#if stopsEligible}
                      <Collapsible in={expandedVehicleId === vehicle.id}>
                        {#if vehicleStops != null && expandedVehicleId === vehicle.id}
                          <div class="rounded-md border border-[color:var(--color-border)]/60 bg-[color:var(--color-surface-raised,var(--color-surface))] overflow-hidden">
                            <TripStopList stops={vehicleStops} class="py-1" />
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
