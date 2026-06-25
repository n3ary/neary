<!--
  Chip — compact label/tag with optional leading icon. Supports `size` and a
  small set of semantic colors mapped to theme tokens, so chips inherit any
  skin change automatically.
-->
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
</script>

<span
  role={onclick ? 'button' : undefined}
  tabindex={onclick ? 0 : undefined}
  {onclick}
  onkeydown={onclick ? (e) => { if (e.key === 'Enter' || e.key === ' ') onclick(e as unknown as MouseEvent); } : undefined}
  class={cn(
    'inline-flex items-center rounded-[var(--radius-chip)] font-medium select-none whitespace-nowrap',
    SIZE[size],
    variant === 'filled' ? FILLED[color] : OUTLINED[color],
    onclick && 'cursor-pointer',
    className,
  )}
>
  {#if icon}{@render icon()}{/if}
  {@render children?.()}
</span>
