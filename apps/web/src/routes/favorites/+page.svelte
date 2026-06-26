<!--
  Favorites — single picker view listing every route in the bound feed
  with a heart toggle per row. Tap the heart to favorite; tap again to
  unfavorite. Favorited rows float to the top, otherwise sorted by
  short-name (numeric-first, alpha after).

  No separate "add" surface — this IS the picker. Stations view also
  shows hearts on favorited badges as visual reinforcement.
-->
<script lang="ts">
  import { Heart } from 'lucide-svelte';
  import {
    Card, CardContent, IconButton, NoFeedState, RouteBadge, Spinner, Stack, Typography,
  } from '$lib/ui';
  import { getGtfsRepo } from '$lib/data/gtfs/repo';
  import type { Route } from '$lib/domain/types';
  import { feedsStore } from '$lib/stores/feedsStore.svelte';
  import { favoritesStore } from '$lib/stores/favoritesStore.svelte';
  import { userPrefs } from '$lib/stores/userPrefs.svelte';

  let allRoutes = $state<Route[] | null>(null);
  let error = $state<string | null>(null);

  $effect(() => {
    const fid = feedsStore.boundFeedId;
    if (!fid) return;
    (async () => {
      try {
        const repo = getGtfsRepo();
        allRoutes = await repo.getRoutes();
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    })();
  });

  // Favorites float to the top so the user sees what they've picked
  // without scrolling. Within each section, sort numeric-first.
  const sortedRoutes = $derived.by<Route[]>(() => {
    if (!allRoutes) return [];
    return [...allRoutes].sort((a, b) => {
      const af = favoritesStore.has(a.id);
      const bf = favoritesStore.has(b.id);
      if (af !== bf) return af ? -1 : 1;
      const an = Number(a.shortName);
      const bn = Number(b.shortName);
      if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn;
      return a.shortName.localeCompare(b.shortName);
    });
  });

  const favCount = $derived(favoritesStore.routeIds.size);
</script>

<div class="mx-auto max-w-3xl px-4 py-6">
  {#if userPrefs.feedId == null}
    <NoFeedState message="Pick a feed in Settings to star routes here." />
  {:else if error}
    <Card>
      <CardContent>
        <Typography variant="h6" class="text-[color:var(--color-danger)]">Failed to load routes</Typography>
        <Typography variant="caption">{error}</Typography>
      </CardContent>
    </Card>
  {:else if allRoutes == null}
    <Card>
      <CardContent>
        <Stack direction="row" spacing={1} align="center">
          <Spinner size={16} />
          <Typography variant="caption">Loading routes…</Typography>
        </Stack>
      </CardContent>
    </Card>
  {:else}
    <Card>
      <CardContent>
        <Stack spacing={2}>
          <Stack spacing={0.5}>
            <Typography variant="h5">Favorites</Typography>
            <Typography variant="caption" class="text-[color:var(--color-fg-muted)]">
              {favCount} of {allRoutes.length} routes starred. Tap the heart to toggle.
            </Typography>
          </Stack>
          <Stack spacing={0.5}>
            {#each sortedRoutes as route (route.id)}
              {@const isFav = favoritesStore.has(route.id)}
              <Stack direction="row" spacing={1} align="center" class="px-1 py-1 rounded-md hover:bg-[color:var(--color-border)]/30">
                <RouteBadge {route} size="medium" isFavorite={isFav} />
                <Typography variant="body2" class="flex-1 truncate text-[color:var(--color-fg-muted)]">
                  Route {route.shortName}
                </Typography>
                <IconButton
                  aria-label={`${isFav ? 'Unfavorite' : 'Favorite'} route ${route.shortName}`}
                  aria-pressed={isFav}
                  onclick={() => favoritesStore.toggle(route.id)}
                >
                  <Heart
                    size={18}
                    fill={isFav ? 'currentColor' : 'none'}
                    class={isFav ? 'text-[color:var(--color-danger)]' : 'text-[color:var(--color-fg-muted)]'}
                  />
                </IconButton>
              </Stack>
            {/each}
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  {/if}
</div>
