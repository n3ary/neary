<!-- Small filter button. Originally scoped to vehicle-type mode filters
  (Filter by Mode in /favorites), but the same visual contract - filled
  accent + active ring + dimmed inactive - reads well for any filter row,
  so the network and marker filters also use it. Caller passes the
  accent color and a label; TypeBadge handles shape, active state, and
  contrast (auto for hex colors, caller-provided for CSS-var colors).

  Used by /favorites for the three filter rows. Active = full opacity
  + white ring; inactive = same fill but dimmed so the unselected
  state reads clearly.

  `onmousedown` calls preventDefault to suppress the focus shift that
  a mouse/touch click would otherwise apply. A real <button> focuses
  on click, and the browser then scrolls the focused element into
  view - on a long /favorites catalog the user is often scrolled past
  the filter row, so the auto-scroll yanks the page back to the top
  on every tap. Suppressing the focus keeps scroll position stable.
  Keyboard activation (Tab + Enter/Space) is unaffected because
  mousedown only fires for pointer input.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
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
    /** Optional icon rendered before the label. Used by the marker
     *  filter chips so each marker type shows its icon. */
    icon?: Snippet;
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
    type, label, icon, color, fg, active = false, onclick, size = 'medium', class: className,
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
  onmousedown={(e) => e.preventDefault()}
  style={`background:${bg};color:${computedFg};${!active ? 'opacity:0.6;' : ''}`}
  class={cn(
    'inline-flex items-center gap-1 justify-center font-semibold rounded-md select-none whitespace-nowrap cursor-pointer',
    'transition-all',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary)]',
    active && 'ring-2 ring-white ring-offset-1 ring-offset-[color:var(--color-surface)]',
    SIZE[size],
    className,
  )}
  >
  {#if icon}
    {@render icon()}
  {/if}
  {renderedLabel}
</button>
