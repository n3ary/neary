/*
 * GTFS frequencies.txt expansion — the consumer side of the anchor-trip
 * + headway-window model.
 *
 * Per the GTFS spec, a row in `frequencies.txt` says: "for this
 * `trip_id`, run every `headway_secs` seconds from `start_time` to
 * `end_time`, applying the anchor trip's `stop_times` as offsets
 * relative to each departure time". The cluj-napoca adapter emits
 * these rows for `*-range` annotations (e.g. M26 `05:05-22:40` /
 * `10-20min`).
 *
 * The publisher pipeline (gtfs-publisher#252) added the table to the
 * SQLite DDL; the app-side consumer expands a frequency row into one
 * `GeneratedDeparture` per departure in the active window. Each
 * generated departure carries the `effectiveStartMin` (the k-th
 * departure's origin time) and a `k` index (so per-stop offset times
 * can be derived: anchor's stop_time at sequence N + k*headway_secs).
 *
 * Soft-probe via `hasFrequenciesTable(db)` — cached blobs that
 * pre-date the publisher's DDL addition return false and the caller
 * degrades to schedule-only behaviour without throwing.
 */

import type { Database } from '@sqlite.org/sqlite-wasm';
import { selectAll } from '../sqlHelpers';
import { timeToMinutes } from '$lib/domain/pipeline/timeUtils';

/** Raw row from `frequencies` (anchor trip's service_id is joined via trips). */
export interface FrequencyRow {
  trip_id: string;
  start_time: string;
  end_time: string;
  headway_secs: number;
  exact_times: number | null;
}

/** One generated departure inside a frequency row's window. */
export interface GeneratedDeparture {
  /** k-th departure's origin time, in minutes since local midnight. */
  effectiveStartMin: number;
  /** 0-based departure index. Multiply by headway_secs to get the offset from start_time. */
  k: number;
}

/** True when the open SQLite blob has a `frequencies` table. Cached
 *  blobs that pre-date the publisher's DDL addition (gtfs-publisher#252)
 *  return false; callers should treat as "no frequency-based trips". */
export function hasFrequenciesTable(db: Database): boolean {
  const row = db.selectValue(
    `SELECT count(*) FROM sqlite_master WHERE type='table' AND name='frequencies'`,
  ) as number | null;
  return row === 1;
}

/** All frequencies rows whose anchor trip runs on any of the given
 *  service_ids today. Filters out `exact_times=1` (schedule-based
 *  trips with a frequencies row — the spec allows it for legacy
 *  feeds; we expand `exact_times=0` only). No window filter —
 *  callers do that themselves so the window semantics stay in one
 *  place (`expandFrequencyToDepartures`). */
export function getFrequenciesForServices(
  db: Database,
  serviceIds: readonly string[],
): FrequencyRow[] {
  if (serviceIds.length === 0) return [];
  const placeholders = serviceIds.map(() => '?').join(',');
  type Row = {
    trip_id: string;
    start_time: string;
    end_time: string;
    headway_secs: number;
    exact_times: number | null;
  };
  return selectAll<Row>(
    db,
    `SELECT f.trip_id, f.start_time, f.end_time, f.headway_secs, f.exact_times
     FROM frequencies f
     JOIN trips t ON t.trip_id = f.trip_id
     WHERE t.service_id IN (${placeholders})
       AND (f.exact_times IS NULL OR f.exact_times = 0);`,
    serviceIds,
  );
}

/** Pure expansion: turn one frequency row into N `GeneratedDeparture`s,
 *  one per departure whose effective time falls in `[windowStartMin,
 *  windowEndMin]`. The GTFS spec says the trip runs at `start_time,
 *  start_time + headway, start_time + 2*headway, …` up to but not
 *  including `end_time`. A departure whose effective time is exactly
 *  `end_time` is NOT generated (it's the exclusive end bound). Pure —
 *  no I/O, no Date, fully unit-testable.
 *
 *  Returns [] on garbage input (unparseable times, non-positive
 *  headway, or window that doesn't intersect the frequency window).
 *  These guards are belt-and-suspenders — the publisher's DDL
 *  CHECKs (`start_time < end_time`, `headway_secs > 0`) reject the
 *  bad rows at INSERT time. */
