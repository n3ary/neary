<!-- Fixed bottom bar of icon + label tabs; position uses left-0 right-0 (not inset-inline) for max iOS Safari compatibility. The nav intentionally has NO bottom safe-area padding: the reserved --color-surface strip at the bottom collapses to --color-bg on dark mode (oklch 20% vs 15%) and reads as a "black bar below the nav" on short views. The iOS home indicator is allowed to overlay the bottom of the nav buttons - the buttons are h-14 (56px) so the indicator covers < 6px of the label baseline, which is acceptable for the visual fix. -->
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
