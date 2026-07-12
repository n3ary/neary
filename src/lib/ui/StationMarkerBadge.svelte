<!--
  StationMarkerBadge: a single icon representing a station's marker
  (favorite / home / work / cityCenter). 12-16px, used wherever a
  station's marker should be visible inline (station name rows, vehicle
  stop lists, route card subtitle, search overlay results, etc.).
-->
<script lang="ts">
  import type { StationMarker } from '$lib/stores/favoritesStore.svelte';
  import {
    STATION_MARKER_ICONS, STATION_MARKER_FILL,
  } from '$lib/stores/favoritesStore.svelte';
  import { cn } from './cn';

  type Props = {
    marker: StationMarker;
    /** 12 fits inline next to a station name; 14 next to a route
     *  long name; 16 standalone. Default 14. */
    size?: 12 | 14 | 16;
    class?: string;
  };

  let { marker, size = 14, class: className }: Props = $props();

  const Icon = $derived(STATION_MARKER_ICONS[marker]);
</script>

<Icon
  {size}
  strokeWidth={2.25}
  fill={STATION_MARKER_FILL[marker]}
  class={cn(
    'text-[color:var(--color-favorite)]',
    'shrink-0',
    className,
  )}
  aria-label={marker}
/>