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
  import type { ArrivalBucket } from '$lib/domain/buckets';
  import { DEFAULT_CONFIG } from '$lib/domain/config';
  import RouteBadge from './RouteBadge.svelte';
  import { cn } from './cn';

  type Props = {
    vehicle: Vehicle;
    /** Optional station-view bucket. When provided, the ETA text is
     *  colored: bold green for arriving / at-station / soon-incoming,
     *  bold red for departing, neutral otherwise. Map / standalone
     *  contexts omit it and the row stays neutral. */
    bucket?: ArrivalBucket;
    onclick?: () => void;
    class?: string;
  };

  let { vehicle, bucket, onclick, class: className }: Props = $props();

  // Per-kind visuals. Spec §2 visual-variant table. Schedule-only kinds
  // (`scheduled` and `predicted`) get the same dashed treatment for now —
  // they only diverge once the live reconciler can promote a `predicted`
  // run to `reconciled` (Phase 5). No opacity dimming on either.
  const KIND = $derived({
    corroborated: { border: 'border-solid',  icon: CheckCircle2, label: 'Corroborated', iconBg: 'bg-[color:var(--color-success)]' },
    reconciled:   { border: 'border-solid',  icon: Calendar,     label: 'Reconciled',   iconBg: 'bg-[color:var(--color-success)]' },
    live:         { border: 'border-solid',  icon: Radio,        label: 'Live',         iconBg: 'bg-[color:var(--color-success)]' },
    predicted:    { border: 'border-dashed', icon: Clock,        label: 'Predicted',    iconBg: 'bg-[color:var(--color-warning)]' },
    scheduled:    { border: 'border-dashed', icon: Calendar,     label: 'Scheduled',    iconBg: 'bg-[color:var(--color-fg-muted)]' },
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

  // Color the ETA text by bucket (when provided) so the most important
  // piece of information on a row — the time — jumps out.
  //   departing                    → bold red
  //   at-station / arriving        → bold green (vehicle is here / right here)
  //   incoming with eta ≤ threshold → bold green (boardable soon)
  //   incoming with eta > threshold → neutral
  //   departed / off-route / none  → neutral
  const etaClass = $derived.by(() => {
    if (!bucket) return 'text-[color:var(--color-fg-muted)]';
    if (bucket === 'departing') {
      return 'font-bold text-[color:var(--color-danger)]';
    }
    if (bucket === 'at-station' || bucket === 'arriving') {
      return 'font-bold text-[color:var(--color-success)]';
    }
    if (bucket === 'incoming') {
      const m = vehicle.eta?.minutes ?? Infinity;
      return m <= DEFAULT_CONFIG.imminentEtaThresholdMin
        ? 'font-bold text-[color:var(--color-success)]'
        : 'text-[color:var(--color-fg-muted)]';
    }
    return 'text-[color:var(--color-fg-muted)]';
  });

  const headsign = $derived(
    vehicle.headsign ?? vehicle.schedule?.headsign ?? '—',
  );

  const interactive = $derived(typeof onclick === 'function');
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  role={interactive ? 'button' : undefined}
  tabindex={interactive ? 0 : undefined}
  onclick={onclick}
  onkeydown={interactive ? (e) => { if (e.key === 'Enter' || e.key === ' ') onclick?.(); } : undefined}
  class={cn(
    'flex items-center gap-3 px-3 py-2 border-2 rounded-md transition-colors',
    'border-[color:var(--color-border)]',
    KIND.border,
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
