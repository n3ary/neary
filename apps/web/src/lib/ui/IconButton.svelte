<!--
  IconButton — round, icon-only button. Same focus / disabled behaviour as
  Button minus the label slot and padding rules.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import { cn } from './cn';

  type Size = 'small' | 'medium' | 'large';
  type Color = 'inherit' | 'primary' | 'danger';

  type Props = Omit<HTMLButtonAttributes, 'class'> & {
    size?: Size;
    color?: Color;
    class?: string;
    children?: Snippet;
  };

  let {
    size = 'medium',
    color = 'inherit',
    type = 'button',
    class: className,
    children,
    ...rest
  }: Props = $props();

  const SIZE: Record<Size, string> = {
    small: 'w-8 h-8',
    medium: 'w-10 h-10',
    large: 'w-12 h-12',
  };

  const COLOR: Record<Color, string> = {
    inherit: 'text-current hover:bg-current/10',
    primary: 'text-[color:var(--color-primary)] hover:bg-[color:var(--color-primary)]/10',
    danger: 'text-[color:var(--color-danger)] hover:bg-[color:var(--color-danger)]/10',
  };
</script>

<button
  {type}
  class={cn(
    'inline-flex items-center justify-center rounded-full transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary)]',
    'disabled:opacity-50 disabled:cursor-not-allowed',
    SIZE[size],
    COLOR[color],
    className,
  )}
  {...rest}
>
  {@render children?.()}
</button>
