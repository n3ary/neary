<!-- Two-line text block (primary + optional secondary) for use inside a ListItem. Truncates both lines so list rows stay single-line. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn } from './cn';

  type Props = {
    primary?: Snippet | string;
    secondary?: Snippet | string;
    class?: string;
  };

  let { primary, secondary, class: className }: Props = $props();
</script>

<div class={cn('flex flex-col min-w-0', className)}>
  {#if typeof primary === 'string'}
    <span class="text-sm font-medium truncate">{primary}</span>
  {:else if primary}
    {@render primary()}
  {/if}
  {#if typeof secondary === 'string'}
    <span class="text-xs text-[color:var(--color-fg-muted)] truncate">{secondary}</span>
  {:else if secondary}
    {@render secondary()}
  {/if}
</div>
