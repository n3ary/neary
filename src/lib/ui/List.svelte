<!-- Semantic <ul> wrapper. No styling beyond removing default browser bullets / padding so callers can compose with Stack-style utilities. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';
  import { cn } from './cn';

  type Props = HTMLAttributes<HTMLUListElement> & {
    class?: string;
    children?: Snippet;
  };

  let { class: className, children, ...rest }: Props = $props();
</script>

<ul class={cn('list-none m-0 p-0 flex flex-col', className)} {...rest}>
  {@render children?.()}
</ul>
