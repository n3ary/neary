<!--
  Box — polymorphic container. Equivalent to a `<div>` (or other tag via the
  `as` prop) with class composition. Replaces MUI's Box without the sx prop
  runtime.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';
  import { cn } from './cn';

  type Props = HTMLAttributes<HTMLElement> & {
    as?: keyof HTMLElementTagNameMap;
    class?: string;
    children?: Snippet;
  };

  let { as = 'div', class: className, children, ...rest }: Props = $props();
</script>

<svelte:element this={as} class={cn(className)} {...rest}>
  {@render children?.()}
</svelte:element>
