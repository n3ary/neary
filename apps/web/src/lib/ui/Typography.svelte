<!--
  Typography — semantic + visually scaled text. Variant chooses both the tag
  and the class set; component prop overrides the tag without losing the
  variant's styling.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn } from './cn';

  type Variant = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'body' | 'body2' | 'caption' | 'overline';

  type Props = {
    variant?: Variant;
    as?: keyof HTMLElementTagNameMap;
    class?: string;
    children?: Snippet;
  };

  let { variant = 'body', as, class: className, children }: Props = $props();

  const CLASSES: Record<Variant, string> = {
    h1: 'text-4xl font-bold tracking-tight',
    h2: 'text-3xl font-semibold tracking-tight',
    h3: 'text-2xl font-semibold',
    h4: 'text-xl font-semibold',
    h5: 'text-lg font-medium',
    h6: 'text-base font-semibold',
    body: 'text-base',
    body2: 'text-sm',
    caption: 'text-xs text-[color:var(--color-fg-muted)]',
    overline: 'text-xs uppercase tracking-wider text-[color:var(--color-fg-muted)]',
  };

  const TAGS: Record<Variant, keyof HTMLElementTagNameMap> = {
    h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h5', h6: 'h6',
    body: 'p', body2: 'p', caption: 'span', overline: 'span',
  };

  const tag = $derived(as ?? TAGS[variant]);
</script>

<svelte:element this={tag} class={cn(CLASSES[variant], className)}>
  {@render children?.()}
</svelte:element>
