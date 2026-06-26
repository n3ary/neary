<!--
  Map view — by-route, by-direction.

  URL shape (path-only, like /schedule/route):
    /map/route/[id]                multi-direction (not yet supported)
    /map/route/[id]_0|[id]_1       single-direction map
    /map/route/[id]_0|[id]_1/[v]   single-direction with vehicle v highlighted

  Renders:
    - the route's shape polyline,
    - every stop along the representative trip,
    - the user's current GPS (if known),
    - one marker per active trip, positioned by domain prediction
      (linear interpolation between consecutive stops at the
      reactive `nowMin`). Schedule-only / not-yet-active vehicles
      are dimmed; vehicles already past their terminus drop off.
    - the selected vehicle ringed.

  Direction-swap and zoom controls live in the header card to match
  the schedule view's chrome. Tab on a stop shows a popup with the
  station's name and a deep link to /station/[id].
-->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { ArrowRightLeft, Moon } from 'lucide-svelte';
  import {
    Card, CardContent, Chip, IconButton, NoFeedState, RouteBadge, Spinner,
    Stack, Typography,
  } from '$lib/ui';
  import { getGtfsRepo } from '$lib/data/gtfs/repo';
  import type { RouteMapView } from '$lib/data/gtfs/types';
  import {
    formatHHMM, isNightRoute, pickContrastingText, vehicleTypeLabel,
  } from '$lib/domain/types';
  import { minSinceMidnightInTz } from '$lib/domain/pipeline/timeUtils';
  import {
    buildTripShapePlan, predictPosition, predictPositionOnShape,
    type TripShapePlan,
  } from '$lib/domain/predictPosition';
  import { feedsStore } from '$lib/stores/feedsStore.svelte';
  import { favoritesStore } from '$lib/stores/favoritesStore.svelte';
  import { locationStore } from '$lib/stores/locationStore.svelte';
  import { nowTicker } from '$lib/stores/nowTicker.svelte';
  import { refreshBus } from '$lib/stores/refreshBus.svelte';
  import { userPrefs } from '$lib/stores/userPrefs.svelte';

  // ── URL params ──────────────────────────────────────────────────────
  // Same `[id]_[dir]` convention the schedule view uses.
  const idSegment = $derived(page.params.id ?? '');
  const parsed = $derived.by<{ routeId: string; direction: 0 | 1 | null }>(() => {
    const m = idSegment.match(/^(.+)_([01])$/);
    if (m) return { routeId: m[1], direction: Number(m[2]) as 0 | 1 };
    return { routeId: idSegment, direction: null };
  });
  const routeId = $derived(parsed.routeId);
  const direction = $derived(parsed.direction);
  const selectedTripId = $derived(page.params.selected ?? null);

  // ── Data ────────────────────────────────────────────────────────────
  let view = $state<RouteMapView | null>(null);
  let error = $state<string | null>(null);

  const tz = $derived(feedsStore.activeTimezone);
  const nowMin = $derived(minSinceMidnightInTz(nowTicker.ms, tz));

  // Lookback / lookahead window for the route-active-trips query.
  // 90 min in each direction comfortably covers normal urban trip
  // lengths plus a head/tail buffer.
  const LOOKBACK_MIN = 90;
  const LOOKAHEAD_MIN = 90;

  $effect(() => {
    const fid = feedsStore.boundFeedId;
    if (!fid || direction == null || routeId.length === 0) return;
    refreshBus.tick;
    const rid = routeId;
    const dir = direction;
    const ms = nowTicker.ms;
    // Window query depends on nowTicker for service-date pickup,
    // but we don't want to refetch every minute — just on first
    // load + dir change + manual refresh.
    void ms;
    (async () => {
      try {
        const repo = getGtfsRepo();
        const localDate = new Intl.DateTimeFormat('en-CA', {
          timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        }).formatToParts(Date.now())
          .reduce((acc, p) => p.type !== 'literal' ? acc + p.value : acc, '');
        view = await repo.getRouteMapView(
          rid, dir, localDate,
          minSinceMidnightInTz(Date.now(), tz),
          LOOKBACK_MIN, LOOKAHEAD_MIN,
        );
        error = null;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    })();
  });

  const route = $derived(view?.route ?? null);
  const isFav = $derived(route ? favoritesStore.has(route.id) : false);
  const nightRoute = $derived(route ? isNightRoute(route) : false);

  // Pre-projected per-trip shape plans. Built once when the view
  // payload arrives and reused on every nowMin tick — the per-tick
  // cost is then a binary search + interpolation per visible
  // vehicle. Trips with no usable shape get `null` here and the UI
  // falls back to straight-line interpolation between stops.
  const tripPlans = $derived.by<Map<string, TripShapePlan | null>>(() => {
    const map = new Map<string, TripShapePlan | null>();
    if (!view) return map;
    for (const t of view.trips) {
      map.set(t.tripId, buildTripShapePlan(t.stops, view.shape));
    }
    return map;
  });

  // ── Derived view-model ──────────────────────────────────────────────
  /** Render-ready vehicles for the current nowMin. Each trip yields
   *  one entry; the domain decides position + status, the UI maps
   *  status → opacity / hidden. */
  type VehicleMarker = {
    tripId: string;
    headsign: string | null;
    lat: number;
    lon: number;
    opacity: number;
    selected: boolean;
  };
  const markers = $derived.by<VehicleMarker[]>(() => {
    if (!view) return [];
    const out: VehicleMarker[] = [];
    for (const t of view.trips) {
      const plan = tripPlans.get(t.tripId);
      const p = plan
        ? predictPositionOnShape(plan, nowMin)
        : predictPosition(t.stops, nowMin);
      if (!p) continue;
      // 'before' = scheduled but not yet imminent at the origin
      // → hide so the start station isn't a tower of buses.
      // 'after'  = past terminus → drop.
      if (p.status === 'before' || p.status === 'after') continue;
      // 'at-origin' = imminent (within ~5 min of departure) →
      // visible but dimmer; 'active' = en route → full opacity.
      const opacity = p.status === 'at-origin' ? 0.4 : 0.9;
      out.push({
        tripId: t.tripId,
        headsign: t.headsign,
        lat: p.lat,
        lon: p.lon,
        opacity,
        selected: t.tripId === selectedTripId,
      });
    }
    return out;
  });

  // ── Title / subtitle ───────────────────────────────────────────────
  const headsign = $derived(view?.trips[0]?.headsign ?? null);
  const headerTitle = $derived(
    route ? `${vehicleTypeLabel(route.type ?? 'unknown')} ${route.shortName}` : '',
  );
  const headerSubtitle = $derived(headsign ? `→ ${headsign}` : null);

  // ── Navigation helpers ─────────────────────────────────────────────
  function swapDirection() {
    if (direction == null) return;
    const otherDir = direction === 0 ? 1 : 0;
    // Selected vehicle isn't on the other direction — drop it.
    goto(`/map/route/${routeId}_${otherDir}`, { replaceState: false });
  }

  // ── Leaflet ────────────────────────────────────────────────────────
  // Leaflet is browser-only; init in onMount. The instance + per-layer
  // refs are non-reactive state held outside Svelte runes so we can
  // mutate them imperatively (Leaflet's API is fully imperative).
  let mapEl: HTMLDivElement | undefined = $state();
  type LeafletNS = typeof import('leaflet');
  let L: LeafletNS | null = null;
  let mapInstance: import('leaflet').Map | null = null;
  let shapeLayer: import('leaflet').Polyline | null = null;
  let stopsLayer: import('leaflet').LayerGroup | null = null;
  let vehiclesLayer: import('leaflet').LayerGroup | null = null;
  let userMarker: import('leaflet').CircleMarker | null = null;
  let hasFitOnce = false;

  onMount(async () => {
    // Tree-shake to client: importing leaflet at module top would
    // pull it into the SSR bundle and explode on `window`.
    L = (await import('leaflet')).default;
    await import('leaflet/dist/leaflet.css');
    if (!mapEl) return;
    mapInstance = L.map(mapEl, {
      zoomControl: true,
      attributionControl: true,
      // Reasonable default — we'll fitBounds once shape loads.
      center: [46.77, 23.6],
      zoom: 13,
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap contributors',
    }).addTo(mapInstance);
    stopsLayer = L.layerGroup().addTo(mapInstance);
    vehiclesLayer = L.layerGroup().addTo(mapInstance);
  });

  onDestroy(() => {
    mapInstance?.remove();
    mapInstance = null;
  });

  // Re-paint the route shape + stops whenever the view-model changes.
  // Leaflet layers are mutated in place; markers are recreated cheaply
  // (a route has O(50) stops, an order of magnitude less than what
  // Leaflet handles fluidly).
  $effect(() => {
    if (!L || !mapInstance || !view) return;
    if (shapeLayer) {
      shapeLayer.remove();
      shapeLayer = null;
    }
    if (view.shape.length >= 2) {
      const latlngs = view.shape.map((p) => [p.lat, p.lon] as [number, number]);
      shapeLayer = L.polyline(latlngs, {
        color: view.route.color,
        weight: 5,
        opacity: 0.85,
      }).addTo(mapInstance);
      if (!hasFitOnce) {
        mapInstance.fitBounds(shapeLayer.getBounds(), { padding: [24, 24] });
        hasFitOnce = true;
      }
    }
    stopsLayer?.clearLayers();
    if (stopsLayer) {
      for (const s of view.stops) {
        const m = L.circleMarker([s.lat, s.lon], {
          radius: 5,
          color: '#fff',
          weight: 1.5,
          fillColor: view.route.color,
          fillOpacity: 1,
        });
        m.bindPopup(stopPopupHtml(s.stopId, s.stopName, s.arrivalMin), {
          closeButton: false,
        });
        m.addTo(stopsLayer);
      }
    }
  });

  // Re-paint vehicles every nowMin tick.
  $effect(() => {
    if (!L || !mapInstance || !vehiclesLayer || !view) return;
    void nowMin; // declare dependency so the effect re-runs each tick
    vehiclesLayer.clearLayers();
    const routeColor = view.route.color;
    const labelFg = pickContrastingText(routeColor);
    for (const m of markers) {
      const html = vehicleHtml(view.route.shortName, routeColor, labelFg, m.selected, m.opacity);
      const icon = L.divIcon({
        className: 'neary-vehicle',
        html,
        iconSize: [44, 28],
        iconAnchor: [22, 14],
      });
      const marker = L.marker([m.lat, m.lon], { icon });
      marker.bindPopup(`<strong>${escapeHtml(view.route.shortName)}</strong>${
        m.headsign ? ` → ${escapeHtml(m.headsign)}` : ''
      }`, { closeButton: false });
      marker.addTo(vehiclesLayer);
    }
  });

  // User position layer.
  $effect(() => {
    if (!L || !mapInstance) return;
    const pos = locationStore.position;
    if (!pos) {
      userMarker?.remove();
      userMarker = null;
      return;
    }
    if (!userMarker) {
      userMarker = L.circleMarker([pos.lat, pos.lon], {
        radius: 7,
        color: '#fff',
        weight: 2,
        fillColor: '#1d4ed8',
        fillOpacity: 1,
      }).addTo(mapInstance);
    } else {
      userMarker.setLatLng([pos.lat, pos.lon]);
    }
  });

  // ── Inline HTML helpers (kept here, not exported, since they are
  // purely the Leaflet `divIcon` payload). ──────────────────────────
  function vehicleHtml(
    shortName: string,
    bg: string,
    fg: string,
    selected: boolean,
    opacity: number,
  ): string {
    const ring = selected
      ? 'box-shadow:0 0 0 3px #fff, 0 0 0 5px #111;'
      : 'box-shadow:0 0 0 2px #fff;';
    return `<div style="
      display:inline-flex;align-items:center;justify-content:center;
      min-width:32px;height:22px;padding:0 6px;border-radius:6px;
      background:${bg};color:${fg};font:600 12px/1 ui-sans-serif,system-ui;
      opacity:${opacity};${ring}
    ">${escapeHtml(shortName)}</div>`;
  }
  function stopPopupHtml(stopId: number, name: string, arrivalMin: number): string {
    return `<div style="font:13px/1.3 ui-sans-serif,system-ui;min-width:160px;">
      <div style="font-weight:600;margin-bottom:2px;">${escapeHtml(name)}</div>
      <div style="color:#666;margin-bottom:6px;">First-trip arrival ${formatHHMM(arrivalMin)}</div>
      <a href="/station/${stopId}" style="
        display:inline-block;padding:4px 8px;border-radius:4px;
        background:#1d4ed8;color:#fff;text-decoration:none;font-weight:500;">
        Open station →
      </a>
    </div>`;
  }
  function escapeHtml(s: string): string {
    return s
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
</script>

<div class="mx-auto max-w-5xl px-4 py-6">
  {#if userPrefs.feedId == null}
    <NoFeedState message="Pick a feed in Settings to view the route map." />
  {:else if direction == null}
    <Card><CardContent>
      <Typography variant="h6" class="text-[color:var(--color-danger)]">Map view needs a direction</Typography>
      <Typography variant="caption">URL must end in <code>_0</code> or <code>_1</code>.</Typography>
    </CardContent></Card>
  {:else if error}
    <Card><CardContent>
      <Stack spacing={1}>
        <Typography variant="h6" class="text-[color:var(--color-danger)]">Failed to load map</Typography>
        <Typography variant="caption">{error}</Typography>
      </Stack>
    </CardContent></Card>
  {:else if view == null}
    <Card><CardContent>
      <Stack direction="row" spacing={1} align="center">
        <Spinner size={16} />
        <Typography variant="caption">Loading map…</Typography>
      </Stack>
    </CardContent></Card>
  {:else}
    <Stack spacing={2}>
      <!-- Header: same chrome the schedule view uses, with a swap-
           direction icon. -->
      <Card>
        <CardContent>
          <Stack direction="row" spacing={1.5} align="center" wrap>
            <RouteBadge route={view.route} size="large" isFavorite={isFav} />
            <Stack spacing={0.25} class="flex-1 min-w-0">
              <Stack direction="row" spacing={1} align="center" wrap>
                <Typography variant="h5" class="truncate">{headerTitle}</Typography>
                {#if nightRoute}
                  <Chip size="small" variant="outlined">
                    {#snippet icon()}<Moon size={12} />{/snippet}
                    Night
                  </Chip>
                {/if}
              </Stack>
              {#if headerSubtitle}
                <Typography variant="caption" class="text-[color:var(--color-fg-muted)] truncate">
                  {headerSubtitle}
                </Typography>
              {/if}
            </Stack>
            <IconButton aria-label="Swap direction" onclick={swapDirection}>
              <ArrowRightLeft size={18} />
            </IconButton>
          </Stack>
        </CardContent>
      </Card>

      <Card>
        <CardContent class="p-0">
          <div bind:this={mapEl} class="neary-map"></div>
        </CardContent>
      </Card>
    </Stack>
  {/if}
</div>

<style>
  .neary-map {
    width: 100%;
    height: 70vh;
    min-height: 360px;
    border-radius: var(--radius-md, 12px);
    overflow: hidden;
  }
  /* Leaflet's own popup container inherits a default white bg; ours
     reads better with rounded corners + a touch of shadow. */
  :global(.leaflet-popup-content-wrapper) {
    border-radius: 8px;
  }
</style>
