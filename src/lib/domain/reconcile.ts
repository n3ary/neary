/*
 * reconcile — merge live GPS observations into a scheduled vehicle list.
 *
 * Match key (spec: docs/specs/live-data-pipeline.md):
 *
 *   (routeId, directionId, tripStartMin) with adaptive tolerance.
 *
 * trip_id equality is NOT used as a fast-path. Some operators publish
 * static GTFS and GTFS-RT from independent build pipelines that happen
 * to share the same `route_dir_service_run_HHMM` schema but populate
 * `<run>_<HHMM>` from independent dispatch databases. Cluj sampling
 * 2026-06-27 showed ~23% of live trip_ids drifted from their static
 * counterparts by ±1 run number and/or ±a few minutes in HHMM. Strict
 * trip_id matching would silently lose those buses.
 *
 * Adaptive tolerance: median gap between consecutive scheduled trip
 * starts on the same (routeId, directionId) within the local ±1h window
 * around `now`, divided by 2. Clamped to [TOLERANCE_FLOOR_MIN,
 * TOLERANCE_CEILING_MIN]. When <3 samples exist in the local hour we
 * widen progressively (±4h → full day) until we have enough.
 *
 * Output is a uniform Vehicle[]: matched scheduled rows are upgraded
 * to `kind: 'reconciled'`; unmatched scheduled rows stay `kind:
 * 'scheduled'`; AND unmatched live observations are emitted as
 * `kind: 'live'` rows when their (routeId, directionId) has a
 * representative scheduled sibling on the input (so we know the
 * route+direction is relevant to whatever view called us, and we
 * have a sibling headsign to copy onto the orphan). True orphans
 * — live observations on a (route, direction) that doesn't appear
 * in the input scheduled list at all — are dropped.
 *
 * Re-attribution: this function is stateless and runs every poll cycle.
 * Each cycle picks the best (closest tripStartMin) match independently.
 * If GPS movement causes a different scheduled run to become a better
 * fit on the next cycle, binding self-heals.
 *
 * Pure. No DOM, no stores, no I/O.
 */

import type { LiveVehicleObservation } from '$lib/data/live/gtfsRtClient';
import type { Vehicle } from './types';
import { minSinceMidnightInTz, timeToMinutes } from './pipeline/timeUtils';
import { projectOnPolyline, type MeasuredPolyline } from './shapeProjection';

const TOLERANCE_FLOOR_MIN = 1;
const TOLERANCE_CEILING_MIN = 30;
const LOCAL_WINDOW_MIN = 60;
const LOCAL_WINDOW_FALLBACK_MIN = 240;
const MIN_HEADWAY_SAMPLES = 2;

/** When route-order pair lands a (sched, live) match whose projected
 *  positions disagree by more than this, treat the no-overtake
 *  invariant as broken for the cohort (detour, terminus turnaround,
 *  bad GPS) and fall back to greedy-by-timing for that cohort. */
const ROUTE_ORDER_IMPLAUSIBLE_M = 2_000;

export interface ReconcileStats {
  /** Scheduled rows upgraded to `kind: 'reconciled'`. */
  matched: number;
  /** Scheduled rows left as `kind: 'scheduled'` (no live candidate). */
  unmatched: number;
  /** Live observations that had a candidate group but were ambiguous
   *  (multiple scheduled trips within tolerance, all tied for closest).
   *  Reserved for future telemetry; today the closest still wins. */
  ambiguous: number;
  /** Live observations emitted as `kind: 'live'` orphan rows because
   *  no scheduled row was a match but their (route, direction) is on
   *  the input. */
  live: number;
}

export interface ReconcileOptions {
  /** Unix ms wall clock. Combined with `timezone` to compute the
   *  feed-local minutes-since-midnight that drives the adaptive
   *  tolerance window. */
  nowMs?: number;
  /** Feed's IANA timezone, e.g. 'Europe/Bucharest'. Required when
   *  `nowMs` is supplied. When omitted the reconciler falls back to a
   *  fixed ±5 min tolerance. */
  timezone?: string;
  /** Optional shape lookup keyed by `${routeId}|${directionId}`. When a
   *  cohort's shape is provided AND `nowMs`+`timezone` are set, the
   *  reconciler matches by route order (sort scheduled by start time
   *  asc + live obs by projected `distAlongM` desc, pair in sequence)
   *  instead of greedy-by-timing-delta. Captures the physical truth
   *  that buses on the same `(route, dir)` don't overtake each other,
   *  which timing-only matching can violate on high-frequency lines.
   *  Falls back to greedy-by-timing per cohort when the shape is
   *  absent or when the route-order pairing is implausible (any pair's
   *  expected-vs-actual distance disagrees by more than
   *  `ROUTE_ORDER_IMPLAUSIBLE_M`). */
  shapesByCohort?: ReadonlyMap<string, MeasuredPolyline>;
}

