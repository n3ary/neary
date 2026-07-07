<!--
  HeaderSearchOverlay: empty mode shows favorites + GPS-gated nearby,
  typed mode searches routes by short_name + stops by name.
  Hits are filtered to actionable entries (arrival_time / hasSchedule).
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { Dialog as Bits } from 'bits-ui';
  import { Search, X } from 'lucide-svelte';
  import { getGtfsRepo } from '$lib/data/gtfs/repo';
  import type { StopWithDistance } from '$lib/data/gtfs/types';
  import type { Route } from '$lib/domain/types';
  import { compareRouteShortName } from '$lib/domain/types';
  import { favoritesStore } from '$lib/stores/favoritesStore.svelte';
  import { feedsStore } from '$lib/stores/feedsStore.svelte';
  import { locationStore } from '$lib/stores/gps/locationStore.svelte';
  import { cn } from './cn';
  import FavoriteRouteRow from './FavoriteRouteRow.svelte';
  import FavoriteStationRow from './FavoriteStationRow.svelte';
  import Spinner from './Spinner.svelte';
  import Stack from './Stack.svelte';
  import Typography from './Typography.svelte';

  type Props = {
    open: boolean;
    onclose: () => void;
  };

  let { open, onclose }: Props = $props();

  let query = $state('');
  let debouncedQuery = $state('');
  // Small (~200-800) so we filter in JS instead of writing SQL.
  let allRoutes = $state<Route[] | null>(null);
  let stopResults = $state<StopWithDistance[] | null>(null);
  let routeResults = $state<Route[] | null>(null);
  // Lazy: users with no station favorites skip the worker round-trip.
  let favoriteStations = $state<StopWithDistance[]>([]);
  // Routes per result stop, batched after stops resolve; keyed by stop_id.
  let stopRoutes = $state<Record<string, Route[]>>({});
  let loading = $state(false);
  let errorMsg = $state<string | null>(null);
  let inputEl = $state<HTMLInputElement | null>(null);

  const anchor = $derived.by(() => {
    const pos = locationStore.position;
    if (pos) return { lat: pos.coords.latitude, lon: pos.coords.longitude };
    const feed = feedsStore.byId(feedsStore.boundFeedId);
    return feed?.center ?? null;
  });
  const hasGps = $derived(locationStore.position != null);
  const sortMode = $derived<'distance' | 'name'>(hasGps ? 'distance' : 'name');

  // Debounce so each keystroke doesn't kick off a worker round-trip.
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    const q = query;
    if (debounceTimer != null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debouncedQuery = q;
    }, 150);
    return () => {
      if (debounceTimer != null) clearTimeout(debounceTimer);
    };
  });

  // Autofocus on the next tick so bits-ui has mounted the portal.
  $effect(() => {
    if (open) {
      query = '';
      debouncedQuery = '';
      stopResults = null;
      routeResults = null;
      stopRoutes = {};
      errorMsg = null;
      queueMicrotask(() => inputEl?.focus());
    }
  });

  $effect(() => {
    feedsStore.boundFeedId; // subscribe
    allRoutes = null;
  });

  $effect(() => {
    if (!open) return;
    const fid = feedsStore.boundFeedId;
    if (!fid) return;
    if (allRoutes != null) return;
    (async () => {
      try {
        const repo = getGtfsRepo();
        allRoutes = await repo.getRoutes();
      } catch (e) {
        errorMsg = e instanceof Error ? e.message : String(e);
      }
    })();
  });

  $effect(() => {
    if (!open) return;
    const fid = feedsStore.boundFeedId;
    if (!fid) return;
    const ids = favoritesStore.stationIds;
    if (ids.size === 0) {
      favoriteStations = [];
      return;
    }
    if (favoriteStations.length > 0) return;
    (async () => {
      try {
        const repo = getGtfsRepo();
        const resolved = await repo.getStopsByIds(Array.from(ids));
        favoriteStations = resolved.sort((a, b) => a.name.localeCompare(b.name));
      } catch (e) {
        errorMsg = e instanceof Error ? e.message : String(e);
      }
    })();
  });

  $effect(() => {
    if (!open) return;
    const routes = allRoutes;
    if (routes == null) return; // wait for catalogue
    const a = anchor;
    const q = debouncedQuery;
    const needle = normalizeForSearch(q);

    // NT-fallback (no-time) routes don't belong in results -- a hit
    // that opens an empty schedule is worse than no hit.
    const scheduledRoutes = routes.filter((r) => r.hasSchedule !== false);

    loading = true;
    errorMsg = null;
    (async () => {
      try {
        const repo = getGtfsRepo();
        if (needle) {
          // Match route short_name only -- long_name is the
          // origin/terminus pair and matches too broadly.
          const matchingRoutes = scheduledRoutes
            .filter((r) => normalizeForSearch(r.shortName).includes(needle))
            .sort((x, y) => compareRouteShortName(x.shortName, y.shortName))
            .slice(0, 12);
          const stops = a
            ? await repo.searchStops(q, a.lat, a.lon, 15, sortMode)
            : [];
          routeResults = matchingRoutes;
          stopResults = stops;
        } else {
          // Favorites are unconditional (the user explicitly opened
          // search, so duplicating the home card is the point). Nearby
          // is GPS-gated and deduped against the favorite-stations set.
          const favs = scheduledRoutes
            .filter((r) => favoritesStore.hasRoute(r.id))
            .sort((x, y) => compareRouteShortName(x.shortName, y.shortName));
          const nearby = hasGps && a
            ? (await repo.searchStops('', a.lat, a.lon, 8, 'distance'))
                .filter((s) => !favoritesStore.hasStation(s.id))
                .slice(0, 4)
            : [];
          routeResults = favs;
          stopResults = nearby;
        }
      } catch (e) {
        errorMsg = e instanceof Error ? e.message : String(e);
      } finally {
        loading = false;
      }
    })();
  });

  const isTyping = $derived(debouncedQuery.length > 0);
  const noResults = $derived(
    !loading &&
      !errorMsg &&
      stopResults != null &&
      routeResults != null &&
      stopResults.length === 0 &&
      routeResults.length === 0,
  );

  // Route chips for nearby + typed + favorited stops in one batched
  // worker call. Cleared when no stop is visible so stale chips
  // don't paint.
  $effect(() => {
    if (!open) return;
    const a = stopResults ?? [];
    const b = favoriteStations;
    const idsSet = new Set<string>();
    for (const s of a) idsSet.add(s.id);
    for (const s of b) idsSet.add(s.id);
    if (idsSet.size === 0) {
      stopRoutes = {};
      return;
    }
    const ids = Array.from(idsSet);
    const snapshotA = a.map((s) => s.id);
    const snapshotB = b.map((s) => s.id);
    (async () => {
      try {
        const repo = getGtfsRepo();
        const routes = await repo.getRoutesForStops(ids);
        // Out-of-order guard: skip if the visible set changed mid-flight.
        // A badge that opens a dead-end schedule is worse than no badge.
        const currentIds = new Set([
          ...snapshotA,
          ...snapshotB,
        ]);
        const filtered: Record<string, Route[]> = {};
        for (const id of Object.keys(routes)) {
          if (!currentIds.has(id)) continue;
          const scheduled = routes[id].filter((r) => r.hasSchedule !== false);
          if (scheduled.length > 0) filtered[id] = scheduled;
        }
        stopRoutes = filtered;
      } catch {
        // Chips are supplementary; failure shouldn't tear down results.
      }
    })();
  });

  function selectStop(id: string) {
    onclose();
    goto(`/station/${id}`);
  }
  function openRouteSchedule(route: Route) {
    onclose();
    goto(`/schedule/route/${route.id}_0`);
  }
  function toggleFavorite(route: Route) {
    favoritesStore.toggleRoute(route.id);
  }
  function toggleFavoriteStation(stopId: string) {
    favoritesStore.toggleStation(stopId);
  }
  function normalizeForSearch(s: string): string {
    return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
  }
