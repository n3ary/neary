<!--
  StationMarkerDropdown: button face that shows the station's current
  marker (filled Heart for favorite, outline for the others, outline
  Heart for unstarred) and opens a small popover with the marker
  options. The "Normal" entry clears the marker; tapping the same
  marker a second time also clears (kept as a shortcut).

  Visual: the active option's icon is rendered in its full color
  (favorite: --color-danger, others: --color-primary); inactive
  options render in --color-fg-muted. Replaces an earlier "current"
  text label which made the row widths jumpy.
-->
<script lang="ts">
  import { Popover } from 'bits-ui';
  import { Briefcase, CircleOff, Heart, Home, Radio } from 'lucide-svelte';
  import type { StationMarker } from '$lib/stores/favoritesStore.svelte';
  import { cn } from './cn';

  type Props = {
    stationId: string;
    /** Current marker on the station, or undefined if unstarred. */
    marker: StationMarker | undefined;
    onChange: (next: StationMarker | null) => void;
    /** The stop name (or generic label) for aria-label on the trigger. */
    label?: string;
    size?: 14 | 16;
    class?: string;
  };

  let {
    stationId,
    marker,
    onChange,
    label,
    size = 16,
    class: className,
  }: Props = $props();

  // Trigger shows the current marker's icon, or outline Heart if none.
  // Filled only for `favorite` (matches the long-standing heart fill
  // convention); the other three read better outlined at 14-16px.
  const TriggerIcon = $derived(
    marker === undefined
      ? Heart
      : marker === 'favorite'
        ? Heart
        : marker === 'home'
          ? Home
          : marker === 'work'
            ? Briefcase
            : Radio,
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

  type Option = {
    /** null = the "Normal" / unstarred entry. */
    marker: StationMarker | null;
    Icon: typeof Heart;
    label: string;
  };
  // Normal sits at the top: it's the default, the most common pick
  // when the user opens the dropdown by accident, and the "remove"
  // escape hatch. The four real markers follow in a fixed order so
  // muscle memory builds the same way across visits.
  const options: Option[] = [
    { marker: null, Icon: CircleOff, label: 'Normal' },
    { marker: 'favorite', Icon: Heart, label: 'Favorite' },
    { marker: 'home', Icon: Home, label: 'Home' },
    { marker: 'work', Icon: Briefcase, label: 'Work' },
    { marker: 'cityCenter', Icon: Radio, label: 'City center' },
  ];
</script>

<Popover.Root>
  <Popover.Trigger
    aria-label={marker
      ? `Change marker for ${label ?? stationId} (currently ${marker})`
      : `Add a marker for ${label ?? stationId}`}
    class={cn(
      'inline-flex items-center justify-center rounded-md p-1 hover:bg-[color:var(--color-border)]/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary)]',
      className,
    )}
  >
    <TriggerIcon
      {size}
      strokeWidth={2.25}
      fill={marker === 'favorite' ? 'currentColor' : 'none'}
      class={cn(
        marker === 'favorite'
          ? 'text-[color:var(--color-danger)]'
          : marker
            ? 'text-[color:var(--color-primary)]'
            : 'text-[color:var(--color-fg-muted)]',
        'shrink-0',
      )}
    />
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
        <button
          type="button"
          onclick={() => pick(opt.marker)}
          class={cn(
            'flex items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-[color:var(--color-border)]/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary)]',
            selected && 'bg-[color:var(--color-border)]/30',
          )}
        >
          <opt.Icon
            size={14}
            strokeWidth={2.25}
            fill={selected && opt.marker === 'favorite' ? 'currentColor' : 'none'}
            class={cn(
              // Selected option: full color (favorite = danger, others = primary).
              // Unselected (including favorite when home/work/cityCenter is the
              // active marker): muted grey. The "favorite always red" exception
              // dropped — favorite reads as just another unselected option
              // when it isn't the active marker.
              selected && opt.marker === 'favorite'
                ? 'text-[color:var(--color-danger)]'
                : selected
                  ? 'text-[color:var(--color-primary)]'
                  : 'text-[color:var(--color-fg-muted)] opacity-60',
            )}
          />
          <span>{opt.label}</span>
        </button>
      {/each}
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>