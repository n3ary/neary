<!-- FavoriteStationRow: single source of truth for the station row used by the search overlay (with optional distance), /favorites, and home. The marker dropdown replaces the old heart toggle; the body tap navigates to /station/[id]. -->
<script lang="ts">
  import { Bus } from 'lucide-svelte';
  import type { Route } from '$lib/domain/types';
  import type { StopWithDistance } from '$lib/data/gtfs/types';
  import type { StationMarker } from '$lib/stores/favoritesStore.svelte';
  import Avatar from './Avatar.svelte';
  import RouteChipsRow from './RouteChipsRow.svelte';
  import StationMarkerDropdown from './StationMarkerDropdown.svelte';
  import { cn } from './cn';

  type Props = {
    /** Accepts the full StopWithDistance from the search overlay OR
     *  the minimal {id, name} shape from the favorites store. The
     *  wider shape enables `hasGps`-gated distance display; the
     *  minimal shape is what the favorites store has on hand. */
    stop: StopWithDistance | { id: string; name: string };
    /** Current marker on the station, or undefined if unstarred. */
    marker: StationMarker | undefined;
    /** Mutate the station's marker; `null` clears it. */
    onChangeMarker: (next: StationMarker | null) => void;
    /** Optional body tap. When null/undefined the row is non-interactive
     *  (the search overlay always supplies one; the home favorites
     *  card uses one for station detail navigation). */
    onbodyclick?: (() => void) | null;
    /** Ordered list of routes serving this station. Renders the
     *  same overflow chip row the search overlay uses. */
    routes?: Route[];
    /** Show a "Nm" / "Nkm" distance chip when true and the stop has
     *  a `distance`. Search overlay passes this from `hasGps`;
     *  favorites surfaces pass false (no distance to show). */
    hasGps?: boolean;
    variant?: 'card' | 'inline';
    class?: string;
  };

  let {
    stop,
    marker,
    onChangeMarker,
    onbodyclick = null,
    routes,
    hasGps = false,
    variant = 'card',
    class: className,
  }: Props = $props();

  const interactive = $derived(typeof onbodyclick === 'function');
  const showChips = $derived(Array.isArray(routes) && routes.length > 0);
  // The wider StopWithDistance shape may or may not carry a `distance`
  // (the favorites store resolves ids via getStopsByIds, which always
  // includes it; older callers might not). 'in' is a type-narrowing
  // operator that needs to run reactively.
  const distance = $derived('distance' in stop ? stop.distance : undefined);

  function formatDistance(m: number): string {
    if (m < 1000) return `${Math.round(m)} m`;
    return `${(m / 1000).toFixed(1)} km`;
  }
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
    <div class="flex items-center gap-2">
      <!-- Marker is conveyed by the dropdown trigger on the right;
           a left-side badge next to the name would be redundant in a
           list row. The dedicated station detail page (/station/[id])
           renders the badge via StationCard. -->
      <span class="min-w-0 flex-1 text-sm font-medium truncate">{stop.name}</span>
      {#if hasGps && distance != null}
        <span class="shrink-0 text-xs font-mono text-[color:var(--color-fg-muted)]">
          {formatDistance(distance)}
        </span>
      {/if}
    </div>
    {#if showChips && routes}
      <RouteChipsRow {routes} />
    {/if}
  </div>
  <div class="flex items-center gap-1 shrink-0">
    <StationMarkerDropdown
      stationId={stop.id}
      {marker}
      onChange={onChangeMarker}
      label={stop.name}
    />
  </div>
</div>