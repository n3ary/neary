<!-- Compact ordered stop list for a single trip. Shared by the schedule view's expanded trip row and the station view's vehicle stop-expansion panel.

  The caller is responsible for slicing stops to the right starting
  point (e.g. slice from the stop after the current station).
  This component just renders what it receives.

  showDepartureMarker: adds a departure arrow to row 0 (used by the
  schedule view where the first stop is the trip's true origin).
  Omit (or false) in station view where stops start mid-trip.

  markers: optional stopId -> StationMarker map. When provided, the
  marker badge renders next to the stop name. The caller decides which
  markers to include (e.g. skip the same-type marker as the current
  station on /station/[id] to avoid redundancy).
-->
<script lang="ts">
  import { ArrowUpRight, ExternalLink } from 'lucide-svelte';
  import type { ScheduleTripStop } from '$lib/data/gtfs/types';
  import { formatHHMM } from '$lib/domain/types';
  import type { StationMarker } from '$lib/stores/favoritesStore.svelte';
  import Chip from './Chip.svelte';
  import Stack from './Stack.svelte';
  import StationMarkerBadge from './StationMarkerBadge.svelte';

  type Props = {
    stops: ScheduleTripStop[];
    showDepartureMarker?: boolean;
    /** When provided, a matching StationMarkerBadge renders next to
     *  the stop name. Stops without an entry render without a badge. */
    markers?: ReadonlyMap<string, StationMarker>;
    /** Hide the per-stop times — used for orphan vehicles, where the
     *  stop sequence comes from a representative trip the vehicle
     *  isn't actually running, so its times would mislead. Stops
     *  flagged `estimated` still show, with a "~" prefix. */
    hideTimes?: boolean;
    class?: string;
  };

  let { stops, showDepartureMarker = false, markers, hideTimes = false, class: className }: Props = $props();
</script>

<Stack spacing={0.5} class={className}>
  {#each stops as s, i (s.stopSequence)}
    <!-- Whole row navigates to the station view. The trailing
         ExternalLink icon is kept (inside the anchor) so the
         tap-to-open affordance is visually obvious. -->
    <a
      href={`/station/${s.stopId}`}
      aria-label={`Open station ${s.stopName}`}
      class="block no-underline text-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary)] rounded-md"
    >
      <Stack
        direction="row"
        spacing={1}
        align="center"
        class="px-2 py-1 rounded-md hover:bg-[color:var(--color-border)]/30"
      >
        <Chip size="small" class="font-mono shrink-0">{i + 1}</Chip>
        {#if markers && markers.has(s.stopId)}
          <StationMarkerBadge marker={markers.get(s.stopId)!} size={12} />
        {/if}
        <span class="flex-1 min-w-0 text-xs truncate">{s.stopName}</span>
        {#if !hideTimes || s.estimated}
          <span class="flex items-center gap-0.5 text-[color:var(--color-fg-muted)] font-mono text-xs shrink-0">
            {#if showDepartureMarker && i === 0}
              <ArrowUpRight size={12} class="text-[color:var(--color-danger)]" aria-label="Departure" />
            {/if}
            {s.estimated ? '~' : ''}{formatHHMM(s.arrivalMin)}
          </span>
        {/if}
        <ExternalLink
          size={16}
          class="shrink-0 text-[color:var(--color-fg-muted)]"
          aria-hidden="true"
        />
      </Stack>
    </a>
  {/each}
</Stack>