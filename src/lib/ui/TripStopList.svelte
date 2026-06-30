<!--
  TripStopList — compact ordered stop list for a single trip.
  Shared by the schedule view's expanded trip row and the station
  view's vehicle stop-expansion panel.

  The caller is responsible for slicing stops to the right starting
  point (e.g. slice from the stop after the current station).
  This component just renders what it receives.

  showDepartureMarker: adds a departure arrow to row 0 (used by the
  schedule view where the first stop is the trip's true origin).
  Omit (or false) in station view where stops start mid-trip.
-->
<script lang="ts">
  import { ArrowUpRight, ExternalLink } from 'lucide-svelte';
  import type { ScheduleTripStop } from '$lib/data/gtfs/types';
  import { formatHHMM } from '$lib/domain/types';
  import Chip from './Chip.svelte';
  import Stack from './Stack.svelte';

  type Props = {
    stops: ScheduleTripStop[];
    showDepartureMarker?: boolean;
    class?: string;
  };

  let { stops, showDepartureMarker = false, class: className }: Props = $props();
</script>

<Stack spacing={0.5} class={className}>
  {#each stops as s, i (s.stopId)}
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
        <span class="flex-1 min-w-0 text-xs truncate">{s.stopName}</span>
        <span class="flex items-center gap-0.5 text-[color:var(--color-fg-muted)] font-mono text-xs shrink-0">
          {#if showDepartureMarker && i === 0}
            <ArrowUpRight size={12} class="text-[color:var(--color-danger)]" aria-label="Departure" />
          {/if}
          {formatHHMM(s.arrivalMin)}
        </span>
        <ExternalLink
          size={16}
          class="shrink-0 text-[color:var(--color-fg-muted)]"
          aria-hidden="true"
        />
      </Stack>
    </a>
  {/each}
</Stack>
