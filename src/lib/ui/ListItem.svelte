<!-- Row inside a List. `button` makes it interactive (becomes a real <button> child so keyboard / focus / hover all behave correctly). -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes, HTMLButtonAttributes } from 'svelte/elements';
  import { cn } from './cn';

  type Props = {
    /** When true, renders a focusable / clickable button inside the <li>. */
    button?: boolean;
    onclick?: (event: MouseEvent) => void;
    class?: string;
    children?: Snippet;
  } & Omit<HTMLAttributes<HTMLLIElement>, 'onclick' | 'class'>;

  let { button = false, onclick, class: className, children, ...rest }: Props = $props();
</script>

<li class={cn('flex items-stretch', className)} {...rest}>
  {#if button}
    <button
      type="button"
      {onclick}
      class={cn(
        'flex-1 inline-flex items-center gap-3 px-3 py-2 text-left rounded',
        'hover:bg-[color:var(--color-border)]/40',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary)]',
      )}
    >
      {@render children?.()}
    </button>
  {:else}
    <div class="flex-1 inline-flex items-center gap-3 px-3 py-2">
      {@render children?.()}
    </div>
  {/if}
</li>
