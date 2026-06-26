# Prediction v2 — Design Document

Status: **DRAFT for review**
Owner: TBD
Last updated: 2026-06-27
Related code: `apps/web/src/lib/domain/predictPosition.ts`, `apps/web/src/lib/domain/predictEta.ts`, `apps/web/src/lib/workers/gtfs.worker.ts`, `apps/legacy/src/utils/vehicle/**`, `neary-gtfs/feeds/cluj-napoca/build.js`

---

## TL;DR

The current v2 prediction pipeline uses the **schedule as the spine**: per-stop arrival times come from `stop_times.txt`, and live GPS is used only for reconciliation and ETA refinement on the Stations board. Map markers move between scheduled stop times, not between GPS pings.

That's a regression vs v1, which used **GPS as the spine** with a four-tier speed cascade (vehicle speed → nearby fleet average → distance-from-center heuristic → static fallback). v1's ETA was meaningfully more accurate for buses running late or off-pattern.

To get back to v1-quality (and beyond) without dragging in v1's quirks, this doc proposes a three-stage pipeline:

1. **Build-time** — produce a *better* schedule spine in `neary-gtfs` (shape-aware distance, time-of-day speed profile, dwell heuristic), and persist `shape_dist_traveled` per stop_time. This stays cheap because the math runs once per feed build, not per browser tick.
2. **Runtime, no GPS** — render the schedule as today, but use the pre-computed `shape_dist_traveled` so position interpolation is O(1) per tick, no client-side projection.
3. **Runtime, with GPS** — port v1's speed cascade as a domain-only module. Speed is per-segment (close-to-bus uses local estimators; far segments fall back through the cascade). ETA is computed by walking remaining shape segments with each segment's best-available speed + each stop's dwell.

This document mines v1 for what to copy, calls out where v1 had bugs we should *not* port, validates the existing `neary-gtfs` interpolation formula, and lists the open design questions that need a decision before we implement.

---

## 1. Today's state (v2)

### 1.1 The schedule spine

[`apps/web/src/lib/workers/gtfs.worker.ts`](apps/web/src/lib/workers/gtfs.worker.ts) reads per-stop times directly from `stop_times.txt` as published in the SQLite database. No runtime interpolation. Three consumers:

- `getStationArrivals(stopId, nowMs, windowMin)` — feeds the Stations board.
- `getRouteSchedule(routeId, dir, ...)` — feeds the Schedule tabs (Today / Tomorrow / Week).
- `getRouteMapView(routeId, dir, ...)` — feeds the Map view with `{shape, stops, trips}`.

Where do those `stop_times.txt` rows come from? See §3 below — for Cluj they're interpolated at build time from a single departure time at 18 km/h; for every other feed currently in the registry they're untouched operator data.

### 1.2 Position rendering (Map view)

[`apps/web/src/lib/domain/predictPosition.ts`](apps/web/src/lib/domain/predictPosition.ts) exposes two predictors:

- `predictPosition(stops, nowMin)` — straight-line interpolation between consecutive stops. O(stops).
- `predictPositionOnShape(plan, nowMin)` — uses a `TripShapePlan` whose `legs[]` array stores `{arrivalMin, distAlongM}` per stop after projecting onto the polyline. O(log stops) per call.

Both are called once per visible trip per `nowTicker` tick (30 s). `buildTripShapePlan` runs once per route view (memoised in the page-level `$derived`).

**The critical thing:** neither predictor consumes the live GPS observation. They take `nowMin` and the static schedule, and emit a position that says "where the schedule says the bus should be at this minute". A bus that's 10 minutes late renders at the wrong place on the map.

### 1.3 ETA prediction (Stations board)

[`apps/web/src/lib/domain/predictEta.ts`](apps/web/src/lib/domain/predictEta.ts) is the *only* place live GPS is currently consumed for prediction:

- Triggered inside `assembleLiveBoard` for **reconciled rows at intermediate stops** only.
- Computes `etaMin = remainingDistAlongShape / vehicle.speedMs * 60`.
- Only the vehicle's own reported `speedMs` is used. No nearby-fleet averaging, no city-center heuristic, no per-segment cascade.
- Speeds ≤ some threshold fall back to schedule ETA.

This is the v2 system's one nod to v1's GPS-aware ETA — a single-tier cascade where v1 had four.

### 1.4 Refresh + tick cadence

- Live poll: every 15 s (`DEFAULT_CONFIG.livePollMs`).
- UI tick: every 30 s (`nowTicker`, hardcoded).
- Manual refresh button: fires `refreshBus.tick++` + an immediate live poll. Does *not* re-trigger predictors — they wait for the next `nowTicker` tick.
- Worst-case visible latency for "bus moved → dot moves": ~55 s. See `temporary/` or the earlier audit for the full table.

---

## 2. What v1 did

Source: [`apps/legacy/src/utils/vehicle/`](apps/legacy/src/utils/vehicle), [`apps/legacy/src/utils/arrival/`](apps/legacy/src/utils/arrival), [`apps/legacy/src/utils/schedule/`](apps/legacy/src/utils/schedule).

### 2.1 GPS spine

Every position calculation started from the live `vehicle.{latitude, longitude}`. The schedule was a reconciliation reference, not the source of position. Once a fresh GPS sample existed:

1. Project the vehicle's GPS onto the route shape (`projectPointToShape`).
2. If `vehicleProjection.distanceToShape > OFF_ROUTE_THRESHOLD` (200 m), declare the vehicle off-route and skip prediction — fall back to its raw GPS.
3. Walk consecutive stop projections to figure out which segment the vehicle is in. That gave a `{previousStop, nextStop}` pair with a HIGH/MEDIUM confidence grade.

### 2.2 The speed cascade — copy this

[`apps/legacy/src/utils/vehicle/speedCalculationUtils.ts`](apps/legacy/src/utils/vehicle/speedCalculationUtils.ts):

| Tier | Method | Trigger | Confidence |
|---|---|---|---|
| 1 | **API speed** — `vehicle.speed` | `vehicle.speed > 5 km/h` | HIGH |
| 2 | **Nearby fleet average** — arithmetic mean of other vehicles' speeds within 1000 m of this one, after dropping speeds ≤ 5 km/h | ≥ 2 valid neighbours | HIGH (≥5 samples) / MED (≥2) / LOW |
| 3 | **City-center heuristic** — linear interp: `15 + 30 × (1 − dist / 20 km)`, clamped [15, 45] km/h, with `dist = haversine(vehicle, centroidOfStops)` | tier 2 unavailable | HIGH (<6 km) / MED / LOW |
| 4 | **Static fallback** — 25 km/h | everything else | VERY_LOW |

Two clarifications vs the user's recollection:
- v1 used **arithmetic mean**, not p60 or trimmed mean. The user's intuition (drop slow vehicles + average) is what shipped; the percentile idea didn't.
- v1's nearby-vehicle filter is *only* `speed > 5 km/h` + `dist ≤ 1000 m`. There's no direction-of-travel filter, no same-route filter. That's a known weakness — see §6.5.

### 2.3 ETA blend distance

v1 didn't apply the cascade per segment. It produced *one* speed per vehicle, then blended that toward a constant average (25 km/h) as the predicted stop got further away:

```ts
const weight = Math.min(1, distance / ETA_SPEED_BLEND_DISTANCE_METERS);  // 2 km
travelTimeMinutes = timeAtCurrent * (1 - weight) + timeAtAverage * weight;
```

So segments within 2 km of the bus used the predicted speed; beyond 2 km, the prediction smoothly faded into 25 km/h. **This is the closest v1 got to "per-segment speed"** — but it's a smoothing trick, not a real per-segment estimator. The user's instinct to do real per-segment estimation is an improvement, not a port.

### 2.4 Distance + dwell

- Preferred: shape projection. Distance = `distToShapeFromVehicle + alongShape(vehicleProj → stopProj) + distToShapeFromStop`. Documented in `distanceUtils.ts`.
- Fallback: haversine through intermediate stops.
- Dwell: `0.5 min × intermediateStopCount`. Constant; no per-stop variation.

### 2.5 Reconciliation

`vehicleMatchingUtils.ts` matches a live vehicle to the closest scheduled trip on the same `(route, direction)` by minimum `|elapsed_so_far − scheduled_elapsed_so_far|`. Tolerance ±10 min. Multiple vehicles matching the same trip → only the closest survives; the rest are flagged as suspect duplicates. High-frequency routes (≤ 10 min headway) skip duplicate flagging — the tolerance overlaps real bus separation.

### 2.6 Stale-GPS handling

