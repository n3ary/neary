<!-- Header strip for a Dialog. Renders an accessible <h2> via bits-ui's Title primitive and an optional close button on the right. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Dialog as Bits } from 'bits-ui';
  import { X } from 'lucide-svelte';
  import { cn } from './cn';

  type Props = {
    onclose?: () => void;
    class?: string;
    children?: Snippet;
  };

  let { onclose, class: className, children }: Props = $props();
</script>

<div
  class={cn(
    'flex items-center justify-between gap-3 px-4 py-3 border-b border-[color:var(--color-border)]',
    className,
  )}
>
  <Bits.Title class="text-lg font-semibold">
    {@render children?.()}
  </Bits.Title>
  {#if onclose}
    <button
      type="button"
      aria-label="Close"
      onclick={onclose}
      class="inline-flex h-8 w-8 items-center justify-center rounded-full hover:bg-[color:var(--color-border)]"
    >
      <X size={18} />
    </button>
  {/if}
</div>
