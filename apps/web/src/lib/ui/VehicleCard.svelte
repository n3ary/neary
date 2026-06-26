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
  import { ArrowRight, Calendar, CheckCircle2, Clock, Radio } from 'lucide-svelte';
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
    class?: string;
  };

  let { vehicle, urgency, onclick, scheduleHref, class: className }: Props = $props();

  // Per-kind visuals. Spec §2 visual-variant table. The kind only drives
  // the badge icon and color now — every row gets the same solid border.
  // Schedule-only kinds (`scheduled` / `predicted`) used to render with
  // a dashed border + opacity dim, but that's misleading when there is
  // no live source to contrast against (Phase 4). Once a live source is
  // configured (Phase 5+) the dim is applied separately via the `dim`
  // prop — see spec §2 for the new rule.
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
    if (vehicle.eta) return formatRelativeMin(vehicle.eta.minutes);
    if (vehicle.schedule) return `Scheduled ${formatHHMM(vehicle.schedule.scheduledDeparture)}`;
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

       Wrapped in an <a> that deep-links to the route map, with the
       current trip (when known) pre-selected. The map link uses the
       same `_dir` URL convention as the schedule view. Card-level
       onclick (when provided) ignores clicks bubbling from this
       anchor, so the parent action and link navigation don't fight. -->
  {#if vehicle.schedule}
    <a
      href={`/map/route/${vehicle.route.id}_${vehicle.schedule.directionId ?? 0}${
        vehicle.schedule.tripId ? `/${encodeURIComponent(vehicle.schedule.tripId)}` : ''
      }`}
      aria-label={`Open ${vehicle.route.shortName} on the map`}
      class="shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary)] rounded-md"
    >
      <RouteBadge route={vehicle.route} size="medium" class="min-w-14" />
    </a>
  {:else}
    <RouteBadge route={vehicle.route} size="medium" class="min-w-14" />
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

  {#if vehicle.dropOffOnly}
    <span
      title="This trip only drops passengers off at this stop — you can't board here."
      class="text-[10px] uppercase font-semibold tracking-wide px-1.5 py-0.5 rounded border border-[color:var(--color-danger)] text-[color:var(--color-danger)] shrink-0"
    >
      Drop off
    </span>
  {/if}

  {#if scheduleHref}
    <a
      href={scheduleHref}
      title={`${KIND.label} — open route schedule`}
      aria-label={`${KIND.label}, open route schedule`}
      class={cn(
        'inline-flex items-center justify-center w-6 h-6 rounded-full text-white shrink-0',
        'hover:ring-2 hover:ring-[color:var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary)]',
        KIND.iconBg,
      )}
    >
      <KindIcon size={12} strokeWidth={2.5} />
    </a>
  {:else}
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
  {/if}
</div>
