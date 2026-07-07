<!--
  RouteChipsRow - horizontal strip of RouteBadges with overflow +N.

  `bind:clientWidth` measures the actual layout width at the call
  site, so the fit calculation adapts to whatever container the
  chip row is rendered in (overlay card, picker row, summary card)
  without hardcoded caps. A `maxVisible` cap kicks in for wide
  cards where the full route list would otherwise stretch across
  the entire row and crowd the next stop: at that point the row
  collapses to `maxVisible - 1` badges + a "+N" chip so the user
  sees a stable, scannable summary regardless of how many routes
  serve the stop.

  The visible-badge + +N pattern means the row's width is bounded
  even when the underlying catalogue has dozens of routes for a stop.
-->
<script lang="ts">
  import type { Route } from '$lib/domain/types';
  import RouteBadge from './RouteBadge.svelte';

  type Props = {
    routes: Route[];
    /** Hard cap on the number of visible badges. When the catalogue
     *  exceeds this, the row renders `maxVisible - 1` badges + a
     *  "+N" chip instead of every route. The full list is still
     *  available on the stop's detail page. Default 7 — enough
     *  variety to be scannable, low enough that the +N is
     *  visible on a typical card width. */
    maxVisible?: number;
    class?: string;
  };

  let { routes, maxVisible = 7, class: className }: Props = $props();

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
    if (routes.length === 0) return { visible: 0, hidden: 0 };
    // Zero rowWidth means we haven't measured yet - render nothing
    // rather than a first-paint flash of "everything fits, no +N".
    if (rowWidth <= 0) return { visible: 0, hidden: 0 };
    // First attempt: does the full row fit without an overflow chip?
    let full = 0;
    for (let i = 0; i < routes.length; i++) {
      full += badgeWidth(routes[i].shortName) + (i > 0 ? GAP_PX : 0);
    }
    if (full <= rowWidth) return { visible: routes.length, hidden: 0 };
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
      if (width <= rowWidth) return { visible: n, hidden };
    }
    return { visible: 0, hidden: routes.length };
  });

  // Hard cap path: when the catalogue has more routes than the cap
  // AND the cap-driven slice would actually fit in the row, prefer
  // the cap so the chip row stays scannable on wide cards where the
  // fit-only path would happily dump 18+ badges across the row.
  // min(2) keeps the +N chip meaningful even at very small caps.
  const cappedVisible = $derived(Math.max(2, maxVisible) - 1);
  const visibleRoutes = $derived(
    routes.length > cappedVisible + 1
      ? routes.slice(0, cappedVisible)
      : routes.slice(0, fit.visible),
  );
  const hiddenCount = $derived(
    routes.length > cappedVisible + 1
      ? routes.length - cappedVisible
      : fit.hidden,
  );
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