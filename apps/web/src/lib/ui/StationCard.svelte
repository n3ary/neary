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
  import { Bus, ChevronDown, MapPin } from 'lucide-svelte';
  import type { Route, Station, Vehicle } from '$lib/domain/types';
  import {
    BUCKET_LABEL, BUCKET_ORDER, etaUrgency, type ArrivalBucket,
  } from '$lib/domain/buckets';
  import type { BoardRow } from '$lib/domain/stationBoard';
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
    selectedRouteId?: number | null;
    onRouteClick?: (routeId: number) => void;
    /** Optional set of route ids that are favorited. */
    favoriteRouteIds?: ReadonlySet<number>;
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
    class: className,
  }: Props = $props();

  function formatDistance(m: number | undefined): string {
    if (typeof m !== 'number') return '';
    return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
  }

  // Dedup routes from `allRoutes` if supplied (so all routes serving the
  // station show even when capped out of the 5-row board), otherwise
  // fall back to deriving from the rows that survived filtering + cap.
  // Numeric short-names sort numerically; alpha after. Lives here (not
  // in the page) so every StationCard consumer gets the same badge-row
  // contract for free.
  const routes = $derived.by(() => {
    const map = new Map<number, Route>();
    if (allRoutes && allRoutes.length > 0) {
      for (const r of allRoutes) map.set(r.id, r);
    } else {
      for (const r of rows) map.set(r.vehicle.route.id, r.vehicle.route);
    }
    return Array.from(map.values()).sort((a, b) => {
      const an = Number(a.shortName);
      const bn = Number(b.shortName);
      if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn;
      return a.shortName.localeCompare(b.shortName);
    });
  });

  // Group rows by bucket while preserving the domain-sorted order. Empty
  // buckets are dropped so the UI shows only headers that have content.
  // The card does NOT filter \u2014 the caller is expected to hand us only
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
        label: BUCKET_LABEL[bucket],
        vehicles,
      }));
  });
  const isEmpty = $derived(groups.length === 0);
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
            <Stack direction="row" spacing={0.5} align="center" wrap class="mt-1">
              {#each routes as route (route.id)}
                <RouteBadge
                  {route}
                  size="medium"
                  colorMode="neutral"
                  selected={selectedRouteId === route.id}
                  isFavorite={favoriteRouteIds?.has(route.id)}
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
          No vehicles right now.
        </Box>
      {:else}
        <Stack spacing={1.5} class="pt-1">
          {#each groups as group (group.bucket)}
            <Box>
              <Typography
                variant="caption"
                class="px-1 pb-1 uppercase tracking-wide text-[color:var(--color-fg-muted)]"
              >
                {group.label} · {group.vehicles.length}
              </Typography>
              <Stack spacing={0.5}>
                {#each group.vehicles as vehicle (vehicle.id)}
                  <VehicleCard
                    {vehicle}
                    urgency={etaUrgency(group.bucket, vehicle.eta?.minutes ?? 0)}
                  />
                {/each}
              </Stack>
            </Box>
          {/each}
        </Stack>
      {/if}
    </Collapsible>
  </CardContent>
</Card>
