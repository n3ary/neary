<!--
  VehicleCard — single component covering the 4-state vehicle taxonomy
  (plan §4). The visual encoding (solid / dashed / dotted / 50% opacity,
  badge icon, accent color) is mechanical from `vehicle.kind`, so every
  surface that renders a vehicle (list, schedule board, map popup) reads
  identically.

  Layout:
    [ RouteBadge ] [ headsign + secondary info ]            [ kind badge ]
                  [ ETA chip / scheduled time chip      ]

  Pure presentational — no business logic. Vehicle is the discriminated
  union; this component reads it.
-->
<script lang="ts">
  import { ArrowDownLeft, ArrowRight, Calendar, ChevronDown, Map as MapIcon } from 'lucide-svelte';
  import type { Vehicle } from '$lib/domain/types';
  import { formatHHMM, formatRelativeMin } from '$lib/domain/types';
  import type { Urgency } from '$lib/domain/buckets';
  import RouteBadge from './RouteBadge.svelte';
  import { urgencyClass } from './urgencyClass';
  import { cn } from './cn';

  type Props = {
    vehicle: Vehicle;
    /** ETA urgency, computed in the domain (see `etaUrgency`). When
     *  omitted (map popup, standalone), the secondary line stays muted. */
    urgency?: Urgency;
    onclick?: () => void;
    /** When set, the schedule icon button is shown and links here.
     *  Used by StationCard to deep-link into /schedule/route/[id]. */
    scheduleHref?: string;
    /** When set, the map icon button is shown and links here. */
    mapHref?: string;
    /** When set, the expand icon button is shown and fires this
     *  callback. Used by StationCard to toggle the per-vehicle
     *  upcoming-stops list. The route badge stays identity-only. */
    onStopsExpand?: () => void;
    /** Reflects the expanded state of the stops list panel; rotates
     *  the chevron when true. */
    stopsExpanded?: boolean;
    class?: string;
  };

  let {
    vehicle, urgency, onclick, scheduleHref, mapHref,
    onStopsExpand, stopsExpanded = false,
    class: className,
  }: Props = $props();

  // Per-kind state dot. Two colors only: green = GPS-backed
  // (`gps-only` / `tracked` / `verified`), grey = schedule-derived
  // (`scheduled`). Tooltip carries the specific kind. A darker-green
  // variant for `verified` (multi-source agreement) is planned but
  // not yet differentiated — gated on the Tranzy integration.
  const KIND = $derived({
    verified:    { label: 'Verified',  dotBg: 'bg-[color:var(--color-success)]' },
    tracked:     { label: 'Tracked',   dotBg: 'bg-[color:var(--color-success)]' },
    'gps-only':  { label: 'GPS only',  dotBg: 'bg-[color:var(--color-success)]' },
    scheduled:   { label: 'Scheduled', dotBg: 'bg-[color:var(--color-fg-muted)]' },
  }[vehicle.kind]);

  // Suppress the kind dot for `scheduled` rows whose `tripPhase` is
  // `later` — at the origin stop those are the future-but-not-next
  // rows where the grey dot adds no information (the rider already
  // knows the row is on the schedule). The `next` / `last` /
  // `on-route` origin rows keep the dot because the data-source
  // distinction (parked-but-on-schedule vs running-without-GPS) is
  // useful there. tripPhase is only set on `isFirstStop` rows, so
  // this rule is implicitly origin-only — intermediate-stop
  // scheduled rows keep their dot.
  const showKindDot = $derived(
    !(vehicle.kind === 'scheduled' && vehicle.schedule?.tripPhase === 'later'),
  );

  // ETA / scheduled-time secondary line.
  //
  // Unlike the schedule view (which renders the clock time as a
  // dedicated chip on every row), VehicleCard has only this one slot
  // for time info. So for far-out trips (>15 min, where 'in 1h 30m'
  // is harder to translate into a concrete moment than the clock
  // time itself), we append the scheduled HH:MM here. Close trips
  // stay on the relative form alone — 'in 5 min' beats 'at 16:50'
  // when the action window is now.
  const secondaryLine = $derived.by(() => {
    if (vehicle.eta) {
      const rel = formatRelativeMin(vehicle.eta.minutes);
      const sched = vehicle.schedule?.scheduledDeparture;
      if (sched != null && vehicle.eta.minutes > 15) {
        return `${rel} (at ${formatHHMM(sched)})`;
      }
      return rel;
    }
    if (vehicle.schedule) return `Scheduled ${formatHHMM(vehicle.schedule.scheduledDeparture)}`;
    // kind:'gps-only' orphans have a GPS position but no schedule/ETA — the bus
    // exists right now even though we don't have a precise per-stop timing
    // for it. 'En route' wrongly implies "departed on schedule, GPS unknown".
    if (vehicle.position) return 'Live';
    return 'En route';
  });

  // CSS for the time column — mechanical lookup from a domain decision.
  const etaClass = $derived(urgencyClass(urgency));

  const headsign = $derived(
    vehicle.headsign ?? vehicle.schedule?.headsign ?? '—',
  );

  const interactive = $derived(typeof onclick === 'function');

  // Outer-card onclick. We don't fire it for clicks that bubbled up
  // from the inner schedule-link, otherwise tapping the link would
  // also activate the row. We deliberately avoid `e.stopPropagation`
  // on the link itself — SvelteKit's client-router intercepts link
  // clicks at the document level during the bubble phase, and
  // stopping propagation forces a full page reload (which tears the
  // GTFS worker down and reseeds OPFS from scratch).
  const handleCardClick = $derived(
    interactive
      ? (e: MouseEvent) => {
          if ((e.target as Element | null)?.closest('a')) return;
          onclick?.();
        }
      : undefined,
  );

  // Low confidence → fade. The domain owns the rule (see scheduleScanner
  // + reconciler); the UI just reads `vehicle.confidence`. By convention:
  //   'low'    schedule-only row at an intermediate stop — no GPS, no
  //            origin anchor; fade.
  //   'medium' tracked (GPS-matched) OR scheduled at the trip's origin
  //            (schedule authoritative); full opacity.
  //   'high'   verified (≥2 live sources agree); full opacity.
  // See spec §2 "Card border, opacity, and anomaly indicator".
  const dim = $derived(vehicle.confidence === 'low');
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  role={interactive ? 'button' : undefined}
  tabindex={interactive ? 0 : undefined}
  onclick={handleCardClick}
  onkeydown={interactive ? (e) => { if (e.key === 'Enter' || e.key === ' ') onclick?.(); } : undefined}
  class={cn(
    'flex items-center gap-3 px-3 py-2 border-2 border-solid rounded-md transition-colors',
    'border-[color:var(--color-border)]',
    dim && 'opacity-60',
    interactive && 'cursor-pointer hover:bg-[color:var(--color-border)]/30',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary)]',
    className,
  )}
