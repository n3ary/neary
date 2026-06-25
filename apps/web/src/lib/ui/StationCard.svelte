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
    /** Routes serving this station, used for the badge row. */
    routes: Route[];
    /** Vehicles serving this station — shown inside the expand region. */
    vehicles: Vehicle[];
    expanded: boolean;
    ontoggle: () => void;
    /** When true, station shows a "Drop off only" outlined chip. */
    dropOffOnly?: boolean;
    /** Selected route badge id (filter applied within the station). */
    selectedRouteId?: number | null;
    onRouteClick?: (routeId: number) => void;
    /** Optional set of route ids that are favorited. */
    favoriteRouteIds?: ReadonlySet<number>;
    class?: string;
  };

  let {
    station,
    routes,
    vehicles,
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

  const filteredVehicles = $derived(
    typeof selectedRouteId === 'number'
      ? vehicles.filter((v) => v.route.id === selectedRouteId)
      : vehicles,
  );
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
      {#if filteredVehicles.length === 0}
        <Box class="px-3 py-3 text-sm text-[color:var(--color-fg-muted)]">
          {selectedRouteId != null
            ? 'No vehicles for the selected route right now.'
            : 'No vehicles right now.'}
        </Box>
      {:else}
        <Stack spacing={0.5} class="pt-1">
          {#each filteredVehicles as vehicle (vehicle.id)}
            <VehicleCard {vehicle} />
          {/each}
        </Stack>
      {/if}
    </Collapsible>
  </CardContent>
</Card>
