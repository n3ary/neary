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
  import { ArrowRight, Calendar, Map as MapIcon } from 'lucide-svelte';
  import type { Vehicle } from '$lib/domain/types';
  import { formatHHMM, formatRelativeMin } from '$lib/domain/types';
  import type { Urgency } from '$lib/domain/buckets';
  import RouteBadge from './RouteBadge.svelte';
  import { urgencyClass } from './urgencyClass';
  import { iconButtonClass } from './iconButtonClass';
  import { cn } from './cn';
  import { userPrefs } from '$lib/stores/userPrefs.svelte';
  import { statusBus } from '$lib/stores/statusBus.svelte';

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

  // Only render the dot for GPS-backed rows (green). `scheduled`
  // rows would draw a grey dot, but absence of green already conveys
  // 'no realtime' — the extra grey mark just adds visual noise.
  const showKindDot = $derived(vehicle.kind !== 'scheduled');

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
    'flex items-start gap-3 px-3 py-2 border-2 border-solid rounded-md transition-colors',
    'border-[color:var(--color-border)]',
    dim && 'opacity-60',
    interactive && 'cursor-pointer hover:bg-[color:var(--color-border)]/30',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary)]',
    className,
  )}
>
  <!-- Fixed-width badge so a row of vehicles in different routes
       (3-char '32B', 1-char '9', 4-char '102L') reads as a single
       column. When the row has a `scheduleHref` (actionable trip),
       the badge becomes an extra tap target into the route's
       schedule view — larger thumb surface for the most common
       drill-down, complementing the small schedule icon to the
       right. NB: deliberately no `e.stopPropagation` on the anchor
       — SvelteKit's client router intercepts link clicks during
       bubble at the document level, so stopping propagation forces
       a full page reload. The card's `handleCardClick` already
       bails for clicks coming from any inner anchor, so the row's
       onclick won't fire either. -->
  {#snippet routeBadge()}
    <RouteBadge
      route={vehicle.route}
      size="medium"
      class="min-w-14"
    />
  {/snippet}
  {#if scheduleHref}
    <a
      href={scheduleHref}
      aria-label={`Open ${vehicle.route.shortName} schedule`}
      class="shrink-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary)]"
    >
      {@render routeBadge()}
    </a>
  {:else}
    {@render routeBadge()}
  {/if}

  <!--
    Content column: text block + icon group, side-by-side when there's
    room, wrapping the icon group onto a second line below the text
    when there isn't. `min-w-[9rem]` on the text block sets the wrap
    trigger — wrap fires before the headsign gets ellipsised down to a
    few characters. When wrapped, the icon group sits inside the
    content column (i.e. indented past the badge), so the badge stays
    visually anchored to the row identity.
  -->
  <div class="min-w-0 flex-1 flex flex-wrap items-center gap-x-3 gap-y-1">
    <!-- Text block. When `onStopsExpand` is provided (stops list is
         available for this trip), tapping anywhere on the text
         block toggles the expansion — same action as the chevron
         on the right, just a much larger thumb target. The chevron
         stays as the visual cue. Inner interactive bits (kind-dot
         button) call `e.stopPropagation()` so they don't double-
         trigger. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class={cn(
        'min-w-[9rem] flex-1',
        onStopsExpand && 'cursor-pointer rounded-md -mx-1 px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary)]',
      )}
      role={onStopsExpand ? 'button' : undefined}
      tabindex={onStopsExpand ? 0 : undefined}
      aria-expanded={onStopsExpand ? stopsExpanded : undefined}
      aria-label={onStopsExpand ? (stopsExpanded ? `Hide upcoming stops for ${vehicle.route.shortName}` : `Show upcoming stops for ${vehicle.route.shortName}`) : undefined}
      onclick={onStopsExpand ? () => onStopsExpand?.() : undefined}
      onkeydown={onStopsExpand ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onStopsExpand?.();
        }
      } : undefined}
    >
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
        <!-- Kind/state dot inline at the end of the headsign — was a
             separate fixed slot in the icon group, moved here to free
             one of the row's right-hand slots. Hidden for `scheduled`
             rows with `tripPhase: later` (see `showKindDot` above).
             Tap surfaces the kind label as a transient info entry in
             the global StatusBar — touch surfaces can't hover, so the
             tooltip alone wouldn't be discoverable there. -->
        {#if showKindDot}
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <span
            role="button"
            tabindex={0}
            title={KIND.label}
            aria-label={KIND.label}
            onclick={(e) => {
              e.stopPropagation();
              statusBus.push({ id: `vehicle-dot:${vehicle.id}`, kind: 'info', message: KIND.label });
            }}
            onkeydown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                statusBus.push({ id: `vehicle-dot:${vehicle.id}`, kind: 'info', message: KIND.label });
              }
            }}
            class={cn(
              'shrink-0 inline-block w-2 h-2 rounded-full ml-1 cursor-pointer',
              KIND.dotBg,
            )}
          ></span>
        {/if}
      </div>
      <div class={cn('text-xs truncate', etaClass)}>{secondaryLine}</div>
      {#if userPrefs.showDebugIds}
        <!-- Diagnostic id line. Surfaces the trip identity so a
             screenshot of the station card can be matched against
             a screenshot of the same vehicle's map marker, which
             renders the same string. Off by default; toggled in
             Settings > Advanced > 'Show debug ids'. -->
        <div class="text-[10px] font-mono text-[color:var(--color-fg-muted)] truncate">
          {vehicle.tripId ?? vehicle.id} · {vehicle.kind[0]}{vehicle.directionId == null || vehicle.directionId === -1 ? '' : vehicle.directionId}
        </div>
      {/if}
    </div>

    <!--
      Action column. Each slot reserves a fixed width so icons sit in
      column-aligned positions even when one is hidden; adding a new
      affordance later (debug toggles, anomaly indicators, …) just
      plugs another fixed slot in. Order left → right:

         schedule (24px) · map (24px)

      Drop-off-only is signalled by the section header ("Drop off only")
      so a per-row icon was duplicate. State dot moved inline beside
      the headsign above. Expand/collapse for the upcoming-stops list
      is driven by tapping the card text — the explicit chevron was
      removed because the text-block hit target already covers it.
    -->
    <div class="flex items-center gap-1 shrink-0">

  <!-- Schedule button slot. -->
  <span class="shrink-0 w-6 flex items-center justify-center">
    {#if scheduleHref}
      <a
        href={scheduleHref}
        title="Open route schedule"
        aria-label={`Open ${vehicle.route.shortName} schedule`}
        class={iconButtonClass}
      >
        <Calendar size={16} strokeWidth={2.25} />
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
        class={iconButtonClass}
      >
        <MapIcon size={16} strokeWidth={2.25} />
      </a>
    {/if}
  </span>
    </div>
  </div>
</div>