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

  type Props = {
    route: Route;
    size?: Size;
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
    isStart = false,
    isEnd = false,
    isFavorite = false,
    selected = false,
    onclick,
    class: className,
    'aria-label': ariaLabel,
  }: Props = $props();

  const fg = $derived(route.textColor ?? pickContrastingText(route.color));

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
  style={`background:${route.color};color:${fg};`}
  class={cn(
    'relative inline-flex items-center justify-center font-bold rounded-md select-none whitespace-nowrap',
    SIZE[size],
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
