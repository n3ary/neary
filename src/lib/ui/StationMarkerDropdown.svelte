  <!--
  StationMarkerDropdown: button face that opens a small popover with
  station marker options (Normal / Favorite / Home / Work / City center).
  The trigger icon reflects the current marker state. The "Normal" entry
  clears the marker; tapping the same marker a second time also clears
  (kept as a shortcut).

  Visual: the active option's icon is rendered in its full color
  (favorite: --color-favorite, others: --color-primary); inactive
  options render muted.

  Props:
  - `icon` (optional): Lucide icon to use as the trigger instead of the
    marker icon. Used by StationCard where the trigger IS the Avatar
    (Bus icon) regardless of the marker state.
  - `markerColor` (optional): CSS color string for the trigger icon.
    When omitted, the icon uses the default marker-colour logic.
  - `size`: lucide icon size for the trigger.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Popover } from 'bits-ui';
  import { Bus, Heart } from 'lucide-svelte';
  import type { StationMarker } from '$lib/stores/favoritesStore.svelte';
  import {
    STATION_MARKERS, STATION_MARKER_ICONS, STATION_MARKER_FILL,
    STATION_MARKER_ACCENT,
  } from '$lib/stores/favoritesStore.svelte';
  import { cn } from './cn';

  type Props = {
    stationId: string;
    /** Current marker on the station, or undefined if unstarred. */
    marker: StationMarker | undefined;
    onChange: (next: StationMarker | null) => void;
    /** The stop name (or generic label) for aria-label on the trigger. */
    label?: string;
    /** Override the trigger icon. When set, this icon renders instead of
     *  the marker icon. Used by StationCard where the Avatar (Bus icon)
     *  is the trigger regardless of marker state. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    icon?: (props: { size?: number; strokeWidth?: number }) => any;
    /** Override the trigger icon colour. When omitted, uses the default
     *  marker colour logic (--color-favorite for favorite, --color-primary for others). */
    iconColor?: string;
    /** Icon pixel size. Defaults to 16. */
    size?: 14 | 16 | 20;
    class?: string;
    children?: Snippet;
  };

  let {
    stationId,
    marker,
    onChange,
    label,
    icon,
    iconColor,
    size = 16,
    class: className,
    children,
  }: Props = $props();

  // Trigger shows the current marker's icon, or the override icon.
  // Filled only for `favorite`; the other three read better outlined.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const TriggerIcon = $derived(
    (icon ?? (marker === undefined ? Bus : STATION_MARKER_ICONS[marker])) as any,
  );
  const triggerFill = $derived(
    icon != null ? 'none'
    : marker === undefined ? 'none'
    : STATION_MARKER_FILL[marker],
  );

  // Background color for the trigger. Like the old Avatar: the marker's
  // accent colour as the background. Normal uses --color-primary.
  const triggerBg = $derived(
    marker == null ? 'var(--color-primary)' : STATION_MARKER_ACCENT[marker],
  );

  function pick(next: StationMarker | null) {
    // "Normal" (null) always clears. For the four real markers, a
    // tap on the currently-active marker also clears - kept as a
    // keyboard / muscle-memory shortcut for users who don't see
    // the Normal entry. Picking a different marker reassigns.
    if (next === null || marker === next) {
      onChange(null);
    } else {
      onChange(next);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type LucideLike = (props: { size?: number; strokeWidth?: number }) => any;

  type Option = {
    /** null = the "Normal" / unstarred entry. */
    marker: StationMarker | null;
    Icon: LucideLike;
    label: string;
  };
  // Normal sits at the top: it's the default, the most common pick
  // when the user opens the dropdown by accident, and the "remove"
  // escape hatch. The four real markers follow STATION_MARKERS order
  // (single source of truth - same order as the favorites card,
  // the marker filter chips, etc.).
  // @ts-ignore Svelte 5 icon components don't satisfy a plain function signature;
  //       the cast is safe because we only invoke them with {size, strokeWidth}.
  const allOptions: Option[] = [
    { marker: null, Icon: Bus, label: 'Normal' } as unknown as Option,
    ...STATION_MARKERS.map<Option>((m) => ({
      marker: m,
      Icon: STATION_MARKER_ICONS[m] as unknown as LucideLike,
      label: m === 'cityCenter' ? 'City center' : m.charAt(0).toUpperCase() + m.slice(1),
    })),
  ];

  // Note: the current marker is NOT filtered out — it stays visible in the
  // list with a highlight so the user can see what's selected. Tapping it
  // again deselects via the pick() shortcut (marker === next branch).
  const options = $derived(allOptions);
</script>

<Popover.Root>
  <Popover.Trigger
    aria-label={marker
      ? `Change marker for ${label ?? stationId} (currently ${marker})`
      : `Add a marker for ${label ?? stationId}`}
    class={cn(
      'inline-flex items-center justify-center rounded-md p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary)]',
      className,
    )}
    style={`background-color: ${triggerBg};`}
  >
    {#if children}
      {@render children()}
    {:else}
      <TriggerIcon
        {size}
        strokeWidth={2.25}
        fill={triggerFill}
        class="shrink-0 text-[color:var(--color-fg)]"
        style={iconColor ? `color: ${iconColor}` : undefined}
      />
    {/if}
  </Popover.Trigger>
  <Popover.Portal>
    <Popover.Content
      side="bottom"
      align="end"
      sideOffset={4}
      class="z-[1200] flex flex-col gap-0.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-1 shadow-md"
    >
      {#each options as opt (opt.marker ?? 'normal')}
        {@const selected = opt.marker === marker}
        {@const Icon = opt.Icon as any}
        <button
          type="button"
          onclick={() => pick(opt.marker)}
          class={cn(
            'flex items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-[color:var(--color-border)]/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary)]',
            // Selected row: clear amber tint for non-Normal, blue for Normal.
            selected && opt.marker === null && 'bg-[color:var(--color-primary)]/20',
            selected && opt.marker !== null && 'bg-[color:var(--color-favorite)]/25',
            // Unselected rows: slightly dim the label so the selected one pops.
            !selected && 'opacity-75',
          )}
        >
          <Icon
            size={14}
            strokeWidth={2.25}
            fill={selected && opt.marker !== null ? STATION_MARKER_FILL[opt.marker] : 'none'}
            class={cn(
              // Selected: full colour via STATION_MARKER_ACCENT
              // (Normal uses --color-primary, others use --color-favorite).
              // Unselected: muted at 80%.
              selected
                ? `text-[color:${opt.marker === null ? 'var(--color-primary)' : STATION_MARKER_ACCENT[opt.marker as keyof typeof STATION_MARKER_ACCENT]}]`
                : 'text-[color:var(--color-fg-muted)] opacity-80',
            )}
          />
          <span class={cn(selected && 'font-medium')}>{opt.label}</span>
        </button>
      {/each}
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>