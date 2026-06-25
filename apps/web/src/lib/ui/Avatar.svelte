<!--
  Avatar — square or circular content holder. Size is either a fixed pixel
  number (rendered as inline style) or driven by class utilities (omit the
  prop). Default stays at 40px to match MUI muscle memory at call sites.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn } from './cn';

  type Variant = 'circular' | 'square';

  type Props = {
    variant?: Variant;
    /** Pixel size. Omit and use `class` utilities (e.g. "w-10 h-10") for
     *  responsive sizing. */
    size?: number;
    class?: string;
    children?: Snippet;
  };

  let { variant = 'circular', size, class: className, children }: Props = $props();
</script>

<div
  style={typeof size === 'number' ? `width:${size}px;height:${size}px;` : undefined}
  class={cn(
    'inline-flex items-center justify-center shrink-0 font-medium',
    'bg-[color:var(--color-primary)] text-[color:var(--color-primary-fg)]',
    variant === 'circular' ? 'rounded-full' : 'rounded-md',
    className,
  )}
>
  {@render children?.()}
</div>
