# Vehicles & Views — v2 design

Companion to [plan.md](plan.md). Where plan.md says "vehicle taxonomy is data
with a discriminated union", this doc fills in:

1. The four user-facing views, validated against current routes and the bottom
   nav decision in [plan.md §4](plan.md).
2. A single `Vehicle` object model that replaces the `ghost / live /
   live-matched / scheduled` naming in plan.md §3 with terms that describe
   the **source of position knowledge** instead of an internal status.
3. The station-view bucketing rules (incoming / arriving / at-station /
   departing / departed) — ported from v1 with the v1 thresholds preserved.
4. The map-view rule: render **every** vehicle known for a route, with the
   marker variant chosen by the vehicle's accuracy tier.
5. The prediction + reconciliation algorithms that produce a `Vehicle`,
   validated against the v1 implementation in `apps/legacy/src/utils/`.

Anything not explicitly contradicted here still matches plan.md.

---

## 1. Views

Validated against [the current Svelte routes](../../apps/web/src/routes/) and
[plan.md §4](plan.md). The user-facing surface is **four primary views plus
two drill-downs**, in this hierarchy:

| Primary (bottom nav)               | Route                       | What it shows                                                           |
| ---------------------------------- | --------------------------- | ----------------------------------------------------------------------- |
| **Stations**                       | `/`                         | Nearby stations, each with its arrivals board                           |
| **Favorites**                      | `/favorites`                | Saved routes + saved stations, each opens its drill-down                |
| **Planner**                        | `/planner`                  | From / to itinerary (Phase 8)                                           |
| **Settings**                       | `/settings`, `/settings/advanced` | Prefs (Phase 7)                                                   |

| Drill-down                         | Route                       | What it shows                                                           |
| ---------------------------------- | --------------------------- | ----------------------------------------------------------------------- |
| **Schedule view (route in station)** | `/schedule/route/[routeId]?stop=[stopId]` | Today/tomorrow board for one route filtered to one stop          |
| **Schedule view (full route)**       | `/schedule/route/[routeId]` | Today/tomorrow board for every stop on the route, both directions       |
| **Map view (route)**                 | `/map/route/[routeId]?selected=[vehicleId]` | Whole route on the map: shape + every vehicle on it + selected highlight |
| **Map view (vehicle)**               | `/map/vehicle/[vehicleId]`  | Single vehicle + its trip path; redirects to `/map/route/[routeId]?selected=[id]` |

### Validation against the user's mental model

The user listed: **station view, map view, favorites, official schedule**.
That maps to: Stations (primary), Map (drill-down), Favorites (primary),
Schedule (drill-down). The drill-downs are reachable from **both** Stations
and Favorites — this is what the user means by "we should have a map view
for route from favorites, just like we should have a schedule view for route
in favorites" *and* "we should also have a schedule view for a route shown
in a station". One drill-down, multiple entry points.

### "Station view IS the schedule view"

Confirmed in the design. The Stations view at `/` already shows the
**schedule-derived arrivals board** for each nearby station — there is no
separate "station schedule" route. The drill-down at
`/schedule/route/[routeId]?stop=[stopId]` is the **same data, longer
horizon**: instead of "next 60 min at this stop for all routes" it's "next
24 h at this stop for one route".

### Entry-point matrix

| From                              | Tap target          | Lands on                                              |
| --------------------------------- | ------------------- | ----------------------------------------------------- |
| Stations card / arrivals row      | Route badge         | `/schedule/route/[routeId]?stop=[stopId]`             |
| Stations card / arrivals row      | Map icon on vehicle | `/map/route/[routeId]?selected=[vehicleId]`           |
| Favorites / saved route           | Card body           | `/schedule/route/[routeId]`                           |
| Favorites / saved route           | Map icon            | `/map/route/[routeId]`                                |
| Favorites / saved station         | Card body           | `/` scrolled to that station (or a `/stations/[id]`) |
| Map view                          | Vehicle marker      | `/map/route/[routeId]?selected=[vehicleId]`           |

---

## 2. `Vehicle` object model

### Naming change from plan.md §3

| Old name (plan.md §3) | New name           | Why                                                                                                         |
| --------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `scheduled`           | `scheduled`        | unchanged — trip is in the schedule, not yet running, no GPS expected                                        |
| `ghost`               | **`predicted`**    | "ghost" implies missing data; the entry is in fact a confident schedule-derived position prediction          |
| `live`                | `live`             | unchanged — at least one live feed reports GPS, no schedule trip matched yet                                 |
| `live-matched`        | **`reconciled`**   | the source-of-truth statement: live GPS reconciled with a scheduled trip                                     |
| —                     | **`corroborated`** | new: a `reconciled` vehicle whose live GPS is confirmed by two or more independent live sources              |

The `predicted` rename is the central point of the user's "ghost is just crap
name" feedback: a vehicle reconstructed from the schedule by running the same
prediction engine we use for live vehicles is **not** a fake — it is a
schedule-only estimate with explicit confidence. Same logic that interpolates
a live vehicle between GPS pings interpolates a scheduled trip between its
known scheduled times.

### Type definition

