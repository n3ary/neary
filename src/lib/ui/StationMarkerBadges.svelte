<!--
  Renders the unique station markers (favorite / home / work / cityCenter)
  for a list of stop IDs. Markers appear once each in canonical
  StationMarker order (favorite, home, work, cityCenter) regardless of
  how many stops carry them. Sized for inline placement next to a
  headsign / route title; the 14px default matches the dropdown's
  option-icon size so the visual language is consistent.
-->
<script lang="ts">
  import type { StationMarker } from '$lib/stores/favoritesStore.svelte';
  import { STATION_MARKERS } from '$lib/stores/favoritesStore.svelte';
  import { Briefcase, Heart, Home, Radio } from 'lucide-svelte';
  import { cn } from './cn';

  type Props = {
    /** Stop IDs whose markers we want to surface. Stations not in
     *  `markerFor` are skipped; duplicates collapse to one. */
    stopIds: readonly string[];
    /** Per-stop marker lookup. Pass the same `markerFor` function the
     *  store exposes (`(stopId) => StationMarker | undefined`). */
    markerFor: (stopId: string) => StationMarker | undefined;
    size?: 12 | 14 | 16;
    class?: string;
  };

  let { stopIds, markerFor, size = 14, class: className }: Props = $props();

  // Unique markers across all stops, in canonical STATION_MARKERS order
  // so the visual ordering is stable across views.
  const uniqueMarkers = $derived.by<StationMarker[]>(() => {
    const seen = new Set<StationMarker>();
    for (const id of stopIds) {
      const m = markerFor(id);
      if (m !== undefined) seen.add(m);
    }
    return STATION_MARKERS.filter((m) => seen.has(m));
  });

  const ICON: Record<StationMarker, typeof Heart> = {
    favorite: Heart,
    home: Home,
    work: Briefcase,
    cityCenter: Radio,
  };

  const COLOR: Record<StationMarker, string> = {
    favorite: 'text-[color:var(--color-danger)]',
    home: 'text-[color:var(--color-primary)]',
    work: 'text-[color:var(--color-primary)]',
    cityCenter: 'text-[color:var(--color-primary)]',
  };

  const FILL: Record<StationMarker, 'currentColor' | 'none'> = {
    favorite: 'currentColor',
    home: 'none',
    work: 'none',
    cityCenter: 'none',
  };
</script>

{#if uniqueMarkers.length > 0}
  <div class={cn('inline-flex items-center gap-0.5', className)}>
    {#each uniqueMarkers as m (m)}
      {@const Icon = ICON[m]}
      <Icon
        {size}
        strokeWidth={2.25}
        fill={FILL[m]}
        class={cn('shrink-0', COLOR[m])}
        aria-label={m}
      />
    {/each}
  </div>
{/if}