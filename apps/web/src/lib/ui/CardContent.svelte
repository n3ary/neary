<!--
  CardContent — padded body slot for a Card. Separate primitive so Card can
  host a header or footer alongside the main content without re-deriving
  padding rules.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn } from './cn';

  type Props = {
    class?: string;
    children?: Snippet;
  };

  let { class: className, children }: Props = $props();
</script>

<div class={cn('p-3 sm:p-4', className)}>
  {@render children?.()}
</div>
