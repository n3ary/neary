<!--
  FavoriteStationRow - single source of truth for the favorited-station
  row layout so a change to the heart, the body tap target, or the
  layout propagates to /favorites, the search overlay, and the home
  page in one edit. Same chrome + a11y shape as FavoriteRouteRow but
  heart-only on the right (stations have no per-station "view all
  schedules" URL - that shape is route-shaped).

  When `routes` is supplied, a RouteChipsRow renders below the name
  showing the routes that serve this station, with the same overflow
  +N chip behaviour as the search overlay's StopSearchCard.
-->
<script lang="ts">
  import { Bus, Heart } from 'lucide-svelte';
  import type { Route } from '$lib/domain/types';
  import Avatar from './Avatar.svelte';
  import RouteChipsRow from './RouteChipsRow.svelte';
  import { cn } from './cn';
  import { iconButtonClass } from './iconButtonClass';

  type Props = {
    /** Station shape compatible with `Station` from $lib/domain/types
     *  (id + name are the only required fields for the row UI). */
    stop: { id: string; name: string };
    isFav: boolean;
    onToggleFavorite: () => void;
    /** Optional body tap. When null/undefined the row is non-interactive. */
    onbodyclick?: (() => void) | null;
    /** Optional ordered list of routes serving this station. When
     *  supplied, renders the same overflow chip row the search overlay
     *  uses so the user sees which routes stop here without leaving the
     *  favorites surface. */
    routes?: Route[];
    variant?: 'card' | 'inline';
    class?: string;
  };

  let {
    stop,
    isFav,
    onToggleFavorite,
    onbodyclick = null,
    routes,
    variant = 'card',
    class: className,
  }: Props = $props();

  const interactive = $derived(typeof onbodyclick === 'function');
  const showChips = $derived(Array.isArray(routes) && routes.length > 0);
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  role={interactive ? 'button' : undefined}
  tabindex={interactive ? 0 : undefined}
  aria-expanded={undefined}
  onclick={interactive
    ? (e) => {
        if ((e.target as Element | null)?.closest('a, button')) return;
        onbodyclick?.();
      }
    : undefined}
  onkeydown={interactive
    ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          if ((e.target as Element | null)?.closest('a, button')) return;
          e.preventDefault();
          onbodyclick?.();
        }
      }
    : undefined}
  class={cn(
    'flex items-center gap-3 rounded-md transition-colors',
    variant === 'card'
      ? 'px-3 py-2 border-2 border-solid border-[color:var(--color-border)] cursor-pointer hover:bg-[color:var(--color-border)]/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary)]'
      : 'px-1 py-1.5 -mx-1 hover:bg-[color:var(--color-border)]/20',
    className,
  )}
>
  <Avatar variant="square" class="w-10 h-10 shrink-0">
    <Bus size={20} />
  </Avatar>
  <div class="min-w-0 flex-1 flex flex-col gap-1">
    <div class="text-sm font-medium truncate">{stop.name}</div>
    {#if showChips && routes}
      <RouteChipsRow routes={routes} />
    {/if}
  </div>
  <div class="flex items-center gap-1 shrink-0">
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
  </div>
</div>