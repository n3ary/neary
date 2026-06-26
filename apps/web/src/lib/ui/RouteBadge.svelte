<!--
  RouteBadge — colored pill showing a route's short name. Encodes the
  start / end / turnaround marker pattern from v1 once, so consumers never
  reach into route data to decide stripe orientation.

  Marker semantics:
    - isStart  : a "▶" wedge on the left edge (route departs here).
    - isEnd    : a "■" cap on the right edge (route terminates here).
    - isTurnaround = isStart AND isEnd → both markers, signalling the loop point.
    - isFavorite: a small heart pip in the upper-right.

  Color comes from `route.color`. The text foreground is either an explicit
  `route.textColor` or computed via pickContrastingText (sRGB luminance).
-->
<script lang="ts">
  import { Heart } from 'lucide-svelte';
  import type { Route } from '$lib/domain/types';
  import { pickContrastingText } from '$lib/domain/types';
  import { cn } from './cn';

  type Size = 'small' | 'medium' | 'large';
  /**
   * 'route'   — use the route's own color (default; used inside
   *             VehicleCard and anywhere the badge represents a single
   *             specific vehicle / line).
   * 'neutral' — use a uniform surface-muted background regardless of
   *             the route's color. Favorited routes keep `route.color`
   *             so they pop visually. Used in the StationCard header
   *             badge row so all lines read as equivalent and the row
   *             doesn't look like a clown car.
   */
  type ColorMode = 'route' | 'neutral';

  type Props = {
    route: Route;
    size?: Size;
    colorMode?: ColorMode;
    isStart?: boolean;
    isEnd?: boolean;
    isFavorite?: boolean;
    selected?: boolean;
    onclick?: (event: MouseEvent) => void;
    class?: string;
    /** Accessible label override. Defaults to "Route {shortName}". */
    'aria-label'?: string;
  };

  let {
    route,
    size = 'medium',
    colorMode = 'route',
    isStart = false,
    isEnd = false,
    isFavorite = false,
    selected = false,
    onclick,
    class: className,
    'aria-label': ariaLabel,
  }: Props = $props();

  // In 'route' mode the badge always paints itself with the route's
  // own color. In 'neutral' mode every line flattens to a uniform
  // surface so a long line-up doesn't read like a clown car;
  // favorites then call attention to themselves with red text (and
  // the heart pip below) instead of a re-introduced background
  // color, which would defeat the point of the neutral mode.
  const useRouteColor = $derived(colorMode === 'route');
  const bg = $derived(useRouteColor ? route.color : 'var(--color-surface-elevated)');
  const fg = $derived(
    useRouteColor
      ? (route.textColor ?? pickContrastingText(route.color))
      : isFavorite
        ? 'var(--color-danger)'
        : 'var(--color-fg)',
  );

  const SIZE: Record<Size, string> = {
    small: 'h-6 min-w-6 px-1.5 text-xs',
    medium: 'h-7 min-w-7 px-2 text-sm',
    large: 'h-8 min-w-8 px-2.5 text-base',
  };
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<span
  role={onclick ? 'button' : 'img'}
  tabindex={onclick ? 0 : undefined}
  aria-label={ariaLabel ?? `Route ${route.shortName}`}
  aria-pressed={onclick ? selected : undefined}
  onclick={onclick}
  onkeydown={onclick ? (e) => { if (e.key === 'Enter' || e.key === ' ') onclick(e as unknown as MouseEvent); } : undefined}
  style={`background:${bg};color:${fg};`}
  class={cn(
    'relative inline-flex items-center justify-center font-bold rounded-md select-none whitespace-nowrap',
    SIZE[size],
    !useRouteColor && 'border border-[color:var(--color-border)]',
    onclick && 'cursor-pointer',
    selected && 'ring-2 ring-offset-1 ring-offset-[color:var(--color-surface)] ring-[color:var(--color-fg)]',
    className,
  )}
>
  <!-- Start wedge: subtle inset triangle on the left. Painted in the
       foreground color so it reads against any background route color. -->
  {#if isStart}
    <span
      aria-hidden="true"
      class="absolute left-0.5 top-1/2 -translate-y-1/2 w-0 h-0 opacity-90"
      style={`border-top:4px solid transparent;border-bottom:4px solid transparent;border-left:5px solid ${fg};`}
    ></span>
  {/if}
  <!-- End cap: small filled square on the right edge. -->
  {#if isEnd}
    <span
      aria-hidden="true"
      class="absolute right-0.5 top-1/2 -translate-y-1/2 w-1.5 h-1.5 opacity-90"
      style={`background:${fg};`}
    ></span>
  {/if}
  <!-- Favorite pip: small heart in the upper-right corner. -->
  {#if isFavorite}
    <span
      aria-hidden="true"
      class="absolute -top-1 -right-1 inline-flex items-center justify-center rounded-full bg-[color:var(--color-danger)] text-white"
      style="width:14px;height:14px;"
    >
      <Heart size={9} strokeWidth={3} />
    </span>
  {/if}

  {route.shortName}
</span>