>
  <!-- Fixed-width badge so a row of vehicles in different routes
       (3-char '32B', 1-char '9', 4-char '102L') reads as a single
       column. When the row has a `mapHref` (actionable trip), the
       badge becomes an extra tap target for the map — same destination
       as the dedicated map icon to the right, just a larger easier-to-
       hit surface for the most common action. NB: deliberately no
       `e.stopPropagation` on the anchor — SvelteKit's client router
       intercepts link clicks during bubble at the document level, so
       stopping propagation forces a full page reload. The card's
       `handleCardClick` already bails for clicks coming from any
       inner anchor, so the row's onclick won't fire either. -->
  {#snippet routeBadge()}
    <RouteBadge
      route={vehicle.route}
      size="medium"
      class="min-w-14"
    />
  {/snippet}
  {#if mapHref}
    <a
      href={mapHref}
      aria-label={`Open ${vehicle.route.shortName} on the map`}
      class="shrink-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary)]"
    >
      {@render routeBadge()}
    </a>
  {:else}
    {@render routeBadge()}
  {/if}

  <div class="flex-1 min-w-0">
    <div class="text-sm font-medium truncate flex items-center gap-1">
      <!-- Direction-of-travel cue. The headsign IS the destination, so
           a small arrow in front reads as 'going to …' without any
           extra label. Inline-flex so it scales with the text and
           stays vertically centred. -->
      <ArrowRight
        size={14}
        aria-hidden="true"
        class="shrink-0 text-[color:var(--color-fg-muted)]"
      />
      <span class="truncate">{headsign}</span>
    </div>
    <div class={cn('text-xs truncate', etaClass)}>{secondaryLine}</div>
  </div>

  <!--
    Action + state column. Each slot reserves a fixed width so icons
    sit in column-aligned positions even when one is hidden; adding
    a new affordance later (debug toggles, anomaly indicators, …)
    just plugs another fixed slot in. Order left → right:

       drop-off (13px) · schedule (24px) · map (24px)
       · expand-stops (24px) · state dot (13px)
  -->

  <!-- Drop-off slot — surfaced for vehicles the rider can't board here. -->
  <span class="shrink-0 w-[13px] flex items-center justify-center">
    {#if vehicle.dropOffOnly}
      <ArrowDownLeft
        size={13}
        aria-label="Drop off only — cannot board here"
        class="text-[color:var(--color-danger)]"
      />
    {/if}
  </span>

  <!-- Schedule button slot. -->
  <span class="shrink-0 w-6 flex items-center justify-center">
    {#if scheduleHref}
      <a
        href={scheduleHref}
        title="Open route schedule"
        aria-label={`Open ${vehicle.route.shortName} schedule`}
        class={cn(
          'inline-flex items-center justify-center w-6 h-6 rounded-md',
          'bg-[color:var(--color-border)]/40 text-[color:var(--color-fg)]',
          'hover:bg-[color:var(--color-border)]/70',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary)]',
        )}
      >
        <Calendar size={13} strokeWidth={2.25} />
      </a>
    {/if}
  </span>

  <!-- Map button slot. -->
  <span class="shrink-0 w-6 flex items-center justify-center">
    {#if mapHref}
      <a
        href={mapHref}
        title="Open route map"
        aria-label={`Open ${vehicle.route.shortName} on the map`}
        class={cn(
          'inline-flex items-center justify-center w-6 h-6 rounded-md',
          'bg-[color:var(--color-border)]/40 text-[color:var(--color-fg)]',
          'hover:bg-[color:var(--color-border)]/70',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary)]',
        )}
      >
        <MapIcon size={14} strokeWidth={2.25} />
      </a>
    {/if}
  </span>

  <!-- Expand-stops slot. Chevron rotates 180° when expanded. -->
  <span class="shrink-0 w-6 flex items-center justify-center">
    {#if onStopsExpand}
      <button
        type="button"
        title={stopsExpanded ? 'Hide upcoming stops' : 'Show upcoming stops'}
        aria-label={stopsExpanded ? 'Hide upcoming stops' : 'Show upcoming stops'}
        aria-expanded={stopsExpanded}
        onclick={(e) => { e.stopPropagation(); onStopsExpand!(); }}
        class={cn(
          'inline-flex items-center justify-center w-6 h-6 rounded-md',
          'bg-[color:var(--color-border)]/40 text-[color:var(--color-fg)]',
          'hover:bg-[color:var(--color-border)]/70',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary)]',
          'transition-transform',
          stopsExpanded && 'rotate-180',
        )}
      >
        <ChevronDown size={14} strokeWidth={2.25} />
      </button>
    {/if}
  </span>

  <!-- State dot slot: non-interactive. Color = GPS health.
       Hidden for `scheduled` rows with `tripPhase: later` (future
       non-next origin rows) — see `showKindDot` above. -->
  <span class="shrink-0 w-[13px] flex items-center justify-center">
    {#if showKindDot}
      <span
        title={KIND.label}
        aria-label={KIND.label}
        class={cn(
          'inline-block w-2.5 h-2.5 rounded-full',
          KIND.dotBg,
        )}
      ></span>
    {/if}
  </span>
</div>