export function reconcileWithLive(
  scheduled: Vehicle[],
  live: LiveVehicleObservation[],
  options: ReconcileOptions = {},
): { vehicles: Vehicle[]; stats: ReconcileStats } {
  const nowMinSinceMidnight =
    options.nowMs != null && options.timezone
      ? minSinceMidnightInTz(options.nowMs, options.timezone)
      : undefined;
  // Index scheduled vehicles by (routeId, directionId). Only
  // kind:'scheduled' rows that carry the new match-key fields are
  // eligible — anything already promoted is left alone (idempotent),
  // and rows missing tripStartMin / directionId are skipped (defensive
  // for stale data shapes). `tripEndMin` (= scheduledArrival on
  // active-trips Vehicles) feeds the route-order pairing's linear
  // time interpolation; falls back to `tripStartMin` (zero duration)
  // when scheduledArrival is missing, which degrades route-order to
  // "everyone is at origin" and then matches by timing only.
  const byKey = new Map<string, SchedEntry[]>();
  scheduled.forEach((v, idx) => {
    if (v.kind !== 'scheduled') return;
    const dir = v.schedule.directionId;
    const start = v.schedule.tripStartMin;
    if ((dir !== 0 && dir !== 1) || typeof start !== 'number') return;
    const end = v.schedule.scheduledArrival ?? start;
    const key = `${v.route.id}|${dir}`;
    const list = byKey.get(key) ?? [];
    list.push({ idx, v, tripStartMin: start, tripEndMin: end });
    byKey.set(key, list);
  });

  // Group live observations into the same cohort keys + parse start
  // times once. Live obs whose cohort has no scheduled siblings are
  // dropped here (the orphan-emission pass below will still consider
  // them — same gate as before).
  const liveByKey = new Map<string, LiveEntry[]>();
  for (const obs of live) {
    const startMin = parseLiveStartMin(obs);
    if (startMin == null) continue;
    const dir = obs.directionId;
    if (dir !== 0 && dir !== 1) continue;
    const key = `${Number(obs.routeId)}|${dir}`;
    if (!byKey.has(key)) continue;
    const list = liveByKey.get(key) ?? [];
    list.push({ obs, startMin });
    liveByKey.set(key, list);
  }

  // Per-cohort matching: try route-order pairing when a shape is
  // available, fall back to greedy-by-timing-delta otherwise (or when
  // route-order produces an implausible pairing). Cohorts are disjoint
  // (different routes / directions), so per-cohort processing is
  // identical in outcome to a global pair-then-greedy walk.
  const matchByScheduledIdx = new Map<number, LiveVehicleObservation>();
  const matchedLiveObs = new Set<LiveVehicleObservation>();
  let ambiguous = 0;
  for (const [key, scheds] of byKey) {
    const lives = liveByKey.get(key);
    if (!lives || lives.length === 0) continue;
    const tol = computeTolerance(scheds.map((e) => e.tripStartMin), nowMinSinceMidnight);
    const shape = options.shapesByCohort?.get(key);
    const useRouteOrder =
      shape != null && nowMinSinceMidnight != null && lives.length >= 1 && scheds.length >= 1;
    const pairings = useRouteOrder
      ? pairCohortRouteOrder(scheds, lives, tol, shape, nowMinSinceMidnight)
      : pairCohortGreedyByTiming(scheds, lives, tol);
    for (const p of pairings.pairs) {
      matchByScheduledIdx.set(p.schedIdx, p.obs);
      matchedLiveObs.add(p.obs);
    }
    ambiguous += pairings.ambiguous;
  }

  let matched = 0;
  let unmatched = 0;
  const vehicles = scheduled.map<Vehicle>((v, idx) => {
    if (v.kind !== 'scheduled') return v;
    const obs = matchByScheduledIdx.get(idx);
    if (!obs) {
      unmatched += 1;
      return v;
    }
    matched += 1;
    return {
      kind: 'reconciled',
      id: v.id,
      route: v.route,
      type: v.type,
      tripId: v.tripId,
      directionId: v.directionId,
      schedule: v.schedule,
      headsign: v.headsign,
      eta: v.eta,
      dropOffOnly: v.dropOffOnly,
      confidence: 'medium',
      position: {
        lat: obs.lat,
        lon: obs.lon,
        source: 'gps',
        asOf: obs.asOfMs > 0 ? obs.asOfMs : Date.now(),
        speedMs: obs.speedMs,
      },
      liveSources: ['gtfs-rt'],
    };
  });

  // Emit kind: 'live' rows for live observations that didn't match any
  // scheduled row. Two gates:
  //   1) The (routeId, directionId) must appear on the input — we copy
  //      a representative sibling's route + headsign onto the orphan
  //      and refuse to surface a route the view doesn't already show.
  //   2) The observation must carry a usable directionId (0 | 1).
  // The Vehicle the reconciler emits is uniform with the rest of the
  // pipeline (downstream applyGpsEta / assembleStationBoard treat
  // kind: 'live' alongside kind: 'reconciled' for bucketing).
  //
  // ETA seed for parked-at-origin orphans:
  //   We also record the sibling's TRAVEL TIME from origin to this
  //   stop (sibling.scheduledArrival − sibling.tripStartMin). When
  //   the orphan reports its own tripStartMin (from `start_time` or
  //   the `..._HHMM` suffix), we synthesize an ETA on the emitted
  //   row: `(obs.tripStartMin + travelTimeMin) − nowMin`. This gives
  //   a sensible ETA for a bus parked at the trip's origin where
  //   GPS speed is zero and a pure-GPS ETA would use the fallback
  //   speed (noisy). `applyGpsEta` downstream KEEPS this seed for
  //   genuinely-at-origin orphans and OVERWRITES it with a GPS-
  //   derived ETA once the bus is moving — so an early departure
  //   self-corrects on the next render tick.
  let liveOut = 0;
  const repByKey = new Map<string, {
    route: Vehicle['route'];
    headsign: string | undefined;
    travelTimeMin: number | undefined;
  }>();
  for (const v of scheduled) {
    if (v.kind !== 'scheduled') continue;
    const dir = v.schedule.directionId;
    if (dir !== 0 && dir !== 1) continue;
    const key = `${v.route.id}|${dir}`;
    const arrivalMin = v.schedule.scheduledArrival ?? v.schedule.scheduledDeparture;
    const startMin = v.schedule.tripStartMin;
    const travelTimeMin =
      typeof arrivalMin === 'number' && typeof startMin === 'number' && arrivalMin >= startMin
        ? arrivalMin - startMin
        : undefined;
    const existing = repByKey.get(key);
    if (
      !existing ||
      // Prefer reps with both headsign + travel time when filling in.
      (!existing.headsign && v.headsign) ||
      (existing.travelTimeMin == null && travelTimeMin != null)
    ) {
      repByKey.set(key, {
        route: v.route,
        headsign: v.headsign ?? existing?.headsign,
        travelTimeMin: travelTimeMin ?? existing?.travelTimeMin,
      });
    }
  }
  for (const obs of live) {
    if (matchedLiveObs.has(obs)) continue;
    if (!obs.tripId) continue;
    const dir = obs.directionId;
    if (dir !== 0 && dir !== 1) continue;
    const rep = repByKey.get(`${obs.routeId}|${dir}`);
    if (!rep) continue;
    // Sibling-derived ETA seed (re-evaluated each tick by applyGpsEta).
    let etaSeed: Vehicle['eta'] | undefined;
    const obsStartMin = parseLiveStartMin(obs);
    if (
      obsStartMin != null &&
      rep.travelTimeMin != null &&
      nowMinSinceMidnight != null
    ) {
      const expectedArrivalMin = obsStartMin + rep.travelTimeMin;
      etaSeed = {
        minutes: Math.round(expectedArrivalMin - nowMinSinceMidnight),
        distanceMeters: 0,
        confidence: 'low',
      };
    }
    vehicles.push({
      kind: 'live',
      id: `live:${obs.tripId}`,
      route: rep.route,
      type: rep.route.type ?? 'unknown',
      tripId: obs.tripId,
      directionId: dir,
      headsign: rep.headsign,
      confidence: 'medium',
      eta: etaSeed,
      position: {
        lat: obs.lat,
        lon: obs.lon,
        source: 'gps',
        asOf: obs.asOfMs > 0 ? obs.asOfMs : Date.now(),
        speedMs: obs.speedMs,
      },
      liveSources: ['gtfs-rt'],
    });
    liveOut += 1;
  }

  return { vehicles, stats: { matched, unmatched, ambiguous, live: liveOut } };
}

