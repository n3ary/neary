<!-- "No feed bound" banner rendered by every view that needs one. Self-contained: reads locationStore + feedsStore + userPrefs directly so consumers don't repeat the smart-suggestion wiring. Three branches: GPS on + position inside feed's bbox (one-tap "Use {feed}" + Open Settings); GPS on + no feed covers position (softer message, Open Settings only); GPS off / feeds unloaded (generic "pick one in Settings" copy that callers can tailor via `fallbackBody`). -->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { Bus } from 'lucide-svelte';
  import { findNearestFeed } from '$lib/domain/feedCoverage';
  import { feedsStore } from '$lib/stores/feedsStore.svelte';
  import { locationStore } from '$lib/stores/gps/locationStore.svelte';
  import { userPrefs } from '$lib/stores/userPrefs.svelte';
  import Button from './Button.svelte';
  import InfoCard from './InfoCard.svelte';

  type Props = {
    /** Optional override for the fallback body — shown when GPS isn't
     *  available so the smart-suggestion branches don't fire. Each
     *  consumer view can pitch its own promise ("… to view route
     *  schedules", "… to star routes here", etc.). Default fits the
     *  Stations view. */
    fallbackBody?: string;
  };

  let {
    fallbackBody =
      "Neary needs a transit feed to load schedules and routes for your city. " +
      "Pick one in Settings to get started — the data downloads once and is " +
      "cached for offline use, no account needed.",
  }: Props = $props();

  const userPos = $derived(
    locationStore.position
      ? { lat: locationStore.position.coords.latitude, lon: locationStore.position.coords.longitude }
      : null,
  );
  const nearest = $derived.by(() => {
    if (!userPos || !feedsStore.feeds) return null;
    return findNearestFeed(userPos, feedsStore.feeds);
  });
  const covering = $derived(
    nearest && nearest.distanceKm === 0 ? nearest.feed : null,
  );
  const noCoverage = $derived(!!userPos && !!feedsStore.feeds && !covering);

  function switchFeed(id: string) {
    userPrefs.feedId = id;
  }
</script>

<InfoCard variant="primary" title="Select your transit feed">
  {#snippet icon()}<Bus size={16} />{/snippet}
  {#snippet body()}
    {#if covering}
      Looks like you're in <strong>{covering.name}</strong>'s service area.
      Use it with one tap, or pick a different feed in Settings. The data
      downloads once and is cached for offline use.
    {:else if noCoverage}
      None of the transit feeds Neary publishes cover your current location,
      so nearby stops likely won't be available. You can still pick a feed in
      Settings to browse routes for another city.
    {:else}
      {fallbackBody}
    {/if}
  {/snippet}
  {#snippet actions()}
    {#if covering}
      <Button variant="contained" size="small" onclick={() => switchFeed(covering.id)}>
        Use {covering.name}
      </Button>
      <Button variant="text" size="small" onclick={() => goto('/settings')}>
        Open Settings
      </Button>
    {:else}
      <Button variant="contained" size="small" onclick={() => goto('/settings')}>
        Open Settings
      </Button>
    {/if}
  {/snippet}
</InfoCard>
