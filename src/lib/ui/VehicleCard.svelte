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
  import { ArrowDownLeft, ArrowRight, Calendar, CheckCircle2, Clock, Map as MapIcon, Radio } from 'lucide-svelte';
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
    /** When set, the round kind-badge becomes a link to this URL.
     *  Used by StationCard to deep-link into /schedule/route/[id].
     *  Keeping URL-knowledge out of the component lets each consumer
     *  decide what the icon should navigate to (or omit it). */
    scheduleHref?: string;
    /** When set, renders a separate map-icon button that opens the
     *  route map (with this trip pre-selected when the URL includes
     *  the trip id). The consumer composes the href so this card
     *  stays free of route-URL convention knowledge. */
    mapHref?: string;
    /** When set, the route badge becomes tappable and fires this
     *  callback. Used by StationCard to toggle the upcoming-stop
     *  list for this vehicle. */
    onRouteBadgeClick?: () => void;
    /** Reflects the expanded state of the stop list panel, passed
     *  back from the consumer so the badge shows a pressed ring. */
    stopsExpanded?: boolean;
    class?: string;
  };

  let {
    vehicle, urgency, onclick, scheduleHref, mapHref,
    onRouteBadgeClick, stopsExpanded = false,
    class: className,
  }: Props = $props();

  // Per-kind visuals. The kind only drives the badge icon and color now —
  // every row gets the same solid border. Schedule-only kinds (`scheduled`
  // / `predicted`) used to render with a dashed border + opacity dim, but
  // that's misleading when there is no live source to contrast against.
  // Dimming is now driven by `vehicle.confidence === 'low'` via the `dim`
  // prop — see docs/concepts/confidence.md.
  const KIND = $derived({
    corroborated: { icon: CheckCircle2, label: 'Corroborated', iconBg: 'bg-[color:var(--color-success)]' },
    reconciled:   { icon: Calendar,     label: 'Reconciled',   iconBg: 'bg-[color:var(--color-success)]' },
    live:         { icon: Radio,        label: 'Live',         iconBg: 'bg-[color:var(--color-success)]' },
    predicted:    { icon: Clock,        label: 'Predicted',    iconBg: 'bg-[color:var(--color-warning)]' },
    scheduled:    { icon: Calendar,     label: 'Scheduled',    iconBg: 'bg-[color:var(--color-fg-muted)]' },
  }[vehicle.kind]);

  const KindIcon = $derived(KIND.icon);

  // ETA / scheduled-time secondary line.
  const secondaryLine = $derived.by(() => {
    if (vehicle.eta) return formatRelativeMin(vehicle.eta.minutes, vehicle.schedule?.scheduledDeparture);
    if (vehicle.schedule) return `Scheduled ${formatHHMM(vehicle.schedule.scheduledDeparture)}`;
    // kind:'live' orphans have a GPS position but no schedule/ETA — the bus
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
  //   'medium' reconciled (GPS-matched) OR scheduled at the trip’s origin
  //            (schedule authoritative); full opacity.
  //   'high'   corroborated (≥2 live sources agree); full opacity.
  // See spec §2 “Card border, opacity, and anomaly indicator”.
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
       column. The headsign + ETA columns to the right then align
       across rows. min-w-14 ≈ 56 px fits four glyphs at the
       medium badge text size; longer ids grow the badge but stay
       centered.

       Badge is identity-only — navigation lives on the dedicated
       map / schedule icon buttons to the right so users learn one
       affordance per destination (consistent with favorites). -->
  <RouteBadge
    route={vehicle.route}
    size="medium"
    class="min-w-14"
    selected={onRouteBadgeClick ? stopsExpanded : undefined}
    onclick={onRouteBadgeClick ? (e) => { e.stopPropagation(); onRouteBadgeClick!(); } : undefined}
  />

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

  <!-- Drop-off slot — always reserves space so the icon columns stay aligned -->
  <span class="shrink-0 w-[13px] flex items-center justify-center">
    {#if vehicle.dropOffOnly}
      <ArrowDownLeft
        size={13}
        aria-label="Drop off only — cannot board here"
        class="text-[color:var(--color-danger)]"
      />
    {/if}
  </span>

  <!--
    Action + state column order: [schedule btn] [map btn] [state indicator].
    Schedule / map are neutral icon BUTTONS — visible only when a target
    exists, hidden entirely otherwise. The state indicator on the right
    is a non-interactive badge whose color encodes whether we have a live
    GPS fix for this vehicle (success=GPS, warning=predicted-only,
    muted=schedule-only).
  -->
  {#if scheduleHref}
    <a
      href={scheduleHref}
      title="Open route schedule"
      aria-label={`Open ${vehicle.route.shortName} schedule`}
      class={cn(
        'inline-flex items-center justify-center w-6 h-6 rounded-md shrink-0',
        'bg-[color:var(--color-border)]/40 text-[color:var(--color-fg)]',
        'hover:bg-[color:var(--color-border)]/70',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary)]',
      )}
    >
      <Calendar size={13} strokeWidth={2.25} />
    </a>
  {/if}

  {#if mapHref}
    <a
      href={mapHref}
      title="Open route map"
      aria-label={`Open ${vehicle.route.shortName} on the map`}
      class={cn(
        'inline-flex items-center justify-center w-6 h-6 rounded-md shrink-0',
        'bg-[color:var(--color-border)]/40 text-[color:var(--color-fg)]',
        'hover:bg-[color:var(--color-border)]/70',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary)]',
      )}
    >
      <MapIcon size={14} strokeWidth={2.25} />
    </a>
  {/if}

  <!-- State indicator: non-interactive. Color = GPS health. -->
  <span
    title={KIND.label}
    aria-label={KIND.label}
    class={cn(
      'inline-flex items-center justify-center w-6 h-6 rounded-full text-white shrink-0',
      KIND.iconBg,
    )}
  >
    <KindIcon size={12} strokeWidth={2.5} />
  </span>
</div>
