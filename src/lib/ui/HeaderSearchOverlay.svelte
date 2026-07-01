<!--
  HeaderSearchOverlay — global search dialog opened from the header icon.
  Combines stops + routes in one result list so the rider can jump to
  either a station or a route without switching UIs.

  Empty query:
    - Nearby: up to 2 nearest stations (when GPS is enabled)
    - Your favorites: every favorited route with a schedule
    - Fallback message when both are empty

  Typed query:
    - Matching routes (short_name + long_name, diacritic-insensitive)
    - Matching stops (name, diacritic-insensitive)

  Only surfaces stops with at least one non-empty arrival_time and
  routes with `hasSchedule !== false` — a search hit should be
  actionable, not a dead-end.

  Backdrop click + Escape dismiss via bits-ui Dialog. Self-contained:
  reads locationStore, feedsStore, favoritesStore directly.
-->
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
  import { locationStore } from '$lib/stores/locationStore.svelte';
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
  // Route catalogue for the bound feed, fetched once per feed. Small
  // (~200-800 routes) so we filter in JS -- no need for a separate SQL
  // search query.
  let allRoutes = $state<Route[] | null>(null);
  let stopResults = $state<StopWithDistance[] | null>(null);
  let routeResults = $state<Route[] | null>(null);
  // Routes serving each result stop, fetched in one batched call after
  // stops resolve. Keyed by stop_id; empty for stops with no scheduled
  // routes (shouldn't happen after the arrival_time filter but guarded).
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

  // 150 ms debounce on the input so each keystroke doesn't kick off a
  // worker round-trip.
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

  // Reset + autofocus when opened. Autofocus runs on the next tick so
  // bits-ui has mounted the portal.
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

  // Invalidate the route catalogue when the feed changes so the next
  // open re-fetches for the new feed.
  $effect(() => {
    feedsStore.boundFeedId; // subscribe
    allRoutes = null;
  });

  // Fetch the route catalogue on demand: when the overlay opens and
  // we don't have one cached for the current feed.
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

  // Main search effect. Runs when open + debounced query + anchor +
  // catalogue change. Two branches:
  //   1. text typed: filter routes (by short/long name) + stops (via
  //      worker). Show mixed results, routes first.
  //   2. empty text: nearest 2 stops (if GPS) + all favorited routes.
  $effect(() => {
    if (!open) return;
    const routes = allRoutes;
    if (routes == null) return; // wait for catalogue
    const a = anchor;
    const q = debouncedQuery;
    const needle = normalizeForSearch(q);

    // Filter to routes with schedule: NT-fallback routes on Cluj don't
    // belong in results since tapping them would open an empty schedule.
    const scheduledRoutes = routes.filter((r) => r.hasSchedule !== false);

    loading = true;
    errorMsg = null;
    (async () => {
      try {
        const repo = getGtfsRepo();
        if (needle) {
          // Typed mode. Match route short_name only -- long_name is
          // usually the origin/terminus pair ('Cluj-Napoca Gara -
          // Piata Mihai Viteazul') and matches too broadly, drowning
          // the exact-number match a rider actually wanted.
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
          // Empty mode. Nearest 4 stops (GPS only) + favorites.
          const nearby = hasGps && a
            ? await repo.searchStops('', a.lat, a.lon, 4, 'distance')
            : [];
          const favs = scheduledRoutes
            .filter((r) => favoritesStore.has(r.id))
            .sort((x, y) => compareRouteShortName(x.shortName, y.shortName));
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

  // After each search settles, fetch the route chips for every result
  // stop in one batched worker round-trip. Cleared between searches so
  // stale chips don't paint while the next fetch is in flight.
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
        // Guard against out-of-order resolution: only apply if the
        // current stopResults still contains these ids. Also drop
        // routes without a schedule -- consistent with the top-level
        // route-search filter, and keeps the chip row honest (a badge
        // that opens a dead-end schedule is worse than no badge).
        const currentIds = new Set((stopResults ?? []).map((s) => s.id));
        const filtered: Record<string, Route[]> = {};
        for (const id of Object.keys(routes)) {
          if (!currentIds.has(id)) continue;
          const scheduled = routes[id].filter((r) => r.hasSchedule !== false);
          if (scheduled.length > 0) filtered[id] = scheduled;
        }
        stopRoutes = filtered;
      } catch {
        // Silent -- badge chips are supplementary; failure to fetch
        // them shouldn't tear down the search results themselves.
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
      class="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in"
    />
    <Bits.Content
      class={cn(
        'fixed z-50 outline-none',
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
              No favorite routes yet and no nearby stops available. Type a station name or a route
              number above to find something.
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
      // Bail when the click came from an inner anchor/button so the
      // badge (map), calendar (schedule), and heart (favorite) taps
      // don't also fire the card's default open-schedule action.
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
