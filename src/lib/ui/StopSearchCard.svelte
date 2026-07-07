<!-- Station result row for the header search overlay. Fixed-height card with the station badge, name, distance, and a horizontal row of route chips. Chip row uses `bind:clientWidth`
  to measure the actual space it has and fits as many RouteBadges as
  will fit, then collapses the rest into a "+N" chip. Because the
  overlay's card width varies with viewport, this yields more badges
  on desktop than on mobile without a hardcoded cap.
-->
<script lang="ts">
  import { Bus } from 'lucide-svelte';
  import type { StopWithDistance } from '$lib/data/gtfs/types';
  import type { Route } from '$lib/domain/types';
  import Avatar from './Avatar.svelte';
  import RouteBadge from './RouteBadge.svelte';
  import { cn } from './cn';

  type Props = {
    stop: StopWithDistance;
    /** Ordered, hasSchedule-filtered routes serving this stop. */
    routes: Route[];
    /** Show a distance chip on the right when true. */
    hasGps: boolean;
    onselect: (stopId: string) => void;
    class?: string;
  };

  let { stop, routes, hasGps, onselect, class: className }: Props = $props();

  // Measured badge-row width. `bind:clientWidth` gives us layout size
  // that reflects the actual viewport + overlay bounds, so we don't
  // need to guess mobile vs desktop.
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
    // Zero rowWidth means we haven't measured yet -- render nothing
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

  const visibleRoutes = $derived(routes.slice(0, fit.visible));

  function formatDistance(m: number | undefined): string {
    if (m == null) return '';
    if (m < 1000) return `${Math.round(m)} m`;
    return `${(m / 1000).toFixed(1)} km`;
  }
</script>

<button
  type="button"
  onclick={() => onselect(stop.id)}
  class={cn(
    'w-full flex items-center gap-3 px-3 py-2 border-2 border-solid rounded-md transition-colors',
    'border-[color:var(--color-border)] cursor-pointer text-left',
    'hover:bg-[color:var(--color-border)]/30',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary)]',
    className,
  )}
>
  <!-- Same station badge as StationCard header: square Avatar + Bus. -->
  <Avatar variant="square" class="w-10 h-10 shrink-0">
    <Bus size={20} />
  </Avatar>
  <div class="min-w-0 flex-1 flex flex-col gap-1">
    <div class="flex items-center gap-2">
      <span class="min-w-0 flex-1 text-sm font-medium truncate">{stop.name}</span>
      {#if hasGps && stop.distance != null}
        <span class="shrink-0 text-xs font-mono text-[color:var(--color-fg-muted)]">
          {formatDistance(stop.distance)}
        </span>
      {/if}
    </div>
    {#if routes.length > 0}
      <!-- Fixed-height, no-wrap chip row. `overflow-hidden` guards
           against a first-frame paint before rowWidth is measured. -->
      <div
        bind:clientWidth={rowWidth}
        class="flex items-center gap-1 min-w-0 h-6 overflow-hidden"
      >
        {#each visibleRoutes as route (route.id)}
          <RouteBadge {route} size="small" class="shrink-0" />
        {/each}
        {#if fit.hidden > 0}
          <span
            class="shrink-0 inline-flex items-center justify-center h-6 min-w-6 px-1.5 text-xs font-medium rounded-md border border-[color:var(--color-border)] text-[color:var(--color-fg-muted)]"
            aria-label={`${fit.hidden} more route${fit.hidden === 1 ? '' : 's'}`}
          >
            +{fit.hidden}
          </span>
        {/if}
      </div>
    {/if}
  </div>
</button>