v1 categorised GPS freshness in three bands: HEALTHY (< 3 min), STALE (< 5 min), VERY_STALE (≥ 5 min). At STALE the *position* still moved (dead-reckoned along the shape using the last good speed), but the *ETA source* downgraded from `gps` to `schedule` with a confidence downgrade (`high → medium`, `medium → low`, `low → low`).

### 2.7 Cadence

- Live API poll: every 60 s (cached).
- Prediction-only re-run: every 15 s (no API hit; just re-projects with elapsed time).
- Auto refresh of full state: every 120 s.

v2 today polls **4× faster** than v1 (15 s vs 60 s) thanks to the worker offloading the parse cost. The thing v1 had that v2 lost is the *predictor* running at 15 s — today's v2 predictor only runs every 30 s on the `nowTicker`, so even fresh GPS sits unused for up to 30 s. Matching the v2.5 predictor cadence to the poll cadence (15 s for both) restores v1's inner-loop frequency on cheap modern hardware. See §6.5 for why 15 s is the right number and how marker smoothness is handled on the map.

### 2.8 v1 things to NOT port

- **City centre = centroid of all stops.** Works in a roughly radial city like Cluj; breaks immediately for any city with a riverfront, a spread-out metro area, or multiple density poles. Either feed-configured or unused; see Q3.
- **Single per-vehicle speed used for the whole route.** The user explicitly wants per-segment. The blend-distance trick was the compromise v1 settled on; we should do better.
- **Mean over nearby vehicles, not percentile or trimmed mean.** One stopped or one runaway bus pulls the estimate. p60 of the >5 km/h cohort is a small, cheap upgrade.
- **No direction-of-travel filter on nearby vehicles.** A bus on the opposite carriageway crawling through traffic shouldn't drag down a bus on the express lane the other way. Filter by `direction_id` if available, or by bearing similarity.
- **Vehicle matching by timing alone.** GPS position is available at the matching layer too — using it would make matching more robust against same-time crossings.

---

## 3. Validation: `neary-gtfs` interpolation

