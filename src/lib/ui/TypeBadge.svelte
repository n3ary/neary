<!--
  TypeBadge — small badge representing a vehicle type
  (bus / tram / trolleybus / …). Shape matches RouteBadge so it
  reads as a peer to route badges in the same UI surface (rounded
  square, similar padding + font). Color defaults to the canonical
  VEHICLE_TYPE_COLOR palette (intentionally distinct per mode for
  filter-classifier legibility); callers may override via `color`
  when a feed happens to paint a type consistently with the
  canonical palette, but most consumers should pass nothing.

  Used by the /favorites view as a single-select mode filter. Active
  = solid filled (badge "on"), inactive = outlined (badge "off").
-->
<script lang="ts">
  import type { VehicleType } from '$lib/domain/types';
  import { VEHICLE_TYPE_COLOR, pickContrastingText, vehicleTypeLabel } from '$lib/domain/types';
  import { cn } from './cn';

  type Size = 'small' | 'medium' | 'large';

  type Props = {
    type: VehicleType;
    /** Override the accent. Pass `route.color` from a sample route
     *  of this type so the chip matches what RouteBadge paints. */
    color?: string;
    active?: boolean;
    onclick?: () => void;
    size?: Size;
    class?: string;
  };

  let {
    type, color, active = false, onclick, size = 'medium', class: className,
  }: Props = $props();

  const SIZE: Record<Size, string> = {
    small: 'h-6 px-1.5 text-xs',
    medium: 'h-7 px-2 text-sm',
    large: 'h-8 px-2.5 text-base',
  };

  const accent = $derived(color ?? VEHICLE_TYPE_COLOR[type]);
  const fg = $derived(pickContrastingText(accent));
  const label = $derived(vehicleTypeLabel(type));
</script>

<!-- Always filled (like RouteBadge in route mode) so filter chips look
     like the route badges they filter. Active = full opacity + white ring;
     inactive = same fill but dimmed so the unselected state reads clearly. -->
<button
  type="button"
  aria-label={`Filter by ${label}`}
  aria-pressed={active}
  title={label}
  onclick={onclick}
  style={`background:${accent};color:${fg};${!active ? 'opacity:0.6;' : ''}`}
  class={cn(
    'inline-flex items-center justify-center font-semibold rounded-md select-none whitespace-nowrap cursor-pointer',
    'transition-all',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary)]',
    active && 'ring-2 ring-white ring-offset-1 ring-offset-[color:var(--color-surface)]',
    SIZE[size],
    className,
  )}
>
  {label}
</button>
