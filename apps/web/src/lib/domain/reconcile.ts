/*
 * reconcile — merge live GPS observations into a scheduled vehicle list.
 *
 * Match key (spec: vehicles-and-views.md §6; see /memories/session/
 * reconciler-design.md for the full agreement):
 *
 *   (routeId, directionId, tripStartMin) with adaptive tolerance.
 *
 * trip_id equality is NOT used as a fast-path. Some operators publish
 * static GTFS and GTFS-RT from independent build pipelines that happen
 * to share the same `route_dir_service_run_HHMM` schema but use
 * independent run numbering and slightly different start times
 * (observed in Cluj — static run 84 starts at 14:21, live run 101 starts
 * at 14:23, same trip in reality). Trip-id equality is therefore at best
 * coincidental and at worst a false-positive across days/services.
 *
 * Adaptive tolerance: median gap between consecutive scheduled trip
 * starts on the same (routeId, directionId) within the local ±1h window
 * around `now`, divided by 2. Clamped to [TOLERANCE_FLOOR_MIN,
 * TOLERANCE_CEILING_MIN]. When <3 samples exist in the local hour we
 * widen progressively (±4h → full day) until we have enough.
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

const TOLERANCE_FLOOR_MIN = 1;
const TOLERANCE_CEILING_MIN = 30;
const LOCAL_WINDOW_MIN = 60;
const LOCAL_WINDOW_FALLBACK_MIN = 240;
const MIN_HEADWAY_SAMPLES = 2;

export interface ReconcileStats {
  /** Scheduled rows upgraded to `kind: 'reconciled'`. */
  matched: number;
  /** Scheduled rows left as `kind: 'scheduled'` (no live candidate). */
  unmatched: number;
  /** Live observations that had a candidate group but were ambiguous
   *  (multiple scheduled trips within tolerance, all tied for closest).
   *  Reserved for future telemetry; today the closest still wins. */
  ambiguous: number;
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
  // for stale data shapes).
  const byKey = new Map<string, Array<{ idx: number; v: Vehicle; tripStartMin: number }>>();
  scheduled.forEach((v, idx) => {
    if (v.kind !== 'scheduled') return;
    const dir = v.schedule.directionId;
    const start = v.schedule.tripStartMin;
    if ((dir !== 0 && dir !== 1) || typeof start !== 'number') return;
    const key = `${v.route.id}|${dir}`;
    const list = byKey.get(key) ?? [];
    list.push({ idx, v, tripStartMin: start });
    byKey.set(key, list);
  });

  // Cache tolerance per (routeId, directionId) so we don't recompute
  // the median for every observation on the same route.
  const toleranceCache = new Map<string, number>();
  function toleranceFor(key: string): number {
    const cached = toleranceCache.get(key);
    if (cached != null) return cached;
    const list = byKey.get(key);
    const tol = computeTolerance(list?.map((e) => e.tripStartMin) ?? [], nowMinSinceMidnight);
    toleranceCache.set(key, tol);
    return tol;
  }

  // Bipartite-style greedy assignment:
  //   1. Enumerate ALL (live, sched) pairs that fall within the
  //      cohort's adaptive tolerance, recording the delta.
  //   2. Sort by delta ascending so the strongest matches claim their
  //      slots first.
  //   3. Greedy walk: each live obs and each scheduled row participate
  //      in at most one match. A perfect (delta=0) pairing therefore
  //      always wins over a sloppy (delta=tol) pairing fighting for the
  //      same scheduled slot, no matter the iteration order of `live`.
  // This is strictly ≥ the previous first-iteration-wins variant; it
  // never loses a match the old code would have made, and recovers
  // dropped perfect matches in the common "two buses claim the same
  // sched slot" situation observed on high-frequency lines.
  type Pair = { obs: LiveVehicleObservation; schedIdx: number; delta: number };
  const pairs: Pair[] = [];
  let ambiguous = 0;
  for (const obs of live) {
    const liveStart = parseLiveStartMin(obs);
    if (liveStart == null) continue;
    const dir = obs.directionId;
    if (dir !== 0 && dir !== 1) continue;
    const key = `${Number(obs.routeId)}|${dir}`;
    const candidates = byKey.get(key);
    if (!candidates || candidates.length === 0) continue;

    const tol = toleranceFor(key);
    let inTol = 0;
    let minDelta = Infinity;
    for (const c of candidates) {
      const delta = Math.abs(c.tripStartMin - liveStart);
      if (delta > tol) continue;
      pairs.push({ obs, schedIdx: c.idx, delta });
      inTol += 1;
      if (delta < minDelta) minDelta = delta;
    }
    // Telemetry only: count obs that had ≥2 candidates at the same
    // closest delta — we still resolve via the global sort below.
    if (inTol >= 2) {
      let tiedAtMin = 0;
      for (const c of candidates) {
        if (Math.abs(c.tripStartMin - liveStart) === minDelta) tiedAtMin += 1;
      }
      if (tiedAtMin > 1) ambiguous += 1;
    }
  }
  pairs.sort((a, b) => a.delta - b.delta);

  const matchByScheduledIdx = new Map<number, LiveVehicleObservation>();
  const matchedLiveObs = new Set<LiveVehicleObservation>();
  for (const p of pairs) {
    if (matchByScheduledIdx.has(p.schedIdx)) continue;
    if (matchedLiveObs.has(p.obs)) continue;
    matchByScheduledIdx.set(p.schedIdx, p.obs);
    matchedLiveObs.add(p.obs);
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
      },
      liveSources: ['gtfs-rt'],
    };
  });

  return { vehicles, stats: { matched, unmatched, ambiguous } };
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
