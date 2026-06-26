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
  import { ArrowRightLeft, Maximize2, Minus, Moon, Plus } from 'lucide-svelte';
  import {
    BackButton, Card, CardContent, Chip, IconButton, NoFeedState, RouteBadge, Spinner,
    Stack, Typography,
  } from '$lib/ui';
  import { getGtfsRepo } from '$lib/data/gtfs/repo';
  import { useOtherDirectionExists } from '$lib/data/gtfs/otherDirectionExists.svelte';
  import type { RouteMapView } from '$lib/data/gtfs/types';
  import {
    formatHHMM, isNightRoute, pickContrastingText, vehicleTypeLabel,
  } from '$lib/domain/types';
  import { minSinceMidnightInTz } from '$lib/domain/pipeline/timeUtils';
  import {
    buildTripShapePlan, predictPosition, predictPositionOnShape,
    type TripShapePlan,
  } from '$lib/domain/predictPosition';
  import {
    measurePolyline, pointAtDistance,
    type MeasuredPolyline,
  } from '$lib/domain/shapeProjection';
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

  // Measured route polyline (cumulative distances) for the direction
  // arrows. One pass per page mount; the arrow positions / bearings
  // below all read from it.
  const measuredShape = $derived.by<MeasuredPolyline | null>(() => {
    if (!view || view.shape.length < 2) return null;
    return measurePolyline(view.shape);
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

  /** Active stop-to-stop segments per vehicle: the leg between the
   *  stop a vehicle just passed and the one it's heading to next.
   *  The traveling-dots animation rides these segments so the flow
   *  hints at where each vehicle is currently going \u2014 instead of an
   *  ambient pulse along the whole route that's unrelated to live
   *  positions. Only shape-aware (planned) trips contribute; the
   *  no-shape fallback skips the trail since we can't translate
   *  stops to polyline distances without a projection. */
  type VehicleTrail = { fromDistM: number; toDistM: number };
  const vehicleTrails = $derived.by<VehicleTrail[]>(() => {
    if (!view || !measuredShape) return [];
    void nowMin; // declare dependency so trails refresh per tick
    const trails: VehicleTrail[] = [];
    for (const t of view.trips) {
      const plan = tripPlans.get(t.tripId);
      if (!plan) continue;
      const { legs } = plan;
      if (legs.length < 2) continue;
      // Skip not-yet-started and finished trips \u2014 no active leg.
      if (nowMin < legs[0].arrivalMin) continue;
      if (nowMin >= legs[legs.length - 1].arrivalMin) continue;
      for (let i = 0; i < legs.length - 1; i++) {
        if (nowMin >= legs[i].arrivalMin && nowMin <= legs[i + 1].arrivalMin) {
          const fromDistM = legs[i].distAlongM;
          const toDistM = legs[i + 1].distAlongM;
          // Drop segments that are degenerate on the shape (out-and-
          // back projections or near-coincident stops) \u2014 a dot
          // hovering in place reads as a glitch.
          if (Math.abs(toDistM - fromDistM) >= 20) {
            trails.push({ fromDistM, toDistM });
          }
          break;
        }
      }
    }
    return trails;
  });

  // ── Title / subtitle ───────────────────────────────────────────────
  // Mirrors the schedule view: title is the origin station name
  // (i.e. 'departures from here'), subtitle is the headsign —
  // operator-published when available, falling back to the
  // terminus stop name. The route badge on the left already
  // carries route identity; repeating 'Bus 40' as the title was
  // redundant.
  const originStopName = $derived(view?.stops[0]?.stopName ?? null);
  const terminusStopName = $derived(
    view ? view.stops[view.stops.length - 1]?.stopName ?? null : null,
  );
  const headsign = $derived(view?.trips[0]?.headsign ?? terminusStopName);
  const headerTitle = $derived(
    originStopName
    ?? (route ? `${vehicleTypeLabel(route.type ?? 'unknown')} ${route.shortName}` : ''),
  );
  const headerSubtitle = $derived(headsign ? `→ ${headsign}` : null);

  // ── Navigation helpers ─────────────────────────────────────────────
  // Does the opposite direction even exist on this route? Some Cluj
  // lines are one-way loops (no dir 1 trips at all) so the swap
  // button should grey out instead of taking the user to an empty
  // map. Shared probe with the schedule view — see
  // lib/data/gtfs/otherDirectionExists.svelte.ts.
  const otherDirection = useOtherDirectionExists(
    () => routeId,
    () => direction,
  );

  function swapDirection() {
    if (direction == null) return;
    const otherDir = direction === 0 ? 1 : 0;
    // Selected vehicle isn't on the other direction — drop it.
    // replaceState so BackButton skips the swap and returns to the
    // surface the user came from (see BackButton.svelte).
    goto(`/map/route/${routeId}_${otherDir}`, { replaceState: true });
  }

  // Header zoom controls. Thin wrappers over Leaflet's imperative
  // API — disabled until the map is mounted so the buttons don't
  // throw before init.
  const mapReady = $derived(mapInstance != null);
  function zoomIn() { mapInstance?.zoomIn(); }
  function zoomOut() { mapInstance?.zoomOut(); }
  function fitToRoute() {
    if (!mapInstance || !shapeLayer) return;
    mapInstance.fitBounds(shapeLayer.getBounds(), {
      padding: [12, 12],
      maxZoom: 15,
    });
  }

  // ── Leaflet ────────────────────────────────────────────────────────
  // Leaflet is browser-only; init in onMount. The instance + per-layer
  // refs are non-reactive state held outside Svelte runes so we can
  // mutate them imperatively (Leaflet's API is fully imperative).
  let mapEl: HTMLDivElement | undefined = $state();
  type LeafletNS = typeof import('leaflet');
  // L MUST be $state — onMount assigns it asynchronously after the
  // dynamic import resolves; without reactivity the init $effect
  // below would never know L changed from null to the module and
  // would stay stuck on its early-return.
  let L = $state<LeafletNS | null>(null);
  // mapInstance is $state so the shape / stops / vehicles render
  // effects below re-run once the deferred init (gated by a
  // ResizeObserver waiting for non-zero container size) finally
  // assigns it. Layer refs stay plain since they're only ever
  // touched from effects that already track mapInstance + view.
  let mapInstance = $state<import('leaflet').Map | null>(null);
  let shapeLayer: import('leaflet').Polyline | null = null;
  let stopsLayer: import('leaflet').LayerGroup | null = null;
  let arrowsLayer: import('leaflet').LayerGroup | null = null;
  let vehiclesLayer: import('leaflet').LayerGroup | null = null;
  let userMarker: import('leaflet').CircleMarker | null = null;
  let hasFitOnce = false;
  let resizeObserver: ResizeObserver | null = null;

  onMount(async () => {
    try {
      const mod = (await import('leaflet')) as unknown as { default?: LeafletNS };
      L = (mod.default ?? (mod as unknown as LeafletNS));
      await import('leaflet/dist/leaflet.css');
      // eslint-disable-next-line no-console
      console.debug('[map] leaflet module ready', typeof L?.map);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[map] leaflet import failed', e);
      error = e instanceof Error ? e.message : String(e);
    }
  });

  // Lazy init the Leaflet instance the first time the container has
  // non-zero size. We can't just init when mapEl + L + view are all
  // present — the Card's flex height is 0 for one frame after it
  // mounts, and Leaflet caches that 0-size on init. Instead, gate
  // on a ResizeObserver tick that reports a real width × height,
  // then disconnect that gate and start observing for future
  // resizes so the map re-tiles when the viewport changes.
  $effect(() => {
    if (!L || mapInstance || !mapEl || view == null) return;
    const el = mapEl;
    const Lref = L;

    const doInit = (w: number, h: number) => {
      // eslint-disable-next-line no-console
      console.debug('[map] init container', w, 'x', h);
      try {
        mapInstance = Lref.map(el, {
          zoomControl: false,
          attributionControl: true,
          center: [46.77, 23.6],
          zoom: 13,
        });
        (window as unknown as { __nearyMap?: import('leaflet').Map }).__nearyMap = mapInstance;
        Lref.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '© OpenStreetMap contributors',
        }).addTo(mapInstance);
        stopsLayer = Lref.layerGroup().addTo(mapInstance);
        arrowsLayer = Lref.layerGroup().addTo(mapInstance);
        vehiclesLayer = Lref.layerGroup().addTo(mapInstance);
        // Dedicated pane for the traveling-dots flow animation,
        // sitting above overlayPane (400) so the dots paint over
        // the route polyline + stop circles, but below markerPane
        // (600) so vehicle badges stay on top. Without this the
        // dots are drawn underneath the 5px route line and read as
        // invisible. pointerEvents:none keeps them from stealing
        // hover / click from the markers below.
        const dotsPane = mapInstance.createPane('nearyDots');
        dotsPane.style.zIndex = '450';
        dotsPane.style.pointerEvents = 'none';
        // Future-resize listener (rotation, splitscreen, sidebar).
        if (typeof ResizeObserver !== 'undefined') {
          resizeObserver = new ResizeObserver(() => mapInstance?.invalidateSize());
          resizeObserver.observe(el);
        }
        // eslint-disable-next-line no-console
        console.debug('[map] init done; children', el.children.length);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[map] init failed', e);
        error = e instanceof Error ? e.message : String(e);
      }
    };

    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      doInit(rect.width, rect.height);
      return;
    }

    // Container has 0 size right now — wait for the layout to give
    // it real dimensions before initialising. ResizeObserver fires
    // immediately on observe() and again on every size change, so
    // the first non-zero entry triggers init and we disconnect.
    if (typeof ResizeObserver === 'undefined') return;
    const gate = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r || r.width <= 0 || r.height <= 0) return;
      gate.disconnect();
      doInit(r.width, r.height);
    });
    gate.observe(el);
  });

  onDestroy(() => {
    resizeObserver?.disconnect();
    resizeObserver = null;
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
        // Borrowed v1's tighter framing: small fixed padding so the
        // route fills the viewport, capped at zoom 15 so a short
        // route doesn't slam in past the point where street labels
        // start to fight each other.
        mapInstance.fitBounds(shapeLayer.getBounds(), {
          padding: [12, 12],
          maxZoom: 15,
        });
        hasFitOnce = true;
      }
    }
    stopsLayer?.clearLayers();
    if (stopsLayer) {
      const lastIdx = view.stops.length - 1;
      view.stops.forEach((s, i) => {
        // Origin gets a play-triangle disc, terminus a square cap
        // — same convention RouteBadge uses for isStart/isEnd, so a
        // user who's seen the badge already reads these icons at a
        // glance. Middle stops stay as the small circleMarker so
        // the endpoint hierarchy is unmistakable.
        const isOrigin = i === 0;
        const isTerminus = i === lastIdx;
        const m = (isOrigin || isTerminus)
          ? L.marker([s.lat, s.lon], {
              icon: L.divIcon({
                className: isOrigin ? 'neary-origin' : 'neary-terminus',
                html: isOrigin
                  ? endpointHtml(view.route.color, 'origin')
                  : endpointHtml(view.route.color, 'terminus'),
                iconSize: [22, 22],
                iconAnchor: [11, 11],
              }),
              keyboard: false,
              riseOnHover: true,
            })
          : L.circleMarker([s.lat, s.lon], {
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
      });
    }
  });

  // Traveling dots, scoped per-vehicle: each active stop-to-stop
  // segment gets one dot that slides from the previous station to
  // the next, fades in / out across the cycle, then loops. So the
  // dots actually mean something live — they trace where buses are
  // moving right now — instead of a generic ambient pulse along
  // the full route. Quiet by design: 1 dot per vehicle, small,
  // peak opacity ~0.4. Cleanup cancels the RAF and clears the
  // layer; the effect re-runs whenever vehicleTrails changes
  // (i.e. when a vehicle advances to the next stop).
  const DOTS_PER_TRAIL = 3;
  const DOT_CYCLE_MS = 3000;
  const DOT_PEAK_OPACITY = 0.45;
  $effect(() => {
    if (!L || !mapInstance || !arrowsLayer) return;
    arrowsLayer.clearLayers();
    if (!measuredShape || vehicleTrails.length === 0) return;
    const Lref = L;
    const layer = arrowsLayer;
    const measured = measuredShape;
    const trails = vehicleTrails;
    const renderer = Lref.svg({ pane: 'nearyDots' });
    type Dot = {
      marker: import('leaflet').CircleMarker;
      fromDistM: number;
      toDistM: number;
      phaseOffset: number;
    };
    const dots: Dot[] = [];
    for (const trail of trails) {
      for (let i = 0; i < DOTS_PER_TRAIL; i++) {
        const marker = Lref.circleMarker(
          [measured.points[0].lat, measured.points[0].lon],
          {
            renderer,
            radius: 2.5,
            stroke: false,
            fillColor: '#fff',
            fillOpacity: 0,
            interactive: false,
          },
        ).addTo(layer);
        dots.push({
          marker,
          fromDistM: trail.fromDistM,
          toDistM: trail.toDistM,
          phaseOffset: i / DOTS_PER_TRAIL,
        });
      }
    }
    const start = performance.now();
    let rafId = 0;
    const tick = (t: number) => {
      const elapsed = (t - start) / DOT_CYCLE_MS;
      for (const d of dots) {
        const p = (elapsed + d.phaseOffset) % 1;
        const dist = d.fromDistM + p * (d.toDistM - d.fromDistM);
        const opacity = Math.sin(p * Math.PI) * DOT_PEAK_OPACITY;
        const pt = pointAtDistance(measured, dist);
        d.marker.setLatLng([pt.lat, pt.lon]);
        d.marker.setStyle({ fillOpacity: opacity });
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
      layer.clearLayers();
    };
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
      // Popup only needs the headsign — the route number is already
      // painted on the badge. `offset: [0, -16]` anchors the popup
      // tail just above the top edge of the 28 px badge instead of
      // its center, so the popup floats above the vehicle rather
      // than half-covering it.
      if (m.headsign) {
        marker.bindPopup(escapeHtml(m.headsign), {
          closeButton: false,
          offset: L.point(0, -16),
        });
      }
      marker.addTo(vehiclesLayer);
    }
  });

  // User position layer. `locationStore.position` is a native
  // `GeolocationPosition`, so coords come from `.coords.latitude` /
  // `.coords.longitude` — NOT the LatLon shape we use everywhere
  // else in the domain.
  $effect(() => {
    if (!L || !mapInstance) return;
    const pos = locationStore.position;
    const coords = pos?.coords;
    if (!coords || !Number.isFinite(coords.latitude) || !Number.isFinite(coords.longitude)) {
      userMarker?.remove();
      userMarker = null;
      return;
    }
    const latlng: [number, number] = [coords.latitude, coords.longitude];
    if (!userMarker) {
      userMarker = L.circleMarker(latlng, {
        radius: 7,
        color: '#fff',
        weight: 2,
        fillColor: '#1d4ed8',
        fillOpacity: 1,
      }).addTo(mapInstance);
    } else {
      userMarker.setLatLng(latlng);
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
  /** Origin / terminus marker glyph. Origin shows a white play
   *  triangle (▶) — the same convention RouteBadge encodes as
   *  isStart, instantly readable as 'departures begin here'.
   *  Terminus shows a white square (■) — RouteBadge's isEnd cap. */
  function endpointHtml(routeColor: string, kind: 'origin' | 'terminus'): string {
    const fg = pickContrastingText(routeColor);
    const glyph = kind === 'origin'
      ? `<svg width="9" height="9" viewBox="0 0 24 24" fill="${fg}" style="margin-left:1px;"><polygon points="6 4 20 12 6 20"/></svg>`
      : `<svg width="8" height="8" viewBox="0 0 24 24" fill="${fg}"><rect x="4" y="4" width="16" height="16" rx="1.5"/></svg>`;
    return `<div style="
      width:22px;height:22px;border-radius:50%;
      background:${routeColor};
      display:inline-flex;align-items:center;justify-content:center;
      box-shadow:0 0 0 2px #fff, 0 1px 3px rgba(0,0,0,0.3);
    ">${glyph}</div>`;
  }
  function escapeHtml(s: string): string {
    return s
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
</script>

<div class="mx-auto max-w-5xl px-4 py-3">
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
            <BackButton />
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
            <Stack direction="row" spacing={0.5} align="center" class="shrink-0">
              <IconButton aria-label="Zoom out" disabled={!mapReady} onclick={zoomOut}>
                <Minus size={18} />
              </IconButton>
              <IconButton aria-label="Zoom in" disabled={!mapReady} onclick={zoomIn}>
                <Plus size={18} />
              </IconButton>
              <IconButton aria-label="Fit route to view" disabled={!mapReady} onclick={fitToRoute}>
                <Maximize2 size={18} />
              </IconButton>
              <IconButton
                aria-label={otherDirection.value === false ? 'Reverse direction not available' : 'Swap direction'}
                disabled={otherDirection.value === false}
                onclick={swapDirection}
              >
                <ArrowRightLeft size={18} />
              </IconButton>
            </Stack>
          </Stack>
        </CardContent>
      </Card>

      <!-- The map card is the only thing on the page besides the
           header, so we just give it an explicit viewport-calc
           height. The 14rem accounts for the app header bar
           (~3.5rem), the in-page header Card + margin (~4rem),
           the page padding (~1.5rem), and the bottom navigation
           (~5rem) — i.e. everything between this card and the
           viewport edges. Single rule, no flex chain to debug. -->
      <Card class="overflow-hidden neary-map-card">
        <div bind:this={mapEl} class="neary-map"></div>
      </Card>
    </Stack>
  {/if}
</div>

<style>
  /* Map card height is computed once from the viewport and the
     fixed chrome offsets above/below. No flex-1 chain involved,
     so the container is never 0×0 at init and Leaflet measures
     a real box from the first call. The 18rem subtraction came
     from the user's measurement: viewport 932 px, intended map
     card 637 px → 295 px ≈ 18.4 rem reserved for app header,
     in-page header card + margin, page padding, and the fixed
     bottom navigation. */
  :global(.neary-map-card) {
    height: calc(100svh - 18rem);
  }
  .neary-map {
    width: 100%;
    height: 100%;
  }
  /* Floor for tiny viewports (e.g. landscape phone): the map gets
     a usable minimum even if the calc would otherwise hand it
     near-zero height. */
  @media (max-height: 480px) {
    :global(.neary-map-card) {
      height: 220px;
    }
  }
  /* Leaflet's own popup container inherits a default white bg; ours
     reads better with rounded corners + a touch of shadow. */
  :global(.leaflet-popup-content-wrapper) {
    border-radius: 8px;
  }
</style>
