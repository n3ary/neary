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
  | 'scheduled'      // trip in schedule, not yet active, no GPS expected
  | 'predicted'      // trip should be running now per schedule, no live GPS
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

  /** True if this stop is marked drop-off-only for this trip (pickup_type=1
   *  in GTFS). UI hides this vehicle from a station view by default unless
   *  `userPrefs.showDropOffOnly` is on. Not relevant on map view. */
  dropOffOnly?: boolean;
}
```

### Confidence and visual variant in one table

| Kind            | `position.source`            | Visual                                | Suppressed by `showGhostVehicles=false`? |
| --------------- | ---------------------------- | ------------------------------------- | ----------------------------------------- |
| `corroborated`  | `gps` (latest of N sources)  | solid + check-circle pip + bold border | no                                        |
| `reconciled`    | `gps`                        | solid + calendar pip                  | no                                        |
| `live`          | `gps`                        | solid                                 | no                                        |
| `predicted`     | `predicted-from-schedule`    | dashed                                | **yes** (rename: now "schedule-only vehicles") |
| `scheduled`     | n/a (no marker on map, list item with calendar icon) | 50 % opacity, calendar icon | yes |

The `showGhostVehicles` userPref is renamed to **`showScheduleOnlyVehicles`**
to match the new model.

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

1. `at-station` → 0
2. `departing` → 1
3. `arriving` → 2
4. `incoming` → 3
5. `departed` → 4
6. `off-route` → hidden by default

Tie-break: ascending `eta.minutes` (so "incoming in 3 min" beats "incoming in
7 min"), then by `vehicle.id`.

### Drop-off-only

When `userPrefs.showDropOffOnly === false` (default in v2), vehicles with
`vehicle.dropOffOnly === true` are **filtered out before bucketing**. The
information comes from GTFS `stop_times.pickup_type=1` for the trip+stop
pair. When the user enables the toggle, those rows appear with a small
"drop-off only" chip in the row.

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
| `predicted`    | route color        | **dashed 1 px** | small dashed-clock             | suppressed if `showScheduleOnlyVehicles=false` |
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

## 7. Implementation sequencing

This doc does **not** change the [plan.md](plan.md) phase ordering. It
refines what Phase 4 / 5 / 6 must actually produce. Concrete deltas:

### Phase 4 (Domain + Stations, schedule-only) — refined deliverables

- New `apps/web/src/lib/domain/vehicle.ts` — type from §2.
- New `apps/web/src/lib/domain/prediction/` — `speed.ts`, `position.ts`,
  `eta.ts` ported per §5.
- New `apps/web/src/lib/domain/reconciler.ts` — §6.1, §6.3 only (no live
  yet, so every active trip becomes `predicted`).
- New repo method (replaces `getStationsNearAsVehicles` named in
  [plan.md §9 Phase 4](plan.md)): `getStationArrivals(stopId, now,
  windowMinutes): UpcomingDeparture[]` — the bucketer in §3 runs in the
  domain layer, not the worker.
- Settings: rename `showGhostVehicles` → `showScheduleOnlyVehicles` in
  [userPrefs.svelte.ts](../../apps/web/src/lib/stores/userPrefs.svelte.ts).
  Old key auto-migrates on read (one-time migration).

### Phase 5 (Live data) — refined deliverables

- Live worker polls GTFS-RT (no key) and Tranzy (if key set), tags responses
  with `source`.
- Reconciler §6.2, §6.4, §6.5 turn on.
- Reactive bus: `vehiclesStore.svelte.ts` (singleton) exposing
  `vehicles: Vehicle[]` filtered per current view.

### Phase 6 (Favorites, Schedule, Map) — refined deliverables

- `/schedule/route/[routeId]` and `/schedule/route/[routeId]?stop=[stopId]`:
  same `<ArrivalsBoard>` component bound to a different filter.
- `/map/route/[routeId]?selected=[vehicleId]`: shape + every vehicle for the
  route + selected ring. Leaflet panes per §4.
- `/map/vehicle/[vehicleId]`: redirect to the route map with `selected` set.
- Favorites stores both saved routes and saved stations; cards link to the
  drill-downs above.

---

## 8. Cross-checks done while writing this doc

- v1 categorization vs user request — covered in §3, all four user buckets
  + `at-station` are derived from v1 inputs.
- v1 ghost-vehicle definition vs new `predicted` name — definition unchanged
  (§6.3); the toggle (`showScheduleOnlyVehicles`) name now matches the data.
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
