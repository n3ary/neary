<!-- Wraps bits-ui's Tooltip with an MUI-style API (`title` + `placement`). Each instance is self-providing — accessibility + timing still correct, the only cost is each tooltip holds its own delay timer (cheap). -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Tooltip as Bits } from 'bits-ui';
  import { cn } from './cn';

  type Placement = 'top' | 'bottom' | 'left' | 'right';

  type Props = {
    title?: string;
    placement?: Placement;
    class?: string;
    children?: Snippet;
  };

  let { title, placement = 'top', class: className, children }: Props = $props();
</script>

{#if !title}
  {@render children?.()}
{:else}
  <Bits.Provider delayDuration={300}>
    <Bits.Root>
      <!--
        Use bits-ui's child snippet so the trigger DOESN'T render its own
        <button>. Otherwise consumers wrapping a <Button> / <IconButton>
        produce nested <button> elements (SSR / hydration warning). The
        span is inline-flex so the trigger area matches the child's box.
      -->
      <Bits.Trigger>
        {#snippet child({ props })}
          <span {...props} class="inline-flex">
            {@render children?.()}
          </span>
        {/snippet}
      </Bits.Trigger>
      <Bits.Portal>
        <Bits.Content
          side={placement}
          sideOffset={6}
          class={cn(
            'z-50 px-2 py-1 rounded text-xs bg-[color:var(--color-fg)] text-[color:var(--color-bg)] shadow',
            'data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in',
            className,
          )}
        >
          {title}
        </Bits.Content>
      </Bits.Portal>
    </Bits.Root>
  </Bits.Provider>
{/if}
