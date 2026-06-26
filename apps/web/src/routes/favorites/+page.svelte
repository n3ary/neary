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
    Card, CardContent, IconButton, NoFeedState, RouteBadge, Spinner, Stack,
    Typography, TypeBadge,
  } from '$lib/ui';
  import { getGtfsRepo } from '$lib/data/gtfs/repo';
  import type { Route, VehicleType } from '$lib/domain/types';
  import { vehicleTypeLabel } from '$lib/domain/types';
  import { feedsStore } from '$lib/stores/feedsStore.svelte';
  import { favoritesStore } from '$lib/stores/favoritesStore.svelte';
  import { userPrefs } from '$lib/stores/userPrefs.svelte';

  let allRoutes = $state<Route[] | null>(null);
  let error = $state<string | null>(null);
  // Multi-select type filter. Empty set = no filter (show all).
  // View-only; resets on page remount per the same pattern as the
  // Stations route filter.
  let typeFilter = $state<Set<VehicleType>>(new Set());

  function toggleType(t: VehicleType) {
    const next = new Set(typeFilter);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    typeFilter = next;
  }

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

  // Set of types actually present in the feed — we don't render filter
  // bubbles for modes that have zero routes (would just be noise).
  // Ordered by vehicleTypeLabel so the row reads alphabetically.
  const presentTypes = $derived.by<VehicleType[]>(() => {
    if (!allRoutes) return [];
    const set = new Set<VehicleType>();
    for (const r of allRoutes) set.add(r.type ?? 'unknown');
    return Array.from(set).sort((a, b) =>
      vehicleTypeLabel(a).localeCompare(vehicleTypeLabel(b)),
    );
  });

  // Per-type accent painted by THIS feed's RouteBadges — pick the
  // first route of each type and reuse its `route.color`. Used by
  // the filter chips so a 'Trolleybus' chip shows the same blue the
  // trolleybus badges below it show, instead of a separate per-mode
  // palette that would never agree with the badges.
  const typeAccent = $derived.by<Map<VehicleType, string>>(() => {
    const map = new Map<VehicleType, string>();
    if (!allRoutes) return map;
    for (const r of allRoutes) {
      const t = r.type ?? 'unknown';
      if (!map.has(t)) map.set(t, r.color);
    }
    return map;
  });

  // Apply the type filter once, then split into the two cards. Within
  // each section, sort numeric-first then alpha.
  function sortRoutes(list: Route[]): Route[] {
    return [...list].sort((a, b) => {
      const an = Number(a.shortName);
      const bn = Number(b.shortName);
      if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn;
      return a.shortName.localeCompare(b.shortName);
    });
  }
  const filteredRoutes = $derived.by<Route[]>(() => {
    if (!allRoutes) return [];
    if (typeFilter.size === 0) return allRoutes;
    return allRoutes.filter((r) => typeFilter.has(r.type ?? 'unknown'));
  });
  const favRoutes = $derived(
    sortRoutes(filteredRoutes.filter((r) => favoritesStore.has(r.id))),
  );
  const otherRoutes = $derived(
    sortRoutes(filteredRoutes.filter((r) => !favoritesStore.has(r.id))),
  );
</script>

<!-- One row-renderer shared by both cards so the layout stays identical
     between favorited and other routes. KISS / DRY. -->
{#snippet routeRow(route: Route)}
  {@const isFav = favoritesStore.has(route.id)}
  {@const type = route.type ?? 'unknown'}
  {@const typeLabel = vehicleTypeLabel(type)}
  <Stack direction="row" spacing={1} align="center" class="px-1 py-1 rounded-md hover:bg-[color:var(--color-border)]/30">
    <!-- Tap the badge to jump to the route's schedule. Direction 0 is
         the default landing direction; the schedule view's own swap
         control lets the user flip without coming back here. min-w-14
         matches VehicleCard so badges read as a tidy left column even
         next to short 1-digit shortNames. -->
    <a href={`/schedule/route/${route.id}_0`} aria-label={`Open schedule for ${typeLabel.toLowerCase()} ${route.shortName}`}>
      <RouteBadge {route} size="medium" isFavorite={isFav} class="min-w-14" />
    </a>
    <Typography variant="body2" class="flex-1 truncate">
      <span style={`color:${route.color}`} class="font-semibold">{typeLabel}</span>
      <span class="text-[color:var(--color-fg-muted)]">{route.shortName}</span>
    </Typography>
    <IconButton
      aria-label={`${isFav ? 'Unfavorite' : 'Favorite'} ${typeLabel.toLowerCase()} ${route.shortName}`}
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
{/snippet}

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
    <Stack spacing={2}>
      {#if presentTypes.length > 1}
        <Card>
          <CardContent>
            <Stack spacing={1}>
              <Stack spacing={0.5}>
                <Typography variant="h5">Filter by mode</Typography>
                <Typography variant="caption" class="text-[color:var(--color-fg-muted)]">
                  {typeFilter.size === 0
                    ? `Showing all ${allRoutes.length} routes. Tap a mode to narrow down.`
                    : `${filteredRoutes.length} of ${allRoutes.length} routes match.`}
                </Typography>
              </Stack>
              <Stack direction="row" spacing={1} align="center" wrap>
                {#each presentTypes as t (t)}
                  <TypeBadge type={t} color={typeAccent.get(t)} active={typeFilter.has(t)} onclick={() => toggleType(t)} />
                {/each}
                {#if typeFilter.size > 0}
                  <button
                    type="button"
                    class="text-xs underline text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]"
                    onclick={() => (typeFilter = new Set())}
                  >
                    Clear filter
                  </button>
                {/if}
              </Stack>
            </Stack>
          </CardContent>
        </Card>
      {/if}

      {#if favRoutes.length > 0}
        <Card>
          <CardContent>
            <Stack spacing={1}>
              <Stack spacing={0.5}>
                <Typography variant="h5">Your favorites</Typography>
                <Typography variant="caption" class="text-[color:var(--color-fg-muted)]">
                  {favRoutes.length} starred. Tap the heart to remove.
                </Typography>
              </Stack>
              <Stack spacing={0.5}>
                {#each favRoutes as route (route.id)}
                  {@render routeRow(route)}
                {/each}
              </Stack>
            </Stack>
          </CardContent>
        </Card>
      {/if}

      <Card>
        <CardContent>
          <Stack spacing={1}>
            <Stack spacing={0.5}>
              <Typography variant="h5">
                {favRoutes.length > 0 ? 'All other routes' : 'All routes'}
              </Typography>
              <Typography variant="caption" class="text-[color:var(--color-fg-muted)]">
                {favRoutes.length > 0
                  ? `${otherRoutes.length} more to choose from. Tap the heart to favorite.`
                  : `${otherRoutes.length} routes available. Tap the heart to favorite.`}
              </Typography>
            </Stack>
            <Stack spacing={0.5}>
              {#each otherRoutes as route (route.id)}
                {@render routeRow(route)}
              {/each}
            </Stack>
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  {/if}
</div>
