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
  import { ArrowRightLeft, Bus, Calendar, Maximize2, Minus, Plus } from 'lucide-svelte';
  import {
    BackButton, Card, CardContent, Chip, IconButton, NoFeedState, RouteBadge, Spinner,
    Stack, Typography, networkIcon, networkTextColor,
  } from '$lib/ui';
  import { getGtfsRepo } from '$lib/data/gtfs/repo';
  import { useOtherDirectionExists } from '$lib/data/gtfs/otherDirectionExists.svelte';
  import { parseRouteIdWithDirection } from '$lib/data/gtfs/parseRouteIdWithDirection';
  import type { Network } from '$lib/domain/types';
  import type { RouteMapView } from '$lib/data/gtfs/types';
  import {
    formatHHMM, formatRelativeMin, pickContrastingText, vehicleTypeLabel,
    type Route,
    type Vehicle,
  } from '$lib/domain/types';
  import { dateKeyInTz, minSinceMidnightInTz } from '$lib/domain/pipeline/timeUtils';
  import {
    buildTripShapePlan, predictPosition, predictPositionOnShape, predictPositionFromGps,
    type TripShapePlan,
  } from '$lib/domain/predictPosition';
  import { predictArrivalFromGps } from '$lib/domain/predictArrivalAlongShape';
  import { measurePolyline, projectOnPolyline } from '$lib/domain/shapeProjection';
  import { clockToBucket } from '$lib/domain/timeOfDay';
  import { feedsStore } from '$lib/stores/feedsStore.svelte';
  import { feedConfigStore } from '$lib/stores/feedConfigStore.svelte';
  import { reconciledVehiclesStore } from '$lib/stores/reconciledVehiclesStore.svelte';
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
  // Origin stop the user came from when they tapped 'map' on a station-card
  // vehicle row. Painted in green on the route so the rider can recognise
  // 'this is the stop I was at'. Null when the URL has no `?from` param
  // (e.g. arriving via favorites, browser history, deep link). Parsed as
  // a number because Station.id is numeric in our schema.
  const fromStopId = $derived.by<number | null>(() => {
    const v = page.url.searchParams.get('from');
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  });

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
  let networkMap = $state<Map<string, Network>>(new Map());

  $effect(() => {
    const fid = feedsStore.boundFeedId;
    if (!fid) return;
    void getGtfsRepo().getNetworks().then((nets) => {
      networkMap = new Map(nets.map((n) => [n.id, n]));
    });
  });

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
        const nowMs = Date.now();
        const localDate = dateKeyInTz(nowMs, tz);
        view = await repo.getRouteMapView(
          rid, dir, localDate,
          minSinceMidnightInTz(nowMs, tz),
          LOOKBACK_MIN, LOOKAHEAD_MIN,
        );
        error = null;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    })();
  });

  const route = $derived(view?.route ?? null);

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

  // Live observations on (routeId, direction) whose trip didn't
  // surface in view.trips. Sourced from the worker's reconciliation
  // broadcast — these are the kind:'gps-only' rows: the worker matched
  // every scheduled trip it could via (route, dir, tripStartMin)
  // tolerance, and anything left over on this (route, dir) is a
  // genuine orphan. We render them at raw GPS (no shape projection
  // — we don't have stop_times for these tripIds, and the static
  // schedule doesn't have a matching trip we could ride a polyline
  // along). The bus is *there* now; the next poll updates it.
  const orphanVehicles = $derived.by(() => {
    if (!view) return [];
    return reconciledVehiclesStore.vehicles.filter(
      (v) =>
        v.kind === 'gps-only' &&
        v.route.id === routeId &&
        v.directionId === direction &&
        v.position != null,
    );
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
    /** Set when the vehicle has a live GPS match.
     *   - 'good':       fresh fix (< 3 min) — high trust.
     *   - 'stale':      3–5 min old — reduced trust (yellow border).
     *   - 'very-stale': 5–15 min old — low trust (red border).
     *   - null:         schedule-estimated. */
    gpsConfidence: 'good' | 'stale' | 'very-stale' | null;
    /** Reconciled vehicle kind, surfaced only for the debug-ids line
     *  rendered when `userPrefs.showDebugIds` is on. Same identity
     *  string appears on the station's VehicleCard so screenshots
     *  of the two views can be correlated. */
    kind: Vehicle['kind'];
    /** GTFS direction_id (0 / 1), or -1 when unknown. Joins `kind`
     *  on the debug line. */
    directionId: 0 | 1 | -1;
    /** Unix ms of the last GPS observation backing this marker, or
     *  null when there is no GPS (schedule-only). Surfaced as 'Xs
     *  ago' on the debug overlay so the rider can see how stale
     *  the underlying fix is relative to where dead-reckoning has
     *  walked the marker. */
    gpsAsOfMs: number | null;
    /** True when `tripStartMin` is a real origin-departure time from
     *  the schedule, false when it's a fallback (e.g. orphan whose
     *  live observation didn't carry a parseable start). The popup
     *  shows 'left at HH:MM' only when this is true — a 'left at'
     *  rendered from `nowMin` is a lie. */
    hasOriginTime: boolean;
    /** Minutes until this vehicle reaches the rider's origin stop
     *  (the `?from=<stopId>` station, painted green on the map),
     *  or null when there's no from-stop selected, the vehicle is
     *  the scheduled-next bubble at its own origin, or the vehicle
     *  has already passed the from-stop. The popup renders this as
     *  an extra `arriving in N min` line so a rider tracking a bus
     *  can see how long until it reaches them, without leaving the
     *  map. */
    arrivingInMin: number | null;
  };
  const markers = $derived.by<VehicleMarker[]>(() => {
    if (!view) return [];
    // Snapshot `view` into a non-null local so the nested closures
    // below (computeArrivingInMin, the stop forEach inside the trips
    // loop) narrow correctly under TypeScript's strict null checks.
    const curView = view;
    const out: VehicleMarker[] = [];
    let nextScheduledShown = false;
    const nowMs = nowTicker.ms;

    // Pre-compute the from-stop's position (when the URL carries
    // `?from=<stopId>`) plus the speed-cascade context, so the
    // per-marker arrival-to-from-stop ETA below is a one-liner
    // instead of duplicating projection / TOD-bucket lookups per
    // marker. fromTarget is null when there's no selected origin
    // stop, in which case computeArrivingInMin always returns null.
    const fromTarget = ((): { lat: number; lon: number } | null => {
      if (fromStopId == null) return null;
      const s = curView.stops.find((x) => Number(x.stopId) === fromStopId);
      return s ? { lat: s.lat, lon: s.lon } : null;
    })();
    const arrivingTodBucket = clockToBucket(
      minSinceMidnightInTz(nowMs, tz),
      feedConfigStore.todProfile,
    );
    const measuredShape = curView.shape.length >= 2 ? measurePolyline(curView.shape) : null;
    const stopDistCache = new Map<string, number[]>();
    const stopDistAlongM = (tripId: string, stops: RouteMapView['trips'][number]['stops']): number[] => {
      const cached = stopDistCache.get(tripId);
      if (cached) return cached;
      if (!measuredShape) return [];
      const out = stops.map((s) =>
        typeof s.distAlongM === 'number'
          ? s.distAlongM
          : projectOnPolyline({ lat: s.lat, lon: s.lon }, measuredShape.points).distAlongM,
      );
      stopDistCache.set(tripId, out);
      return out;
    };
    // Single GPS-anchored ETA call site for the popup `arriving in N min`
    // row. Delegates the dead-reckon + per-segment + dwell walk to the
    // shared domain helper used by station applyGpsEta, so the two views
    // can never diverge. Schedule-only fallback (no GPS) uses the trip's
    // own scheduled arrival at the from-stop.
    const computeArrivingInMin = (opts: {
      rawGpsLat: number | null;
      rawGpsLon: number | null;
      scheduledAtOrigin: boolean;
      etaSource: 'gps' | 'schedule';
      speedMs: number | null;
      gpsAsOfMs: number | null;
      directionId: 0 | 1 | -1;
      scheduledFromArrivalMin: number | null;
      dwellStopDistAlongM: ReadonlyArray<number> | null;
    }): number | null => {
      if (!fromTarget || opts.scheduledAtOrigin) return null;
      if (opts.etaSource === 'schedule') {
        if (opts.scheduledFromArrivalMin == null) return null;
        const m = opts.scheduledFromArrivalMin - nowMin;
        return m > 0 ? m : null;
      }
      if (
        curView.shape.length < 2 ||
        opts.rawGpsLat == null ||
        opts.rawGpsLon == null ||
        opts.gpsAsOfMs == null
      ) return null;
      const { arrival } = predictArrivalFromGps({
        obs: {
          lat: opts.rawGpsLat,
          lon: opts.rawGpsLon,
          speedMs: opts.speedMs,
          asOfMs: opts.gpsAsOfMs,
        },
        polyline: curView.shape,
        stopPos: fromTarget,
        nowMs,
        todBucket: arrivingTodBucket,
        feedConfig: feedConfigStore.speedConfig,
        vehicleDirectionId: opts.directionId === -1 ? undefined : opts.directionId,
        dwellStopDistAlongM: opts.dwellStopDistAlongM ?? undefined,
        dwellSecondsPerStop: feedConfigStore.dwellSec,
        ctx: {
          feedConfig: feedConfigStore.speedConfig,
          timezone: tz,
          todProfile: feedConfigStore.todProfile,
        },
      });
      return arrival.minutes > 0 ? Math.round(arrival.minutes) : null;
    };

    // Hard cap on GPS-fix age before we stop showing the orphan marker
    // at all — orphans don't go through `predictPositionFromGps` (no
    // shape projection without a trip plan), so we enforce the same
    // 15-min ceiling here.
    const STALE_HARD_MAX_MS = 15 * 60_000;

    // Index reconciled vehicles by their (static) tripId so each
    // iteration is O(1). The worker matched by (route, dir,
    // tripStartMin) tolerance — NOT by string-equality on tripId —
    // so live observations whose tripId drifted from static still
    // resolve correctly here.
    const reconciledByTripId = new Map<string, (typeof reconciledVehiclesStore.vehicles)[number]>();
    for (const v of reconciledVehiclesStore.vehicles) {
      if (v.tripId) reconciledByTripId.set(v.tripId, v);
    }

    // Sort by tripStartMin so the soonest not-yet-departed trip always wins
    // the single origin slot, regardless of query order from the DB.
    const trips = [...view.trips].sort((a, b) => a.tripStartMin - b.tripStartMin);
    for (const t of trips) {
      const plan = tripPlans.get(t.tripId);
      // GPS-anchored prediction takes priority when the worker reconciled
      // this trip to a live fix; fall back to schedule interpolation
      // otherwise.
      const reconciled = reconciledByTripId.get(t.tripId);
      let p: ReturnType<typeof predictPositionOnShape> | null = null;
      let gpsConfidence: 'good' | 'stale' | 'very-stale' | null = null;
      if (plan && reconciled?.kind === 'tracked' && reconciled.position) {
        const pos = reconciled.position;
        const gps = predictPositionFromGps(
          plan,
          { lat: pos.lat, lon: pos.lon, speedMs: pos.speedMs ?? null, asOfMs: pos.asOf },
          nowMs,
          { timezone: tz },
        );
        if (gps) {
          p = gps;
          gpsConfidence =
            gps.freshness === 'fresh' ? 'good'
            : gps.freshness === 'stale' ? 'stale'
            : 'very-stale';
        }
        // No `else` fallback: predictPositionFromGps already extrapolates
        // out to 15 min via the cascade. Anything older returns null and
        // we fall through to schedule prediction so the marker doesn't
        // freeze on a 30-min-old GPS sample.
      }
      if (!p) {
        p = plan
          ? predictPositionOnShape(plan, nowMin)
          : predictPosition(t.stops, nowMin);
      }
      if (!p) continue;
      // Past terminus — drop entirely.
      if (p.status === 'after') continue;
      // 'before' and 'at-origin' are both "not yet departed from origin":
      // show only the soonest one so bubbles don't stack at the origin stop.
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
        gpsConfidence,
        kind: reconciled?.kind ?? 'scheduled',
        directionId: (reconciled?.directionId ?? (direction as 0 | 1)) as 0 | 1 | -1,
        gpsAsOfMs: reconciled?.position?.asOf ?? null,
        hasOriginTime: true,
        arrivingInMin: computeArrivingInMin({
          rawGpsLat: reconciled?.position?.lat ?? null,
          rawGpsLon: reconciled?.position?.lon ?? null,
          scheduledAtOrigin: p.status === 'before' || p.status === 'at-origin',
          etaSource: reconciled?.position ? 'gps' : 'schedule',
          speedMs: reconciled?.position?.speedMs ?? null,
          gpsAsOfMs: reconciled?.position?.asOf ?? null,
          directionId: (reconciled?.directionId ?? (direction as 0 | 1)) as 0 | 1 | -1,
          scheduledFromArrivalMin:
            fromStopId == null
              ? null
              : (t.stops.find((s) => Number(s.stopId) === fromStopId)?.arrivalMin ?? null),
          dwellStopDistAlongM: stopDistAlongM(t.tripId, t.stops),
        }),
      });
    }

    // Orphans: live buses the worker couldn't match to any active
    // scheduled trip on this (route, dir). Rendered at raw GPS — no
    // shape projection because we don't have stop_times for them.
    // Cap by STALE_HARD_MAX_MS to drop markers whose last fix is
    // ancient.
    for (const v of orphanVehicles) {
      if (!v.position) continue;
      const age = nowMs - v.position.asOf;
      if (age > STALE_HARD_MAX_MS) continue;
      const tripId = v.tripId ?? v.id;
      out.push({
        tripId,
        headsign: v.headsign ?? null,
        lat: v.position.lat,
        lon: v.position.lon,
        opacity: 0.9,
        selected: tripId === selectedTripId,
        // Worker sets schedule.tripStartMin on orphans when the live
        // obs carries a parseable start time; fall back to nowMin so
        // sort order stays defined.
        tripStartMin: v.schedule?.tripStartMin ?? nowMin,
        scheduled: false,
        // Orphan freshness mirrors the reconciled bands so the marker
        // styling matches. We don't have a trip plan to extrapolate
        // along, but we still age the badge.
        gpsConfidence:
          age < 3 * 60_000 ? 'good'
          : age < 5 * 60_000 ? 'stale'
          : 'very-stale',
        kind: v.kind,
        directionId: v.directionId ?? -1,
        gpsAsOfMs: v.position.asOf,
        hasOriginTime: v.schedule?.tripStartMin != null,
        arrivingInMin: computeArrivingInMin({
          rawGpsLat: v.position.lat,
          rawGpsLon: v.position.lon,
          scheduledAtOrigin: false,
          etaSource: 'gps',
          speedMs: v.position.speedMs ?? null,
          gpsAsOfMs: v.position.asOf,
          directionId: v.directionId ?? -1,
          scheduledFromArrivalMin: null,
          dwellStopDistAlongM: null,
        }),
      });
    }
    return out;
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
  /** Pan + zoom the viewport onto the selected vehicle with the two
   *  stops before and the two after, so the rider sees the bus
   *  centred between its current segment's neighbours. Bails when
   *  there's no selected trip OR the marker hasn't surfaced yet
   *  (e.g. the vehicle dropped off the live feed). Wraps fitBounds
   *  so the result remains pan-and-zoom-able afterwards — we never
   *  lock the viewport. */
  function focusOnVehicle() {
    if (!mapInstance || !view || !L || !selectedTripId) return;
    const sel = markers.find((m) => m.tripId === selectedTripId);
    if (!sel) return;
    const trip = view.trips.find((t) => t.tripId === selectedTripId);
    if (!trip || trip.stops.length === 0) return;
    const Lref = L;
    const vehLL = Lref.latLng(sel.lat, sel.lon);
    // Nearest stop index to the vehicle's current position. The trip
    // shape is monotonic in stop_sequence, so [idx-2 .. idx+2] gives a
    // five-stop window centred on where the bus is right now.
    let nearestIdx = 0;
    let nearestDist = Infinity;
    for (let i = 0; i < trip.stops.length; i += 1) {
      const d = vehLL.distanceTo(Lref.latLng(trip.stops[i].lat, trip.stops[i].lon));
      if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
    }
    const lo = Math.max(0, nearestIdx - 2);
    const hi = Math.min(trip.stops.length - 1, nearestIdx + 2);
    const bounds = Lref.latLngBounds([[sel.lat, sel.lon]]);
    for (let i = lo; i <= hi; i += 1) {
      bounds.extend([trip.stops[i].lat, trip.stops[i].lon]);
    }
    mapInstance.fitBounds(bounds, { padding: [40, 40], maxZoom: 17 });
  }
  // Selected-vehicle focus is meaningful only when there IS a selected
  // trip AND its marker is currently on the map.
  const focusOnVehicleEnabled = $derived(
    selectedTripId != null && markers.some((m) => m.tripId === selectedTripId),
  );

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
        vehiclesLayer = Lref.layerGroup().addTo(mapInstance);
        // Vehicles pane sits above markerPane (600) so vehicle badges
        // always paint over stop circles, but below tooltipPane (650).
        const vehiclesPane = mapInstance.createPane('nearyVehicles');
        vehiclesPane.style.zIndex = '620';
        // Stop debug-id tooltips live in their own pane below the
        // vehicles pane (z=610 < nearyVehicles z=620) so vehicle
        // badges and their debug overlays stay readable in debug
        // mode and aren't covered by station ids. Tooltip pointer
        // events are disabled too — riders can still tap stop
        // circles through the label.
        const stopDebugPane = mapInstance.createPane('nearyStopDebug');
        stopDebugPane.style.zIndex = '610';
        stopDebugPane.style.pointerEvents = 'none';
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
      // Every stop renders as the same small circleMarker — origin and
      // terminus get no special treatment. The route badge in the
      // header already names origin + destination, and "next at
      // origin" surfaces via the scheduled vehicle bubble; a separate
      // play / square endpoint glyph was redundant.
      //
      // Exception: when the user navigated here from a station card
      // (`?from=<stopId>` query param), that stop renders in the
      // success-green colour so the rider can recognise where they
      // were standing. Pure visual marker; no other behavioural
      // change — the popup, hit target, and trip data are identical.
      const originStopId = fromStopId;
      currentView.stops.forEach((s) => {
        // Coerce both sides through Number(). The TypeScript types
        // say `number === number`, but at runtime SQLite-wasm sometimes
        // surfaces stop_id as a string (the JSON serialisation in the
        // worker → main thread Comlink hop loses the original numeric
        // typing for some columns). Number() handles both shapes
        // uniformly without resorting to '==='. NaN guarded by the
        // originStopId != null check above (fromStopId is already a
        // parsed number).
        const isOrigin = originStopId != null && Number(s.stopId) === originStopId;
        const m = Lref.circleMarker([s.lat, s.lon], {
          // Stops are already drawn ON TOP of the route polyline:
          // both live in overlayPane, the polyline is added by this
          // effect FIRST and the stops are appended AFTER, so SVG
          // insertion order puts the stop circles above the line. No
          // pane gymnastics needed — earlier attempts to hoist the
          // origin into markerPane / a custom pane broke the marker
          // entirely because Leaflet's SVG renderer isn't on
          // markerPane by default.
          radius: isOrigin ? 9 : 5,
          color: '#fff',
          weight: isOrigin ? 3 : 1.5,
          // Hardcoded green hex (not var(--color-success)) because
          // Leaflet's SVG renderer doesn't parse CSS custom properties
          // or oklch() — keep parity with the GPS-good ring used in
          // vehicleHtml below.
          fillColor: isOrigin ? '#22c55e' : currentView.route.color,
          fillOpacity: 1,
        });
        m.bindPopup(stopPopupHtml(s.stopId, s.stopName, currentRoutes.get(s.stopId) ?? []), {
          closeButton: false,
        });
        // Debug overlay: render the stop_id as a permanent tooltip
        // next to each stop circle when `userPrefs.showDebugIds` is
        // on. Lets the rider compare against the `?from=<id>` query
        // param (and against the station-card stop they came from)
        // when investigating why the from-stop highlight didn't
        // appear. The origin stop gets a `★` prefix so we can also
        // see whether the isOrigin check itself is firing — if the
        // star appears but the dot is still route-coloured, the
        // match works and it's a rendering bug; if no star appears
        // on the stop you came from, the match itself is failing.
        // Suppressed in production so the map stays readable.
        if (userPrefs.showDebugIds) {
          m.bindTooltip(`${isOrigin ? '★ ' : ''}${s.stopId}`, {
            permanent: true,
            direction: 'right',
            offset: [4, 0],
            className: 'neary-stop-id-label',
            pane: 'nearyStopDebug',
          });
        }
        m.addTo(sl);
      });
    }
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
      const debugId = userPrefs.showDebugIds
        ? `${m.tripId} · ${m.kind[0]}${m.directionId === -1 ? '' : m.directionId}`
          + (m.gpsAsOfMs != null
            ? ` · ${Math.max(0, Math.round((nowTicker.ms - m.gpsAsOfMs) / 1000))}s ago`
            : '')
        : '';
      const html = vehicleHtml(view.route.shortName, routeColor, labelFg, m.selected, m.opacity, m.scheduled, m.gpsConfidence, debugId);
      const icon = Lref.divIcon({
        className: 'neary-vehicle',
        html,
        iconSize: [44, 28],
        iconAnchor: [22, 14],
      });
      // pane: 'nearyVehicles' (z=620) keeps vehicles above stop markers
      // (markerPane z=600) so they're never hidden behind station icons.
      // zIndexOffset stacks vehicles within the pane so a schedule-only
      // marker never covers a live (GPS-backed) marker, and the
      // selected vehicle floats above both. Leaflet otherwise uses
      // insertion order, which is non-deterministic across ticks.
      const stackOffset = m.selected ? 1000 : m.scheduled ? -100 : 0;
      const marker = Lref.marker([m.lat, m.lon], {
        icon,
        pane: 'nearyVehicles',
        zIndexOffset: stackOffset,
      });
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
    const clockSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;flex-shrink:0;"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
    const schedSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;flex-shrink:0;"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><circle cx="8" cy="14" r="1" fill="currentColor"/><circle cx="12" cy="14" r="1" fill="currentColor"/><circle cx="16" cy="14" r="1" fill="currentColor"/><circle cx="8" cy="18" r="1" fill="currentColor"/><circle cx="12" cy="18" r="1" fill="currentColor"/></svg>`;
    // Kind dot beside the headsign, matching the VehicleCard one on
    // the station view so the visual language stays consistent across
    // surfaces. Green for any kind backed by GPS (tracked / verified /
    // gps-only), grey for schedule-only. Replaces the dedicated
    // "est." / "gps" info row that used to live below — same signal
    // in less vertical space.
    const dotColor = m.kind === 'scheduled' ? '#888' : '#22c55e';
    const dotTitle = m.kind === 'scheduled' ? 'Scheduled'
      : m.kind === 'tracked' ? 'Tracked'
      : m.kind === 'verified' ? 'Verified'
      : 'GPS only';
    const dot = `<span title="${dotTitle}" aria-label="${dotTitle}" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${dotColor};flex-shrink:0;"></span>`;
    // Headsign + kind dot + schedule button on the same row.
    const headsignText = m.headsign
      ? `<span style="font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(m.headsign)}</span>`
      : `<span style="flex:1;"></span>`;
    // Routes with no usable schedule (Cluj's Tranzy-fallback `_NT*`
    // trips: empty arrival_time on every stop_time row) skip the
    // schedule shortcut — /schedule/route would have nothing to show.
    const schedLink = view?.route.hasSchedule !== false
      ? `<a href="/schedule/route/${escapeHtml(rId)}_${dir}" title="View schedule" style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:4px;background:rgba(0,0,0,0.07);color:#555;text-decoration:none;flex-shrink:0;">${schedSvg}</a>`
      : '';
    const topRow = `<div style="display:flex;align-items:center;gap:6px;margin-bottom:5px;">${headsignText}${dot}${schedLink}</div>`;
    // Shared row template for every line below `topRow`. Three callers:
    // countdown (scheduled-at-origin "in X min"), leftAt (departed
    // bus's wall-clock origin time), arrivingIn (ETA to the rider's
    // ?from-stop). Same flex / icon / coloured-label layout, just
    // different colour + label. Factor here so adding a fourth info
    // line is one line of code.
    const popupRow = (color: string, label: string): string =>
      `<div style="display:flex;align-items:center;gap:2px;color:${color};font-size:11px;margin-top:3px;">${clockSvg}<span style="margin-left:2px;">${label}</span></div>`;
    // Countdown row, kept only for scheduled-at-origin / scheduled-
    // before bubbles: green clock + "in X min". Tells the rider when
    // the parked / not-yet-departed bus is expected to leave. On-route
    // vehicles don't get this line — their dot already conveys "live".
    const countdownHtml = m.scheduled
      ? popupRow(
          '#16a34a',
          (() => {
            const minsUntil = m.tripStartMin - nowMinVal;
            return minsUntil <= 0 ? 'now' : formatRelativeMin(minsUntil);
          })(),
        )
      : '';
    // For vehicles that have ALREADY departed origin (everything but
    // the scheduled-at-origin / scheduled-before bubbles, which the
    // 'in X min' label above already covers), append the wall-clock
    // time the trip left its first stop. Lets a rider on the map
    // map a moving bubble back to a specific scheduled departure
    // without opening the schedule view. Suppressed for orphans whose
    // tripStartMin is a fallback (hasOriginTime === false) — rendering
    // 'left at <now>' there would be a lie.
    const leftAtHtml = !m.scheduled && m.hasOriginTime
      ? popupRow('#888', `left at ${formatHHMM(m.tripStartMin)}`)
      : '';
    // 'arriving in N min' line, surfaced only when the URL carries a
    // `?from=<stopId>` (green-painted target station) AND the vehicle
    // is still on its way toward that stop. predictArrivalAlongShape
    // returns negative minutes once the vehicle passes the target;
    // the marker setter (`computeArrivingInMin` in the markers
    // derivation) drops the value to null in that case, so this
    // string is empty for everything that's no longer 'incoming' to
    // the rider's origin. Green to match the green stop highlight.
    const arrivingHtml = m.arrivingInMin != null
      ? popupRow('#16a34a', `arriving in ${m.arrivingInMin} min`)
      : '';
    return `<div style="font:13px/1.3 ui-sans-serif,system-ui;min-width:150px;">${topRow}${countdownHtml}${leftAtHtml}${arrivingHtml}</div>`;
  }
  function vehicleHtml(
    shortName: string,
    bg: string,
    fg: string,
    selected: boolean,
    opacity: number,
    scheduled: boolean,
    gpsConfidence: 'good' | 'stale' | 'very-stale' | null,
    debugId: string,
  ): string {
    // Inner ring colour reflects GPS data source so the same green /
    // yellow / red signal a rider reads from any vehicle stays
    // visible when the vehicle is selected. When unselected this is
    // the only ring; selection adds a dark outer ring around it as
    // the "you tapped this one" highlight.
    //   good        → green   stale       → yellow   very-stale → red
    //   null (schedule-only): white.
    const inner =
      gpsConfidence === 'good' ? '#22c55e' :
      gpsConfidence === 'stale' ? '#eab308' :
      gpsConfidence === 'very-stale' ? '#ef4444' :
      '#fff';
    const ring = selected
      ? `box-shadow:0 0 0 3px ${inner}, 0 0 0 5px #111;`
      : gpsConfidence != null
        ? `box-shadow:0 0 0 2.5px ${inner};`
        : 'box-shadow:0 0 0 2px #fff;';
    // Scheduled vehicles (at-origin / next 'before'): outlined badge so
    // the user can distinguish "waiting to depart" from "en route".
    const colors = scheduled
      ? `background:rgba(255,255,255,0.92);color:${bg};border:1.5px solid ${bg};`
      : `background:${bg};color:${fg};`;
    // Pulsing CSS class for the selected badge — the keyframe lives
    // in the page-level style block and animates an additional
    // box-shadow on top of the static one above, so the dark outer
    // ring breathes outward without the badge moving. The
    // `--neary-inner` custom property carries the GPS-confidence
    // ring colour into the animation so the inner ring stays at its
    // semantic colour through the pulse.
    const selectedClass = selected ? ' neary-vehicle-selected' : '';
    const selectedVar = selected ? `--neary-inner:${inner};` : '';
    return `<div style="position:relative;"><div class="neary-vehicle-badge${selectedClass}" style="
      display:inline-flex;align-items:center;justify-content:center;
      min-width:32px;height:22px;padding:0 6px;border-radius:6px;
      ${colors}font:600 12px/1 ui-sans-serif,system-ui;
      opacity:${opacity};${ring}${selectedVar}
    ">${escapeHtml(shortName)}</div>${debugId ? `<div style="position:absolute;top:24px;left:50%;transform:translateX(-50%);white-space:nowrap;font:600 9px/1.1 ui-monospace,SFMono-Regular,Menlo,monospace;color:#111;background:rgba(255,255,255,0.9);border-radius:3px;padding:1px 3px;pointer-events:none;">${escapeHtml(debugId)}</div>` : ''}</div>`;
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
  function escapeHtml(s: string): string {
    return s
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

</script>

<!-- Map control button factory + per-control icon snippets. Defined
     at the top of the template (NOT inside any component) so they
     stay template-scoped rather than being interpreted as props on
     whichever component happens to host them. -->
{#snippet mapControl(label: string, iconSnippet: import('svelte').Snippet, onclick: () => void, disabled = false)}
  <IconButton
    size="small"
    aria-label={label}
    title={label}
    {disabled}
    class="bg-[color:var(--color-surface)] text-[color:var(--color-fg)] border border-[color:var(--color-border)] shadow-lg hover:bg-[color:var(--color-border)]/60"
    {onclick}
  >
    {@render iconSnippet()}
  </IconButton>
{/snippet}
{#snippet plusIcon()}<Plus size={16} />{/snippet}
{#snippet minusIcon()}<Minus size={16} />{/snippet}
{#snippet fitIcon()}<Maximize2 size={16} />{/snippet}
{#snippet busIcon()}<Bus size={16} />{/snippet}
{#snippet calendarIcon()}<Calendar size={16} />{/snippet}

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
            <RouteBadge route={view.route} size="large" />
            <Stack spacing={0.5} class="flex-1 min-w-0">
              <Stack direction="row" spacing={1} align="center" wrap>
                <Typography variant="h5" class="truncate">{headerTitle}</Typography>
                {#each (route?.networks ?? []) as netId (netId)}
                  {@const net = networkMap.get(netId)}
                  {@const Icon = networkIcon(netId)}
                  <Chip size="small" hex={net?.color} fg={net ? networkTextColor(net.color) : undefined}>
                    {#snippet icon()}<Icon size={12} />{/snippet}
                    {net?.name ?? netId}
                  </Chip>
                {/each}
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
             map tile. Sits above Leaflet's panes via z-index. The
             button class is identical for every control — factored
             into the `mapControl` snippet (defined at the top of
             this template, outside any Card) so adding a new
             control is one line, not seven. -->
        <div class="neary-map-controls">
          {@render mapControl('Zoom in', plusIcon, zoomIn)}
          {@render mapControl('Zoom out', minusIcon, zoomOut)}
          {@render mapControl('Fit route to view', fitIcon, fitToRoute)}
          {@render mapControl('Focus on tracked vehicle', busIcon, focusOnVehicle, !focusOnVehicleEnabled)}
        </div>
        <!-- Schedule shortcut in the bottom-right corner. Mirrors the
             top-right zoom/fit cluster's styling so it reads as the
             same control family, but lives in the opposite corner to
             avoid clobbering the cluster while keeping a single
             thumb-reachable destination. Same (route, direction) the
             page already binds against — no parameter recomputation.
             Hidden for routes with no usable schedule (the feed's
             trips ship empty arrival_times) — /schedule/route would
             have nothing to show. -->
        {#if view?.route.hasSchedule !== false}
          <div class="neary-map-controls-bottom">
            {@render mapControl(
              'Open schedule for this route',
              calendarIcon,
              () => goto(`/schedule/route/${routeId}_${direction}`),
            )}
          </div>
        {/if}
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
  /* Bottom-right cluster — same chrome as the top-right cluster,
     opposite corner so the two don't crowd each other. */
  .neary-map-controls-bottom {
    position: absolute;
    bottom: 0.5rem;
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

  /* Selected vehicle marker: animate the dark outer ring outward in a
     soft breathing pulse so it stands out among other markers without
     redrawing the map. The inline box-shadow handles the static inner
     coloured ring + 5px dark ring at the resting state; this keyframe
     blends an extra 9px translucent ring at 50% so the dark ring
     appears to expand and fade rhythmically. --neary-inner is set
     inline per badge to preserve the GPS-confidence inner ring colour
     through the animation. */
  :global(.neary-vehicle-selected) {
    animation: neary-vehicle-selected-pulse 1.6s ease-in-out infinite;
  }
  @keyframes neary-vehicle-selected-pulse {
    0%, 100% {
      box-shadow:
        0 0 0 3px var(--neary-inner, #fff),
        0 0 0 5px #111;
    }
    50% {
      box-shadow:
        0 0 0 3px var(--neary-inner, #fff),
        0 0 0 5px #111,
        0 0 0 9px rgba(17, 17, 17, 0.35);
    }
  }

  /* Stop debug-id tooltip (only rendered when userPrefs.showDebugIds
     is on). Compact font + tight padding so the labels don't crowd
     the route geometry, and so the vehicle markers + their own debug
     labels (which paint above this pane) stay the eye's anchor. */
  :global(.leaflet-tooltip.neary-stop-id-label) {
    font: 600 8px/1.1 ui-monospace, SFMono-Regular, Menlo, monospace;
    padding: 1px 3px;
    background: rgba(255, 255, 255, 0.85);
    border: none;
    box-shadow: none;
    color: #333;
  }
  :global(.leaflet-tooltip.neary-stop-id-label::before) {
    display: none;
  }
</style>
