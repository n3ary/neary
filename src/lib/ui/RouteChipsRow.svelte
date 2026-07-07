<!--
  RouteChipsRow - horizontal strip of RouteBadges with overflow +N.

  `bind:clientWidth` measures the actual layout width at the call
  site, so the visible count adapts to whatever container the chip
  row is rendered in (overlay card, picker row, summary card).

  Two layers drive the count:
  1. The natural fit, computed from rowWidth: largest N such that
     N badges + a "+M" chip fits, or every badge if they all fit
     without an overflow chip.
  2. A dynamic `maxVisible` cap, derived from rowWidth, that bounds
     the visible count so the row never paints an uncomfortably
     dense set of badges just because the card is wide. The cap
     formula reserves space for a "+N" chip on top of the per-badge
     width and clamps to a [2, 10] range so narrow rows always
     collapse via +N and wide rows never stretch the row to the
     last possible badge.

  The visible count is min(fit, maxVisible). Callers can override
  `maxVisible` for a hard upper bound (e.g. a scannable summary at
  a specific row width) - useful when the dynamic default is too
  generous for a particular layout.
-->
<script lang="ts">
  import type { Route } from '$lib/domain/types';
  import RouteBadge from './RouteBadge.svelte';

  type Props = {
    routes: Route[];
    /** Optional hard upper bound on visible badges. When supplied,
     *  the row shows min(fit, maxVisible) badges + a "+N" chip for
     *  the rest. When omitted, a dynamic cap derived from the
     *  measured rowWidth applies (see COMFORTABLE_PX / MAX_VISIBLE
     *  in the script). */
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
  // Width budget for the "+N" overflow chip. Two digits + the +
  // glyph fit inside the rounded-md border in ~33px; one-digit
  // counts are 26px. Worst case is 33px.
  const PLUS_N_WIDTH_PX = 33;
  // Comfortable per-badge width including the trailing gap. Each
  // badge is 24-33px and the gap is 4px; 32 is the average end of
  // the range, which keeps the row readable on every common
  // short_name length without crowding the next stop.
  const COMFORTABLE_PX = 32;
  // Upper bound on the dynamic cap. Without this clamp, a 1440px
  // desktop would compute a cap large enough to paint 40+ badges
  // before +N, which defeats the "leave space for +N" property.
  // 10 is the largest count that still reads as a summary.
  const MAX_VISIBLE = 10;

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
      let i = 0;
      for (; i < n; i++) {
        width += badgeWidth(routes[i].shortName) + (i > 0 ? GAP_PX : 0);
      }
      const hidden = routes.length - n;
      const chipWidth = badgeWidth(`+${hidden}`);
      width += (i > 0 ? GAP_PX : 0) + chipWidth;
      if (width <= rowWidth) return { visible: n };
    }
    return { visible: 0 };
  });

  // Dynamic cap derived from the measured rowWidth. Reserves the
  // +N chip's width and assumes a comfortable per-badge width, so
  // the resulting count is "how many badges fit alongside a +N
  // chip at comfortable density". Clamped to [2, MAX_VISIBLE] so
  // narrow rows always collapse and wide rows never stretch past
  // a summary-friendly count.
  const dynamicMaxVisible = $derived.by(() => {
    if (rowWidth <= 0) return MAX_VISIBLE;
    const cap = Math.floor((rowWidth - PLUS_N_WIDTH_PX) / COMFORTABLE_PX);
    return Math.max(2, Math.min(MAX_VISIBLE, cap));
  });

  // Effective cap: caller override wins, otherwise the dynamic cap.
  const effectiveMax = $derived(maxVisible ?? dynamicMaxVisible);
  // Visible count is min(fit, effective cap).
  const visibleRoutes = $derived(routes.slice(0, Math.min(fit.visible, effectiveMax)));
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