Hypothesis (the user's framing):

> "during gtfs assembly, if we have only start station leave time and end station arrival time or similar, we divide the whole length of the journey based on segment length (intermediary) and we compute schedule times at intermediary stations"

Reality, found in [`neary-gtfs/feeds/cluj-napoca/build.js`](../../../neary-gtfs/feeds/cluj-napoca/build.js):

```js
// interpolateStopTimes(startTime, stops) — lines 166–188
//   1. Cumulative HAVERSINE distance between consecutive stops (NOT shape).
//      Fallback 400 m if a stop is missing coordinates.
//   2. totalDuration = (totalDist_km / 18 km/h) * 3600 seconds
//   3. boundedDuration = clamp(totalDuration, numStops * 60, numStops * 300)
//   4. arrival_time[i] = departure_time[i] = startTime + cumDist[i] / totalDist * boundedDuration
```

Findings:

1. **The hypothesis is correct only for Cluj.** Every other feed in `countries.json` is mirrored from Transitous untouched — they keep the operator's published intermediate times, which may or may not be accurate.
2. **Distance is haversine between consecutive stops, NOT shape-aware.** Two stops on opposite sides of a river get a straight-line distance that ignores the bridge detour. For Cluj's grid this is mostly fine; for any city with topography it underestimates travel distance and therefore underestimates travel time.
3. **Speed is 18 km/h flat.** No time-of-day variation, no per-route variation, no city-center vs outskirts variation. Cluj rush hour is ~12 km/h on Calea Mănăștur; off-peak is ~25 km/h on Eroilor.
4. **Dwell is zero.** Every intermediate stop has `arrival_time === departure_time === interpolated_value`. A typical 20-stop route therefore loses 5–10 minutes of cumulative real dwell.
5. **`shape_dist_traveled` is not populated.** The SQLite schema has the column ([`make-sqlite.js#L96`](../../../neary-gtfs/src/pipeline/make-sqlite.js#L96)) but `interpolateStopTimes` doesn't write it, and the schema only fills it from upstream when present. This means the runtime predictor has to project stops onto the shape itself, every time it builds a `TripShapePlan`.
6. **The min/max clamp can lie.** A 5-stop route at 18 km/h might compute 4 min total → clamped to 5 min minimum (60 s × 5). A 40-stop route across the whole city might compute 90 min → clamped to 200 min (300 s × 40). Both bounds can move every intermediate time noticeably.

**Verdict:** the existing interpolation is the right *shape* of solution (one place, runs once per build, deterministic), but the *parameters* are too coarse. The proposal in §5 keeps the architecture and fixes the parameters.

---

## 4. Industry context (brief)

The shipped systems that solve this in production cluster into four families:

1. **GTFS-RT TripUpdates** (Google Transit, most modern agencies). The agency sends per-stop predicted arrival times derived from their own AVL/CAD system. The client just renders. No client-side prediction needed.
   - Cluj does *not* publish TripUpdates. Only VehiclePositions. If that ever changes, most of this doc becomes irrelevant for Cluj.
2. **Schedule + delay propagation** (OpenTripPlanner default). The most recent observed delay at the most recent stop is propagated forward — `eta(future_stop) = scheduled(future_stop) + observed_delay`. Cheap, defensible, doesn't try to be smart. Falls down when a bus catches up later in the route (the delay keeps inflating).
3. **Per-segment historical speed** (OneBusAway, NextBus). Per `(route, direction, segment, hour-of-week)` they store the empirical mean travel time observed over the last N days. ETA = sum of remaining segments' empirical times. Requires a historical database and a backfill job. Genuinely accurate; orders of magnitude more infrastructure than we have.
4. **Kalman filter / state-space model** (TransitMaster, some recent academic systems). State = `(progress_along_route, current_speed)`, observation = each GPS ping. Updates the model each tick; predicts forward by extrapolating. Continuous, smooth, requires per-feed tuning of process noise.

What v1 did sat between (2) and (3) — heuristic speed estimation with no historical database. That's the right pocket of complexity for this app: more than the laziest schedule-delay propagation, far less than a Kalman filter or a historical pipeline. The v2 proposal stays in that pocket.

---

## 5. Proposed pipeline (v2.5)

Three stages, each with a single responsibility and a clear interface.

### Stage A — Build-time schedule, shape-aware

Lives in `neary-gtfs`. One job: produce per-stop times that are realistic enough to be useful even when no GPS exists. Runs once per feed build; output is plain `stop_times.txt` + a fresh `shape_dist_traveled` column.

**Changes vs today's `interpolateStopTimes`:**

1. **Use the shape, not haversine.** For each consecutive `(stop[i], stop[i+1])` pair on a trip, compute distance along the polyline using the existing `projectOnPolyline` math (port from `apps/web/src/lib/domain/shapeProjection.ts`). Fallback to haversine only when the trip has no `shape_id`.
2. **Time-of-day speed profile** instead of a single 18 km/h. Three buckets, derived from real Cluj data:
   - Peak (07:00–09:00, 17:00–19:00 weekdays): `kmh_peak` (default 12)
   - Off-peak day: `kmh_offpeak` (default 22)
   - Night (22:00–05:00): `kmh_night` (default 30)
3. **Per-stop dwell.** A flat 20 s per stop is a defensible default. The first stop (origin) gets 0 — the published departure time already accounts for layover. The terminus gets 0 — there is no continuation.
4. **Populate `shape_dist_traveled`** on every `stop_times` row using the projection. This is the single biggest win for runtime cost: the web app can then derive `TripShapePlan.legs[i].distAlongM` for free instead of projecting per stop per route view.
5. **Don't lie at the bounds.** Drop the `numStops * 60` / `numStops * 300` clamp; if the speed profile says a route takes 18 min, let it. The clamps mostly mask bad input — they shouldn't be a load-bearing safety net.

**Open question O.1:** ~~should the speed profile be per-feed or per-route?~~ **DECIDED 2026-06-27 — per-feed.** Per-route is overkill; in the city centre many routes overlap with essentially the same traffic profile. Lives in `neary-gtfs/feeds/<id>/config.json` as three numbers (`kmh_peak`, `kmh_offpeak`, `kmh_night`).

**Open question O.2:** can we *learn* the profile from past GTFS-RT VehiclePositions if we capture them for a week? That's a separate "build a tiny historical store" project — answer is probably "yes, eventually" but not in this design.

### Stage B — Runtime, no GPS

The current `predictPosition` / `predictPositionOnShape` keep working, but now consume the build-time `shape_dist_traveled` directly. The per-page `TripShapePlan` derived collapses from "project every stop onto the shape" to "read `shape_dist_traveled` off the row". Same O(log stops) per tick, but the build-once cost of `buildTripShapePlan` is now ~free.

No new public API. The `RouteMapView.stops[]` payload starts carrying `distAlongM` per stop directly from SQLite.

### Stage C — Runtime, with GPS (the v1 port, modernised)

Three pieces, all in `apps/web/src/lib/domain/`, pure TS, unit-tested:

#### C.1 `speedEstimator.ts`

```ts
type SpeedSample = {
  kmh: number;
  source: 'self' | 'fleet' | 'tod' | 'static';
  confidence: 'high' | 'medium' | 'low' | 'very-low';
};

estimateSegmentSpeed(args: {
  segment: { fromStop: PredictStop; toStop: PredictStop };
  vehicle: LiveVehicleObservation;
  nearbyVehicles: readonly LiveVehicleObservation[];  // pre-filtered: same direction, within 1km
  segmentDistanceFromVehicleM: number;                // 0 = current segment
  todBucket: 'peak' | 'offpeak' | 'night';            // from feed clock + Stage A profile
  feedDefaults: { kmh_peak; kmh_offpeak; kmh_night };
}): SpeedSample
```

Cascade rules — v1's, with the three fixes from §2.8. **DECIDED 2026-06-27 (Q.3): keep v1's city-centre tier as well**, sitting between the time-of-day profile and the static fallback. The cascade is therefore five-tier per segment:

1. **Current segment + the next one (distance < 500 m):** use `vehicle.speed` if `> 5 km/h`, else go to step 2.
2. **2–5 segments out (500 m – 2 km):** p60 of `nearbyVehicles[].speed`, after dropping speeds ≤ 5 km/h and after filtering by same `direction_id`. If fewer than 2 samples, go to step 3.
3. **Far segments (> 2 km) OR cascade hit a wall:** time-of-day profile (Stage A, per-feed defaults), with the *expected* speed for the segment's clock band (peak/off-peak/night).
4. **City-centre tier (v1 port):** linear interpolation `15 + 30 × (1 − dist / 20 km)` km/h on `dist = haversine(segmentMidpoint, feedCentroid)`. Same formula as v1; the centroid is computed once at build time per feed and shipped in the SQLite metadata so the runtime predictor doesn't recompute it. Cluj is roughly radial; for non-radial cities this tier still gives a *floor* better than the static fallback while degrading gracefully.
5. **Static fallback:** `kmh_offpeak` from feed defaults, marked `very-low`.

Critically: **the cascade runs per segment**, not per vehicle. A bus stuck in central traffic still gets fast far-segment estimates if the city is empty at the route's outer end. This is the v1-Pro upgrade the user asked for.

The "drop speeds ≤ 5 km/h" rule survives because it's the only cheap proxy for "this vehicle is stopped at a light, not moving". 5 km/h is essentially walking speed; nothing useful comes from including stopped buses in the average.

#### C.2 `predictArrivalAlongShape.ts`

Replaces / generalises today's `predictEta.ts`. Given:

- a `TripShapePlan` for the trip
- the vehicle's current projected position on the shape (`distAlongM`)
- the stops we care about (next stop, +1 hop, +2 hops, …)
- a `SpeedEstimator` to call per segment

Walk forward from the vehicle's `distAlongM`. For each segment between consecutive stops:

```
segmentTimeMin = (segmentDistanceM / 1000) / segmentSpeedKmh * 60
arriveAtStop  += segmentTimeMin
arriveAtStop  += dwellMin(stop)   // 20 s default; 0 for terminus
```

Output: an `ArrivalPlan` per stop the caller asked about, with `{etaMin, source, confidence}`. The Stations board, the Schedule view's "Next trip" tab, and the Map view all consume the same `ArrivalPlan` API — no more `predictEta` vs `predictPositionOnShape` ad-hoc split.

#### C.3 `predictPositionOnShape` keeps its current contract

Same signature, same return shape. The big change is that the marker now moves *continuously* for every visible vehicle on every `nowTicker` tick, regardless of whether the vehicle has live GPS or not. What changes per vehicle is the *source of the position* and the confidence label, not whether the marker animates:

- **Live GPS, HEALTHY:** consult Stage C.1 for the *current* segment's speed and dead-reckon forward using `(nowMs − vehicle.asOfMs) × speedKmh`. The dot shows where the bus *should be right now*, anchored to its last real GPS sample.
- **Live GPS, STALE:** same dead-reckoning math, but ArrivalPlan source downgrades to `schedule` with one band of confidence loss.
- **Live GPS, VERY_STALE:** marker frozen at last known projected `distAlongM`, yellow border (Q.6).
- **No GPS at all (schedule-only):** position interpolated continuously between the trip's scheduled stops using `nowMs`. Stop coordinates come from `stops.txt`; the in-between position is the linear-by-time interpolation along the shape (same math today's `predictPositionOnShape` already does — the only change is the 5 s tick instead of 30 s, so the marker slides smoothly instead of jumping).

The point: **every visible vehicle moves smoothly**. Schedule-only vehicles aren't second-class citizens on the map — the schedule + stop locations + the current clock is enough to predict their position too. A bus on a route with no GPS reporting still glides between its scheduled stops, just without the live anchor a GPS-equipped bus gets.

Falls back to the straight-line `predictPosition` (no shape) when a trip has no `shape_id` — already handled by today's code path.

### Reconciliation

Mostly the v1 contract, with one addition:

- Match by `(route, direction, scheduled_start_min)` with ±10 min timing tolerance (today's v2 already does this; see `apps/web/src/lib/domain/reconcile.ts`).
- **Also use GPS position when available**: among candidates within timing tolerance, prefer the one whose projected `distAlongM` is closest to the elapsed-time expectation. Breaks ties on same-time crossings — a known weakness today.
- High-frequency routes (≤ 10 min headway): keep duplicate flagging disabled.

### Stale GPS

Same three bands as v1 (HEALTHY < 3 min, STALE < 5 min, VERY_STALE ≥ 5 min). **DECIDED 2026-06-27 (Q.6):**

- **HEALTHY:** position dead-reckons normally; ArrivalPlan source `gps`.
- **STALE:** position dead-reckons from the last good speed estimate; ArrivalPlan source downgrades to `schedule` with one band of confidence loss.
- **VERY_STALE:** position freezes at the last known projected `distAlongM` — *no dead-reckoning forward*. Marker stays at last known location with a **yellow border** to flag uncertainty. ArrivalPlan source = `schedule` at minimum confidence. Vehicle does NOT disappear (v1 dropped it; v2.5 keeps showing it so the user still knows where the bus was last seen).

---

## 6. Implementation plan (phased)

Each phase is independently shippable. None of them is "the big bang". P0 is foundational — no user-visible change — but everything later depends on it.

### Phase P0 — Foundation: shared cascade + geo math

One pure module per repo, byte-identical, mirrored from a single source of truth. No UI, no DOM, no IO. Heavily unit-tested. Doesn't ship to users — sits in the codebase as a building block.

**Contents (~260 lines of pure logic):**

- `geo.{js,ts}` — `haversineMeters`, `projectOnPolyline`, `pointAtDistance`, `bearingAtDistance`. Already exist in `apps/web/src/lib/domain/shapeProjection.ts`; this phase ports them to the shared shape.
- `timeOfDay.{js,ts}` — `clockToBucket(localMs, tz, profile): 'peak' | 'offpeak' | 'night'`. Reads `peak_windows` + `night_window` from feed config.
- `speedCascade.{js,ts}` — `estimateSegmentSpeed(args): SpeedSample`. Implements all four tiers from §5.C.1. Tiers 1–2 take optional live-data inputs; when `undefined`, they short-circuit and the cascade falls through to TOD → centre → static. **Same function used at build time (tiers 3–4 only) and at runtime (all four available when GPS is present).** That's how we avoid duplicating the per-segment speed math between the two repos.
- `dwell.{js,ts}` — `dwellSecondsFor(stop): number`. Today a constant 20 s (Q.2 still open); abstracted so per-class lookup is a one-file change.

**Cross-repo sharing strategy (see §6.6 for details):** vendor + mirror, low ceremony. `apps/web/src/lib/domain/prediction-core/` is the source of truth; `neary-gtfs/src/pipeline/lib/prediction-core/` is a mirrored copy as plain ESM `.js`. A `scripts/check-mirror.{sh,mjs}` step diffs the two in CI so drift is impossible to merge.

**Acceptance:**

- Both repos import their `prediction-core/` modules and unit tests pass in both.
- The CI mirror-check rejects a PR that touches one copy without the other.
- `estimateSegmentSpeed` test corpus: a small canned set of (segment, feedConfig, optional liveData) inputs with known expected outputs, identical in both repos.

No user-visible change. Strictly preparation for P1.

### Phase P1 — `neary-gtfs` interpolation upgrade

The whole of Stage A from §5. Spelled out explicitly because this is the most consequential change in the rollout and the existing Cluj formula is wrong on every axis. Self-contained, all in `neary-gtfs`. The web app keeps reading `stop_times.txt` from SQLite without code changes; it just gets better data. Shippable in isolation.

Only the **Cluj** path changes — feeds that ship full operator `stop_times.txt` via Transitous keep using the operator's times as authoritative (no interpolation). The new formula replaces [`interpolateStopTimes`](../../../neary-gtfs/feeds/cluj-napoca/build.js#L166-L188).

**P1 deliverables, in order:**

1. **Shape-aware segment distance.** For each consecutive `(stop[i], stop[i+1])` on a trip, distance is `distAlongShape(stop[i+1]) − distAlongShape(stop[i])` using `projectOnPolyline` from P0's shared `geo` module. Falls back to haversine only when the trip has no `shape_id`. This alone fixes any route that crosses the Someș with a one-way bridge detour today's haversine misses.
2. **Per-segment travel time via the shared cascade.** Call `estimateSegmentSpeed` from P0 once per segment, with `vehicleSpeed` and `nearbyVehicles` both `undefined` (no live data at build time). The cascade short-circuits to its TOD → centre → static tiers, all of which are deterministic from the segment's start time + feed config. **No build-time speed code lives in `neary-gtfs`** — the function is imported from `prediction-core/`. Per-feed config (see seed values for Cluj below) lives in `feeds/<id>/config.json` and is read in once per trip.
3. **Per-stop dwell, with proper arrival/departure split.** Today's Cluj build sets `arrival_time === departure_time` for every stop. With dwell, intermediate stops get:
   ```
   intermediate.arrival_time   = previous.departure_time + segment_travel
   intermediate.departure_time = intermediate.arrival_time + dwell
   ```
   Origin: `arrival_time = departure_time = operator-published value` (no upstream dwell to model; the published time IS the departure). Terminus: `arrival_time = previous.departure_time + segment_travel`, `departure_time = arrival_time` (no continuation). `dwellSecondsFor` is the P0 helper; default **20 s** for intermediate stops (Q.2 still open).
4. **`shape_dist_traveled` populated** on every `stop_times` row using the projection from step 1. Single biggest perf win for the web app — eliminates the per-route `buildTripShapePlan` projection cost at runtime (Phase P3 consumes this; P1 just produces it).
5. **Drop the min/max-per-stop clamp.** If the speed profile says a route takes 18 min, let it. The clamps in today's `interpolateStopTimes` mostly mask bad input rather than guard against it.

**Seed feed config for Cluj** (`neary-gtfs/feeds/cluj-napoca/config.json`):

```json
{
  "speed": {
    "kmh_peak": 12,
    "kmh_offpeak": 22,
    "kmh_night": 30,
    "kmh_min_city_centre": 15,
    "kmh_max_outskirts": 45,
    "centre_radius_km": 20
  },
  "peak_windows": [
    { "days": "mon-fri", "from": "07:00", "to": "09:00" },
    { "days": "mon-fri", "from": "17:00", "to": "19:00" }
  ],
  "night_window": { "from": "22:00", "to": "05:00" },
  "dwell_intermediate_sec": 20,
  "city_centre": { "lat": 46.7712, "lon": 23.6236 }
}
```

These are seed values from lived experience of Cluj traffic, not from any measurement pipeline (explicitly **not** building a historical store — see §8 anti-goals). Tune by riding the bus and editing the file; rebuild the feed; next reload shows the new times.

**Worked example** (Cluj 25N, peak hour, 4 hypothetical stops):

Operator publishes only `start_departure = 17:00:00`.

| i | Stop | Cum dist (shape, m) | Seg dist (m) | Seg travel @ 12 km/h | arrival_time | departure_time |
|---|---|---|---|---|---|---|
| 0 | Origin | 0 | — | — | 17:00:00 | 17:00:00 |
| 1 | A | 600 | 600 | 3 min | 17:03:00 | 17:03:20 |
| 2 | B | 1 800 | 1 200 | 6 min | 17:09:20 | 17:09:40 |
| 3 | Terminus | 3 000 | 1 200 | 6 min | 17:15:40 | 17:15:40 |

Same trip today (haversine + 18 km/h + 0 dwell): all rows would compress, terminus would land around 17:10. The new times are realistic; today's are not.

**What stays out of P1** so it stays shippable:
- The runtime web-app changes that *consume* `shape_dist_traveled` — that's P2.
- The runtime speed cascade / GPS-aware predictor — that's P3+.
- Per-route or per-segment speed overrides — Q.1 deferred to "per-feed first, per-route later if needed".

**Acceptance:**
- For Cluj, visible time differences on the Schedule view for sparse-stop routes (25N's intermediate timing should look more realistic at peak).
- `arrival_time !== departure_time` for every intermediate stop on every Cluj trip.
- `shape_dist_traveled` is non-NULL for every `stop_times` row produced by the Cluj build.
- The cumulative trip duration on a known route matches operator-published terminus times within a few minutes (or, if there is no published terminus, matches a manually-stopwatched reference trip).
- All other feeds: zero behavioural change (operator times remain authoritative).

### Phase P2 — `shape_dist_traveled` round-trip

Populate at build time (already done in P1), consume in `apps/web/src/lib/workers/gtfs.worker.ts`'s `getRouteMapView`, drop the runtime `projectOnPolyline` call in `buildTripShapePlan`. Cuts a measurable chunk of per-route-load CPU. Shippable independently of later phases.

### Phase P3 — `predictArrivalAlongShape.ts`

Replace today's `predictEta.ts`. Update `assembleLiveBoard` to call the new module. The Stations board's ETAs start using the cascade per segment, with all four tiers available now that we have live observations. Map view unchanged at this phase. Shippable behind a feature flag if we want to A/B against today's single-tier ETA.

P3 has no new pure-logic of its own — it composes P0's `estimateSegmentSpeed` with the shape walk from P2. New file just orchestrates.

### Phase P4 — continuous position rendering for every vehicle

The big one. `predictPositionOnShape` consumes the live observation when present and dead-reckons; when no live observation exists, the same function interpolates the schedule-only position from `nowMs` + stop lat/lon. Either way **every marker moves continuously**, because the 15 s `nowTicker` (from P5) re-runs the predictor for every visible vehicle.

The behavioural shift vs today is twofold:

1. GPS-equipped vehicles stop being snapped to scheduled stop times — they track where the bus actually is, anchored to the last GPS sample and extrapolated forward.
2. Schedule-only vehicles stop being frozen between `nowTicker` ticks — they slide smoothly between their scheduled stops on the same 15 s cadence (with RAF interpolation in between, see P5).

This is the phase where the user's "GPS as spine" wish lands for live-GPS vehicles, while schedule-only vehicles also benefit from the smoother UI cadence. Cannot ship before P0 (no speed estimator) and P3 (no per-segment ArrivalPlan to anchor against).

### Phase P5 — tick alignment + the refresh-button contract

**DECIDED 2026-06-27, REVISED 2026-06-27 (Q.4): drop `nowTicker` to 15 s globally, synchronised with `livePollMs`.** Earlier draft proposed 5 s; thinking it through, 5 s is overkill because the predictor inputs only change in two ways:

1. **Fresh GPS arrives** — happens on the poll cadence, which is 15 s. Ticking faster than the poll just re-runs the predictor with identical inputs.
2. **Wall-clock time advances** — affects only what's visible to the user (ETA labels, urgency colours, dead-reckoned marker positions). For the Stations board, a 15 s display lag on a minute-resolution label is invisible. For the Map view, smooth marker movement is the only real motivation — and that's better handled by RAF interpolation between ticks (next bullet).

**Smooth marker animation comes from RAF, not from a fast global tick.** Same pattern the traveling-dots layer already uses. Each marker stores its current `(predictedPos, predictedVel)` pair at the last `nowTicker` tick; an RAF loop on the map page interpolates `pos += vel * dt` every frame between ticks. At the next tick the predictor recomputes the anchor and the RAF picks up the new vel. Markers slide smoothly at 30 fps without the cost of running the predictor 30 times a second.

Reasons to keep it at 15 s instead of 5 s:

- **Matches the poll cadence** — one frequency to reason about, no "why did the predictor run when nothing changed".
- **3× less work** — 4 ticks/min vs 12. Predictor + every dependent `$derived` runs that much less.
- **Refresh button still snaps to ~150 ms** — cadence doesn't determine refresh responsiveness; the `nowTicker.bump()` in the handler does. See §6.5.

Also in P5: wire the refresh button so it produces an immediate fresh prediction in one beat. See §6.5 below for the full mechanics.

---

## 6.6 — Cross-repo sharing for the prediction core

P0's modules need to be byte-identical in both repos. The repos are separate, so we need a discipline. Three options considered:

| Option | Cost | When to use |
|---|---|---|
| **A. Vendor + mirror, low ceremony** | ~30 min setup, near-zero maintenance | When the math is ~hundreds of lines and stabilises after the initial port. **This is our choice.** |
| B. Private NPM package | Real infra: registry, versioning, release process | When a third consumer appears or the math churns weekly |
| C. Git submodule / subtree | Mid-cost, tends to confuse contributors | Almost never — skip |

### Mirror layout

- **Source of truth:** `apps/web/src/lib/domain/prediction-core/` (TypeScript).
  - `geo.ts`, `timeOfDay.ts`, `speedCascade.ts`, `dwell.ts` + their `*.test.ts` files.
  - Stays inside the SvelteKit app so the existing test runner + import graph keep working.
- **Mirror:** `neary-gtfs/src/pipeline/lib/prediction-core/` (plain ESM JS).
  - Same filenames, same exports, same logic.
  - Header comment in each file: `// MIRRORED from neary/apps/web/src/lib/domain/prediction-core/<file>.ts. Do not edit — run scripts/sync-prediction-core.mjs instead.`

### The sync script

`scripts/sync-prediction-core.mjs` (lives in `neary-gtfs`):

1. Reads each `.ts` source from a configured path (env var or local checkout of the `neary` repo).
2. Strips type annotations using `esbuild`'s `transform` API (which is already a `neary-gtfs` dependency for the build pipeline).
3. Writes the resulting `.js` next to the original filename.
4. Verifies test corpus passes locally.

Running the script is idempotent. PRs that touch `prediction-core` in `neary-gtfs` without running the script are rejected by:

### The CI mirror-check

`scripts/check-mirror.mjs` runs in CI in both repos:

- In `neary-gtfs` CI: re-runs `sync-prediction-core.mjs` against a pinned `neary` git ref and `git diff --exit-code`. If anything changes, fail the build with "Mirror is stale; run `npm run sync-prediction-core` and commit."
- In `neary` CI: smoke test that the `.ts` source compiles to JS equivalent to what the sync script would produce.

### When to graduate to Option B

If within the first six months any of the following happen, promote `prediction-core` to a private NPM package:

- A third repo wants to consume it (a back-office analytics tool, a different app surface).
- We start tweaking it more than monthly.
- We add a fourth language target (Python for analysis, Go for a backend).

Until then, vendor-and-mirror is the lowest-friction path. The contract is enforced by CI, not by humans remembering.

---

---

## 6.5 — The three loops + the refresh button (explainer)

This is the part that's confusing today and gets worse if we don't write it down. There are three distinct loops, and the refresh button has to talk to all of them.

### The three loops

| # | Loop | Owns | Cadence | What it does |
|---|---|---|---|---|
| L1 | **Live GPS poll** | `liveVehiclesStore.poll()` | every 15 s (`livePollMs`) | fetches `/api/rt/<feed>/vehiclePositions`, parses, writes `observations` to the store |
| L2 | **UI / time tick** | `nowTicker.ms` | every **15 s** (post-P5; 30 s today) | a reactive `$state` representing "the now we use for display" — drives every `$derived` that depends on time |
| L3 | **Manual data refresh** | `refreshBus.tick` | on user tap | wakes effects that gate on it to re-fetch *static* data (schedules, route lists) from the SQLite worker |

They are **fully decoupled by design**:

- L1 doesn't trigger UI by itself. The store's `observations` is a `$state`; whichever `$derived` reads it re-runs when it changes. That happens *naturally* per Svelte reactivity — no timer involved.
- L2 doesn't fetch anything. It only advances a clock value. Pure UI cadence knob.
- L3 doesn't predict anything. It re-runs the worker queries that loaded the schedule and routes for the current page.

### Where prediction happens in this picture

After Phases P3–P5, the predictor inputs are `(nowMs, observations, route_static_data)`. Anything that *changes* those inputs re-runs the predictor — because Svelte's reactivity tracks the read graph automatically. So:

- L1 fires → fresh `observations` → predictor re-runs immediately.
- L2 ticks → fresh `nowMs` → predictor re-runs immediately.
- L3 fires + worker returns → fresh `route_static_data` → predictor re-runs immediately.

The bug today is that `markers` on the Map view doesn't actually read `liveVehiclesStore.observations` (because v2 uses schedule as the spine — see §1.2), so L1 doesn't wake it. That's a v2 limitation P5 fixes.

### What the refresh button does today

[`+layout.svelte`](apps/web/src/routes/+layout.svelte) `onrefresh`:

```ts
refreshBus.fire();           // L3 — wake schedule re-fetch
liveVehiclesStore.refresh(); // L1 — immediate poll, skip the 15 s wait
```

What it *doesn't* do:

- It doesn't advance `nowTicker.ms`. So time-only-derived values (ETA labels, urgency colors, bucketing) still wait for the next L2 tick.
- (Today) it doesn't matter for `markers` on the Map view because `markers` only depends on `nowMin` and the static schedule — not on live observations. So an "immediate fresh GPS" doesn't help.

### The refresh contract (post-P4)

After P4 the dependencies are right; the refresh button needs one tiny addition to deliver the freshest prediction in one beat:

```ts
function onrefresh() {
  refreshBus.fire();           // L3: re-fetch static data
  liveVehiclesStore.refresh(); // L1: immediate GPS poll
  nowTicker.bump();            // L2: force now to wall-clock right now
}
```

`nowTicker.bump()` sets `ms = Date.now()` and resets the interval. After this:

1. The L1 poll completes in ~100 ms — observations update.
2. `nowTicker.bump()` fires synchronously — `nowMs` advances.
3. Both wake the same `$derived`s simultaneously; predictor runs once (Svelte batches the dependency changes within a microtask).
4. UI re-renders.

End-to-end: **~150 ms from tap to fresh prediction on screen**, vs today's "up to 30 s" worst case waiting for the next L2 tick.

### Recommended config (post-P4/P5)

| Setting | Value | Why |
|---|---|---|
| `livePollMs` | **15 000 ms** | unchanged; bounded by upstream feed cadence (Cluj GTFS-RT publishes ~every 10 s) |
| `nowTickerMs` | **15 000 ms** | matches `livePollMs` so predictor inputs change in one beat; smoothness on the map comes from RAF interpolation, not from a faster tick |
| `mapAnimationFps` | **30** | RAF loop on the map page tweens markers between `nowTicker` ticks using each marker's last predicted velocity. Same pattern as the existing traveling-dots layer. 30 fps is the visible-smoothness threshold and is half the cost of 60 fps. |
| `refreshDebounceMs` | **2 000 ms** | prevents the refresh button from triggering more than one poll cycle by spam-tapping |
| `gpsHealthyMs` | **180 000 ms** (3 min) | unchanged from v1 |
| `gpsStaleMs` | **300 000 ms** (5 min) | unchanged from v1 |

All of these (except the RAF rate, which is map-local) live in `DEFAULT_CONFIG` in [`lib/domain/config.ts`](apps/web/src/lib/domain/config.ts), keeping one source of truth.

### What NOT to do

- **Don't fold L1 and L2 into one timer.** They have different concerns. Bundling them means you can't tune liveness without changing API load, and vice versa.
- **Don't have the predictor subscribe to its own timer.** That's a fourth loop. Predictors should be `$derived`s; their re-runs are caused by their inputs changing, not by a tick of their own.
- **Don't trigger predictions inside the L1 callback.** Same reason — keep prediction purely a function of `(now, observations, static)`. The reactive graph does the rest.
- **Don't bump `nowTicker` from inside L1.** That would mean every GPS poll forces a UI re-render of every nowTicker subscriber. Wasteful and conflates two concerns. Only the refresh button bumps; the poll just updates the store and lets Svelte wake the right derived nodes.

### End-to-end latency, post-P4/P5

Compared to the current ~25 s typical / 55 s worst case (see §1.4):

| Path | Today | After P4+P5 |
|---|---|---|
| GPS reports → marker moves (auto) | 0–55 s | 0–30 s (15 s poll + 15 s tick worst case; markers also RAF-interpolate between ticks) |
| Refresh tap → marker moves | 30 s waiting for `nowTicker` | ~150 ms |
| ETA label flips a minute (auto) | 0–30 s | 0–15 s |

The win on refresh is the user-facing one: tapping the button is finally meaningful.

---

## 6.7 — Calibrating the per-feed speed profile

The seed numbers in P1 (`kmh_peak: 12`, `kmh_offpeak: 22`, `kmh_night: 30`) are starting points, not measurements. Three approaches to refining them, in increasing automation.

### Cluj-specific consideration: bus lanes

The standard transit-ETA shortcut is "take driving time from a routing API, multiply by ~0.65 to discount for stops". **That heuristic is wrong-direction for Cluj**, and probably for any city with a partial dedicated bus-lane network.

- **Routes mostly on dedicated bus lanes** (Mănăștur axis, parts of Eroilor) are *faster* than cars at peak hours, not slower. The "× 0.65" adjustment underestimates them badly.
- **Routes in mixed traffic** behave like buses everywhere — slower than cars by stop frequency. The "× 0.65" is roughly right.

Since the adjustment factor varies per route within the same city, automating from any car-time API requires per-route knowledge anyway. At which point you've replaced one estimate (lived experience) with a more complicated one (car time × per-route factor) and gained nothing.

This is why Cluj is also the strongest case for Q.1 eventually flipping to per-route overrides (see Option C below). For now the per-feed defaults are fine; we accept some routes will be a few minutes off until P1 has shipped and we have something to compare against.

### Option A — Ride the bus (recommended for v2.5 launch)

Cheapest, most accurate per route, captures bus-lane behaviour directly. Stopwatch a representative trip during peak and off-peak; divide shape distance by elapsed time; that's `kmh_peak` and `kmh_offpeak` for that route. Two rides → numbers good enough for P1 to ship.

### Option B — OSM driving + per-route factor (other cities only)

[OpenRouteService](https://openrouteservice.org/) gives free car-driving time without traffic. Multiply by:

- ~0.65 for routes in mixed traffic
- ~0.95 for routes on partial bus lanes
- ~1.0–1.1 for routes on dedicated bus lanes

Useful for non-Cluj feeds where we have no local knowledge. **Not recommended for Cluj** because the per-route factor has to come from somewhere, and once you have it you've done Option A anyway.

**Why not Google Maps APIs:**

- `mode=driving` gives car time, which is wrong-direction-biased for bus-lane routes (same problem as OSM, but it costs money to be wrong).
- `mode=transit` returns the operator's GTFS schedule back — that's our input, not useful as calibration.
- ToS restricts storing derived data from their APIs beyond display.

### Option C — Historical observation, three deliverables (future work, post-v2.5)

This is the long-term right answer and the user's planned follow-on work. Three deliverables, in order:

#### C.1 — The capture script

A standalone Node script in `neary-gtfs/scripts/observe-cluj.mjs` (or similar) that:

1. Polls the upstream GTFS-RT VehiclePositions feed at the same cadence as `apps/web` (every ~15 s).
2. Stores raw snapshots to a local directory or SQLite file. **Storage stays local** — no operator data leaves the machine. This keeps the script in the same "tool you can run when you feel like it" category as `scripts/build-sqlite/` rather than a load-bearing service.
3. Run for a meaningful window: a month gives ~2.6 M snapshots for a 100-vehicle city. SQLite handles that comfortably.

Not wired into the build pipeline. Manual `node observe-cluj.mjs --since=… --until=…` invocation.

#### C.2 — The analysis pass

A second script, `scripts/analyze-observations.mjs`, that reads the captured snapshots and computes empirical speeds.

**Critical:** speed is computed from **subsequent GPS position reports**, NOT from the bus's reported instant `speed` field. The reported speed is a sensor reading at a single instant: noisy, sometimes wrong unit, sometimes absent, fluctuates with brake/accelerator/idle in ways that don't reflect actual progress along the route. Position deltas across two consecutive pings give the true average speed over that interval — which is exactly the quantity we want.

**The fancy formulas, in order of subtlety:**

1. **Project each observation onto the trip's shape.** `projectOnPolyline` from P0's `geo` module. Discard observations where `perpDistM > 200 m` (off-route — bus on detour, or just bad GPS fix).
2. **Match consecutive observations of the same `vehicle_id` on the same `trip_id`.** A trip change between two pings invalidates the delta (different shape entirely). Keep only `(O₁, O₂)` pairs where `O₁.trip_id === O₂.trip_id`.
3. **Require monotone progress.** `O₂.distAlongM >= O₁.distAlongM`. A regression means either a GPS jitter, a bus that turned around, or a stale ping out of order. Discard.
4. **Reject implausible intervals.** Drop pairs where `Δt > 60 s` (likely a dropout — too much can happen between the samples to assume constant speed) or `Δt < 5 s` (likely a duplicate ping; noise dominates).
5. **Reject implausible speeds.** Compute `kmh = (Δd_m / Δt_s) × 3.6`. Drop if `kmh < 0.5` (effectively stopped — at a stop or red light) or `kmh > 80` (Cluj bus + outlier; sanity).
6. **Map to per-segment samples.** This is the bit that takes real care. The pair `(O₁, O₂)` traverses zero, one, or more polyline *segments* — where a "segment" here is `(stop_seq i → stop_seq i+1)`, i.e. one of the inter-stop legs. Three cases:
   - Both observations fall within the same inter-stop leg → assign the computed speed to that one segment.
   - Observations span exactly one boundary (between leg N and leg N+1) → assign the speed to *both* legs touched, weighted by the fraction of `Δd` that fell in each. (Yes, the bus could have been faster on leg N than leg N+1 within that interval; we don't try to disentangle that — sub-segment resolution requires sub-15s GPS, which we don't have.)
   - Observations span two or more boundaries → distribute the speed proportionally across each touched leg, again by `Δd` fraction.
7. **Filter dwell time before computing speed.** The "drop kmh < 0.5" rule in step 5 catches obvious dwell, but a bus that stops for 25 s mid-interval and then sprints for 35 s through to the next stop produces a deceptively low average. Cleanest fix: within a `(O₁, O₂)` pair, if either observation has `current_status === STOPPED_AT`, drop the pair (it overlaps a stop event, not pure transit). The remaining pairs are pure-transit samples; their speed is the real transit speed on those segments.
8. **Bucket by `(route_id, direction_id, segment_idx, hour_of_week)`.** `hour_of_week = (day_of_week × 24 + hour_of_day)`, range 0..167. Keeps day-of-week structure (Sat 17:00 traffic ≠ Wed 17:00 traffic in Cluj).
9. **Take p60 per bucket**, not arithmetic mean. p60 is robust to slow outliers (a bus stuck behind a wrong-place wrong-time delivery van shouldn't drag the median down). Drop ≤ 5 km/h samples first as a final paranoia filter.
10. **Drop sparse buckets.** Fewer than ~20 samples and the p60 is noise. Better to leave the cell empty and let the cascade fall through to a fallback than ship overfit data.

Output: a per-bucket median speed table with sample counts.

The "fancy formulas" framing is right — step 6 (per-segment distribution of a multi-segment interval) and step 7 (dwell filtering) are where most of the implementation hours will go. The rest is straightforward.

#### C.3 — Ship the empirical data IN THE SAME SQLITE THE CLIENT ALREADY DOWNLOADS

This is the key architectural call. The empirical speeds are valuable in **two** contexts:

1. **Build time in `neary-gtfs`:** when generating `stop_times.txt` for the next feed build, the per-segment speeds are far better inputs to the schedule interpolation than the per-feed TOD defaults. So P1's `estimateSegmentSpeed` call picks them up directly.
2. **Runtime in `apps/web`:** when the cascade is deciding which speed to apply to a far segment, having the *empirical* median for that exact `(route, direction, segment, hour)` is better than falling back to the per-feed TOD bucket.

The cleanest way to get both: **stash the table in the SQLite database the client downloads**. New table in `make-sqlite.js`:

```sql
CREATE TABLE segment_speeds (
  route_id        TEXT NOT NULL,
  direction_id    INTEGER NOT NULL,
  segment_idx     INTEGER NOT NULL,
  hour_of_week    INTEGER NOT NULL,  -- 0..167; lets the client collapse to its own bucketing
  kmh_p60         REAL NOT NULL,
  sample_count    INTEGER NOT NULL,
  PRIMARY KEY (route_id, direction_id, segment_idx, hour_of_week)
);
```

The Cluj feed build picks up the latest snapshot of this table and ships it inside the same `.sqlite` artifact users already download once per feed. **No new network endpoint, no extra HTTP, no client config to manage.** Empirical data flows through the same channel as the schedule.

#### C.4 — What happens to the cascade once C.3 ships

**This is the big simplification.** With dense empirical data for every `(route, dir, segment, hour-of-week)` bucket, most of v2.5's cascade becomes dead weight. The fallback tiers (TOD, centre, static) are *configured estimates of what observation would tell us*; once observation tells us, the configured estimates are obsolete by definition.

The cascade collapses from 5–6 tiers to **two real layers**:

| Layer | Source | What it answers |
|---|---|---|
| **Baseline (empirical)** | `segment_speeds` p60 for this `(route, dir, segment, hour)` | "What's the normal speed here?" |
| **Live correction** | `(observed_speed_of_this_bus_recently) / (empirical_median_for_those_segments)` over the last ~5 min | "Is this bus running normal, fast, or slow right now?" |

The prediction for any future segment becomes `empirical_baseline × live_correction_ratio`. So instead of choosing between a vehicle's instant speed (tier 1) OR fleet average (tier 2) OR TOD (tier 3), we always use empirical baseline AND apply the live observation as a multiplier on it.

**Why "live correction" survives even when empirical is dense:**

- Empirical median says "normal Monday 8 AM is 14 km/h on this segment". That's a forecast, not a fact about this Monday.
- A protest, a wreck, weather, a road closure — these all bend reality away from the historical median. The vehicle's own GPS catches that in real time; the median can't.
- Same goes for individual vehicle behaviour: a particular bus running broken / running early / dwelling unusually long. Its own observed speed tells us; the median doesn't.

**What disappears post-C.3:**

- ~~Tier 1 (vehicle's own raw speed)~~ — folded into the live-correction multiplier.
- ~~Tier 2 (nearby fleet average)~~ — folded in too. Computed as the same ratio against the empirical median, weighted by sample count.
- ~~Tier 3 (per-feed TOD default)~~ — empirical baseline supersedes. Stays as `route_overrides` in feed config for the **sparse-bucket** case (specific (segment, hour) cells with <20 samples).
- ~~Tier 4 (city-centre interpolation)~~ — empirical supersedes. Useful only as ultimate cold-start fallback for cities where Option C hasn't run yet.
- ~~Tier 5 (static fallback)~~ — same. Survives as the universal "I have no data at all" fallback.

So the post-C.3 cascade is conceptually `empirical × correction` with config tail-fallbacks for cold start / sparse data:

| # | Source | When fires |
|---|---|---|
| 1 | Empirical p60 × live correction multiplier | When `segment_speeds` row exists with enough samples |
| 2 | Empirical p60 from adjacent hour bucket × live correction | Sparse cell, but nearby bucket has data |
| 3 | Per-route TOD override × live correction | No empirical for this route at all |
| 4 | Per-feed TOD default × live correction | Brand new feed, no empirical anywhere |
| 5 | Static fallback | Catastrophic case |

The same `estimateSegmentSpeed` signature handles all of this; the function just becomes "look up empirical first, derive correction multiplier from live observations, multiply, fall back if empirical is missing".

**Implication for v2.5 design:**

The cascade we ship in v2.5 is *the cold-start version* of this design. Tiers 3–5 in v2.5 ARE tiers 3–5 in the post-C.3 cascade — same constants, same code paths. Tiers 1–2 in v2.5 (raw vehicle speed / fleet average) get reworked into the live-correction multiplier when C.4 lands, but the data they consume is already in place. So the migration from v2.5 to post-C.3 is **adding** layers, not throwing the cascade away.

**Why keep the fallbacks at all once C.3 ships?**

Fair question. For Cluj specifically, once `segment_speeds` has been populated for the full feed (~1 month of capture, all routes, all hours), the fallback tiers (TOD config, city-centre, static) effectively never fire — the empirical baseline answers ~every query. So aren't they dead code?

Three reasons they stay in the codebase, even if Cluj never hits them:

1. **First-day-of-Cluj-observation.** Between `feeds/cluj-napoca/build.js` running for the first time post-C.3 and the next time C.2 produces a fresh `segment_speeds` table, sparse buckets exist. Empirical median for "Thursday 03:00 segment 14 of route 25N" might have 4 samples — below the 20-sample threshold, so it's dropped from the table. That cell's queries fall through to the TOD-config fallback. Few cells, sure, but non-zero.
2. **New routes / route changes mid-cycle.** When CTP adds a route or changes a shape, the new geometry has zero empirical samples for some weeks. The route still needs ETAs during that window. Fallbacks fire.
3. **Future expansion to other cities.** Bucharest, Iași, Timișoara — each starts cold. Their first build ships with `segment_speeds` empty. The cascade gives reasonable answers from feed-level TOD config until that city's observation pipeline catches up.

**What changes operationally for Cluj specifically post-C.3:**

The fallback tiers are still in the code, but in practice they almost never fire. We could (and should) instrument:

- A counter in `speedCascade.ts` that increments when each tier fires.
- A debug logger in dev that warns "Cluj cascade fell to tier ≥ 3 — sparse bucket at (route=…, segment=…, hour=…)".

If post-launch the counter shows tiers 3+ firing on > 5 % of Cluj queries, we know our sample threshold (20 / bucket) is too aggressive and need to either capture more or relax the threshold. If they fire on < 0.1 %, the fallbacks have done their job and we can stop worrying about them.

In short: the fallbacks aren't dead code, they're the **long-tail backstop**. The 80/20 cut on Cluj queries goes to the empirical baseline; the long tail goes through the cascade. Keeping the cascade in place costs near-zero (it's already written, tested, and runs in microseconds) and buys us "the app never refuses to give an ETA, even for an unseen bucket".

#### What this design is NOT

- **Not** an ML model. p60 of observed speeds is straight arithmetic; the historical pipeline learns nothing it doesn't observe.
- **Not** a real-time service. The capture script runs occasionally (think "once a month"); the analysis pass runs once per feed build. No always-on infrastructure.
- **Not** part of v2.5's first release. The slots exist in the cascade and the SQLite schema (empty initially); the script is built when someone has the appetite for it.

#### Deferred-work entry point

When picking this up:

1. Spike the capture script first — a day's work, validates the data quality is what we expect.
2. Let it run for a week before bothering to build the analysis pass; one week is enough to know whether the data is dense enough for the p60 buckets to be meaningful.
3. Analysis pass + SQLite schema + `make-sqlite.js` wiring come together as one PR (they're tightly coupled).
4. Client-side: add the empirical-baseline tier to `speedCascade.ts`. With `segment_speeds` empty (or missing), it short-circuits and falls through to the config tiers — so the cascade keeps working before any data is captured. Later, rework tiers 1–2 into the live-correction multiplier when there's enough empirical data to make the ratio meaningful.

---

---

## 7. Open design questions

Decisions needed before P1 starts. None of them block writing the v1 port modules (those are pure).

- **Q.1 — Where does the speed profile live?** ~~Per-feed config in `neary-gtfs/feeds/<id>/config.json`, or per-feed-per-route, or derived from observation (P0 output)?~~ **DECIDED 2026-06-27: per-feed.** Per-route is overkill — in the city centre many routes overlap with essentially the same traffic profile.
- **Q.2 — Per-stop dwell.** Flat 20 s, or per-stop based on observed headway / boarding volume, or per-stop-class (terminal vs through-stop vs request-only)? Recommendation: flat 20 s ship, per-class once we have observed data. *Open.*
- **Q.3 — City-centre tier from v1.** ~~Do we keep it?~~ **DECIDED 2026-06-27: keep v1's city-centre tier for now.** Sits between the time-of-day profile and the static fallback. Centroid computed once at build time per feed.
- **Q.4 — Map liveness vs battery.** ~~Drop `nowTicker` to 5 s globally, or only the map page (P6)?~~ **DECIDED 2026-06-27, REVISED 2026-06-27: nowTicker at 15 s globally, synchronised with `livePollMs`.** Smooth map marker animation comes from RAF interpolation between ticks, not from a faster global tick. See §6 P5 + §6.5 for the full reasoning.
- **Q.5 — Should reconciliation use GPS position?** The position-aware tie-break in §5 fixes same-time crossings but adds a per-candidate projection call. Cheap, but worth being explicit. Recommendation: yes, with a fallback to timing-only when no GPS is available for the candidate. *Open.*
- **Q.6 — What does the Map view do when GPS is VERY_STALE?** ~~v1 dropped the vehicle. v2-today renders the schedule position regardless.~~ **DECIDED 2026-06-27: freeze at last known position with a yellow border, no dead-reckoning forward.** Vehicle stays visible so the user still knows where it was last seen.
- **Q.7 — Test corpus.** We don't have one yet for prediction quality. Recommendation: P0 captures a week of vehicle pings; a CSV of `(tripId, stopId, scheduled_arrival, observed_arrival)` triples becomes the regression input. Each predictor is scored on MAE against it. *Open.*

---

## 8. Anti-goals

Things this design deliberately does *not* attempt, with reasons:

- **No historical speed pipeline / measurement poller.** The original P0 was "capture a week of GTFS-RT and dump empirical speeds". Rejected on the same grounds as the Kalman/ML approaches: real infrastructure, real maintenance, and the cascade gives a defensible answer from per-feed config alone. Seed values come from lived experience; tune by riding the bus and editing the config.
- **No Kalman filter / state-space model.** Tunable per-feed parameters are a real ops burden; the cascade gives 80 % of the win with 10 % of the complexity.
- **No historical speed database.** OneBusAway-style per-segment learned models need a backend. We don't have one, and the project is still a static PWA.
- **No machine-learning ETA.** Same reason. Plus accountability matters here — a heuristic cascade is debuggable line by line.
- **No prediction storage / replay.** Predictions are ephemeral per tick. Tests run on canned inputs.
- **No multi-feed merging at runtime.** Each feed's predictor uses only its own GPS + its own schedule. If two feeds share a route (rare), they get two predictions.
- **No bypass of the worker.** All SQLite access stays in `gtfs.worker.ts`; the predictor modules are pure functions called from the page-level `$derived`s.
- **No two implementations of the cascade.** The `prediction-core` module is mirrored byte-for-byte between repos and CI-enforced (see §6.6). Anyone tempted to write a second copy in either repo should be told to import from `prediction-core` instead.

---

## 9. Glossary / references

- `TripShapePlan` — pre-computed `{measured polyline, [legs]}` for a trip; see [`predictPosition.ts`](apps/web/src/lib/domain/predictPosition.ts).
- `LiveVehicleObservation` — one GPS sample from GTFS-RT; see [`liveVehiclesStore.svelte.ts`](apps/web/src/lib/stores/liveVehiclesStore.svelte.ts).
- `shape_dist_traveled` — GTFS column on `stop_times` carrying cumulative distance along the trip's `shape_id` polyline up to that stop. Currently unpopulated in our pipeline.
- v1 source map for everything ported in §2: [`apps/legacy/src/utils/vehicle/`](apps/legacy/src/utils/vehicle), [`apps/legacy/src/utils/arrival/`](apps/legacy/src/utils/arrival).
- Audit of current v2 pipeline (latency + duplication scan): see the chat transcript from 2026-06-27 ("how pipeline runs, when prediction happens…").

---

## 10. Decision log (this doc only)

- 2026-06-27 — draft created. Sources: v1 deep-dive (Explore subagent), `neary-gtfs` interpolation validation (Explore subagent), current-v2 pipeline trace (earlier audit), industry context (OTP / OneBusAway / GTFS-RT TripUpdates). Awaiting decisions on Q.1–Q.7.
- 2026-06-27 — Q.1 decided **per-feed** (not per-route). Q.3 decided **keep v1's city-centre tier** as a 4th step in the cascade. Q.4 decided **drop `nowTicker` to 5 s globally** (no per-page split). Q.6 decided **freeze at last known position with yellow border** on VERY_STALE GPS. §6.5 added: explainer of the three loops (live poll / nowTicker / refreshBus), recommended config, and the refresh-button contract. Q.2 / Q.5 / Q.7 still open.
- 2026-06-27 — P5 scope clarified: the map moves *every* visible vehicle on each `nowTicker` tick, not just live-GPS ones. Schedule-only vehicles interpolate continuously between their scheduled stops; live-GPS vehicles dead-reckon from their last sample. Source determines confidence + reckoning rules, not whether the marker animates. §5.C.3 + Phase P5 description rewritten.
- 2026-06-27 — P1 scope spelled out in full instead of "Stage A from §5". Five explicit deliverables: shape-aware segment distance, per-feed time-of-day speed profile, per-stop dwell with proper arrival/departure split, `shape_dist_traveled` populated, drop the min/max clamp. Worked example added showing today's haversine+18 km/h+0 dwell vs the new formula on a 4-stop trip. Acceptance criteria added. Only the Cluj path changes; feeds with operator-provided `stop_times.txt` keep using those as authoritative.
- 2026-06-27 — P0 ("measurement") deleted. User confirmed no historical-speed pipeline; seed defaults come from lived experience instead. New P0 ("Foundation") replaces it: shared `prediction-core` module (geo math + TOD bucket + speed cascade + dwell), byte-mirrored between the two repos with CI enforcement. §6.6 added explaining the vendor-and-mirror strategy, the sync script, and when to graduate to a private NPM package. P1–P6 renumbered to P1–P5 (the old P3 "speedEstimator domain module" is absorbed into P0 since it's the same shared cascade). Anti-goals section updated to call out the absence of a measurement pipeline.
- 2026-06-27 — Q.4 revised. Earlier decision was 5 s `nowTicker` everywhere. Reconsidered: that's overkill because predictor inputs only change on the poll cadence (15 s) anyway, and 5 s ticking just re-runs the predictor with identical inputs. New decision: `nowTicker = 15 s`, synchronised with `livePollMs`. Map marker smoothness handled by an RAF interpolation loop on the map page (`pos += vel * dt` per frame, anchor recomputed at each tick) — same pattern the traveling-dots layer already uses. §2.7 cadence comparison fixed (v1 vs v2 vs v2.5 was wrongly framed); §6 P5 description rewritten; §6.5 config table + latency table updated.
- 2026-06-27 — §6.7 expanded with three Option-C deliverables and a key architectural call: empirical per-segment speeds ship inside the same SQLite database the client already downloads (new `segment_speeds` table). Used at BOTH build time (better stop_times.txt input than per-feed TOD defaults) AND runtime (a new tier 3 in the cascade between fleet-average and per-feed defaults). Same source of truth across both contexts. Refined the bus-lane reasoning: bus lanes don't offer a static advantage; the benefit depends on whether there's traffic to bypass, so the right answer is empirical observation per `(route, time, day-of-week)`. Still deferred from v2.5 (no historical-store as part of initial pipeline); slot in cascade + schema exists so when the script ships, it's a data-only change. Entry-point checklist added at the bottom of §6.7 for picking up tomorrow.
- 2026-06-27 — §6.7 added C.4 ("What happens to the cascade once C.3 ships"). User insight: with dense empirical data per `(route, dir, segment, hour-of-week)`, most of v2.5's heuristic cascade becomes dead weight. Post-C.3, the cascade collapses from 5–6 tiers to two real layers: empirical baseline (the truth from observation) × live correction multiplier (how this bus is running right now relative to that baseline). Live correction folds today's tier 1 (vehicle's own speed) + tier 2 (fleet average) into a ratio against empirical median; tiers 3–5 (TOD / centre / static) shrink to cold-start + sparse-bucket backstop. The v2.5 cascade is the cold-start version of this design — same data, same code paths — so the migration is additive, not destructive.
- 2026-06-27 — §6.7 C.2 expanded with the speed-calculation methodology. **Empirical speeds are derived from subsequent GPS position deltas, NOT from the bus's reported instant speed.** Ten-step recipe documented: project both pings onto the shape, require same-trip + monotone-progress + plausible-interval + plausible-speed, distribute multi-segment intervals proportionally across touched legs, filter dwell by dropping pairs that overlap `STOPPED_AT` events, bucket by `(route, dir, segment, hour-of-week)`, take p60 with ≥ 20-sample threshold. Steps 6 (per-segment distribution) and 7 (dwell filtering) are where the implementation hours go.
- 2026-06-27 — §6.7 C.4 expanded with the "do we still need fallbacks?" question. Short answer: for Cluj post-C.3, fallbacks almost never fire — but they're not dead code. Three real cases keep them in the codebase: (1) sparse cells below the sample threshold; (2) brand-new routes / shape changes mid-cycle; (3) future expansion to other cities that start cold. Operational guidance added: instrument a per-tier-fired counter so we know empirically whether the fallbacks are doing their long-tail job (target: tier ≥ 3 firing on < 1 % of Cluj queries post-C.3).
