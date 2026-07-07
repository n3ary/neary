<!-- Fixed top bar: view title (left) + health dots + search + refresh (right). Health dot states — GPS / Schedule / Live — come from the `health` prop. Refresh button is hidden when no callback is passed. GPS dot's 'off' state opens the enable flow. Search icon shows only when a feed is bound; the overlay is rendered here so it's truly global across views. -->
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
