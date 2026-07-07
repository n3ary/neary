<!-- Compact label/tag with optional leading icon. Semantic colors map to theme tokens so chips inherit skin changes. One-off data-driven colors via `hex` (a CSS string), which overrides `color`/`variant` with inline styles and auto-computes contrast `fg`. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn } from './cn';

  type Size = 'small' | 'medium';
  type Variant = 'filled' | 'outlined';
  type Color = 'default' | 'primary' | 'success' | 'warning' | 'danger';

  type Props = {
    size?: Size;
    variant?: Variant;
    color?: Color;
    /** Raw CSS background color (e.g. `#5B2D8E`). When set, overrides
     *  `color`/`variant` with inline styles. Pass `fg` for the foreground. */
    hex?: string;
    /** Foreground color paired with `hex`. Ignored when `hex` is absent. */
    fg?: string;
    onclick?: (event: MouseEvent) => void;
    class?: string;
    /** Leading icon slot — receives a small icon component or <svg>. */
    icon?: Snippet;
    /** Label slot — text or other inline content. */
    children?: Snippet;
  };

  let {
    size = 'medium',
    variant = 'filled',
    color = 'default',
    hex,
    fg,
    onclick,
    class: className,
    icon,
    children,
  }: Props = $props();

  const SIZE: Record<Size, string> = {
    small: 'text-xs h-6 px-2 gap-1',
    medium: 'text-sm h-7 px-3 gap-1.5',
  };

  const FILLED: Record<Color, string> = {
    default: 'bg-[color:var(--color-border)] text-[color:var(--color-fg)]',
    primary: 'bg-[color:var(--color-primary)] text-[color:var(--color-primary-fg)]',
    success: 'bg-[color:var(--color-success)] text-white',
    warning: 'bg-[color:var(--color-warning)] text-black',
    danger: 'bg-[color:var(--color-danger)] text-white',
  };

  const OUTLINED: Record<Color, string> = {
    default: 'border border-[color:var(--color-border)] text-[color:var(--color-fg)]',
    primary: 'border border-[color:var(--color-primary)] text-[color:var(--color-primary)]',
    success: 'border border-[color:var(--color-success)] text-[color:var(--color-success)]',
    warning: 'border border-[color:var(--color-warning)] text-[color:var(--color-warning)]',
    danger: 'border border-[color:var(--color-danger)] text-[color:var(--color-danger)]',
  };

  const inlineStyle = $derived(hex ? `background:${hex};color:${fg ?? '#fff'};` : undefined);
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<span
  role={onclick ? 'button' : undefined}
  tabindex={onclick ? 0 : undefined}
  {onclick}
  style={inlineStyle}
  onkeydown={onclick ? (e) => { if (e.key === 'Enter' || e.key === ' ') onclick(e as unknown as MouseEvent); } : undefined}
  class={cn(
    'inline-flex items-center rounded-[var(--radius-chip)] font-medium select-none whitespace-nowrap',
    SIZE[size],
    !hex && (variant === 'filled' ? FILLED[color] : OUTLINED[color]),
    onclick && 'cursor-pointer',
    className,
  )}
>
  {#if icon}{@render icon()}{/if}
  {@render children?.()}
</span>