```ts
// apps/web/src/lib/domain/vehicle.ts (new in Phase 4)

export type LiveSource = 'gtfs-rt' | 'tranzy';

export type VehicleKind =
  | 'scheduled'      // trip exists in the schedule. The schedule-only
                     // pipeline (Phase 4) emits every row with this kind.
                     // No position attached. Bucketing classifies it as
                     // arriving / at-station / departing / departed / etc.
                     // based on its scheduled times.
  | 'predicted'      // RESERVED for the live reconciler (Phase 5+). Means
                     // "we polled live sources, none reported this trip,
                     // and we *estimate* its position from the schedule".
                     // `checkedSources` will list which live feeds we
                     // tried. Not emitted by the schedule-only path —
                     // there's nothing to "predict" against if no live
                     // source has even been polled.
  | 'live'           // live GPS, no schedule trip matched
  | 'reconciled'     // live GPS + matched scheduled trip (1 live source)
  | 'corroborated';  // live GPS + matched scheduled trip + ≥2 live sources

export interface Vehicle {
  /** Stable id. For live vehicles it's the operator id; for scheduled/predicted
   *  vehicles it's `trip:${tripId}`. Same id across refreshes. */
  id: string;

  kind: VehicleKind;
  route: Route;

  /** Always present, even for `scheduled` — comes from either GPS (live*) or
   *  prediction (scheduled/predicted). `source` says which. */
  position: {
    lat: number;
    lon: number;
    /** Where this position came from. */
    source: 'gps' | 'predicted-from-schedule' | 'predicted-from-gps';
    /** UNIX ms of the GPS fix (for source=gps) or the moment we generated
     *  the prediction (otherwise). */
    asOf: number;
  };

  /** Trip schedule, if we know which trip this vehicle is running. Always
   *  present for scheduled/predicted/reconciled/corroborated; absent for
   *  pure `live`. */
  schedule?: ScheduledRun;

  /** Headsign / direction label. Pulled from schedule if matched, otherwise
   *  from live feed (Tranzy carries it; GTFS-RT doesn't). */
  headsign?: string;

  /** Estimated arrival at the **stop the view is for** (station view) or at
   *  the next stop on the trip (map view). Always relative to `Date.now()`. */
  eta?: {
    /** Distance in metres along the route shape from `position` to the
     *  target stop. */
    distanceMeters: number;
    /** Whole minutes (negative = already passed for `departed` bucket). */
    minutes: number;
    /** Confidence the ETA itself, separate from `vehicle.confidence`. */
    confidence: 'high' | 'medium' | 'low';
  };

  /** Where confidence comes from. Drives small badges in the UI.
   *  Computed strictly from `kind` and `liveSources`:
   *    corroborated → high
   *    reconciled   → medium
   *    live         → medium (if recent GPS) | low (if stale)
   *    predicted    → low
   *    scheduled    → n/a (no position yet) */
  confidence: 'high' | 'medium' | 'low';

  /** Which live feeds reported this vehicle in the latest poll. Empty
   *  for `scheduled` and `predicted`. */
  liveSources: LiveSource[];

  /** For `predicted` only — which live sources were polled and did NOT see
   *  the trip. `['gtfs-rt','tranzy'] = confirmed predicted`,
   *  `['gtfs-rt']` (no Tranzy key) = `probable predicted`. */
  checkedSources?: LiveSource[];

  /** True if this stop is marked drop-off-only for this trip. The pipeline
   *  sets this when either (a) GTFS `stop_times.pickup_type = 1`, OR (b)
   *  the stop is the trip's terminus (`stop_sequence === MAX(stop_sequence)`
   *  for that trip). Many operators leave `pickup_type` null at terminuses,
   *  so the structural fallback catches them. UI hides by default unless
   *  `userPrefs.showDropOffOnly`. Only meaningful in station-view context. */
  dropOffOnly?: boolean;
}
```

### Visual variant table

| Kind            | `position.source`            | Visual                                |
| --------------- | ---------------------------- | ------------------------------------- |
| `corroborated`  | `gps` (latest of N sources)  | solid + check-circle pip + bold border |
| `reconciled`    | `gps`                        | solid + calendar pip                  |
| `live`          | `gps`                        | solid                                 |
| `predicted`     | `predicted-from-schedule`    | dashed                                |
| `scheduled`     | n/a (no marker on map, list item with calendar icon) | dashed, calendar icon (same as `predicted` until live reconciler lands) |

Schedule-only kinds (`predicted` / `scheduled`) are always shown — they
are the only data we have when no live source is wired, and the user
should not be able to hide them. (Earlier draft had a
`showScheduleOnlyVehicles` toggle; dropped per request.)

### Why this is one type and not five

Single discriminated union → one `<VehicleCard>` component, one map marker
component (with `variant={vehicle.kind}`), one sort comparator, one filter
predicate. The reconciler is the only place that decides what `kind` and
`confidence` to stamp; nothing downstream branches on whether a vehicle is
"real" or "ghost". This is the user's "object structure so we no longer leak
logic all over the place" requirement.

---

## 3. Station view — arrival buckets

The user's requested buckets are **incoming / arriving / at-station /
departing / departed**. V1 used **off_route / at_stop / in_minutes /
departed** ([statusUtils.ts L40-L65](../../apps/legacy/src/utils/arrival/statusUtils.ts)).
The v2 buckets are a superset that splits `at_stop` into the three operational
states the user wants (at-station / departing / arriving) using the gap
between scheduled arrival and scheduled departure that v1 had access to but
never modelled.

### Bucket definitions

Inputs available per `Vehicle`:

- `vehicle.position` (always)
- `vehicle.schedule.scheduledArrival` and `scheduledDeparture` at the target
  stop (always for `scheduled` / `predicted` / `reconciled` / `corroborated`)
- `vehicle.eta.minutes` (always once the prediction engine runs)
- Live speed if `kind ∈ {live, reconciled, corroborated}` — used to detect
  motion at the stop

