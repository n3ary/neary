<!-- RouteChipsRow: badge strip with overflow +N. Visible count = min(naturalFit, maxVisible). The natural fit alone is the cap by default -- a "+N" chip appears only when the catalogue genuinely overflows. maxVisible is an opt-in hard override for callers that need a specific upper bound. -->
<script lang="ts">
  import type { Route } from '$lib/domain/types';
  import RouteBadge from './RouteBadge.svelte';
  import { naturalFit } from './routeChipLayout';

  type Props = {
    routes: Route[];
    /** Optional hard upper bound on visible badges. Overrides the
     *  natural fit for callers that need a specific count. */
    maxVisible?: number;
    class?: string;
  };

  let { routes, maxVisible, class: className }: Props = $props();

  // bind:clientWidth reflects the actual constrained layout (the
  // chip row's container, e.g. the middle column of a flex row),
  // so the natural fit scales with whatever container the row renders in.
  let rowWidth = $state(0);

  const fit = $derived(naturalFit(routes, rowWidth));
  const visibleRoutes = $derived(routes.slice(0, maxVisible ?? fit.visible));
  const hiddenCount = $derived(routes.length - visibleRoutes.length);
</script>

{#if routes.length > 0}
  <!-- overflow-hidden guards against a first-frame paint before rowWidth is measured. -->
  <div
    bind:clientWidth={rowWidth}
    class={`flex items-center gap-1 min-w-0 h-6 overflow-hidden ${className ?? ''}`}
  >
    {#each visibleRoutes as route (route.id)}
      <RouteBadge {route} size="small" class="shrink-0" />
    {/each}
    {#if hiddenCount > 0}
      <span
        class="shrink-0 inline-flex items-center justify-center h-6 min-w-6 px-1.5 text-xs font-medium rounded-md border border-[color:var(--color-border)] text-[color:var(--color-fg-muted)]"
        aria-label={`${hiddenCount} more route${hiddenCount === 1 ? '' : 's'}`}
      >
        +{hiddenCount}
      </span>
    {/if}
  </div>
{/if}