/** Parse the live observation's scheduled start time into minutes since
 *  local midnight. Prefers the canonical `TripDescriptor.start_time`
 *  ("HH:MM:SS"), falls back to parsing the last four digits of the
 *  trip_id when the feed encodes start time there (the
 *  `..._HHMM` suffix used by both Cluj static + Cluj RT). Returns null
 *  if neither source yields a parseable time. */
export function parseLiveStartMin(obs: LiveVehicleObservation): number | null {
  if (obs.startTime) {
    return timeToMinutes(obs.startTime);
  }
  // trip_id tail pattern: any suffix ending in `_HHMM` or `_HMM` digits.
  const m = obs.tripId.match(/_(\d{3,4})$/);
  if (!m) return null;
  const digits = m[1];
  // 3 digits = HMM, 4 digits = HHMM.
  const h = digits.length === 4 ? Number(digits.slice(0, 2)) : Number(digits.slice(0, 1));
  const min = Number(digits.slice(-2));
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  if (h < 0 || h > 30 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** Compute the matching tolerance (in minutes) for a single
 *  (routeId, directionId) cohort. Uses the median gap between
 *  consecutive trip starts within ±1h of `now` for that cohort.
 *  Widens the window if there are fewer than MIN_HEADWAY_SAMPLES
 *  trips, and falls back to a fixed tolerance when `now` is unknown. */
export function computeTolerance(
  tripStartMins: number[],
  nowMinSinceMidnight?: number,
): number {
  if (tripStartMins.length === 0) return TOLERANCE_FLOOR_MIN;
  if (nowMinSinceMidnight == null) return clampTolerance(5);

  for (const window of [LOCAL_WINDOW_MIN, LOCAL_WINDOW_FALLBACK_MIN, Infinity]) {
    const lo = nowMinSinceMidnight - window;
    const hi = nowMinSinceMidnight + window;
    const local = tripStartMins
      .filter((m) => m >= lo && m <= hi)
      .sort((a, b) => a - b);
    if (local.length < MIN_HEADWAY_SAMPLES) continue;
    const gaps: number[] = [];
    for (let i = 1; i < local.length; i++) gaps.push(local[i] - local[i - 1]);
    gaps.sort((a, b) => a - b);
    const mid = Math.floor(gaps.length / 2);
    const median = gaps.length % 2 === 0 ? (gaps[mid - 1] + gaps[mid]) / 2 : gaps[mid];
    return clampTolerance(median / 2);
  }
  // Cohort too small even across the whole day — use the floor so we
  // only match dead-center hits.
  return TOLERANCE_FLOOR_MIN;
}

function clampTolerance(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return TOLERANCE_FLOOR_MIN;
  return Math.max(TOLERANCE_FLOOR_MIN, Math.min(TOLERANCE_CEILING_MIN, value));
}

// ---------------------------------------------------------------------------
// Cohort-level matchers. Each takes one (route, dir) cohort's scheduled
// rows and live observations and returns the matched pairs (plus an
// `ambiguous` telemetry count). The outer reconciler aggregates results
// across cohorts.
// ---------------------------------------------------------------------------

type SchedEntry = {
  idx: number;
  v: Vehicle;
  tripStartMin: number;
  tripEndMin: number;
};
type LiveEntry = { obs: LiveVehicleObservation; startMin: number };
type CohortMatch = {
  pairs: Array<{ schedIdx: number; obs: LiveVehicleObservation }>;
  ambiguous: number;
};

/** Today's behaviour, extracted: enumerate all (live, sched) pairs
 *  within tolerance, sort by `|delta|` ascending, greedy walk. Each
 *  live obs and each scheduled row participate in at most one match.
 *  Used as the fallback when no shape is available or when route-order
 *  pairing produces an implausible result. */
function pairCohortGreedyByTiming(
  scheds: readonly SchedEntry[],
  lives: readonly LiveEntry[],
  tol: number,
): CohortMatch {
  type Pair = { obs: LiveVehicleObservation; schedIdx: number; delta: number };
  const pairs: Pair[] = [];
  let ambiguous = 0;
  for (const { obs, startMin } of lives) {
    let inTol = 0;
    let minDelta = Infinity;
    for (const c of scheds) {
      const delta = Math.abs(c.tripStartMin - startMin);
      if (delta > tol) continue;
      pairs.push({ obs, schedIdx: c.idx, delta });
      inTol += 1;
      if (delta < minDelta) minDelta = delta;
    }
    if (inTol >= 2) {
      let tiedAtMin = 0;
      for (const c of scheds) {
        if (Math.abs(c.tripStartMin - startMin) === minDelta) tiedAtMin += 1;
      }
      if (tiedAtMin > 1) ambiguous += 1;
    }
  }
  pairs.sort((a, b) => a.delta - b.delta);
  const result: CohortMatch = { pairs: [], ambiguous };
  const usedSched = new Set<number>();
  const usedObs = new Set<LiveVehicleObservation>();
  for (const p of pairs) {
    if (usedSched.has(p.schedIdx) || usedObs.has(p.obs)) continue;
    usedSched.add(p.schedIdx);
    usedObs.add(p.obs);
    result.pairs.push({ schedIdx: p.schedIdx, obs: p.obs });
  }
  return result;
}

/** Route-order pairing. Captures the no-overtake invariant: buses on
 *  the same (route, dir) don't pass each other in normal operation, so
 *  the earliest scheduled trip should pair with the live obs that's
 *  furthest along the shape.
 *
 *  Deliberately ignores the timing tolerance for pair eligibility —
 *  the whole motivation for route-order is that the operator's
 *  reported `start_time` can lie, and timing-only matching mis-pairs
 *  in that case. The cohort itself (same route + direction) is the
 *  scope guard; getActiveTrips already filters scheduled trips to the
 *  "currently in transit" window upstream.
 *
 *  Algorithm:
 *    1. Project every live obs onto the shape; record `distAlongM`.
 *    2. Compute each scheduled trip's expected `distAlongM` at `now`
 *       via linear time interpolation:
 *         expected = (now - tripStartMin) / (tripEndMin - tripStartMin)
 *                  × shape.totalDistM
 *       clamped to [0, totalDistM].
 *    3. Sort scheduled by `tripStartMin` ascending (earliest = furthest
 *       along expected).
 *    4. Sort live by `distAlongM` descending (furthest along first).
 *    5. Pair in sequence (min(n_sched, n_live) pairs).
 *    6. If any pair's expected-vs-actual distance disagrees by more
 *       than `ROUTE_ORDER_IMPLAUSIBLE_M`, the no-overtake invariant
 *       likely doesn't hold for this cohort (detour, terminus
 *       turnaround, bad GPS). Fall back to greedy-by-timing for the
 *       whole cohort. */
function pairCohortRouteOrder(
  scheds: readonly SchedEntry[],
  lives: readonly LiveEntry[],
  tol: number,
  shape: MeasuredPolyline,
  nowMin: number,
): CohortMatch {
  if (shape.points.length < 2 || shape.totalDistM <= 0) {
    return pairCohortGreedyByTiming(scheds, lives, tol);
  }
  const liveDist = lives.map((l) => ({
    obs: l.obs,
    distAlongM: projectOnPolyline(
      { lat: l.obs.lat, lon: l.obs.lon },
      shape.points,
    ).distAlongM,
  }));
  const schedDist = scheds.map((s) => {
    const duration = s.tripEndMin - s.tripStartMin;
    const expectedDistAlongM =
      duration > 0
        ? Math.max(
            0,
            Math.min(
              shape.totalDistM,
              ((nowMin - s.tripStartMin) / duration) * shape.totalDistM,
            ),
          )
        : 0;
    return { idx: s.idx, tripStartMin: s.tripStartMin, expectedDistAlongM };
  });
  // Sort schedule by start asc (earliest first → furthest along expected).
  schedDist.sort((a, b) => a.tripStartMin - b.tripStartMin);
  // Sort live by distAlongM desc (furthest along first).
  const sortedLive = [...liveDist].sort((a, b) => b.distAlongM - a.distAlongM);

  const n = Math.min(schedDist.length, sortedLive.length);
  const pairs: Array<{
    schedIdx: number;
    obs: LiveVehicleObservation;
    distDelta: number;
  }> = [];
  for (let i = 0; i < n; i++) {
    const s = schedDist[i];
    const l = sortedLive[i];
    pairs.push({
      schedIdx: s.idx,
      obs: l.obs,
      distDelta: Math.abs(s.expectedDistAlongM - l.distAlongM),
    });
  }

  // Implausibility check: a single bad pair signals the invariant
  // doesn't hold; fall back rather than ship a wrong pairing.
  if (pairs.some((p) => p.distDelta > ROUTE_ORDER_IMPLAUSIBLE_M)) {
    return pairCohortGreedyByTiming(scheds, lives, tol);
  }

  return {
    pairs: pairs.map((p) => ({ schedIdx: p.schedIdx, obs: p.obs })),
    ambiguous: 0,
  };
}