export function expandFrequencyToDepartures(
  freq: FrequencyRow,
  windowStartMin: number,
  windowEndMin: number,
): GeneratedDeparture[] {
  const startMin = timeToMinutes(freq.start_time);
  const endMin = timeToMinutes(freq.end_time);
  if (!Number.isFinite(startMin) || !Number.isFinite(endMin)) return [];
  if (endMin <= startMin) return [];

  const headwayMin = freq.headway_secs / 60;
  if (!(headwayMin > 0)) return [];

  // The frequency window may straddle midnight (cluj has 25:00+ rows
  // for past-midnight trips), so we use the raw minutes-since-
  // midnight arithmetic — the window argument is the same unit.
  // The end bound is exclusive: a departure AT endMin is not
  // generated (per the spec's "up to but not including end_time").
  const out: GeneratedDeparture[] = [];
  // Clamp kStart to 0: the first departure is at startMin, never earlier.
  const kStart = Math.max(0, Math.ceil((windowStartMin - startMin) / headwayMin));
  // kFreqEnd: largest k whose effective time is STRICTLY < endMin.
  // `ceil - 1` handles both the integer-divisible case (e.g. start=5:00,
  // end=7:30, headway=30 → ceil(150/30)-1 = 4, excludes 7:30) and the
  // non-divisible case (e.g. 1055/15 = 70.33 → ceil-1 = 70, includes
  // 22:35 and excludes 22:50). A `- 1` on the floor would be wrong on
  // the non-divisible case.
  const kFreqEnd = Math.ceil((endMin - startMin) / headwayMin) - 1;
  // kWindowEnd: the query window is inclusive on both ends, matching
  // the existing `getActiveTrips` window filter at
  // src/lib/workers/gtfs/queries/activeTrips.ts:65-72.
  const kWindowEnd = Math.floor((windowEndMin - startMin) / headwayMin);
  const kEnd = Math.min(kFreqEnd, kWindowEnd);
  if (kEnd < kStart) return [];

  for (let k = kStart; k <= kEnd; k++) {
    out.push({
      effectiveStartMin: startMin + k * headwayMin,
      k,
    });
  }
  return out;
}

/** Convenience: expand many frequency rows at once. Returns a Map
 *  keyed by trip_id; rows with no departures in the window are
 *  omitted (callers can iterate the map and treat absence as
 *  "not active in window"). */
export function expandFrequenciesToDepartures(
  freqs: readonly FrequencyRow[],
  windowStartMin: number,
  windowEndMin: number,
): Map<string, GeneratedDeparture[]> {
  const out = new Map<string, GeneratedDeparture[]>();
  for (const f of freqs) {
    const deps = expandFrequencyToDepartures(f, windowStartMin, windowEndMin);
    if (deps.length > 0) out.set(f.trip_id, deps);
  }
  return out;
}

/** For one frequency-based trip, fetch the anchor's full stop_times
 *  in stop_sequence order. The expansion helper uses these to
 *  derive per-stop effective times (anchor's stop_time + k*headway).
 *  Returns rows in the same shape as a stop_times table scan (no
 *  stop_name / stop_lat / stop_lon — those are joined in the
 *  per-stop queries, not here, so this helper stays decoupled from
 *  the stops table). */
export interface AnchorStopTimeRow {
  trip_id: string;
  stop_id: string;
  /** Anchor offset time, HH:MM:SS. The k-th generated departure's
   *  effective time at this stop is `arrival_time + k*headway_secs`. */
  arrival_time: string;
  departure_time: string;
  stop_sequence: number;
  pickup_type: number | null;
}

export function getAnchorStopTimes(
  db: Database,
  tripId: string,
): AnchorStopTimeRow[] {
  return selectAll<AnchorStopTimeRow>(
    db,
    `SELECT trip_id, stop_id, arrival_time, departure_time, stop_sequence, pickup_type
     FROM stop_times
     WHERE trip_id = ?
     ORDER BY stop_sequence ASC;`,
    [tripId],
  );
}
