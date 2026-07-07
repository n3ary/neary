<!--
  Header — fixed top bar. Carries the view title (left) and the four health
  dots + search + refresh button (right).

  The dots are wired to a `health` prop, an object the parent fills with
  each source's current state: GPS reflects the geolocation listener,
  Schedule reflects the worker's feed-bind state, Live reflects the
  worker's reconciliation broadcast.

  Refresh callback is optional — when absent (e.g. on routes that have
  nothing to refresh) the button is hidden.

  When `health.gps.state === 'off'`, tapping the GPS dot opens the
  enable flow (locationStore.enable() — persists across reloads).

  Search icon shows only when `showSearch` is true (i.e. a feed is
  bound). The overlay is rendered here so it's truly global across views.
-->
<script lang="ts">
  import { RefreshCw, Search } from 'lucide-svelte';
  import { locationStore } from '$lib/stores/gps/locationStore.svelte';
  import { searchOverlayStore } from '$lib/stores/searchOverlayStore.svelte';
  import HeaderSearchOverlay from './HeaderSearchOverlay.svelte';
  import IconButton from './IconButton.svelte';
  import StatusDot from './StatusDot.svelte';
  import type { HeaderHealth } from './headerTypes';

  type Props = {
    title: string;
    health: HeaderHealth;
    onrefresh?: () => void;
    refreshing?: boolean;
    /** Show the station-search icon. Hidden when no feed is selected
     *  (nothing to search). */
    showSearch?: boolean;
  };

  let { title, health, onrefresh, refreshing = false, showSearch = false }: Props = $props();
</script>

<header
  class="sticky top-0 z-40 flex items-center gap-3 px-4
         h-[calc(3rem+var(--space-safe-top))] pt-[var(--space-safe-top)]
         bg-[color:var(--color-surface)] border-b border-[color:var(--color-border)]"
>
  <h1 class="flex-1 text-base font-semibold truncate">{title}</h1>

  <div class="flex items-center gap-2">
    <StatusDot
      state={health.gps.state}
      label="GPS"
      tooltip={health.gps.tooltip}
      onclick={health.gps.state === 'off' ? () => locationStore.enable() : undefined}
    />
    <StatusDot state={health.connection.state} label="Connection" tooltip={health.connection.tooltip} />
    <StatusDot state={health.schedule.state} label="Schedule" tooltip={health.schedule.tooltip} />
    <StatusDot state={health.live.state} label="Live" tooltip={health.live.tooltip} pulse />
  </div>

  {#if showSearch}
    <IconButton size="small" onclick={() => searchOverlayStore.open()} aria-label="Search stations">
      <Search size={18} />
    </IconButton>
  {/if}

  {#if onrefresh}
    <IconButton size="small" onclick={onrefresh} aria-label="Refresh" disabled={refreshing}>
      <RefreshCw size={18} class={refreshing ? 'animate-spin' : ''} />
    </IconButton>
  {/if}
</header>

<HeaderSearchOverlay open={searchOverlayStore.isOpen} onclose={() => searchOverlayStore.close()} />
