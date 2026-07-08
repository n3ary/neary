<!-- Small filter button. Originally scoped to vehicle-type mode filters
  (Filter by Mode in /favorites), but the same visual contract - filled
  accent + active ring + dimmed inactive - reads well for any filter row,
  so the network and marker filters also use it. Caller passes the
  accent color and a label; TypeBadge handles shape, active state, and
  contrast (auto for hex colors, caller-provided for CSS-var colors).

  Used by /favorites for the three filter rows. Active = full opacity
  + white ring; inactive = same fill but dimmed so the unselected
  state reads clearly.
-->
<script lang="ts">
  import type { VehicleType } from '$lib/domain/types';
  import { pickContrastingText, vehicleTypeLabel } from '$lib/domain/types';
  import { cn } from './cn';

  type Size = 'small' | 'medium' | 'large';

  type Props = {
    /** Vehicle type for the default mode-filter case. Optional when
     *  `label` is provided (network / marker filters pass a custom
     *  label). */
    type?: VehicleType;
    /** Override the rendered label. Defaults to `vehicleTypeLabel(type)`. */
    label?: string;
    /** Background color. A hex string gets auto-contrast fg; a CSS
     *  `var(...)` string renders against the supplied `fg` (or
     *  `var(--color-fg)` as a final fallback). */
    color?: string;
    /** Explicit foreground color. Use when `color` is a CSS variable
     *  and you want a theme-aware fg (e.g. `var(--color-primary-fg)`). */
    fg?: string;
    active?: boolean;
    onclick?: () => void;
    size?: Size;
    class?: string;
  };

  let {
    type, label, color, fg, active = false, onclick, size = 'medium', class: className,
  }: Props = $props();

  const SIZE: Record<Size, string> = {
    small: 'h-6 px-1.5 text-xs',
    medium: 'h-7 px-2 text-sm',
    large: 'h-8 px-2.5 text-base',
  };

  const bg = $derived(color ?? 'var(--color-surface-elevated)');
  const autoFg = $derived(
    color
      ? color.startsWith('var(') || color.startsWith('oklch') || color.startsWith('rgb')
        ? (fg ?? 'var(--color-fg)')
        : pickContrastingText(color)
      : 'var(--color-fg)'
  );
  const computedFg = $derived(fg ?? autoFg);
  const renderedLabel = $derived(label ?? (type ? vehicleTypeLabel(type) : ''));
</script>

<button
  type="button"
  aria-label={renderedLabel ? `Filter by ${renderedLabel}` : undefined}
  aria-pressed={active}
  title={renderedLabel}
  onclick={onclick}
  style={`background:${bg};color:${computedFg};${!active ? 'opacity:0.6;' : ''}`}
  class={cn(
    'inline-flex items-center justify-center font-semibold rounded-md select-none whitespace-nowrap cursor-pointer',
    'transition-all',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary)]',
    active && 'ring-2 ring-white ring-offset-1 ring-offset-[color:var(--color-surface)]',
    SIZE[size],
    className,
  )}
>
  {renderedLabel}
</button>
