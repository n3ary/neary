# Prediction v2 — plan

Living roadmap. Tick boxes as PRs land. Architecture and current behaviour
live in [docs/specs/live-data-pipeline.md](../specs/live-data-pipeline.md);
this doc only carries decisions and pending work.

## Where we are

Schedule-driven pipeline with worker-owned reconciliation (PR #72).
Live-GPS vehicles dead-reckon along the trip shape via
[`predictPositionFromGps`](../../src/lib/domain/predictPosition.ts).
Schedule-only markers snap to `nowTicker` ticks (15 s). ETA is
single-tier: vehicle's own `speedMs`, fallback to schedule.

Gap to close: per-segment ETA cascade, smooth marker animation between
ticks, and a path to empirical speeds.

## Settled decisions

These aren't up for re-litigation; they fix the shape of the work below.

- Speed profile is **per-feed**, not per-route. Lives in
  `neary-gtfs/feeds/<id>/config.json`.
- Intermediate-stop **dwell flat 20 s**. Per-stop-class lookup is a
  future refinement.
- **Cascade includes the city-centre tier** (v1 formula). Centroid baked
  once per feed at build time.
- **`nowTicker = 15 s`** globally, synced with `livePollMs`. Map marker
  smoothness comes from RAF interpolation between ticks, not from a
  faster global tick.
- **VERY_STALE GPS (≥ 5 min)**: freeze marker at last projected
  `distAlongM` with a yellow border. No dead-reckoning forward. Vehicle
  stays visible (don't drop like v1).
- No Kalman, no ML, no always-on historical service. Cascade is
  heuristic; everything's debuggable line by line.
- **Single source of truth for cascade math** — mirrored byte-for-byte
  between the two repos, CI-enforced. No duplicate implementations.
- **Validation is empirical.** No formal test corpus; quality is judged
  by using the app (rides, screenshots, gut feel). A regression-MAE
  pipeline is explicit anti-goal until we feel the lack of one.

## Open questions

- **Q1 — Should reconciliation tie-break by GPS position when timing
  alone is ambiguous?**

  Today's matcher uses `(routeId, directionId, tripStartMin)` with an
  adaptive timing tolerance. On a high-frequency route, two scheduled
  trips often sit inside the same tolerance window (e.g.
  `tripStartMin = 12:30` and `12:32`, a live obs reporting `12:31`).
  The smallest-delta winner can be wrong: a bus running 5 min late on
  the 12:30 trip looks identical to a bus running on time on the 12:32
  trip if we only look at start time.

  Proposal: project the live obs onto the route shape (we have the
  shape for ETA already). For each candidate scheduled trip, compute
  *where the trip should be right now* per its own schedule — also a
  `distAlongM`. Pick the candidate whose expected position is closest
  to where the bus actually is. Fall back to timing-only when shape
  projection isn't available.

  *Decide before item 6.*

---

## Work items

Numbered in dependency order. neary-gtfs work is grouped in §A at the end.

### 1. Shared `prediction-core` module — [ ]

Pure TS, no DOM/IO, lives at `src/lib/domain/prediction-core/`. Mirrored
into neary-gtfs (see §A.2) so build-time and runtime use the same math.

- [ ] `geo.ts` — `haversineMeters`, `projectOnPolyline`, `pointAtDistance`,
      `bearingAtDistance`. Port from existing
      [`shapeProjection.ts`](../../src/lib/domain/shapeProjection.ts).
- [ ] `timeOfDay.ts` — `clockToBucket(localMs, tz, profile): 'peak' | 'offpeak' | 'night'`.
      Reads `peakWindows` + `nightWindow` from feed config.
- [ ] `speedCascade.ts` — `estimateSegmentSpeed(args): SpeedSample`
      implementing all 5 tiers below. Same function used at build time
      (tiers 3–5 only; live data undefined) and at runtime (all five).
- [ ] `dwell.ts` — `dwellSecondsFor(stop): number`. Today flat 20 s;
      abstracted so per-class lookup is a one-file change.
- [ ] Unit tests in both repos against an identical canned corpus.

**Cascade tiers (per segment)**

| # | Source | Trigger | Confidence |
|---|---|---|---|
| 1 | `vehicle.speed` | current segment or +1 hop AND `vehicle.speed > 5 km/h` | high |
| 2 | p60 of nearby vehicles' speed (≤ 1 km, same direction, > 5 km/h) | 500 m – 2 km out AND ≥ 2 samples | high (≥5) / med (≥2) |
| 3 | Time-of-day profile from feed config | far segments or cascade fall-through | med / low |
| 4 | City-centre interpolation: `15 + 30 × (1 − dist/centre_radius_km)`, clamped `[kmh_min_city_centre, kmh_max_outskirts]` | TOD unavailable | low |
| 5 | Static fallback: `kmh_offpeak` from feed config | catastrophic | very-low |

Cascade runs **per segment**, not per vehicle. Speeds ≤ 5 km/h are
treated as "stopped, not moving" and excluded from tiers 1–2.

### 2. Consume `shape_dist_traveled` at runtime — [ ]

neary-gtfs already populates this column on every `stop_times` row
(see §A.1). Web app still re-projects every stop in `buildTripShapePlan`
on page load — wasted CPU.

- [ ] Surface `shape_dist_traveled` on the rows returned by
      [`getRouteMapView`](../../src/lib/workers/gtfs/queries/routeMapView.ts)
      and [`getStopsAlongTrip`](../../src/lib/workers/gtfs/queries/routeStops.ts).
- [ ] Drop the `projectOnPolyline` call in `buildTripShapePlan`; read
      `distAlongM` directly off the row.
- [ ] Measure: route-map load CPU drops by the projection share
      (hot route: 24B).

### 3. `predictArrivalAlongShape.ts` — multi-tier ETA — [ ]

Replaces today's single-tier [`predictEta.ts`](../../src/lib/domain/predictEta.ts).
Composes item 1's `estimateSegmentSpeed` with the shape walk from
item 2.

Signature:

```ts
predictArrivalAlongShape(args: {
  plan: TripShapePlan;
  vehicleDistAlongM: number;
  targetStops: TargetStop[];
  speedEstimator: SpeedEstimator;     // from item 1
  feedConfig: FeedSpeedConfig;
  nowMs: number;
}): ArrivalPlan[]
```

Per segment walked forward from `vehicleDistAlongM`:
`segmentTimeMin = (segDistM / 1000) / segmentSpeedKmh × 60`, then
`arriveAt += segmentTimeMin + dwellMin(stop)`. Output per target:
`{ etaMin, source, confidence }`. Stations board, Schedule view and Map
view all consume the same `ArrivalPlan` — no more `predictEta` vs
`predictPositionOnShape` ad-hoc split.

- [ ] Module + tests.
- [ ] Wire `assembleLiveBoard` to call it instead of `predictEta`.
- [ ] Optional: feature flag for A/B vs today's single-tier ETA.
- [ ] Delete `predictEta.ts` once the new path is the sole caller.

### 4. Continuous position rendering for every visible vehicle — [ ]

Live-GPS vehicles already dead-reckon. Schedule-only markers still snap
on each `nowTicker` tick. Goal: every marker glides between ticks.

Pattern (copied from the existing "traveling dots" RAF layer): each
marker stores `{ predictedPos, predictedVel }` at the last tick; an RAF
loop on the map page advances `pos += vel · dt` per frame. Predictor
recomputes the anchor at the next tick.

- [ ] Vehicle markers go through an RAF interpolator on the map page.
- [ ] Schedule-only path: `predictPositionOnShape` returns a
      `predictedVel` alongside `predictedPos`.
- [ ] Live-GPS path: `predictPositionFromGps` does the same.

### 5. VERY_STALE handling on the map — [ ]

Freshness bands: HEALTHY < 3 min · STALE < 5 min · VERY_STALE ≥ 5 min.

- [x] HEALTHY: dead-reckon from last GPS sample. (Already shipped —
      `predictPositionFromGps`, `freshness: 'fresh'`.)
- [x] STALE: render at the snapped GPS without forward dead-reckoning.
      (Already shipped — `freshness: 'stale'`.)
- [ ] VERY_STALE: freeze at last projected `distAlongM`, yellow border,
      vehicle remains visible.

Today the map page has a defensive `STALE_HARD_MAX_MS = 15 min` cap for
orphans but no VERY_STALE-with-border path.

### 6. Reconciliation GPS tie-break — [ ]

(Resolves Q1.) Among candidates within timing tolerance, prefer the one
whose projected `distAlongM` is closest to the elapsed-time expectation.
Fall back to timing-only when no GPS is available for the candidate.

- [ ] Decide Q1.
- [ ] Implement in [`reconcileWithLive`](../../src/lib/domain/reconcile.ts).
- [ ] Tests for the same-minute-crossing case.

### 7. Empirical per-segment speeds — [ ]

Long-term: capture → analyse → ship empirical speeds inside the same
SQLite the client already downloads. Collapses the cascade from 5 tiers
to **empirical baseline × live-correction multiplier**, with the cold-
start tiers (3–5) becoming sparse-cell backstop.

#### 7a. Capture script — [ ]

- [ ] `neary-gtfs/scripts/observe-cluj.mjs`: polls upstream GTFS-RT every
      ~15 s, stores raw snapshots locally. Manual invocation. Not wired
      into the build pipeline.

#### 7b. Analysis pass — [ ]

- [ ] `neary-gtfs/scripts/analyze-observations.mjs` reads snapshots,
      outputs per-bucket median speeds.

Method: speed = **position deltas between consecutive pings**, not the
reported `speed` field. Per-pair filters: same trip, monotone progress,
5 s < Δt < 60 s, 0.5 < kmh < 80, neither ping in `STOPPED_AT`.
Multi-segment intervals distribute `Δd` proportionally across touched
legs. Bucket by `(route_id, direction_id, segment_idx, hour_of_week)`,
take p60, drop buckets with < 20 samples.

#### 7c. Ship empirical data in SQLite — [ ]

New table in the existing artifact (no new endpoint):

```sql
CREATE TABLE segment_speeds (
  route_id      TEXT    NOT NULL,
  direction_id  INTEGER NOT NULL,
  segment_idx   INTEGER NOT NULL,
  hour_of_week  INTEGER NOT NULL,  -- 0..167
  kmh_p60       REAL    NOT NULL,
  sample_count  INTEGER NOT NULL,
  PRIMARY KEY (route_id, direction_id, segment_idx, hour_of_week)
);
```

- [ ] Schema in `make-sqlite.js`.
- [ ] neary-gtfs build picks up the latest analysis output and ships it
      in the feed's `.sqlite`.
- [ ] Worker query exposes per-bucket lookup to `speedCascade.ts`.

#### 7d. Cascade collapse — [ ]

- [ ] Tiers 1–2 fold into a live-correction multiplier
      (`observed / empirical_median`).
- [ ] Tiers 3–5 stay as cold-start + sparse-cell backstop.
- [ ] Instrument per-tier-fired counter. Target: tiers ≥ 3 fire on
      < 1 % of Cluj queries post-shipping.

---

## A. neary-gtfs work

Build-time changes live in the sibling repo. Grouped here so this plan
stays the single roadmap.

### A.1. Build-time interpolation — [x]

Shipped as **neary-gtfs#12**. Replaced the legacy haversine + 18 km/h +
0-dwell formula in `feeds/cluj-napoca/build.js` with shape-aware timing.

Current Cluj `feeds/cluj-napoca/config.json`:

- `speedKmh: { peak: 14, offpeak: 22, night: 28 }`
- Peak windows: 07:00–09:30, 16:00–19:00
- Night window: 22:30–05:30
- `intermediateDwellSec: 20`

`shape_dist_traveled` populated on every `stop_times` row.

### A.2. `prediction-core` mirror — [ ]

When item 1 lands:

- [ ] Mirror `src/lib/domain/prediction-core/` into
      `neary-gtfs/src/pipeline/lib/prediction-core/` as plain ESM JS.
- [ ] `scripts/sync-prediction-core.mjs` in neary-gtfs (TS → JS strip).
- [ ] `scripts/check-mirror.{sh,mjs}` in CI fails any PR that touches
      one copy without the other.

### A.3. Build-time `estimateSegmentSpeed` — [ ]

Once §A.2 lands:

- [ ] Replace the inline speed-bucket call in
      `feeds/cluj-napoca/lib/timing.js` with the shared
      `estimateSegmentSpeed` (tiers 3–5; live data undefined at build
      time). No behavioural change expected — same constants, single
      source of truth.

### A.4. Observation pipeline — [ ]

Items 7a–7c above live in neary-gtfs. Cross-referenced here so a
neary-gtfs reader can see the full picture.

---

## Anti-goals

Repeat-resistant against scope drift.

- No Kalman / state-space model.
- No machine-learning ETA.
- No always-on historical service in the release path (item 7 is opt-in,
  runs manually).
- No multi-feed merging at runtime.
- No bypass of the worker for SQLite access.
- No duplicate cascade implementation — `prediction-core` is the only source.
