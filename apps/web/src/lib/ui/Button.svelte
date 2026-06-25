<!--
  Button — primary action element. `variant` × `color` × `size` cover the
  cases used across the app today (the MUI inventory had no more knobs). All
  visual properties resolve to theme tokens via CSS vars.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import { cn } from './cn';

  type Variant = 'contained' | 'outlined' | 'text';
  type Color = 'primary' | 'danger' | 'inherit';
  type Size = 'small' | 'medium' | 'large';

  type Props = Omit<HTMLButtonAttributes, 'class'> & {
    variant?: Variant;
    color?: Color;
    size?: Size;
    /** Optional icon slot rendered before the label. */
    startIcon?: Snippet;
    /** Optional icon slot rendered after the label. */
    endIcon?: Snippet;
    class?: string;
    children?: Snippet;
  };

  let {
    variant = 'contained',
    color = 'primary',
    size = 'medium',
    startIcon,
    endIcon,
    type = 'button',
    class: className,
    children,
    ...rest
  }: Props = $props();

  const BASE =
    'inline-flex items-center justify-center gap-2 font-medium rounded-md transition-colors select-none ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary)] ' +
    'disabled:opacity-50 disabled:cursor-not-allowed';

  const SIZE: Record<Size, string> = {
    small: 'text-xs px-2.5 h-7',
    medium: 'text-sm px-3.5 h-9',
    large: 'text-base px-4 h-11',
  };

  function variantClasses(v: Variant, c: Color): string {
    if (v === 'contained') {
      if (c === 'danger') return 'bg-[color:var(--color-danger)] text-white hover:opacity-90';
      if (c === 'inherit') return 'bg-[color:var(--color-surface)] text-[color:var(--color-fg)] hover:bg-[color:var(--color-border)]';
      return 'bg-[color:var(--color-primary)] text-[color:var(--color-primary-fg)] hover:opacity-90';
    }
    if (v === 'outlined') {
      const ring =
        c === 'danger' ? 'var(--color-danger)' :
        c === 'inherit' ? 'currentColor' : 'var(--color-primary)';
      return `border border-[color:${ring}] text-[color:${ring}] hover:bg-[color:${ring}]/10`;
    }
    const fg =
      c === 'danger' ? 'var(--color-danger)' :
      c === 'inherit' ? 'currentColor' : 'var(--color-primary)';
    return `text-[color:${fg}] hover:bg-[color:${fg}]/10`;
  }
</script>

<button
  {type}
  class={cn(BASE, SIZE[size], variantClasses(variant, color), className)}
  {...rest}
>
  {#if startIcon}{@render startIcon()}{/if}
  {@render children?.()}
  {#if endIcon}{@render endIcon()}{/if}
</button>
