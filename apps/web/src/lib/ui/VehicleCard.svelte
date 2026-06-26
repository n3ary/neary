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
  import RouteBadge from './RouteBadge.svelte';
  import { cn } from './cn';

  type Props = {
    vehicle: Vehicle;
    onclick?: () => void;
    class?: string;
  };

  let { vehicle, onclick, class: className }: Props = $props();

  // Per-kind visuals. Keep this in ONE place so adding a new kind is one edit.
  // See docs/rebuild-v2/vehicles-and-views.md §2 for the source-of-truth table.
  const KIND = $derived({
    corroborated: { border: 'border-solid',  opacity: '',           icon: CheckCircle2, label: 'Corroborated', iconBg: 'bg-[color:var(--color-success)]' },
    reconciled:   { border: 'border-solid',  opacity: '',           icon: Calendar,     label: 'Reconciled',   iconBg: 'bg-[color:var(--color-success)]' },
    live:         { border: 'border-solid',  opacity: '',           icon: Radio,        label: 'Live',         iconBg: 'bg-[color:var(--color-success)]' },
    predicted:    { border: 'border-dashed', opacity: '',           icon: Clock,        label: 'Predicted',    iconBg: 'bg-[color:var(--color-warning)]' },
    scheduled:    { border: 'border-dotted', opacity: 'opacity-60', icon: Calendar,     label: 'Scheduled',    iconBg: 'bg-[color:var(--color-fg-muted)]' },
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
    KIND.opacity,
    interactive && 'cursor-pointer hover:bg-[color:var(--color-border)]/30',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary)]',
    className,
  )}
>
  <RouteBadge route={vehicle.route} size="medium" />

  <div class="flex-1 min-w-0">
    <div class="text-sm font-medium truncate">{headsign}</div>
    <div class="text-xs text-[color:var(--color-fg-muted)] truncate">{secondaryLine}</div>
  </div>

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