```ts
type ArrivalBucket =
  | 'incoming'    // future, far away
  | 'arriving'    // future, close
  | 'at-station'  // dwelling
  | 'departing'   // about to leave / just started moving from stop
  | 'departed'    // already passed
  | 'off-route';  // sanity bucket — surfaces only in debug view

interface BucketInputs {
  etaMinutes: number;                 // signed: positive=future, negative=past
  distanceToStopMeters: number;       // positive
  vehicleSpeedKmh?: number;           // undefined for scheduled/predicted
  scheduledArrivalMin?: number;       // minutes-since-midnight, target stop
  scheduledDepartureMin?: number;
  nowMin: number;                     // minutes-since-midnight
}

const PROXIMITY_AT_STATION_M = 50;    // v1: STATION_PROXIMITY_METERS
const ARRIVING_THRESHOLD_MIN = 2;     // tighter than incoming
const RECENT_DEPARTURE_WINDOW_MIN = 5;
const DEPARTING_SPEED_KMH = 5;        // crossed when leaving station
const SCHEDULED_DWELL_GAP_MIN = 1;    // if departure-arrival > 1 min show at-station

function bucketOf(v: Vehicle, stop: Stop, now: number, inp: BucketInputs): ArrivalBucket {
  // 1. Off-route hard fail — same as v1, applies to live* kinds only
  if (v.kind === 'live' || v.kind === 'reconciled' || v.kind === 'corroborated') {
    if (inp.distanceToStopMeters > 200 && !onRouteShape(v.position, v.route)) return 'off-route';
  }

  // 2. At station — physical proximity + (speed=0 OR scheduled dwell window)
  const inDwellWindow =
    inp.scheduledArrivalMin != null && inp.scheduledDepartureMin != null &&
    inp.nowMin >= inp.scheduledArrivalMin && inp.nowMin <= inp.scheduledDepartureMin;

  const physicallyAtStation =
    inp.distanceToStopMeters <= PROXIMITY_AT_STATION_M &&
    (inp.vehicleSpeedKmh == null || inp.vehicleSpeedKmh < DEPARTING_SPEED_KMH);

  if (physicallyAtStation || (v.kind !== 'live' && inDwellWindow)) {
    // Split at-station into arriving / at-station / departing using the
    // scheduled dwell gap and live motion.
    const dwellMin = (inp.scheduledDepartureMin ?? 0) - (inp.scheduledArrivalMin ?? 0);

    // (a) Live vehicle picking up speed → departing
    if (inp.vehicleSpeedKmh != null && inp.vehicleSpeedKmh >= DEPARTING_SPEED_KMH) {
      return 'departing';
    }
    // (b) Within last minute of scheduled dwell → departing
    if (inp.scheduledDepartureMin != null &&
        inp.nowMin >= inp.scheduledDepartureMin - 1 &&
        inp.nowMin <= inp.scheduledDepartureMin + 1) {
      return 'departing';
    }
    // (c) Within first minute of scheduled dwell → arriving
    if (inp.scheduledArrivalMin != null &&
        inp.nowMin >= inp.scheduledArrivalMin - 1 &&
        inp.nowMin <= inp.scheduledArrivalMin + 1) {
      return 'arriving';
    }
    // (d) Mid-dwell on a route with a meaningful gap → at-station
    if (dwellMin >= SCHEDULED_DWELL_GAP_MIN) return 'at-station';
    // (e) Short gap → it's just passing; treat as arriving
    return 'arriving';
  }

  // 3. Future
  if (inp.etaMinutes >= 0) {
    return inp.etaMinutes <= ARRIVING_THRESHOLD_MIN ? 'arriving' : 'incoming';
  }

  // 4. Past
  if (-inp.etaMinutes <= RECENT_DEPARTURE_WINDOW_MIN) return 'departed';
  return 'off-route'; // very old; hidden in normal view
}
```

### Bucket counts

The user asked for the v1 count logic: it lives in
[arrivalUtils.calculateMultipleArrivals](../../apps/legacy/src/utils/arrival/arrivalUtils.ts).
In v2 the count is a `Map<ArrivalBucket, number>` built by reducing the
station's `Vehicle[]` through `bucketOf`. Per-route counts (for the badge
row on the station card) drop into the same shape, keyed by `routeId`.

### Sort order

Within a station's arrivals board:

1. `departing` → 0
2. `at-station` → 1
3. `arriving` → 2
4. `incoming` → 3
5. `departed` → 4 (hidden by default — see filters below)
6. `off-route` → hidden by default

