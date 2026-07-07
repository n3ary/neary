<!-- Expand/collapse animation. Pure CSS via the grid-template-rows: 1fr / 0fr trick — the only modern way to animate from 0 to intrinsic content height without JS measuring. Semantics are display-only (no headless lib). Interruptible transition respects prefers-reduced-motion when caller passes `reduced=true`. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn } from './cn';

  type Props = {
    in?: boolean;
    open?: boolean;
    /** Disable the animation; useful when the parent already animates. */
    reduced?: boolean;
    class?: string;
    children?: Snippet;
  };

  let { in: inProp, open, reduced = false, class: className, children }: Props = $props();
  const isOpen = $derived(inProp ?? open ?? false);
</script>

<div
  data-state={isOpen ? 'open' : 'closed'}
  class={cn(
    'grid',
    reduced ? '' : 'transition-[grid-template-rows] duration-200 ease-out',
    isOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
    className,
  )}
  aria-hidden={!isOpen}
>
  <div class="overflow-hidden min-h-0">
    {@render children?.()}
  </div>
</div>

