<!-- Padded scroll region inside a Dialog. Separate from DialogTitle so dialogs can pin a header / footer while the body scrolls. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn } from './cn';

  type Props = {
    class?: string;
    children?: Snippet;
  };

  let { class: className, children }: Props = $props();
</script>

<div class={cn('p-4 overflow-auto', className)}>
  {@render children?.()}
</div>
