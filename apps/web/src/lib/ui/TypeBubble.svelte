<!--
  TypeBubble — small colored pill representing a vehicle type
  (bus / tram / trolleybus / …). No number, no text — pure visual
  filter chip. Active state inverts so the user can see which
  type-filters are on without reading.

  Used by the /favorites view to filter the route list by mode;
  designed to be reusable on the Stations view (per-stop type filter)
  and future map filters.
-->
<script lang="ts">
  import type { VehicleType } from '$lib/domain/types';
  import { VEHICLE_TYPE_COLOR, vehicleTypeLabel } from '$lib/domain/types';
  import { cn } from './cn';

  type Props = {
    type: VehicleType;
    active?: boolean;
    onclick?: () => void;
    size?: 'small' | 'medium';
    class?: string;
  };

  let { type, active = false, onclick, size = 'medium', class: className }: Props = $props();

  const SIZE = { small: 'w-5 h-5', medium: 'w-6 h-6' } as const;
  const color = $derived(VEHICLE_TYPE_COLOR[type]);
  const label = $derived(vehicleTypeLabel(type));
</script>

<button
  type="button"
  aria-label={`Filter by ${label}`}
  aria-pressed={active}
  title={label}
  onclick={onclick}
  style={`background:${active ? color : 'transparent'}; border-color:${color};`}
  class={cn(
    'inline-block rounded-full border-2 cursor-pointer transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary)]',
    SIZE[size],
    className,
  )}
></button>
