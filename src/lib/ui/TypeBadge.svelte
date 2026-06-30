<!--
  TypeBadge — small badge representing a vehicle type
  (bus / tram / trolleybus / …). Shape matches RouteBadge so it
  reads as a peer to route badges in the same UI surface (rounded
  square, similar padding + font).

  Color is data-driven: callers pass a `color` (typically taken from
  a route of that type in the loaded catalog). No palette and no
  color logic in this component — whatever the feed shipped is what
  the chip shows. When the catalog hasn't loaded yet and no color is
  available, the chip renders against a theme-neutral surface.

  Used by the /favorites view as a single-select mode filter. Active
  = solid filled (badge "on"), inactive = outlined (badge "off").
-->
<script lang="ts">
  import type { VehicleType } from '$lib/domain/types';
  import { pickContrastingText, vehicleTypeLabel } from '$lib/domain/types';
  import { cn } from './cn';

  type Size = 'small' | 'medium' | 'large';

  type Props = {
    type: VehicleType;
    /** Per-type accent color, taken from a route of this type in the
     *  loaded catalog. When undefined (catalog not loaded yet, or no
     *  route of this type), the chip renders against the theme's
     *  elevated surface. */
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

  const bg = $derived(color ?? 'var(--color-surface-elevated)');
  const fg = $derived(color ? pickContrastingText(color) : 'var(--color-fg)');
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
  style={`background:${bg};color:${fg};${!active ? 'opacity:0.6;' : ''}`}
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