Tie-break: by `eta.minutes` — **ascending** for all forward buckets ("in 3
min" before "in 7 min"), but **descending** for `departed` so the most
recent departure comes first ("1 min ago" before "10 min ago"). Final
tie-break by `vehicle.id`.

### ETA coloring (per bucket)

Time is the single most important piece of information on a vehicle row,
so `VehicleCard` colors the secondary line by an **urgency tier** computed
in the domain (`etaUrgency(bucket, etaMinutes, config?)` in
[buckets.ts](../../apps/web/src/lib/domain/buckets.ts)). The UI never
re-derives "which buckets are urgent"; it just maps the urgency enum to a
CSS class.

| `urgency` | When                                                              | UI styling                  |
| --------- | ----------------------------------------------------------------- | --------------------------- |
| `'stop'`  | `bucket === 'departing'`                                          | bold + danger color (red)   |
| `'go'`    | `bucket ∈ {'at-station', 'arriving'}` OR (`'incoming'` AND `eta.minutes ≤ imminentEtaThresholdMin`) | bold + success color (green) |
| `'neutral'` | everything else (departed, off-route, distant incoming, no bucket) | muted neutral             |

Threshold for "imminent incoming" is `NearyConfig.imminentEtaThresholdMin`
(default 5). When `VehicleCard` is rendered without an `urgency` prop
(standalone showcase, future map popup), the row stays muted neutral.

### Departed collapse (one row per route)

Even after the trip-end gate, an active route running every few minutes can
produce many recently-departed rows. The board collapses the `departed`
bucket to **the most-recent row per route** in
[`assembleStationBoard`](../../apps/web/src/lib/domain/stationBoard.ts) via
the helper `collapseDepartedByRoute`. The user sees one departed entry per
route ("you just missed the 24 a minute ago") instead of a 20-row history.
The map view bypasses this — it consumes the raw `Vehicle[]` directly,
showing every still-en-route bus.

### Station-view filters (`filterForStationView`)

Two user-tunable filters apply **before** the board renders. Map view
ignores both and always shows every vehicle.

| `userPrefs` flag             | Default | Effect on station view                                                |
| ---------------------------- | ------- | --------------------------------------------------------------------- |
| `showDropOffOnly`            | `true`  | When `false`, drop vehicles with `vehicle.dropOffOnly === true` from the **future** buckets (incoming / arriving / at-station / departing). Set by `scheduleScanner` when either GTFS `stop_times.pickup_type = 1` OR the stop is the trip's terminus (operators routinely leave `pickup_type` null at the last stop, so the structural fallback catches those). The `departed` bucket ignores this flag — past vehicles aren't boardable anyway, so the question is moot. When `true`, the row is shown with a small "Drop off" chip. |
| `showDepartedVehicles`       | `false` | When `false`, drop the `departed` bucket entirely. When `true`, show vehicles that have passed this stop and are still en route to their trip's terminus (no artificial recency cap — the scheduleScanner gates on `trip_end_time > now`). The `dropOffOnly` filter does NOT apply here; you can't board a past vehicle anyway. |

Schedule-only kinds (`predicted` / `scheduled`) are always shown.
`off-route` is always hidden from station boards; it only surfaces in the
debug view.

---

## 4. Map view — render the whole route

### What changes from v1

V1 already passed an arbitrary set of vehicles to `VehicleLayer`
([VehicleLayer.tsx L1-L100](../../apps/legacy/src/components/features/maps/VehicleLayer.tsx)),
but the entry point from a station card only ever opened the map scoped to
**one** vehicle's trip
([VehicleMapContent.tsx L70-L150](../../apps/legacy/src/components/features/maps/VehicleMapContent.tsx)).
v2 reverses that default: opening `/map/route/[routeId]` from any entry
point renders **every vehicle currently on that route**, with the marker
variant set by `vehicle.kind`. The vehicle the user came from is
`selected` and gets the highlight treatment.

### Map-view `Vehicle[]` source

Same domain reconciler as the station view. Difference is the input filter:

- Station view: `vehicles.filter(v => v.schedule?.stopsOnTrip.includes(stop.id))`
- Map view:    `vehicles.filter(v => v.route.id === routeId)`

Both produce a `Vehicle[]`. Each vehicle has its current `position` already
computed — for `predicted` ones, the prediction engine has been run from the
nearest scheduled stop time forward to `now`. The map just plots them.

### Marker variants by `kind` (replaces plan.md §4 table)

| `vehicle.kind` | Marker fill        | Border       | Badge corner                    | Notes                                  |
| -------------- | ------------------ | ------------ | ------------------------------- | -------------------------------------- |
| `corroborated` | route color, solid | 2 px route color, **white outline** | small check-circle | rendered topmost (after selected)      |
| `reconciled`   | route color, solid | 2 px route color | small calendar               |                                        |
| `live`         | route color, solid | 1 px route color | —                            |                                        |
| `predicted`    | route color        | **dashed 1 px** | small dashed-clock             | always shown                                   |
| `scheduled`    | n/a — does not appear on map until trip becomes `predicted` or live |     |    | (it's only a list row in the schedule view) |
| `selected`     | overlay ring around any of the above, 3 px accent colour |          |                                |                                        |

Pane order (refines [plan.md §4](plan.md)):

```
selected-overlay > corroborated > reconciled > live > predicted >
user-location > stations > route-shapes > tiles
```

So a `corroborated` marker is never visually buried under a `predicted` one
overlapping it.

### Selected vehicle highlight

`/map/route/[routeId]?selected=[vehicleId]` reads `selected` and renders the
ring overlay on whichever marker has `vehicle.id === selected`. Tapping
another vehicle's marker updates the query param (no navigation), so the
back button still returns to the station / favorites that opened the map.

### Route shape source

`routeShapeService` equivalent — joins GTFS `shapes` for the route's most
common `shape_id` per direction, returns a polyline per direction. Rendered
in the `route-shapes` pane.

### Stations on the map

Every stop on the route (both directions) renders as a small circle on the
`stations` pane. Tapping a stop opens the schedule view scoped to that
stop+route: `/schedule/route/[routeId]?stop=[stopId]`.

---

## 5. Prediction engine (revalidated from v1)

The v1 engine is split across three files and an enhancement pipeline. v2
ports the same algorithm to `apps/web/src/lib/domain/prediction/` as pure TS
(no React, no stores). The validation below confirms each step is correct or
flags what to change.

### 5.1 Speed estimator

V1 fallback chain in
[speedCalculationUtils.predictVehicleSpeed L52-L92](../../apps/legacy/src/utils/vehicle/speedCalculationUtils.ts):

1. API-reported speed if > 5 km/h → **high confidence**
2. Average speed of other vehicles within 200 m → confidence by sample size
3. Location-based estimate (slower in dense-station areas) → medium
4. Static 25 km/h fallback → very low

**v2 verdict:** keep, with two changes.

- (a) "Other vehicles" in v2 means "vehicles of the same `route` going in the
  same direction, within 500 m along the shape" — same-route is a stronger
  prior than same-200 m circle on a mixed street.
- (b) For `predicted` vehicles (no live GPS), the engine should look up the
  scheduled `arrival_time` → `departure_time` deltas at adjacent stops on
  the trip and use *that* as the per-segment speed. The fallback chain above
  is for live vehicles only.

### 5.2 Position interpolation

V1 in
[positionPredictionUtils.simulateMovementAlongRoute L175+](../../apps/legacy/src/utils/vehicle/positionPredictionUtils.ts).

Inputs: time since last GPS fix, predicted speed, vehicle projected onto
route shape, list of stops with dwell.

Algorithm: walk forward along the polyline segments, deducting `speed × dt`
metres; when crossing a stop, deduct 30 s of dwell (hardcoded). Return the
new lat/lon and metadata (`stationsEncountered`, `totalDwellTime`,
`positionMethod`).

**v2 verdict:** keep the structure, with three changes.

- Dwell is **per stop** from GTFS (`departure_time - arrival_time`), not a
  flat 30 s. v1's 30 s assumption hides delay propagation. The data is in
  the SQLite blob already — `stop_times.arrival_time` and `departure_time`
  exist per (trip, stop).
- For `predicted` vehicles, the same walker runs **forward from the most
  recent scheduled stop** instead of from the last GPS fix. Cleanly the same
  function with two callers.
- Hard cap on extrapolation: if `dt > 5 min`, clamp dt to 5 min and lower
  ETA confidence to `low`. Beyond 5 min the prediction is fiction.

### 5.3 ETA calculation

V1 in [arrivalUtils.calculateArrival L23-L68](../../apps/legacy/src/utils/arrival/arrivalUtils.ts):
`eta = distanceAlongShape(vehiclePos, stopPos) / predictedSpeed + dwellsBetween`.

**v2 verdict:** keep verbatim. The math is correct. Distinguish only the
**source** of `predictedSpeed` per §5.1.

### 5.4 Things v1 doesn't handle (and v2 should not pretend to)

- **U-turns at terminus / trip flip.** V1 confirmed-no in
  [v1 §3 gaps](../../apps/legacy/src/utils/vehicle/positionPredictionUtils.ts).
  v2 inherits this — when a vehicle reaches the end of its trip's shape it
  becomes a stale `live` vehicle. The reconciler must demote it the moment
  the next trip's GPS appears (typically a new trip_id; see §6.4).
- **Heading / bearing.** v1 doesn't read the field; v2 still doesn't. GTFS-RT
  carries `bearing` ([live-data-analysis.md](live-data-analysis.md)) so a
  future enhancement is to use it as a "vehicle facing forward or backward
  along the shape" hint, lowering ETA confidence when it disagrees with the
  shape's natural direction.
- **GPS jump detection.** v1 only filters on staleness (30 min) and distance
  to shape (200 m). v2 inherits — adds nothing here in the first cut.

---

## 5.5 Pipeline assembly

The reconciler from §6 below is **not** a monolith — it's the tail of a
**pipeline of stages** assembled at startup based on which features are
actually wired up. This is what lets the same UI render correctly when the
user has offline-only schedule data, when GTFS-RT is reachable, and when the
user also pasted a Tranzy key.

### The contract

```ts
// apps/web/src/lib/domain/pipeline/types.ts
interface PipelineContext {
  nowMs: number;
  nowMinSinceMidnight: number;
  localDate: string;       // GTFS calendar key YYYYMMDD
}

interface Stage<Ctx extends PipelineContext = PipelineContext> {
  name: string;
  run(state: Vehicle[], context: Ctx): Vehicle[] | Promise<Vehicle[]>;
}

function runPipeline(stages: Stage[], ctx: PipelineContext): Promise<Vehicle[]>;
```

A stage receives the `Vehicle[]` produced so far and a per-run context. It
returns a new `Vehicle[]` — usually the input plus modifications (upgraded
`kind`, attached `liveSources`, refreshed `position`), occasionally with
new vehicles appended.

### The composition table

| Features available           | Stage list (in order)                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| schedule only                | `scheduleScanner`                                                                      |
| + GTFS-RT                    | `scheduleScanner`, `rtIngester`, `rtScheduleReconciler`                                |
| + Tranzy                     | `scheduleScanner`, `rtIngester`, `tranzyIngester`, `rtScheduleReconciler`, `multiSourceCorroborator` |
| any subset                   | composer drops the unavailable stages and keeps the rest in order                      |

The composer (`composePipeline(features): Stage[]`) is the one place that
encodes feature gating. The stages themselves never check feature flags —
if a stage is in the list it runs; if it isn't, it doesn't exist. This is
what keeps the system simple: the UI consumes whatever the pipeline output
is, and the pipeline's *shape* is the feature flag.

### What lives where

| Stage                       | File                                                          | Phase |
| --------------------------- | ------------------------------------------------------------- | ----- |
| `scheduleScanner`           | `lib/domain/pipeline/scheduleScanner.ts`                      | 4     |
| `rtIngester`                | `lib/domain/pipeline/rtIngester.ts`                           | 5     |
| `tranzyIngester`            | `lib/domain/pipeline/tranzyIngester.ts`                       | 5     |
| `rtScheduleReconciler`      | `lib/domain/pipeline/rtScheduleReconciler.ts`                 | 5     |
| `multiSourceCorroborator`   | `lib/domain/pipeline/multiSourceCorroborator.ts`              | 5     |

### Why this matters for the UI

The UI only ever binds to the **output** of `runPipeline`. It reads
`vehicle.kind`, `vehicle.type`, `vehicle.position`, `vehicle.eta`,
`vehicle.headsign` — nothing else. All the reconciliation reasoning,
multi-source confidence math, ghost detection, prediction smoothing —
*everything* — happens inside stages and never leaks. Adding a third live
source (some other city's API, a community feed) means: write one
`Ingester` stage, one merger if needed, drop both into the composition
table. Zero UI change.

---

## 6. Reconciler (revalidated from v1)

The reconciler is the only place that produces `Vehicle.kind`. It takes:

- `liveVehicles: LiveVehicleRaw[]` from each polled source, tagged with
  `source: LiveSource`
- `activeTrips: ScheduledRun[]` from the SQLite repo (trips whose service is
  active today and whose scheduled window covers `now`)
- `now: Date`

…and returns a `Vehicle[]`.

### 6.1 Match a live vehicle to a scheduled trip

V1 algorithm in
[vehicleMatchingUtils.matchVehiclesToSchedule L188-L290](../../apps/legacy/src/utils/schedule/vehicleMatchingUtils.ts):

> Convert position to "minutes elapsed since scheduled start" for both
> vehicle and candidate. Match by smallest delta within ±10 min.

V1's bands: ≤ 3 min → high, ≤ 7 min → medium, ≤ 10 min → low.

**v2 verdict:** keep, with two improvements.

- (a) Prefer matching by `trip_id` when the live source already exposes it
  in canonical form. GTFS-RT does
  ([live-data-analysis.md](live-data-analysis.md) — `45_1_LV_9_0721`); Tranzy
  does not (only `45_1`). When `trip_id` matches a row in `trips`, set
  `kind: 'reconciled'`, skip the timing math, `confidence: 'high'`.
- (b) When `trip_id` doesn't match exactly, run the v1 timing match, but
  only against trips of the **same route_id and direction_id** as the
  vehicle's reported route. v1 already filtered by route; v2 also filters by
  direction (GTFS-RT carries direction_id; Tranzy does too). Cuts false
  matches at terminuses where two directions overlap.

### 6.2 Promote single-source matches to multi-source

After per-source matching, group by `(matched trip_id, vehicle operator id
when known)`:

- 2+ sources point at the same trip → `kind: 'corroborated'`, `confidence:
  'high'`, `liveSources` is the union.
- 1 source only → `kind: 'reconciled'`, `confidence: 'medium'`.
- A live vehicle with no schedule match → `kind: 'live'`, `confidence` is
  `medium` if GPS fix is < 2 min old, else `low`.

### 6.3 Detect schedule-only (`predicted`) trips

V1 in [ghostVehicleUtils.identifyGhostTrips L62-L100](../../apps/legacy/src/utils/schedule/ghostVehicleUtils.ts).
Algorithm:

1. For every trip with `scheduled_start < now <= scheduled_end` on today's
   service, check whether any live source returned a vehicle on that trip.
2. If none did, the trip becomes a `Vehicle` of `kind: 'predicted'`.
3. Its `position` is generated by running the prediction engine §5 forward
   from the most recent scheduled stop using GTFS scheduled times for the
   per-segment speed.
4. `checkedSources` = the set of live sources that were polled.

**v2 verdict:** keep.

### 6.4 Suspect-duplicate handling

V1 flags `isSuspectDuplicate` when two vehicles claim the same trip
([vehicleMatchingUtils L260+](../../apps/legacy/src/utils/schedule/vehicleMatchingUtils.ts)).
The vehicle with the smaller timing delta wins; the rest get `confidence:
'low'`. v1 disables this on high-frequency routes (headway ≤ 10 min).

**v2 verdict:** keep, with the same headway carve-out.

### 6.5 Terminus / trip-end edge cases

The user mentioned "many exceptions at route ends" in v1. Reviewing
[v1 §4 GAPS](../../apps/legacy/src/utils/schedule/vehicleMatchingUtils.ts):

- A vehicle sitting at the terminus past its scheduled end → v1 keeps it
  matched until a new GPS update arrives with a different `trip_id`. v2
  inherits: define a 5 min grace window after `scheduled_end`, after which
  unmatched `reconciled` vehicles drop to `live` and the original trip
  becomes a `predicted` candidate until the next trip claims the vehicle.
- A vehicle deadheading (no `trip_id` reported) → v2 leaves it as `live`
  with `confidence: 'low'`. It does not appear in any station's arrivals
  (no trip → no `stops_on_trip`); it can appear on a map view scoped to its
  last-known `route_id`.

---

## 7. Configurable thresholds & operational edge cases

The buckets and the reconciler share a set of magic numbers (50 m, 5 min,
±10 min, etc.) that the user has surfaced as: "we should be able to tune
these without grepping the source." This section defines a single `Config`
shape and walks through the operational edge cases that the v1 reconciler
either got wrong or didn't address, with proposed v2 solutions.

### 7.1 The `Config` object

All thresholds live in one place — `lib/domain/config.ts` (Phase 4 follow-up
commit). Production defaults below; the `/settings/advanced` panel exposes
them so power users can tune.

```ts
export interface NearyConfig {
  // ── Bucketing (station view) ─────────────────────────────────────────
  /** A vehicle within this many meters of the stop is considered
   *  "physically at" it. v1: 50. */
  proximityAtStationM: number;
  /** Live vehicle that's > this far from the stop AND off the route shape
   *  is bucketed off-route. v1: 200. */
  offRouteDistanceM: number;
  /** Width of the "arriving" / "departing" windows around scheduled
   *  arrival / departure (full window = 2 × value, centred on schedule).
   *  v1: implicit 1 min. Default: 30 seconds for live, 60 seconds for
   *  schedule-only — see §7.2 below. */
  arrivingDepartingWindowS: number;
  /** Reserved — no longer used. Earlier drafts capped the 'departed'
   *  bucket at a flat N-min recency. v2 instead gates on the trip
   *  reaching its terminus (`scheduleScanner` filters past arrivals
   *  whose `trip_end_time` is already < now), so 'departed' shows
   *  every still-en-route vehicle that passed this stop. */
  recentDepartureWindowMin?: number;
  /** Future ETA threshold separating "arriving" from "incoming". v1: 2 min. */
  arrivingThresholdMin: number;
  /** A scheduled dwell shorter than this is treated as just-passing and
   *  surfaces as "arriving" rather than splitting into at-station. v1: 1. */
  minDwellGapMin: number;
  /** A live vehicle at the stop moving faster than this is "departing"
   *  (otherwise it's "at-station"). v1: 5 km/h. */
  departingSpeedKmh: number;

  // ── Reconciliation ───────────────────────────────────────────────────
  /** Max |timing delta| (min) between live vehicle and scheduled trip
   *  for a match. v1: 10. */
  matchToleranceMin: number;
  /** Confidence bands by timing delta (min). v1: 3 / 7 / 10. */
  matchConfidenceBands: { high: number; medium: number; low: number };
  /** Headway threshold below which suspect-duplicate flagging is
   *  disabled (the timing heuristic gets unreliable on frequent service).
   *  v1: 10. v2: also gates start-station inference (§7.5). */
  highFrequencyHeadwayMin: number;
  /** Grace window after a trip's scheduled end time during which a
   *  vehicle stuck at the terminus stays bound to the old trip. v2 new. */
  terminusGraceMin: number;
  /** A GPS fix older than this is "stale" and forces confidence to low.
   *  v1: 30 min. */
  staleGpsMin: number;

  // ── Prediction ───────────────────────────────────────────────────────
  /** Max time the position-prediction engine extrapolates forward before
   *  capping `eta.confidence` to low. v2 new. */
  maxExtrapolationMin: number;
  /** Static fallback speed for the speed estimator's last resort. v1: 25. */
  fallbackSpeedKmh: number;
}
```

### 7.2 Live-data-aware wording matrix

When live data confirms a vehicle's position, we can be tighter and more
confident about the at-station / arriving / departing micro-states. When
it's schedule-only we have to assume a wider window. The thresholds in
§7.1 split per source (`arrivingDepartingWindowS = 30s` for live, `60s`
for schedule-only — implemented as two configurable values).

The displayed wording also shifts subtly — same bucket, different tone:

| Bucket       | Schedule-only wording           | Live wording                       |
| ------------ | ------------------------------- | ---------------------------------- |
| `at-station` | "Scheduled at station now"      | "At station"                       |
| `departing`  | "Scheduled to leave"            | "Leaving now"                      |
| `arriving`   | "Arrives in ~1 min"             | "Arriving"                         |
| `incoming`   | "In ~3 min (scheduled)"         | "In 3 min"                         |
| `departed`   | "Departed ~2 min ago (scheduled)" | "Departed 2 min ago"             |

Implementation: a helper `wordingFor(bucket, vehicle): string` reads
`vehicle.kind` to decide; lives next to `bucketOf`. The "(scheduled)"
qualifier is only added when `kind ∈ {scheduled, predicted}`.

### 7.3 Late-vehicle reconciliation (the 15-min-late example)

**Scenario.** Route X runs every 30 min. Schedule says the next bus at this
stop is in 2 min. A live GPS vehicle for route X is 15 min late — its
trip_id (via GTFS-RT) is the *previous* schedule trip, not the on-time one.
A naïve reconciler would match the live vehicle to its trip_id and stamp
its ETA at this stop based on that trip's stop_times — ETA = (scheduled
departure of late trip from this stop) − now = something like 27 min ago
(already past!) and we'd put it in `departed`. Meanwhile the on-time
schedule bus shows as `arriving` even though no GPS vehicle exists for it.
The user sees one phantom "arriving" and misses the actually-incoming
late bus.

**The v1 hack** ([vehicleMatchingUtils.ts L188-L290](../../apps/legacy/src/utils/schedule/vehicleMatchingUtils.ts))
tried to fix this by re-matching live vehicles to whichever trip minimised
the |timing delta|, ignoring the trip_id the operator reported. That works
when the operator-reported trip_id is wrong, but breaks down when the
*timing* is wrong (the late case).

**v2 approach** — three signals, combined in `rtScheduleReconciler`:

1. **Trust trip_id first.** If GTFS-RT's `trip_id` matches a trip in the
   SQLite `trips` table, that's authoritative — the vehicle IS on that
   trip. The "ETA at this stop" then comes from the live vehicle's
   *predicted travel time* (route shape + speed estimate), NOT from the
   trip's scheduled stop_times. This is the §5 prediction engine doing its
   job.
2. **Compute "late offset" as the headline metadata.** The reconciler
   stamps `vehicle.lateOffsetMin = nowMin − scheduledArrivalAtThisStop` so
   the UI can show "5 min late" in the station card. The bucketing uses
   the predicted ETA from signal 1, not the lateOffset.
3. **Promote the on-time slot to `predicted` not `arriving`.** When a
   scheduled trip should be running per the calendar and no live vehicle
   was matched to it (signal 1 found a different trip taking its place),
   the scheduleScanner emits it as `kind: 'predicted'` with
   `checkedSources: ['gtfs-rt']`. The UI shows both: the *live late one*
   with its real ETA, AND the *predicted on-time one* with a "no live
   tracking" badge. The user sees the truth — one bus might come now (late)
   and a second one might come on time, both bound for the same headsign.

Net behaviour: in the user's scenario, the station card shows
`Route X · 15 min late · arriving in 3 min` (live) AND
`Route X · scheduled · arriving in 2 min (no live tracking)` (predicted).
If the predicted one never materialises in subsequent polls, it goes from
`predicted` to `departed` after its scheduled time + recency window —
correct.

### 7.4 Frequent vehicles — smarter than v1's flat filter

V1 disabled suspect-duplicate detection on routes with headway ≤ 10 min
([vehicleMatchingUtils L39-L43](../../apps/legacy/src/utils/schedule/vehicleMatchingUtils.ts)).
The reasoning was sound (timing-based matching is unreliable on frequent
service) but the response (disable a feature) is heavy-handed — the
duplicate detection has *some* signal value.

**v2 approach**, two changes:

1. **Use `trip_id` to cut Gordian knots.** When the live source carries a
   canonical trip_id (GTFS-RT does;
   [live-data-analysis.md](live-data-analysis.md)), duplicate detection
   doesn't need timing math at all — two vehicles can't legally share a
   `trip_id`. The high-frequency carve-out disappears in that path.
2. **Scale confidence down by headway, don't disable.** When trip_id is
   absent (Tranzy fallback), the timing-delta match still happens but the
   confidence band shrinks based on the route's median headway in the
   ±2 hour window around now:
   - headway > 30 min → use v1 bands (3/7/10 min)
   - headway 10..30 min → tighten to (1.5/3.5/5 min)
   - headway ≤ 10 min → tighten to (0.5/1.5/2.5 min) AND require a
     second consistent poll before promoting `live` → `reconciled`
     (single observation isn't enough)
   The carve-out becomes "require persistence" not "give up."

Implementation: precompute `routeHeadwayMin(routeId, now)` once at
reconciler startup (median of inter-departure intervals at the route's
busiest stop within ±2h). Cache for the polling period.

### 7.5 Start-station / terminus special case

**Scenario.** Route Y starts at Terminal A. Schedule says next departure is
at 09:15. At 09:08 a live GPS vehicle for route Y is 100 m from Terminal A
(in the terminal's bus lot). A naïve reconciler:
1. Sees the vehicle has trip_id of route Y's 08:45 trip (the one that just
   arrived and parked).
2. Computes its "expected position" along that trip → end of the trip.
3. Vehicle's actual position is at the end → matches. Calls it `reconciled`
   for the 08:45 trip. Bucket: `departed` (the trip ended 23 min ago).
4. Doesn't surface anything for the 09:15 departure — until 09:15 ticks and
   the predicted "08:45 trip departed bucket" rolls off.

But the user is at Terminal A looking for the 09:15 bus. They want to know
"the bus is here, sitting on the lot." We failed.

**v2 approach** — terminus-aware reconciliation in `rtScheduleReconciler`:

A stop S is a **terminus** for a trip T if:
- S is `trips[T].first_stop` (per stop_times ordered by stop_sequence), OR
- S is `trips[T].last_stop`

When the reconciler matches a live vehicle V to a finished trip T, and:
- V is within `2 × proximityAtStationM` of T's last stop S (i.e. parked at
  terminus), AND
- The same vehicle (same operator id) is the next-trip-from-S candidate
  per the schedule (route + direction match a next-departure trip
  T_next from S within `terminusGraceMin`)

…then V's match is **upgraded** from `reconciled-to-T (departed)` to
`reconciled-to-T_next (at-station)`. The UI shows the bus at the terminus,
correctly bound to the upcoming trip.

**The mistaken-bus example** (from your notes): GPS vehicle 100 m from
station, schedule not for another X minutes, vehicle gets bucketed as
"departed late from last trip." Same fix — if the vehicle is sitting at
the start station of a near-future trip on the same route, prefer the
forward binding. Symmetric in spirit but more conservative: only triggers
when start station, not random along-route stops.

**Sub-case: GPS error at start station.** Bus parked at terminus, schedule
says next departure in 8 min, but vehicle's GPS briefly reports a fix 100 m
away (wrong direction, doesn't match shape). Without the terminus
heuristic, this looks like "vehicle left early, now en route." With it:
within the 5-min grace window of a terminus, GPS positions outside the
proximity radius are *ignored* (re-stamped to the terminus coords) until
either (a) the scheduled departure time passes or (b) a second consistent
off-terminus fix arrives. New flag: `vehicle.flags = ['gps-suppressed-at-terminus']`
visible in debug only.

### 7.6 Tentative matches — partial confidence to multiple candidates

**Scenario.** GPS vehicle, route Y, no trip_id (Tranzy path). Two
candidate scheduled trips within timing tolerance: T1 (the on-time one,
delta = 3 min) and T2 (the late one, delta = 8 min). v1 picks the smaller
delta (T1) and stamps `reconciled` with `low` confidence — but the user
doesn't see T2 at all.

**v2 approach** — let the reconciler emit a `tentative` *flag* (NOT a new
kind), and pair it with `predicted` ghost twins for the rejected
candidates:

- Live vehicle emitted as `kind: 'reconciled'`, `confidence: 'low'`,
  `flags: ['tentative']`, with `scheduledRun = T1` (the picked one).
- T2 still emitted as `kind: 'predicted'` (didn't have a live match) with
  `flags: ['tentative-twin-of:<live-vehicle-id>']`.

The UI renders T1 normally with a small "tentative" indicator (e.g. ⚠️
chip) and shows T2 below it as a separate predicted row. The user sees
"either this is the on-time bus or the late one is — they're both within
8 min and we can't tell which yet."

When the next poll arrives:
- If the vehicle's new position is consistent with T1's expected progress
  → drop the flag, T2 stays predicted (or rolls off if its scheduled
  window passed).
- If it's consistent with T2 instead → re-match to T2, T1 reverts to
  predicted.
- If both still match → keep both tentative. The user still sees both.

Implementation note: only used in the Tranzy-only fallback path. The
GTFS-RT path has trip_id and never goes tentative.

### 7.7 Wait-for-second-observation rule

Cuts across several of the above. The general principle: don't promote
a single observation to a high-confidence reconciliation when the heuristic
is shaky. Spelled out:

- Tentative matches (§7.6) require a confirming poll before flag drops.
- High-frequency routes (§7.4) require 2 consistent polls before
  `live` → `reconciled` promotion.
- Terminus matches (§7.5) require either schedule-time tick or a second
  off-terminus fix before forward-binding switches off.

This is the same idea three times. Implement once as a small
`observationHistory: Map<vehicleId, { lastNFixes, lastNMatches }>` in the
reconciler state; expose a single helper `requiresPersistence(reason)`
that the policies above call.

### 7.8 What's NOT here (deferred)

- **Bearing-based off-route detection** — GTFS-RT carries bearing; v1
  doesn't use it; v2 won't either until Phase 6+.
- **GPS jump detection** (>X m in Y s, snap to shape) — v1 lacks it, v2
  defers to a follow-up after Phase 5.
- **Per-feed config overrides** — `Config` is global for v2. A future
  feed-specific overlay can come if Bucharest needs different defaults
  than Cluj.

---

## 7.5 Implementation sequencing

This doc does **not** change the [plan.md](plan.md) phase ordering. It
refines what Phase 4 / 5 / 6 must actually produce. Status as of the
latest commit:

### Phase 4 (Domain + Stations, schedule-only) — status

- `lib/domain/types.ts` — new Vehicle union per §2 + `VehicleType` enum
  + `vehicleTypeFromGtfs` mapper. **shipped**
- `lib/domain/buckets.ts` + tests — bucketOf, compareForBoard,
  filterForStationView. **shipped**
- `lib/domain/stationBoard.ts` + tests — assembleStationBoard,
  dedupRoutes. **shipped**
- `lib/domain/pipeline/` — types.ts, scheduleScanner.ts, timeUtils.ts
  (with feed-timezone-aware helpers). **shipped**
- `getStationArrivals(stopId, nowMs, windowMinutes)` and
  `getStationBoardsNear(...)` worker methods. **shipped**
- Worker stores feed timezone at setFeed and uses it for now-math.
  **shipped**
- Stations view (`/`) — real proximity list with bucketed boards.
  **shipped**
- Settings: dropped `showGhostVehicles` toggle (initially renamed to
  `showScheduleOnlyVehicles`, then removed — schedule-only vehicles are
  always shown). New `showDepartedVehicles` toggle. **shipped**
- Real position-prediction engine (`lib/domain/prediction/`) per §5 —
  speed estimator, position interpolation, ETA. **deferred to Phase 5**
  (predicted vehicles currently use the stop coords as a placeholder).
- `Config` object from §7.1 and live-data-aware wording from §7.2.
  **deferred** to a follow-up commit once one live source exists to
  exercise the wording shift.

### Phase 5 (Live data) — refined deliverables

- Live worker polls GTFS-RT (no key) and Tranzy (if key set), tags
  responses with `source: LiveSource`.
- Pipeline gains `rtIngester`, `tranzyIngester`, `rtScheduleReconciler`
  (§6 + §7.3 late-vehicle logic + §7.5 terminus heuristic),
  `multiSourceCorroborator` (§6.2).
- `requiresPersistence` helper (§7.7) lives in the reconciler.
- `Config` (§7.1) lands and `wordingFor` (§7.2) is wired into
  `VehicleCard`.
- Reactive bus: `vehiclesStore.svelte.ts` (singleton).
- Real prediction engine (the §5 deferral above) ships here.

### Phase 6 (Favorites, Schedule, Map) — refined deliverables

- `/schedule/route/[routeId]` and `/schedule/route/[routeId]?stop=[stopId]`:
  same `<ArrivalsBoard>` component bound to a different filter; both
  consume `assembleStationBoard`.
- `/map/route/[routeId]?selected=[vehicleId]`: shape + every vehicle for
  the route + selected ring. Leaflet panes per §4.
- `/map/vehicle/[vehicleId]`: redirect to the route map with `selected` set.
- Favorites stores both saved routes and saved stations; cards link to
  the drill-downs above.

---
## 8. Cross-checks done while writing this doc

- v1 categorization vs user request — covered in §3, all four user buckets
  + `at-station` are derived from v1 inputs.
- v1 ghost-vehicle definition vs new `predicted` name — definition unchanged
  (§6.3). The `showGhostVehicles` toggle was renamed once, then dropped:
  schedule-only vehicles are always shown.
- v1 map vs user claim "v1 only showed one vehicle" — refuted (see exploration
  report); v1 already supported many. The change in v2 is the **default** —
  open the map and you see the route, not just the vehicle you came from.
- v1 prediction engine — §5 cites every file and flags the three real
  changes (per-stop dwell from GTFS, 5 min extrapolation cap, schedule-driven
  speed for `predicted`).
- v1 reconciliation — §6 keeps the timing-delta algorithm intact and adds
  the `trip_id`-canonical fast path for GTFS-RT, which only became possible
  once we moved to a SQLite-backed canonical `trips` table.

---

## 9. Open questions

- Should the bucket counts on a station card show "5 incoming · 1 at-station ·
  1 departing" or the simpler v1-style "next 3 routes" badge row? Decided
  later — UI Phase 4 will iterate.
- Whether `live-data-analysis.md`'s 61 s GTFS-RT lag warrants a per-source
  "freshness" tag on `Vehicle.liveSources` (e.g. `[{source, ageMs}]`).
  Deferred to Phase 5 implementation.
- Trip Planner (Phase 8) reuses the schedule view as its result renderer
  per [plan.md §9 Phase 8](plan.md); no impact on this design.
