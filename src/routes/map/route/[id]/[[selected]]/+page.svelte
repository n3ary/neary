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
  import { parseRouteIdWithDirection } from '$lib/data/gtfs/parseRouteIdWithDirection';
  import type { RouteMapView } from '$lib/data/gtfs/types';
  import {
    formatHHMM, formatRelativeMin, isNightRoute, pickContrastingText, vehicleTypeLabel,
    type Route,
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
  // Same `[id]_[dir]` convention the schedule view uses — parser
  // shared via lib/data/gtfs/parseRouteIdWithDirection.
  const idSegment = $derived(page.params.id ?? '');
  const parsed = $derived(parseRouteIdWithDirection(idSegment));
  const routeId = $derived(parsed.routeId);
  const direction = $derived(parsed.direction);
  const selectedTripId = $derived(page.params.selected ?? null);

  // Remember the original direction + trip so that swapping twice restores
  // the highlight. Captured once on first arrival; swapping to the other
  // direction and back re-selects the trip the user navigated here with.
  let homeDirection = $state<0 | 1 | null>(null);
  let homeSelectedTripId = $state<string | null>(null);
  $effect(() => {
    const dir = direction;
    const sel = selectedTripId;
    if (dir != null && homeDirection === null) {
      homeDirection = dir;
      homeSelectedTripId = sel;
    }
  });

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

  // Routes per stop — fetched once when the view payload arrives so
  // the stop popup can show route badges without a per-click async call.
  let stopRoutes = $state<Map<number, Route[]>>(new Map());
  $effect(() => {
    const stops = view?.stops;
    if (!stops || stops.length === 0) return;
    const repo = getGtfsRepo();
    void (async () => {
      const entries = await Promise.all(
        stops.map(async (s) => [s.stopId, await repo.getRoutesForStop(s.stopId)] as const),
      );
      stopRoutes = new Map(entries);
    })();
  });

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
   *  status → opacity / style.
   *
   *  `scheduled` = vehicle is at origin waiting to depart ('at-origin')
   *  or not yet close enough to be imminent ('before', next trip only).
   *  Scheduled vehicles show with an outlined badge so the user knows
   *  position is a schedule estimate, not a live/interpolated position. */
  type VehicleMarker = {
    tripId: string;
    headsign: string | null;
    lat: number;
    lon: number;
    opacity: number;
    selected: boolean;
    tripStartMin: number;
    /** True for 'before' (next only) and 'at-origin' — no movement prediction. */
    scheduled: boolean;
    /** Phase 5+: set when the vehicle has a live GPS match. null = schedule-estimated. */
    gpsConfidence: 'good' | 'poor' | null;
  };
  const markers = $derived.by<VehicleMarker[]>(() => {
    if (!view) return [];
    const out: VehicleMarker[] = [];
    let nextScheduledShown = false;
    // Sort by tripStartMin so the soonest not-yet-departed trip always wins
    // the single origin slot, regardless of query order from the DB.
    const trips = [...view.trips].sort((a, b) => a.tripStartMin - b.tripStartMin);
    for (const t of trips) {
      const plan = tripPlans.get(t.tripId);
      const p = plan
        ? predictPositionOnShape(plan, nowMin)
        : predictPosition(t.stops, nowMin);
      if (!p) continue;
      // Past terminus — drop entirely.
      if (p.status === 'after') continue;
      // 'before' and 'at-origin' are both "not yet departed from origin":
      // show only the soonest one so bubbles don't stack at the origin stop.
      // (Sorting above ensures the soonest tripStartMin is encountered first.)
      if (p.status === 'before' || p.status === 'at-origin') {
        if (nextScheduledShown) continue;
        nextScheduledShown = true;
      }
      out.push({
        tripId: t.tripId,
        headsign: t.headsign,
        lat: p.lat,
        lon: p.lon,
        opacity: 0.9,
        selected: t.tripId === selectedTripId,
        tripStartMin: t.tripStartMin,
        scheduled: p.status === 'before' || p.status === 'at-origin',
        gpsConfidence: null,
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
    // When swapping back to the original direction, restore the trip the user
    // arrived with so the highlight isn't lost after a double-swap.
    const restoreTrip = otherDir === homeDirection ? homeSelectedTripId : null;
    const target = restoreTrip
      ? `/map/route/${routeId}_${otherDir}/${restoreTrip}`
      : `/map/route/${routeId}_${otherDir}`;
    goto(target, { replaceState: true });
  }

  // Map control wrappers — thin closures over Leaflet's imperative
  // API. Rendered as a styled IconButton overlay in the top-right of
  // the map card (see markup below), not as Leaflet's native
  // `leaflet-bar` controls (those don't match the app's chrome).
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
  let userMarker: import('leaflet').Marker | null = null;
  let hasFitOnce = false;
  let resizeObserver: ResizeObserver | null = null;

  onMount(async () => {
    try {
      const mod = (await import('leaflet')) as unknown as { default?: LeafletNS };
      L = (mod.default ?? (mod as unknown as LeafletNS));
      await import('leaflet/dist/leaflet.css');
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

    const doInit = () => {
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
        // Vehicles pane sits above markerPane (600) so vehicle badges
        // always paint over stop circles, but below tooltipPane (650).
        const vehiclesPane = mapInstance.createPane('nearyVehicles');
        vehiclesPane.style.zIndex = '620';
        // Future-resize listener (rotation, splitscreen, sidebar).
        if (typeof ResizeObserver !== 'undefined') {
          resizeObserver = new ResizeObserver(() => mapInstance?.invalidateSize());
          resizeObserver.observe(el);
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[map] init failed', e);
        error = e instanceof Error ? e.message : String(e);
      }
    };

    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      doInit();
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
      doInit();
    });
    gate.observe(el);
  });

  onDestroy(() => {
    resizeObserver?.disconnect();
    resizeObserver = null;
    mapInstance?.remove();
    mapInstance = null;
  });

  // Re-paint the route shape + stops whenever the view-model or stop
  // routes change. Leaflet layers are mutated in place; markers are
  // recreated cheaply (a route has O(50) stops, an order of magnitude
  // less than what Leaflet handles fluidly).
  $effect(() => {
    // Capture reactive state into local const so TypeScript narrowing
    // holds inside forEach callbacks (rune getters don't narrow).
    const Lref = L;
    const currentView = view;
    const currentRoutes = stopRoutes;
    if (!Lref || !mapInstance || !currentView) return;
    if (shapeLayer) {
      shapeLayer.remove();
      shapeLayer = null;
    }
    if (currentView.shape.length >= 2) {
      const latlngs = currentView.shape.map((p) => [p.lat, p.lon] as [number, number]);
      shapeLayer = Lref.polyline(latlngs, {
        color: currentView.route.color,
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
    const sl = stopsLayer;
    if (sl) {
      const lastIdx = currentView.stops.length - 1;
      currentView.stops.forEach((s, i) => {
        // Origin gets a play-triangle disc, terminus a square cap
        // — same convention RouteBadge uses for isStart/isEnd, so a
        // user who's seen the badge already reads these icons at a
        // glance. Middle stops stay as the small circleMarker so
        // the endpoint hierarchy is unmistakable.
        const isOrigin = i === 0;
        const isTerminus = i === lastIdx;
        const m = (isOrigin || isTerminus)
          ? Lref.marker([s.lat, s.lon], {
              icon: Lref.divIcon({
                className: isOrigin ? 'neary-origin' : 'neary-terminus',
                html: isOrigin
                  ? endpointHtml(currentView.route.color, 'origin')
                  : endpointHtml(currentView.route.color, 'terminus'),
                iconSize: isOrigin ? [18, 18] : [16, 16],
                iconAnchor: isOrigin ? [9, 9] : [8, 8],
              }),
              keyboard: false,
              riseOnHover: true,
            })
          : Lref.circleMarker([s.lat, s.lon], {
              radius: 5,
              color: '#fff',
              weight: 1.5,
              fillColor: currentView.route.color,
              fillOpacity: 1,
            });
        m.bindPopup(stopPopupHtml(s.stopId, s.stopName, currentRoutes.get(s.stopId) ?? []), {
          closeButton: false,
        });
        m.addTo(sl);
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
    const Lref = L;
    const dir = direction;
    const rid = routeId;
    if (dir == null) return;
    vehiclesLayer.clearLayers();
    const routeColor = view.route.color;
    const labelFg = pickContrastingText(routeColor);
    const nowMinSnap = nowMin;
    for (const m of markers) {
      const html = vehicleHtml(view.route.shortName, routeColor, labelFg, m.selected, m.opacity, m.scheduled, m.gpsConfidence);
      const icon = Lref.divIcon({
        className: 'neary-vehicle',
        html,
        iconSize: [44, 28],
        iconAnchor: [22, 14],
      });
      // pane: 'nearyVehicles' (z=620) keeps vehicles above stop markers
      // (markerPane z=600) so they're never hidden behind station icons.
      const marker = Lref.marker([m.lat, m.lon], { icon, pane: 'nearyVehicles' });
      // offset: [0, -16] anchors the popup tail just above the badge
      // top edge so it floats above the vehicle rather than covering it.
      marker.bindPopup(vehiclePopupHtml(m, rid, dir, nowMinSnap), {
        closeButton: false,
        offset: Lref.point(0, -16),
      });
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
      userMarker = L.marker(latlng, {
        icon: L.divIcon({
          className: '',
          html: '<div class="neary-user-dot"></div>',
          iconSize: [14, 14],
          iconAnchor: [7, 7],
        }),
        interactive: false,
        zIndexOffset: -200,
      }).addTo(mapInstance);
    } else {
      userMarker.setLatLng(latlng);
    }
  });

  // ── Inline HTML helpers (kept here, not exported, since they are
  // purely the Leaflet `divIcon` payload). ──────────────────────────
  function vehiclePopupHtml(m: VehicleMarker, rId: string, dir: 0 | 1, nowMinVal: number): string {
    // Source icons.
    const calSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;flex-shrink:0;"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;
    const gpsSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;flex-shrink:0;"><circle cx="12" cy="12" r="3"/><path d="M12 2v4"/><path d="M12 18v4"/><path d="M2 12h4"/><path d="M18 12h4"/></svg>`;
    const clockSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;flex-shrink:0;"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
    const schedSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;flex-shrink:0;"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><circle cx="8" cy="14" r="1" fill="currentColor"/><circle cx="12" cy="14" r="1" fill="currentColor"/><circle cx="16" cy="14" r="1" fill="currentColor"/><circle cx="8" cy="18" r="1" fill="currentColor"/><circle cx="12" cy="18" r="1" fill="currentColor"/></svg>`;
    // Headsign + schedule button on the same row.
    const headsignText = m.headsign
      ? `<span style="font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(m.headsign)}</span>`
      : `<span style="flex:1;"></span>`;
    const topRow = `<div style="display:flex;align-items:center;gap:6px;margin-bottom:5px;">${headsignText}<a href="/schedule/route/${escapeHtml(rId)}_${dir}" title="View schedule" style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:4px;background:rgba(0,0,0,0.07);color:#555;text-decoration:none;flex-shrink:0;">${schedSvg}</a></div>`;
    // Info row: scheduled → green clock + countdown (outlined badge already signals waiting,
    //           no need for "est." label); GPS → coloured gps label; otherwise → est.
    let infoHtml: string;
    if (m.scheduled) {
      const minsUntil = m.tripStartMin - nowMinVal;
      const relLabel = minsUntil <= 0 ? 'now' : formatRelativeMin(minsUntil, m.tripStartMin);
      infoHtml = `<span style="display:flex;align-items:center;gap:2px;color:#16a34a;font-size:11px;">${clockSvg}<span style="margin-left:2px;">${relLabel}</span></span>`;
    } else if (m.gpsConfidence) {
      const c = m.gpsConfidence === 'good' ? '#16a34a' : '#ca8a04';
      infoHtml = `<span style="display:flex;align-items:center;gap:2px;color:${c};font-size:11px;opacity:0.85;">${gpsSvg}<span>gps</span></span>`;
    } else {
      infoHtml = `<span style="display:flex;align-items:center;gap:2px;color:#888;font-size:11px;opacity:0.85;">${calSvg}<span>est.</span></span>`;
    }
    return `<div style="font:13px/1.3 ui-sans-serif,system-ui;min-width:150px;">${topRow}${infoHtml}</div>`;
  }
  function vehicleHtml(
    shortName: string,
    bg: string,
    fg: string,
    selected: boolean,
    opacity: number,
    scheduled: boolean,
    gpsConfidence: 'good' | 'poor' | null,
  ): string {
    const ring = selected
      ? 'box-shadow:0 0 0 3px #fff, 0 0 0 5px #111;'
      : gpsConfidence === 'good'  ? 'box-shadow:0 0 0 2.5px #22c55e;'
      : gpsConfidence === 'poor'  ? 'box-shadow:0 0 0 2.5px #eab308;'
      :                             'box-shadow:0 0 0 2px #fff;';
    // Scheduled vehicles (at-origin / next 'before'): outlined badge so
    // the user can distinguish "waiting to depart" from "en route".
    const colors = scheduled
      ? `background:rgba(255,255,255,0.92);color:${bg};border:1.5px solid ${bg};`
      : `background:${bg};color:${fg};`;
    return `<div style="
      display:inline-flex;align-items:center;justify-content:center;
      min-width:32px;height:22px;padding:0 6px;border-radius:6px;
      ${colors}font:600 12px/1 ui-sans-serif,system-ui;
      opacity:${opacity};${ring}
    ">${escapeHtml(shortName)}</div>`;
  }
  function routeBadgeHtml(r: Route): string {
    const fg = pickContrastingText(r.color);
    return `<span style="
      display:inline-flex;align-items:center;justify-content:center;
      padding:1px 5px;border-radius:4px;
      background:${r.color};color:${fg};
      font:600 10px/1.4 ui-sans-serif,system-ui;white-space:nowrap;
    ">${escapeHtml(r.shortName)}</span>`;
  }
  function stopPopupHtml(stopId: number, name: string, routes: Route[]): string {
    const externalLinkSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" style="display:block;flex-shrink:0;"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>`;
    const badgesHtml = routes.length > 0
      ? `<div style="display:flex;flex-wrap:wrap;gap:3px;margin-top:5px;">${routes.map(routeBadgeHtml).join('')}</div>`
      : '';
    return `<div style="font:13px/1.3 ui-sans-serif,system-ui;min-width:160px;">
      <div style="display:flex;align-items:center;gap:5px;">
        <span style="font-weight:600;flex:1;min-width:0;">${escapeHtml(name)}</span>
        <a href="/station/${stopId}" title="Open station" aria-label="Open station ${escapeHtml(name)}" style="
          display:inline-flex;align-items:center;justify-content:center;
          color:#555;text-decoration:none;flex-shrink:0;">
          ${externalLinkSvg}
        </a>
      </div>${badgesHtml}
    </div>`;
  }
  /** Origin / terminus marker glyph. Origin shows a white play
   *  triangle (▶) — the same convention RouteBadge encodes as
   *  isStart, instantly readable as 'departures begin here'.
   *  Terminus shows a white square (■) — RouteBadge's isEnd cap. */
  function endpointHtml(routeColor: string, kind: 'origin' | 'terminus'): string {
    const fg = pickContrastingText(routeColor);
    // Origin: 18×18 — play-styled, stands out but leaves room for the
    // scheduled vehicle badge that usually sits on top of it.
    // Terminus: 16×16 — slightly special (square glyph) but smaller so
    // the hierarchy origin > terminus > regular stop is clear.
    const size = kind === 'origin' ? 18 : 16;
    const glyph = kind === 'origin'
      ? `<svg width="8" height="8" viewBox="0 0 24 24" fill="${fg}" style="margin-left:1px;"><polygon points="6 4 20 12 6 20"/></svg>`
      : `<svg width="8" height="8" viewBox="0 0 24 24" fill="${fg}"><rect x="4" y="4" width="16" height="16" rx="1.5"/></svg>`;
    return `<div style="
      width:${size}px;height:${size}px;border-radius:50%;
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
            <Stack spacing={0.5} class="flex-1 min-w-0">
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
              {#if otherDirection.value !== false}
                <IconButton
                  aria-label="Swap direction"
                  onclick={swapDirection}
                >
                  <ArrowRightLeft size={18} />
                </IconButton>
              {/if}
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
        <!-- Viewport controls overlaid on the map, top-right.
             Same IconButton styling the rest of the app uses, with a
             surface background + shadow so they read against any
             map tile. Sits above Leaflet's panes via z-index. -->
        <div class="neary-map-controls">
          <IconButton
            size="small"
            aria-label="Zoom in"
            class="bg-[color:var(--color-surface)] text-[color:var(--color-fg)] border border-[color:var(--color-border)] shadow-lg hover:bg-[color:var(--color-border)]/60"
            onclick={zoomIn}
          >
            <Plus size={16} />
          </IconButton>
          <IconButton
            size="small"
            aria-label="Zoom out"
            class="bg-[color:var(--color-surface)] text-[color:var(--color-fg)] border border-[color:var(--color-border)] shadow-lg hover:bg-[color:var(--color-border)]/60"
            onclick={zoomOut}
          >
            <Minus size={16} />
          </IconButton>
          <IconButton
            size="small"
            aria-label="Fit route to view"
            class="bg-[color:var(--color-surface)] text-[color:var(--color-fg)] border border-[color:var(--color-border)] shadow-lg hover:bg-[color:var(--color-border)]/60"
            onclick={fitToRoute}
          >
            <Maximize2 size={16} />
          </IconButton>
        </div>
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
    position: relative;
  }
  .neary-map {
    width: 100%;
    height: 100%;
  }
  /* Floating viewport controls in the top-right corner. Above the
     Leaflet panes (which top out at ~700 for popups) so the buttons
     are always clickable; rounded shadow matches the app's surface
     chrome. */
  .neary-map-controls {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    z-index: 1000;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
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
  /* User-position dot: blue circle with a gentle breathing pulse so it
     reads as "live location" without being distracting. 2 s cycle
     (not too fast / not too slow). Uses transform so the animation
     stays composited and doesn't repaint the map layer below it. */
  :global(.neary-user-dot) {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #1d4ed8;
    border: 2.5px solid #fff;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
    animation: neary-user-pulse 2s ease-in-out infinite;
  }
  @keyframes neary-user-pulse {
    0%, 100% { transform: scale(1); opacity: 1; }
    50% { transform: scale(1.35); opacity: 0.65; }
  }
</style>
