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

That's a tighter inner loop than today's v2 (live every 15 s, predictor every 30 s) — but v1's heavier per-tick work (full speed cascade + per-vehicle predict) doesn't run in a worker, which is the v2 advantage.

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

Same signature, same return shape. Internally it now consults Stage C.1 for the *current* segment's speed and dead-reckons forward using `(nowMs − vehicle.asOfMs)` — i.e. the dot on the map shows where the bus *should be right now*, not where the schedule says it should be at the next 30 s grid mark. Falls back to schedule-only when no GPS exists.

This is the big behavioural change. It needs the `nowTicker` cadence to drop to ~5 s (Q.4 below).

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

Each phase is independently shippable. None of them is "the big bang".

### Phase P0 — measurement

Before changing anything, capture a week of `VehiclePositions` for Cluj and dump per-segment empirical speeds. We need this baseline to:

- Set realistic defaults for `kmh_peak / kmh_offpeak / kmh_night` (not 18 km/h flat).
- Pick the time-of-day bucket boundaries empirically rather than guess.
- Quantify "how wrong is the current schedule" so the v2.5 changes have a benchmark.

Lives outside the app. Can be a small Node script in `neary-gtfs/scripts/`.

### Phase P1 — `neary-gtfs` interpolation upgrade

Stage A from §5. Self-contained, all in `neary-gtfs`. The web app keeps reading `stop_times.txt` from SQLite without code changes; it just gets better data. Shippable in isolation.