</script>

<Bits.Root bind:open={() => open, (v) => { if (!v) onclose(); }}>
  <Bits.Portal>
    <Bits.Overlay
      class="fixed inset-0 z-[1100] bg-black/75 data-[state=open]:animate-in data-[state=open]:fade-in"
    />
    <Bits.Content
      class={cn(
        'fixed z-[1100] outline-none',
        'left-1/2 -translate-x-1/2 top-[10svh] w-[min(calc(100vw-2rem),36rem)]',
        'flex flex-col gap-2',
        'data-[state=open]:animate-in data-[state=open]:fade-in data-[state=open]:zoom-in-95',
      )}
    >
      <Bits.Title class="sr-only">Search stations and routes</Bits.Title>

      <div
        class="relative bg-[color:var(--color-surface)] text-[color:var(--color-fg)] border border-[color:var(--color-border)] rounded-lg shadow-xl"
      >
        <div class="flex items-center gap-2 px-3 py-2 border-b border-[color:var(--color-border)]">
          <Search size={18} class="shrink-0 text-[color:var(--color-fg-muted)]" />
          <input
            bind:this={inputEl}
            bind:value={query}
            type="search"
            inputmode="search"
            placeholder="Search stations or routes…"
            aria-label="Search stations and routes"
            class="flex-1 min-w-0 bg-transparent text-base sm:text-sm outline-none placeholder:text-[color:var(--color-fg-muted)]"
          />
          <button
            type="button"
            onclick={onclose}
            aria-label="Cancel"
            class="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-md hover:bg-[color:var(--color-border)]/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary)]"
          >
            <X size={16} />
          </button>
        </div>

        <div class="max-h-[70svh] overflow-y-auto px-2 py-2 space-y-1.5">
          {#if errorMsg}
            <Typography variant="caption" class="block px-2 py-1 text-[color:var(--color-danger)]">
              {errorMsg}
            </Typography>
          {:else if anchor == null && stopResults == null}
            <Typography variant="caption" class="block px-2 py-1 text-[color:var(--color-fg-muted)]">
              Pick a feed in Settings to search stations and routes.
            </Typography>
          {:else if loading && stopResults == null && routeResults == null}
            <Stack direction="row" spacing={1} align="center" class="px-2 py-1">
              <Spinner size={14} />
              <Typography variant="caption">Searching…</Typography>
            </Stack>
          {:else if noResults && isTyping}
            <Typography variant="caption" class="block px-2 py-2 text-[color:var(--color-fg-muted)]">
              Nothing matches “{debouncedQuery}”. Try a different name, route number, or destination.
            </Typography>
          {:else if noResults}
            <Typography variant="caption" class="block px-2 py-2 text-[color:var(--color-fg-muted)]">
              {hasGps
                ? 'No nearby stops. Type a station name or a route number above to find something.'
                : 'Type a station name or a route number above to find something.'}
            </Typography>
          {:else}
            {#if routeResults && routeResults.length > 0}
              <Typography variant="caption" class="block px-2 pt-1 text-[color:var(--color-fg-muted)]">
                {isTyping ? 'Routes' : 'Your favorite routes'}
              </Typography>
              {#each routeResults as route (route.id)}
                <FavoriteRouteRow
                  {route}
                  isFav={favoritesStore.hasRoute(route.id)}
                  onToggleFavorite={() => toggleFavorite(route)}
                  onbodyclick={() => openRouteSchedule(route)}
                />
              {/each}
            {/if}

            {#if !isTyping && favoriteStations.length > 0}
              <Typography variant="caption" class="block px-2 pt-2 text-[color:var(--color-fg-muted)]">
                Your favorite stations
              </Typography>
              {#each favoriteStations as stop (stop.id)}
                <FavoriteStationRow
                  {stop}
                  isFav={favoritesStore.hasStation(stop.id)}
                  onToggleFavorite={() => toggleFavoriteStation(stop.id)}
                  onbodyclick={() => selectStop(stop.id)}
                  routes={stopRoutes[stop.id]}
                />
              {/each}
            {/if}

            {#if !isTyping && stopResults && stopResults.length > 0}
              <Typography variant="caption" class="block px-2 pt-2 text-[color:var(--color-fg-muted)]">
                Nearby
              </Typography>
              {#each stopResults as stop (stop.id)}
                <FavoriteStationRow
                  {stop}
                  routes={stopRoutes[stop.id] ?? []}
                  {hasGps}
                  onbodyclick={() => selectStop(stop.id)}
                  isFav={favoritesStore.hasStation(stop.id)}
                  onToggleFavorite={() => toggleFavoriteStation(stop.id)}
                />
              {/each}
            {/if}

            {#if isTyping && stopResults && stopResults.length > 0}
              <Typography variant="caption" class="block px-2 pt-2 text-[color:var(--color-fg-muted)]">
                Stations
              </Typography>
              {#each stopResults as stop (stop.id)}
                <FavoriteStationRow
                  {stop}
                  routes={stopRoutes[stop.id] ?? []}
                  {hasGps}
                  onbodyclick={() => selectStop(stop.id)}
                  isFav={favoritesStore.hasStation(stop.id)}
                  onToggleFavorite={() => toggleFavoriteStation(stop.id)}
                />
              {/each}
            {/if}
          {/if}
        </div>
      </div>

      {#if anchor && !hasGps}
        <Typography variant="caption" class="block text-center text-[color:var(--color-fg-muted)]">
          Enable location to sort stations by distance.
        </Typography>
      {/if}
    </Bits.Content>
  </Bits.Portal>
</Bits.Root>
