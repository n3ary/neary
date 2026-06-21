/**
 * Compact <-> expanded schedule payload codec.
 *
 * The on-CDN format ({@link CompactSchedulePayload}) deduplicates stop-time
 * sequences: the Cluj feed's ~14.7k trips collapse to ~194 unique relative
 * patterns (98.7% redundant), since the same route pattern runs many times a
 * day differing only by start time. Storing each pattern once + a per-trip
 * {patternIndex, startMinutes, serviceId} ref cuts the payload from ~1.13 MB gz
 * to ~0.1 MB gz and shrinks the localStorage footprint accordingly.
 *
 * - `compactifySchedule` runs server-side (pipeline) to produce the CDN payload.
 * - `expandSchedule` runs client-side after fetch/hydrate to rebuild the
 *   queryable {@link SchedulePayload} (absolute minutes-since-midnight times).
 *
 * Round-trip: `expandSchedule(compactifySchedule(p))` deep-equals `p` when each
 * trip's stop times are ordered by stop_sequence (the pipeline guarantees this).
 *
 * Pure functions — no I/O, no store access.
 */

import type {
  SchedulePayload,
  CompactSchedulePayload,
  ScheduleStopTime,
  PatternStop,
} from '../../types/schedule';

/** First-stop departure (offset base) for a trip = lowest-`q` stop's `d`. */
function firstDeparture(stopTimes: ScheduleStopTime[]): number {
  let first = stopTimes[0];
  for (const st of stopTimes) {
    if (st.q < first.q) first = st;
  }
  return first.d;
}

/**
 * Build the canonical pattern (offsets from `base`, ordered by stop_sequence)
 * plus a stable dedupe key for a trip's stop times.
 */
function toPattern(
  stopTimes: ScheduleStopTime[],
  base: number,
): { pattern: PatternStop[]; key: string } {
  const ordered = [...stopTimes].sort((l, r) => l.q - r.q);
  const pattern: PatternStop[] = ordered.map((st) => ({
    s: st.s,
    q: st.q,
    a: st.a - base,
    d: st.d - base,
  }));
  // Compact, collision-free key (fixed field order).
  const key = pattern.map((p) => `${p.s},${p.q},${p.a},${p.d}`).join(';');
  return { pattern, key };
}

/**
 * Deduplicate an expanded {@link SchedulePayload} into the compact CDN form.
 */
export function compactifySchedule(payload: SchedulePayload): CompactSchedulePayload {
  const patterns: PatternStop[][] = [];
  const patternIndexByKey = new Map<string, number>();
  const trips: CompactSchedulePayload['trips'] = {};

  for (const [tripId, stopTimes] of Object.entries(payload.stopTimes)) {
    if (!stopTimes || stopTimes.length === 0) continue;

    const base = firstDeparture(stopTimes);
    const { pattern, key } = toPattern(stopTimes, base);

    let index = patternIndexByKey.get(key);
    if (index === undefined) {
      index = patterns.length;
      patterns.push(pattern);
      patternIndexByKey.set(key, index);
    }

    trips[tripId] = {
      p: index,
      t: base,
      s: payload.tripServiceMap[tripId] ?? '',
      r: payload.tripRouteMap?.[tripId],
      h: payload.tripHeadsignMap?.[tripId],
    };
  }

  return {
    version: payload.version,
    ...(payload.agencyId !== undefined ? { agencyId: payload.agencyId } : {}),
    patterns,
    trips,
    calendar: payload.calendar,
    calendarExceptions: payload.calendarExceptions,
  };
}

/**
 * Expand the compact CDN payload back into a queryable {@link SchedulePayload}
 * with absolute minutes-since-midnight stop times.
 */
export function expandSchedule(compact: CompactSchedulePayload): SchedulePayload {
  const stopTimes: Record<string, ScheduleStopTime[]> = {};
  const tripServiceMap: Record<string, string> = {};
  const tripRouteMap: Record<string, number> = {};
  const tripHeadsignMap: Record<string, string> = {};

  for (const [tripId, ref] of Object.entries(compact.trips)) {
    const pattern = compact.patterns[ref.p];
    if (!pattern) continue;
    stopTimes[tripId] = pattern.map((ps) => ({
      s: ps.s,
      q: ps.q,
      a: ps.a + ref.t,
      d: ps.d + ref.t,
    }));
    tripServiceMap[tripId] = ref.s;
    if (ref.r !== undefined) tripRouteMap[tripId] = ref.r;
    if (ref.h !== undefined) tripHeadsignMap[tripId] = ref.h;
  }

  return {
    version: compact.version,
    ...(compact.agencyId !== undefined ? { agencyId: compact.agencyId } : {}),
    stopTimes,
    calendar: compact.calendar,
    calendarExceptions: compact.calendarExceptions,
    tripServiceMap,
    tripRouteMap,
    tripHeadsignMap,
  };
}

/** Runtime guard: does this look like a compact payload (vs malformed/legacy)? */
export function isCompactSchedulePayload(value: unknown): value is CompactSchedulePayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as CompactSchedulePayload).patterns) &&
    typeof (value as CompactSchedulePayload).trips === 'object' &&
    (value as CompactSchedulePayload).trips !== null
  );
}
