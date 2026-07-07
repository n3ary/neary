<!--
  RouteChipsRow - horizontal strip of RouteBadges with overflow +N.

  `bind:clientWidth` measures the actual layout width at the call
  site, so the fit calculation adapts to whatever container the
  chip row is rendered in (overlay card, picker row, summary card)
  without hardcoded caps. The visible count is purely fit-driven:
  the row shows as many badges as the measured rowWidth can hold
  (the largest N such that N badges + a "+M" chip fits, or every
  badge if they all fit without an overflow chip), then collapses
  the rest into a single +N chip.

  An optional `maxVisible` prop caps the visible count for callers
  that want a hard upper bound (e.g. a scannable summary at a
  specific row width). When omitted, no caller cap applies and the
  fit calculation is the sole driver.

  The visible-badge + +N pattern means the row's width is bounded
  even when the underlying catalogue has dozens of routes for a stop.
-->
<script lang="ts">
  import type { Route } from '$lib/domain/types';
  import RouteBadge from './RouteBadge.svelte';

  type Props = {
    routes: Route[];
    /** Optional hard upper bound on visible badges. When supplied,
     *  the row shows min(fit, maxVisible) badges + a "+N" chip for
     *  the rest. When omitted, the fit calculation alone drives
     *  the visible count - the row fills its available space and
     *  +N only appears when the catalogue truly overflows. */
    maxVisible?: number;
    class?: string;
  };

  let { routes, maxVisible, class: className }: Props = $props();

  // Measured badge-row width. `bind:clientWidth` gives us layout size
  // that reflects the actual container bounds, so we don't need to
  // guess mobile vs desktop.
  let rowWidth = $state(0);

  // Estimated pixel width of one RouteBadge (size='small') given its
  // short_name. Matches the badge's `h-6 min-w-6 px-1.5 text-xs`
  // shape: 12px of horizontal padding, minimum 24px total, and ~7px
  // per additional character at text-xs. Verified against multi-feed
  // catalogues (short_names up to 5 chars).
  function badgeWidth(text: string): number {
    return Math.max(24, text.length * 7 + 12);
  }
  const GAP_PX = 4; // matches Tailwind `gap-1`

  const fit = $derived.by(() => {
    if (routes.length === 0) return { visible: 0 };
    // Zero rowWidth means we haven't measured yet - render nothing
    // rather than a first-paint flash of "everything fits, no +N".
    if (rowWidth <= 0) return { visible: 0 };
    // First attempt: does the full row fit without an overflow chip?
    let full = 0;
    for (let i = 0; i < routes.length; i++) {
      full += badgeWidth(routes[i].shortName) + (i > 0 ? GAP_PX : 0);
    }
    if (full <= rowWidth) return { visible: routes.length };
    // Otherwise find the largest N such that first N badges + a
    // "+M" chip fits. M = total - N; overflow chip's width grows
    // with M's digits (26px for "+9", 33px for "+99"), so the fit
    // check accounts for that. Linear scan; N is small enough that
    // the extra pass over cumulative widths is trivial.
    for (let n = routes.length - 1; n >= 0; n--) {
      let width = 0;
      for (let i = 0; i < n; i++) {
        width += badgeWidth(routes[i].shortName) + (i > 0 ? GAP_PX : 0);
      }
      const hidden = routes.length - n;
      const chipWidth = badgeWidth(`+${hidden}`);
      width += (n > 0 ? GAP_PX : 0) + chipWidth;
      if (width <= rowWidth) return { visible: n };
    }
    return { visible: 0 };
  });

  // Visible count is min(fit, optional cap). With no cap, the fit
  // calculation alone decides how many badges paint, and the row
  // fills the available width before resorting to +N.
  const visibleRoutes = $derived(
    maxVisible != null
      ? routes.slice(0, Math.min(fit.visible, maxVisible))
      : routes.slice(0, fit.visible),
  );
  const hiddenCount = $derived(routes.length - visibleRoutes.length);
</script>

{#if routes.length > 0}
  <!-- Fixed-height, no-wrap chip row. `overflow-hidden` guards
       against a first-frame paint before rowWidth is measured. -->
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