<!-- Fixed bottom bar of icon + label tabs. Designed for iOS PWA: respects safe-area inset, h-14 tap targets, home-indicator compatible. Items declared via the `items` prop (data) instead of children snippets so we don't pay a slot-collection round-trip on every nav render. Position uses left-0 right-0 (not inset-inline) for max iOS Safari compatibility. On iOS PWA standalone `position: fixed; bottom: 0` anchors to the visual viewport (visible area, above the home indicator) on first paint and only snaps to the layout viewport (screen bottom) after the viewport stabilises — so the bottom anchor is shifted up by the safe-area inset on first paint and lands at the same screen-bottom position in both states. Bottom padding is a FIXED 34px (the iOS home-indicator height) rather than env() — env() resolves to 0 in the layout viewport post-navigation, which would leave the nav's content sitting in the home-indicator area and trigger the iOS bottom-edge swipe gesture (#227). -->
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
    'fixed left-0 right-0 z-30 flex bg-[color:var(--color-surface)]',
    'border-t border-[color:var(--color-border)]',
    'pb-[34px]',
    className,
  )}
  style="bottom: calc(-1 * env(safe-area-inset-bottom, 34px));"
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