Acceptance: visible time differences on the Schedule view for sparse-stop routes (e.g. 25N's intermediate timing should look more realistic at peak).

### Phase P2 — `shape_dist_traveled` round-trip

Populate at build time, consume in `apps/web/src/lib/workers/gtfs.worker.ts`'s `getRouteMapView`, drop the runtime `projectOnPolyline` call in `buildTripShapePlan`. Cuts a measurable chunk of per-route-load CPU. Shippable independently of P1.

### Phase P3 — `speedEstimator.ts` domain module

Pure TS, no UI, no DOM. Heavily unit-tested. Doesn't ship to users — sits in the codebase as a building block.

### Phase P4 — `predictArrivalAlongShape.ts`

Replace today's `predictEta.ts`. Update `assembleLiveBoard` to call the new module. The Stations board's ETAs start using the cascade per segment. Map view unchanged at this phase. Shippable behind a feature flag if we want to A/B against v1-ETA-style.

### Phase P5 — GPS-aware position rendering

The big one. `predictPositionOnShape` consumes the live observation and dead-reckons. `nowTicker` cadence drops (or a separate faster ticker is introduced just for the map). Map markers start tracking live buses.

This is the phase where the user's "GPS as spine" wish lands. Cannot ship before P3 (no speed) and P4 (no per-segment ArrivalPlan to read from).

### Phase P6 — fast tick + the refresh-button contract

**DECIDED 2026-06-27 (Q.4): drop `nowTicker` to 5 s globally.** Single timer in the app, no per-page gating. Reasons:

- The Stations board's ETA bucket changes at minute boundaries anyway; ticking at 5 s instead of 30 s just makes a stale display invisible faster.
- Single global timer is simpler to reason about than two timers + page-visibility gating.
- Battery impact: 6× more derived runs per minute, but each is O(visible vehicles) and visible vehicles is tens. Negligible.

Also in P6: wire the refresh button so it produces an immediate fresh prediction in one beat. See §6.5 below for the full mechanics.

---

## 6.5 — The three loops + the refresh button (explainer)

This is the part that's confusing today and gets worse if we don't write it down. There are three distinct loops, and the refresh button has to talk to all of them.

### The three loops

| # | Loop | Owns | Cadence | What it does |
|---|---|---|---|---|
| L1 | **Live GPS poll** | `liveVehiclesStore.poll()` | every 15 s (`livePollMs`) | fetches `/api/rt/<feed>/vehiclePositions`, parses, writes `observations` to the store |
| L2 | **UI / time tick** | `nowTicker.ms` | every **5 s** (post-P6; 30 s today) | a reactive `$state` representing "the now we use for display" — drives every `$derived` that depends on time |
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

### The refresh contract (post-P5)

After P5 the dependencies are right; the refresh button needs one tiny addition to deliver the freshest prediction in one beat:

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

### Recommended config (post-P5/P6)

| Setting | Value | Why |
|---|---|---|
| `livePollMs` | **15 000 ms** | unchanged; bounded by upstream feed cadence (Cluj GTFS-RT publishes ~every 10 s) |
| `nowTickerMs` | **5 000 ms** | balances liveness for the map vs cost; Q.4 decided |
| `refreshDebounceMs` | **2 000 ms** | prevents the refresh button from triggering more than one poll cycle by spam-tapping |
| `gpsHealthyMs` | **180 000 ms** (3 min) | unchanged from v1 |
| `gpsStaleMs` | **300 000 ms** (5 min) | unchanged from v1 |

All of these live in `DEFAULT_CONFIG` in [`lib/domain/config.ts`](apps/web/src/lib/domain/config.ts), keeping one source of truth.

### What NOT to do

- **Don't fold L1 and L2 into one timer.** They have different concerns. Bundling them means you can't tune liveness without changing API load, and vice versa.
- **Don't have the predictor subscribe to its own timer.** That's a fourth loop. Predictors should be `$derived`s; their re-runs are caused by their inputs changing, not by a tick of their own.
- **Don't trigger predictions inside the L1 callback.** Same reason — keep prediction purely a function of `(now, observations, static)`. The reactive graph does the rest.
- **Don't bump `nowTicker` from inside L1.** That would mean every GPS poll forces a UI re-render of every nowTicker subscriber. Wasteful and conflates two concerns. Only the refresh button bumps; the poll just updates the store and lets Svelte wake the right derived nodes.

### End-to-end latency, post-P5/P6

Compared to the current ~25 s typical / 55 s worst case (see §1.4):

| Path | Today | After P5+P6 |
|---|---|---|
| GPS reports → marker moves (auto) | 0–55 s | 0–20 s (15 s poll + 5 s tick) |
| Refresh tap → marker moves | 30 s waiting for `nowTicker` | ~150 ms |
| ETA label flips a minute (auto) | 0–30 s | 0–5 s |

The win on refresh is the user-facing one: tapping the button is finally meaningful.

---

## 7. Open design questions

Decisions needed before P1 starts. None of them block writing the v1 port modules (those are pure).

- **Q.1 — Where does the speed profile live?** ~~Per-feed config in `neary-gtfs/feeds/<id>/config.json`, or per-feed-per-route, or derived from observation (P0 output)?~~ **DECIDED 2026-06-27: per-feed.** Per-route is overkill — in the city centre many routes overlap with essentially the same traffic profile.
- **Q.2 — Per-stop dwell.** Flat 20 s, or per-stop based on observed headway / boarding volume, or per-stop-class (terminal vs through-stop vs request-only)? Recommendation: flat 20 s ship, per-class once we have observed data. *Open.*
- **Q.3 — City-centre tier from v1.** ~~Do we keep it?~~ **DECIDED 2026-06-27: keep v1's city-centre tier for now.** Sits between the time-of-day profile and the static fallback. Centroid computed once at build time per feed.
- **Q.4 — Map liveness vs battery.** ~~Drop `nowTicker` to 5 s globally, or only the map page (P6)?~~ **DECIDED 2026-06-27: drop to 5 s globally.** Single timer; no per-page gating.
- **Q.5 — Should reconciliation use GPS position?** The position-aware tie-break in §5 fixes same-time crossings but adds a per-candidate projection call. Cheap, but worth being explicit. Recommendation: yes, with a fallback to timing-only when no GPS is available for the candidate. *Open.*
- **Q.6 — What does the Map view do when GPS is VERY_STALE?** ~~v1 dropped the vehicle. v2-today renders the schedule position regardless.~~ **DECIDED 2026-06-27: freeze at last known position with a yellow border, no dead-reckoning forward.** Vehicle stays visible so the user still knows where it was last seen.
- **Q.7 — Test corpus.** We don't have one yet for prediction quality. Recommendation: P0 captures a week of vehicle pings; a CSV of `(tripId, stopId, scheduled_arrival, observed_arrival)` triples becomes the regression input. Each predictor is scored on MAE against it. *Open.*

---

## 8. Anti-goals

Things this design deliberately does *not* attempt, with reasons:

- **No Kalman filter / state-space model.** Tunable per-feed parameters are a real ops burden; the cascade gives 80 % of the win with 10 % of the complexity.
- **No historical speed database.** OneBusAway-style per-segment learned models need a backend. We don't have one, and the project is still a static PWA.
- **No machine-learning ETA.** Same reason. Plus accountability matters here — a heuristic cascade is debuggable line by line.
- **No prediction storage / replay.** Predictions are ephemeral per tick. Tests run on canned inputs.
- **No multi-feed merging at runtime.** Each feed's predictor uses only its own GPS + its own schedule. If two feeds share a route (rare), they get two predictions.
- **No bypass of the worker.** All SQLite access stays in `gtfs.worker.ts`; the predictor modules are pure functions called from the page-level `$derived`s.

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
