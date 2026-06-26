<!--
  Favorites — lists the user’s favorited routes. Each badge links to a
  (future) route detail view; for now tapping a heart removes the
  favorite. Routes the user hasn’t encountered yet aren’t shown here
  — favoriting still happens from the Stations view (in a follow-up
  commit, until then via `neary.stores.favoritesStore.add(routeId)` in
  the console).
-->
<script lang="ts">
  import { Heart, HeartOff } from 'lucide-svelte';
  import {
    Card, CardContent, IconButton, RouteBadge, Stack, Typography,
  } from '$lib/ui';
  import { getGtfsRepo } from '$lib/data/gtfs/repo';
  import type { Route } from '$lib/domain/types';
  import { feedsStore } from '$lib/stores/feedsStore.svelte';
  import { favoritesStore } from '$lib/stores/favoritesStore.svelte';
  import { userPrefs } from '$lib/stores/userPrefs.svelte';

  // Fetch the feed’s full route list once so we can look up shortName
  // and color for each favorited id. Keeps the favorite store as a pure
  // id set (no embedded route metadata that could drift from the feed).
  let routesById = $state<Map<number, Route> | null>(null);
  let error = $state<string | null>(null);

  $effect(() => {
    const fid = feedsStore.boundFeedId;
    if (!fid) return;
    (async () => {
      try {
        const repo = getGtfsRepo();
        const all = await repo.getRoutes();
        const m = new Map<number, Route>();
        for (const r of all) m.set(r.id, r);
        routesById = m;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    })();
  });

  const favRoutes = $derived.by<Route[]>(() => {
    if (!routesById) return [];
    const out: Route[] = [];
    for (const id of favoritesStore.routeIds) {
      const r = routesById.get(id);
      if (r) out.push(r);
    }
    return out.sort((a, b) => {
      const an = Number(a.shortName);
      const bn = Number(b.shortName);
      if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn;
      return a.shortName.localeCompare(b.shortName);
    });
  });
</script>

<div class="mx-auto max-w-3xl px-4 py-6">
  {#if userPrefs.feedId == null}
    <Card>
      <CardContent class="text-center">
        <Stack spacing={1.5} align="center">
          <div class="inline-flex items-center justify-center w-12 h-12 rounded-full bg-[color:var(--color-danger)]/10 text-[color:var(--color-danger)]">
            <Heart size={24} />
          </div>
          <Typography variant="h4">Favorites</Typography>
          <Typography variant="body2" class="max-w-prose text-[color:var(--color-fg-muted)]">
            Pick a feed in Settings first; then star routes from a station card to see them here.
          </Typography>
        </Stack>
      </CardContent>
    </Card>
  {:else if error}
    <Card>
      <CardContent>
        <Typography variant="h6" class="text-[color:var(--color-danger)]">Failed to load routes</Typography>
        <Typography variant="caption">{error}</Typography>
      </CardContent>
    </Card>
  {:else if favRoutes.length === 0}
    <Card>
      <CardContent class="text-center">
        <Stack spacing={1.5} align="center">
          <div class="inline-flex items-center justify-center w-12 h-12 rounded-full bg-[color:var(--color-danger)]/10 text-[color:var(--color-danger)]">
            <Heart size={24} />
          </div>
          <Typography variant="h4">No favorites yet</Typography>
          <Typography variant="body2" class="max-w-prose text-[color:var(--color-fg-muted)]">
            Star a route from any station card to keep it here.
          </Typography>
        </Stack>
      </CardContent>
    </Card>
  {:else}
    <Card>
      <CardContent>
        <Stack spacing={2}>
          <Typography variant="h5">Your favorite routes</Typography>
          <Stack spacing={1}>
            {#each favRoutes as route (route.id)}
              <Stack direction="row" spacing={1} align="center">
                <RouteBadge {route} size="large" isFavorite={true} />
                <Typography variant="body2" class="flex-1 truncate">
                  Route {route.shortName}
                </Typography>
                <IconButton
                  aria-label={`Unfavorite route ${route.shortName}`}
                  onclick={() => favoritesStore.remove(route.id)}
                >
                  <HeartOff size={18} />
                </IconButton>
              </Stack>
            {/each}
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  {/if}
</div>
