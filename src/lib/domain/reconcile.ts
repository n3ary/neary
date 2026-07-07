// Merge live GPS observations into a scheduled vehicle list. Match key: (routeId, directionId, tripStartMin) with adaptive tolerance — not trip_id, because some operators publish static + RT from independent dispatch pipelines and trip_ids drift by ±1 run / ±a few minutes HHMM. Spec: docs/specs/live-data-pipeline.md. Pure. No DOM, no stores, no I/O.

import type { LiveVehicleObservation } from '$lib/data/live/gtfsRtClient';
import type { Vehicle } from './types';
import { minSinceMidnightInTz, timeToMinutes } from './pipeline/timeUtils';
import { projectOnPolyline, type MeasuredPolyline } from '@n3ary/gtfs-spec/shape';

const TOLERANCE_FLOOR_MIN = 1;
const TOLERANCE_CEILING_MIN = 30;
const LOCAL_WINDOW_MIN = 60;
const LOCAL_WINDOW_FALLBACK_MIN = 240;
const MIN_HEADWAY_SAMPLES = 2;

// When a (sched, live) pair's projected positions disagree by more than this, the no-overtake invariant is broken for the cohort (detour, turnaround, bad GPS); fall back to greedy-by-timing.
const ROUTE_ORDER_IMPLAUSIBLE_M = 2_000;

export interface ReconcileStats {
  /** Scheduled rows upgraded to `kind: 'tracked'`. */
  matched: number;
  /** Scheduled rows left as `kind: 'scheduled'` (no live candidate). */
  unmatched: number;
  /** Live observations that had a candidate group but were ambiguous (multiple scheduled trips within tolerance, all tied for closest). Today the closest still wins. */
  ambiguous: number;
  /** Live observations emitted as `kind: 'gps-only'` orphan rows. */
  live: number;
}

export interface ReconcileOptions {
  /** Combined with `timezone` for feed-local minutes-since-midnight that drives the adaptive tolerance window. */
  nowMs?: number;
  /** Required when `nowMs` is supplied. Without both, reconciler falls back to fixed ±5 min tolerance. */
  timezone?: string;
  /** `${routeId}|${directionId}` -> measured polyline. Enables route-order pairing (no-overtake invariant) instead of greedy-by-timing. Falls back per cohort when shape absent or pair produces implausible disagreement > ROUTE_ORDER_IMPLAUSIBLE_M. */
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

  // Index scheduled `scheduled` rows by (routeId, directionId). tripEndMin feeds route-order's linear interpolation; falls back to tripStartMin (zero duration) when scheduledArrival is missing, which degrades route-order to timing-only.
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

  // Per-cohort matching: route-order when a shape's available + cohort has both sides, otherwise greedy-by-timing. Cohorts are disjoint (different routes / directions), so per-cohort processing matches a global pair-then-greedy walk in outcome.
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
      kind: 'tracked',
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

  // Emit kind: 'gps-only' orphan rows for unmatched live obs. (routeId, directionId) must appear on the input so we copy a representative sibling's route+headsign and refuse to surface a route the view doesn't already show. The orphan carries a sibling-derived ETA seed (origin + travel-time-from-origin) for parked-at-origin buses; applyGpsEta downstream keeps that seed for genuinely-at-origin orphans and overwrites it once the bus starts moving.
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
      kind: 'gps-only',
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

/** Parse the live observation's scheduled start time into minutes since local midnight. Reads TripDescriptor.start_time ("HH:MM:SS") — per-feed trip_id encoding is resolved into `obs.startTime` upstream at parse time (see `enrichObservations.ts`). Returns null when the field is absent or unparseable. */
export function parseLiveStartMin(obs: LiveVehicleObservation): number | null {
  if (!obs.startTime) return null;
  return timeToMinutes(obs.startTime);
}

/** Matching tolerance in minutes. Median gap between consecutive trip starts within ±1h of `now`, divided by 2. Clamped to [TOLERANCE_FLOOR_MIN, TOLERANCE_CEILING_MIN]. Widens the window (4h, then full day) when < MIN_HEADWAY_SAMPLES exist locally. Falls back to fixed ±5 min when `now` is unknown. */
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
  // Cohort too small even across the whole day — use the floor so we only match dead-center hits.
  return TOLERANCE_FLOOR_MIN;
}

function clampTolerance(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return TOLERANCE_FLOOR_MIN;
  return Math.max(TOLERANCE_FLOOR_MIN, Math.min(TOLERANCE_CEILING_MIN, value));
}

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

/** Fallback matcher. Enumerate all (live, sched) pairs within tolerance, sort by `|delta|` ascending, greedy walk. Each live obs and scheduled row participate in at most one match. */
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

/** Route-order matcher. Captures the no-overtake invariant: earliest scheduled = furthest-along live. Algorithm: project live onto shape; expected scheduled distAlong via linear time interpolation; sort both sides; pair in sequence; if any pair's expected-vs-actual distance disagrees by > ROUTE_ORDER_IMPLAUSIBLE_M, fall back to greedy-by-timing for the whole cohort. */
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
  // Sort schedule by start asc (earliest first → furthest along expected)
  schedDist.sort((a, b) => a.tripStartMin - b.tripStartMin);
  // Sort live by distAlongM desc (furthest along first)
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

  if (pairs.some((p) => p.distDelta > ROUTE_ORDER_IMPLAUSIBLE_M)) {
    return pairCohortGreedyByTiming(scheds, lives, tol);
  }

  return {
    pairs: pairs.map((p) => ({ schedIdx: p.schedIdx, obs: p.obs })),
    ambiguous: 0,
  };
}
