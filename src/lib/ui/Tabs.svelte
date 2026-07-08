<!-- Wraps bits-ui's Tabs with a simpler API: pass a `value` and an `items` array; consumer renders the active panel below via the active value (single source of truth). Headless lib handles keyboard navigation (arrow keys, Home/End), roving tabindex, a11y roles. -->
<script lang="ts" generics="T extends string">
  import { Tabs as Bits } from 'bits-ui';
  import { cn } from './cn';

  type Item = {
    value: T;
    label: string;
  };

  type Props = {
    value: T;
    items: Item[];
    onchange: (next: T) => void;
    /** `inline` (default) - pills side-by-side. `block` - tab
     *  triggers span full row width, two equal columns. The block
     *  variant is what /favorites uses so the tabs read as a top-level
     *  page section rather than a corner chip. */
    variant?: 'inline' | 'block';
    class?: string;
  };

  let { value, items, onchange, variant = 'inline', class: className }: Props = $props();
</script>

<Bits.Root
  bind:value={() => value, (v: T) => onchange(v)}
  class={cn('w-full', className)}
>
  <Bits.List
    class={cn(
      variant === 'block'
        ? 'grid w-full grid-cols-2'
        : 'inline-flex items-center gap-1 p-1 rounded-md bg-[color:var(--color-border)]/50',
    )}
  >
    {#each items as item (item.value)}
      <Bits.Trigger
        value={item.value}
        class={cn(
          'px-3 h-9 text-sm transition-colors',
          variant === 'block'
            // Selected tab fills with a soft primary tint; the
            // surrounding container in /favorites handles the
            // shared border so the tabs and the catalog card read
            // as one section.
            ? 'text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)] data-[state=active]:bg-[color:var(--color-primary)]/15 data-[state=active]:text-[color:var(--color-primary)] data-[state=active]:font-semibold'
            : 'rounded-md data-[state=active]:bg-[color:var(--color-surface)] data-[state=active]:text-[color:var(--color-fg)] data-[state=active]:shadow-sm text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary)]',
        )}
      >
        {item.label}
      </Bits.Trigger>
    {/each}
  </Bits.List>
</Bits.Root>