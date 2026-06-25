<!--
  Card — surface container. Tokenized via CSS variables so theme.css fully
  controls the look. variant adds a small accent stripe used by the unified
  Station / Route / Vehicle cards (plan §4).
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn } from './cn';

  type Variant = 'plain' | 'station' | 'route' | 'vehicle';

  type Props = {
    variant?: Variant;
    class?: string;
    children?: Snippet;
  };

  let { variant = 'plain', class: className, children }: Props = $props();

  const ACCENT: Record<Variant, string> = {
    plain: '',
    station: 'border-l-4 border-l-[color:var(--color-primary)]',
    route: 'border-l-4 border-l-[color:var(--color-success)]',
    vehicle: 'border-l-4 border-l-[color:var(--color-warning)]',
  };
</script>

<div
  class={cn(
    'bg-[color:var(--color-surface)] text-[color:var(--color-fg)]',
    'rounded-[var(--radius-card)] border border-[color:var(--color-border)] shadow-sm',
    ACCENT[variant],
    className,
  )}
>
  {@render children?.()}
</div>
