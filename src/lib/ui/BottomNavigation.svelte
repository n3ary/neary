<!-- Fixed bottom bar of icon + label tabs. Designed for iOS PWA: respects safe-area inset, h-14 tap targets, home-indicator compatible. Items declared via the `items` prop (data) instead of children snippets so we don't pay a slot-collection round-trip on every nav render. Position uses left-0 right-0 (not inset-inline) for max iOS Safari compatibility. `bottom: calc(-1 * var(--space-safe-bottom))` shifts the box down by the safe area so the background always extends to the screen bottom — on iOS PWA standalone `position: fixed; bottom: 0` anchors to the visual viewport (visible area, above the home indicator) on first paint and only snaps to the layout viewport (screen bottom) after the viewport stabilises; shifting the anchor by the safe-area inset gives the same end position in both cases (#227). Safe-area inset read via the `:root` custom property (see theme.css comment) rather than raw env() in a Tailwind class. -->
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
    'pb-[var(--space-safe-bottom)]',
    className,
  )}
  style="bottom: calc(-1 * var(--space-safe-bottom));"
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
