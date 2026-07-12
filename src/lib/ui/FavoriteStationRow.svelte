<!-- FavoriteStationRow: plain tappable station row used by the search overlay (with optional distance) and /favorites. Tapping the row navigates to /station/[id] where the marker dropdown lives via the StationCard avatar. -->
<script lang="ts">
  import { Bus } from 'lucide-svelte';
  import type { Route } from '$lib/domain/types';
  import type { StopWithDistance } from '$lib/data/gtfs/types';
  import type { StationMarker } from '$lib/stores/favoritesStore.svelte';
  import { STATION_MARKER_ICONS, STATION_MARKER_ACCENT } from '$lib/stores/favoritesStore.svelte';
  import Avatar from './Avatar.svelte';
  import RouteChipsRow from './RouteChipsRow.svelte';
  import { cn } from './cn';

  type Props = {
    /** Accepts the full StopWithDistance from the search overlay OR
     *  the minimal {id, name} shape from the favorites store. The
     *  wider shape enables `hasGps`-gated distance display; the
     *  minimal shape is what the favorites store has on hand. */
    stop: StopWithDistance | { id: string; name: string };
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
    /** Marker for this station. Drives the avatar background colour
     *  (amber for favorite, blue for home/work/cityCenter, blue for normal).
     *  When omitted the Avatar uses the default blue. */
    marker?: StationMarker | null;
    class?: string;
  };

  let {
    stop,
    onbodyclick = null,
    routes,
    hasGps = false,
    variant = 'card',
    marker,
    class: className,
  }: Props = $props();

  const interactive = $derived(typeof onbodyclick === 'function');
  const showChips = $derived(Array.isArray(routes) && routes.length > 0);
  // The wider StopWithDistance shape may or may not carry a `distance`
  // (the favorites store resolves ids via getStopsByIds, which always
  // includes it; older callers might not). 'in' is a type-narrowing
  // operator that needs to run reactively.
  const distance = $derived('distance' in stop ? stop.distance : undefined);

  // Avatar icon: marker icon when the station has a marker, Bus otherwise.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const AvatarIcon = $derived(marker != null ? STATION_MARKER_ICONS[marker] as any : Bus);
  const avatarAccent = $derived(marker != null ? STATION_MARKER_ACCENT[marker] : 'var(--color-primary)');

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
  <Avatar variant="square" class="w-10 h-10 shrink-0" style={`background-color: ${avatarAccent}; color: var(--color-fg);`}>
    <AvatarIcon size={20} />
  </Avatar>
  <div class="min-w-0 flex-1 flex flex-col gap-1">
    <div class="flex items-center gap-2">
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
</div>
