<!-- Global search dialog opened from the header icon. Combines stops + routes in one result list so the rider can jump to either without switching UIs. Empty = nearby (when GPS) + favorited routes + fallback. Typed = matching routes (short_name only — long_name matches too broadly) + stops (diacritic-insensitive). Only surfaces stops with arrival_time and routes with hasSchedule !== false — a search hit should be actionable. Backdrop click + Escape dismiss via bits-ui Dialog. -->

<script lang="ts">
  import { goto } from '$app/navigation';
  import { Dialog as Bits } from 'bits-ui';
  import { Calendar, Heart, Search, X } from 'lucide-svelte';
  import { getGtfsRepo } from '$lib/data/gtfs/repo';
  import type { StopWithDistance } from '$lib/data/gtfs/types';
  import type { Route } from '$lib/domain/types';
  import { compareRouteShortName, vehicleTypeLabel } from '$lib/domain/types';
  import { favoritesStore } from '$lib/stores/favoritesStore.svelte';
  import { feedsStore } from '$lib/stores/feedsStore.svelte';
  import { locationStore } from '$lib/stores/gps/locationStore.svelte';
  import { cn } from './cn';
  import { iconButtonClass } from './iconButtonClass';
  import RouteBadge from './RouteBadge.svelte';
  import Spinner from './Spinner.svelte';
  import Stack from './Stack.svelte';
  import StopSearchCard from './StopSearchCard.svelte';
  import Typography from './Typography.svelte';

  type Props = {
    open: boolean;
    onclose: () => void;
  };

  let { open, onclose }: Props = $props();

  let query = $state('');
  let debouncedQuery = $state('');
  let allRoutes = $state<Route[] | null>(null);
  let stopResults = $state<StopWithDistance[] | null>(null);
  let routeResults = $state<Route[] | null>(null);
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

  // 150 ms debounce so each keystroke doesn't kick off a worker round-trip.
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

  // Reset + autofocus when opened. Autofocus on next tick so bits-ui has mounted the portal.
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

  // Invalidate the route catalogue when the feed changes.
  $effect(() => {
    feedsStore.boundFeedId; // subscribe
    allRoutes = null;
  });

  // Lazy-fetch the route catalogue on open.
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

  // Main search: typed → routes by short_name + nearest stops; empty → nearest 2 stops (if GPS) + favorited routes. NT-fallback routes are filtered (no arrival_time would dead-end).
  $effect(() => {
    if (!open) return;
    const routes = allRoutes;
    if (routes == null) return;
    const a = anchor;
    const q = debouncedQuery;
    const needle = normalizeForSearch(q);
    const scheduledRoutes = routes.filter((r) => r.hasSchedule !== false);

    loading = true;
    errorMsg = null;
    (async () => {
      try {
        const repo = getGtfsRepo();
        if (needle) {
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
          const nearby = hasGps && a
            ? await repo.searchStops('', a.lat, a.lon, 4, 'distance')
            : [];
          const favs = hasGps
            ? scheduledRoutes
                .filter((r) => favoritesStore.has(r.id))
                .sort((x, y) => compareRouteShortName(x.shortName, y.shortName))
            : [];
          stopResults = nearby;
          routeResults = favs;
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

  // After each search settles, batched fetch the route chips for every result stop. Out-of-order guard: only apply if current stopResults still contains the same ids. Silent on failure — chips are supplementary.
  $effect(() => {
    if (!open) return;
    const stops = stopResults;
    if (stops == null) return;
    if (stops.length === 0) {
      stopRoutes = {};
      return;
    }
    const ids = stops.map((s) => s.id);
    (async () => {
      try {
        const repo = getGtfsRepo();
        const routes = await repo.getRoutesForStops(ids);
        const currentIds = new Set((stopResults ?? []).map((s) => s.id));
        const filtered: Record<string, Route[]> = {};
        for (const id of Object.keys(routes)) {
          if (!currentIds.has(id)) continue;
          const scheduled = routes[id].filter((r) => r.hasSchedule !== false);
          if (scheduled.length > 0) filtered[id] = scheduled;
        }
        stopRoutes = filtered;
      } catch {
        // badge chips are supplementary; failure shouldn't tear down the search results
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
    favoritesStore.toggle(route.id);
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
                {isTyping ? 'Routes' : 'Your favorites'}
              </Typography>
              {#each routeResults as route (route.id)}
                {@const isFav = favoritesStore.has(route.id)}
                {@const type = route.type ?? 'unknown'}
                {@const typeLabel = vehicleTypeLabel(type)}
                {@const primaryLabel = route.longName ?? typeLabel}
                {@render routeCard(route, isFav, primaryLabel, typeLabel)}
              {/each}
            {/if}

            {#if stopResults && stopResults.length > 0}
              <Typography variant="caption" class="block px-2 pt-2 text-[color:var(--color-fg-muted)]">
                {isTyping ? 'Stations' : 'Nearby'}
              </Typography>
              {#each stopResults as stop (stop.id)}
                <StopSearchCard
                  {stop}
                  routes={stopRoutes[stop.id] ?? []}
                  {hasGps}
                  onselect={selectStop}
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

{#snippet routeCard(route: Route, isFav: boolean, primaryLabel: string, typeLabel: string)}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    role="button"
    tabindex={0}
    onclick={(e) => {
      // Bail when the click came from an inner anchor/button so the badge (map), calendar (schedule), and heart (favorite) taps don't fire the default open-schedule action.
      if ((e.target as Element | null)?.closest('a, button')) return;
      openRouteSchedule(route);
    }}
    onkeydown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        if ((e.target as Element | null)?.closest('a, button')) return;
        e.preventDefault();
        openRouteSchedule(route);
      }
    }}
    class={cn(
      'flex items-center gap-3 px-3 py-2 border-2 border-solid rounded-md transition-colors',
      'border-[color:var(--color-border)] cursor-pointer',
      'hover:bg-[color:var(--color-border)]/30',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary)]',
    )}
  >
    <a
      href={`/map/route/${route.id}_0`}
      onclick={onclose}
      aria-label={`Open map for ${typeLabel.toLowerCase()} ${route.shortName}`}
      title="Open route map"
      class="shrink-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary)]"
    >
      <RouteBadge {route} size="medium" class="min-w-14" />
    </a>
    <div class="min-w-0 flex-1">
      <div class="text-sm font-medium truncate">{primaryLabel}</div>
      {#if route.description}
        <div class="text-xs truncate text-[color:var(--color-fg-muted)]">{route.description}</div>
      {/if}
    </div>
    <div class="flex items-center gap-1 shrink-0">
      <a
        href={`/schedule/route/${route.id}_0`}
        onclick={onclose}
        aria-label={`Open schedule for ${typeLabel.toLowerCase()} ${route.shortName}`}
        title="Open route schedule"
        class={iconButtonClass}
      >
        <Calendar size={16} strokeWidth={2.25} />
      </a>
      <button
        type="button"
        aria-label={`${isFav ? 'Unfavorite' : 'Favorite'} ${typeLabel.toLowerCase()} ${route.shortName}`}
        aria-pressed={isFav}
        onclick={(e) => { e.stopPropagation(); toggleFavorite(route); }}
        class={iconButtonClass}
      >
        <Heart
          size={16}
          strokeWidth={2.25}
          fill={isFav ? 'currentColor' : 'none'}
          class={isFav ? 'text-[color:var(--color-danger)]' : 'text-[color:var(--color-fg-muted)]'}
        />
      </button>
    </div>
  </div>
{/snippet}
