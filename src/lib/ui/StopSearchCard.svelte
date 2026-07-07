<!--
  StopSearchCard: search-overlay station row with optional heart toggle
  (mirrors FavoriteStationRow so the search hit reads as a first-class
  favorite surface).
-->
<script lang="ts">
  import { Bus, Heart } from 'lucide-svelte';
  import type { StopWithDistance } from '$lib/data/gtfs/types';
  import type { Route } from '$lib/domain/types';
  import Avatar from './Avatar.svelte';
  import RouteChipsRow from './RouteChipsRow.svelte';
  import { cn } from './cn';
  import { iconButtonClass } from './iconButtonClass';

  type Props = {
    stop: StopWithDistance;
    /** Ordered, hasSchedule-filtered routes serving this stop. */
    routes: Route[];
    /** Show a distance chip on the right when true. */
    hasGps: boolean;
    onselect: (stopId: string) => void;
    /** When paired with `onToggleFavorite`, the row renders a heart. */
    isFav?: boolean;
    onToggleFavorite?: () => void;
    class?: string;
  };

  let {
    stop, routes, hasGps, onselect,
    isFav = false, onToggleFavorite,
    class: className,
  }: Props = $props();

  function formatDistance(m: number | undefined): string {
    if (m == null) return '';
    if (m < 1000) return `${Math.round(m)} m`;
    return `${(m / 1000).toFixed(1)} km`;
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  role="button"
  tabindex={0}
  onclick={(e) => {
    // Inner controls (heart) bail here so the row's body action
    // doesn't double-fire. Same guard as Favorite{Route,Station}Row.
    if ((e.target as Element | null)?.closest('a, button')) return;
    onselect(stop.id);
  }}
  onkeydown={(e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      if ((e.target as Element | null)?.closest('a, button')) return;
      e.preventDefault();
      onselect(stop.id);
    }
  }}
  class={cn(
    'w-full flex items-center gap-3 px-3 py-2 border-2 border-solid rounded-md transition-colors',
    'border-[color:var(--color-border)] cursor-pointer text-left',
    'hover:bg-[color:var(--color-border)]/30',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary)]',
    className,
  )}
>
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
      <RouteChipsRow {routes} />
    {/if}
  </div>
  {#if onToggleFavorite}
    <button
      type="button"
      aria-label={`${isFav ? 'Unfavorite' : 'Favorite'} station ${stop.name}`}
      aria-pressed={isFav}
      onclick={(e) => { e.stopPropagation(); onToggleFavorite(); }}
      class={iconButtonClass}
    >
      <Heart
        size={16}
        strokeWidth={2.25}
        fill={isFav ? 'currentColor' : 'none'}
        class={isFav ? 'text-[color:var(--color-danger)]' : 'text-[color:var(--color-fg-muted)]'}
      />
    </button>
  {/if}
</div>
