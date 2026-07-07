<!-- Fixed bottom bar of icon + label tabs. Designed for iOS PWA: respects safe-area inset, h-14 tap targets, home-indicator compatible. Items declared via the `items` prop (data) instead of children snippets so we don't pay a slot-collection round-trip on every nav render. Position uses left-0 right-0 (not inset-inline) for max iOS Safari compatibility; safe-area inset read via env() directly so the fallback is explicit at paint time. -->
<script lang="ts" generics="T extends string | number">
  import type { Snippet } from 'svelte';
  import { cn } from './cn';

  type Item = {
    value: T;
    label: string;
    /** Inline-icon snippet — receives nothing, renders an icon. */
    icon: Snippet;
  };

  type Props = {
    value: T;
    items: readonly Item[];
    onchange: (next: T) => void;
    class?: string;
  };

  let { value, items, onchange, class: className }: Props = $props();
</script>

<nav
  class={cn(
    'fixed left-0 right-0 bottom-0 z-30 flex bg-[color:var(--color-surface)]',
    'border-t border-[color:var(--color-border)]',
    'pb-[env(safe-area-inset-bottom,0px)]',
    className,
  )}
>
  {#each items as item (item.value)}
    {@const active = item.value === value}
    <button
      type="button"
      onclick={() => onchange(item.value)}
      class={cn(
        'flex-1 h-14 flex flex-col items-center justify-center gap-0.5 text-xs',
        'transition-colors',
        active
          ? 'text-[color:var(--color-primary)]'
          : 'text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]',
      )}
      aria-current={active ? 'page' : undefined}
    >
      {@render item.icon()}
      <span>{item.label}</span>
    </button>
  {/each}
</nav>
