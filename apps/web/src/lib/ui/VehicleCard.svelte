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
  import { Calendar, CheckCircle2, Clock, Radio } from 'lucide-svelte';
  import type { Vehicle } from '$lib/domain/types';
  import { formatHHMM } from '$lib/domain/types';
  import type { Urgency } from '$lib/domain/buckets';
  import RouteBadge from './RouteBadge.svelte';
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
    if (vehicle.eta) {
      const m = vehicle.eta.minutes;
      if (m < 0) return `${-m} min ago`;
      if (m === 0) return 'Now';
      return `in ${m} min`;
    }
    if (vehicle.schedule) return `Scheduled ${formatHHMM(vehicle.schedule.scheduledDeparture)}`;
    return 'En route';
  });

  // CSS for the time column — mechanical lookup from a domain decision.
  const URGENCY_CLASS: Record<Urgency | 'none', string> = {
    go: 'font-bold text-[color:var(--color-success)]',
    stop: 'font-bold text-[color:var(--color-danger)]',
    neutral: 'text-[color:var(--color-fg-muted)]',
    none: 'text-[color:var(--color-fg-muted)]',
  };
  const etaClass = $derived(URGENCY_CLASS[urgency ?? 'none']);

  const headsign = $derived(
    vehicle.headsign ?? vehicle.schedule?.headsign ?? '—',
  );

  const interactive = $derived(typeof onclick === 'function');

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
  onclick={onclick}
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
  <RouteBadge route={vehicle.route} size="medium" />

  <div class="flex-1 min-w-0">
    <div class="text-sm font-medium truncate">{headsign}</div>
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
      onclick={(e) => e.stopPropagation()}
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
