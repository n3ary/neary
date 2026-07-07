<!-- RouteChipsRow: badge strip with overflow +N. Visible count = min(naturalFit, comfortableCap), where comfortableCap is derived from the natural fit (which is derived from the measured rowWidth) so wide cards still trigger +N when the catalogue exceeds a comfortable density. -->
<script lang="ts">
  import type { Route } from '$lib/domain/types';
  import RouteBadge from './RouteBadge.svelte';
  import { naturalFit, comfortableCap } from './routeChipLayout';

  type Props = {
    routes: Route[];
    /** Optional hard upper bound on visible badges. Overrides the
     *  comfortable cap for callers that want a specific count. */
    maxVisible?: number;
    class?: string;
  };

  let { routes, maxVisible, class: className }: Props = $props();

  // bind:clientWidth reflects the actual constrained layout (the
  // chip row's container, e.g. the middle column of a flex row),
  // so the cap scales with whatever container the row renders in.
  let rowWidth = $state(0);

  const fit = $derived(naturalFit(routes, rowWidth));
  const dynamicCap = $derived(comfortableCap(fit.visible));
  const effectiveMax = $derived(maxVisible ?? dynamicCap);
  const visibleRoutes = $derived(routes.slice(0, Math.min(fit.visible, effectiveMax)));
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
