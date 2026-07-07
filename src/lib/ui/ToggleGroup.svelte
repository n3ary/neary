<!-- Single-select toggle row (MUI's ToggleButtonGroup + ToggleButton flattened). Used for "today / tomorrow" in schedule and "auto / light / dark" in theme. Multi-select is intentionally not exposed yet — no call site needs it. -->
<script lang="ts" generics="T extends string">
  import type { Snippet } from 'svelte';
  import { ToggleGroup as Bits } from 'bits-ui';
  import { cn } from './cn';

  type Size = 'small' | 'medium';

  type Item = {
    value: T;
    label?: string;
    /** Icon snippet — optional. */
    icon?: Snippet;
    /** Accessible label when only an icon is rendered. */
    'aria-label'?: string;
  };

  type Props = {
    value: T;
    items: Item[];
    onchange: (next: T) => void;
    size?: Size;
    class?: string;
  };

  let { value, items, onchange, size = 'medium', class: className }: Props = $props();

  const SIZE: Record<Size, string> = {
    small: 'text-xs h-7 px-2.5',
    medium: 'text-sm h-9 px-3.5',
  };
</script>

<Bits.Root
  type="single"
  bind:value={() => value, (v: T | undefined) => { if (v) onchange(v); }}
  class={cn(
    'inline-flex rounded-md border border-[color:var(--color-border)] overflow-hidden',
    className,
  )}
>
  {#each items as item (item.value)}
    <Bits.Item
      value={item.value}
      aria-label={item['aria-label']}
      class={cn(
        'inline-flex items-center justify-center gap-1.5 transition-colors',
        SIZE[size],
        'data-[state=on]:bg-[color:var(--color-primary)] data-[state=on]:text-[color:var(--color-primary-fg)]',
        'hover:bg-[color:var(--color-border)]/50',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary)]',
      )}
    >
      {#if item.icon}{@render item.icon()}{/if}
      {#if item.label}<span>{item.label}</span>{/if}
    </Bits.Item>
  {/each}
</Bits.Root>
