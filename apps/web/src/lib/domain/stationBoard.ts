/*
 * stationBoard — pure helpers for turning a raw Vehicle[] into a
 * ready-to-render board for a single station. Used by:
 *   - the Stations view (/) per nearby stop
 *   - the Schedule drill-down (/schedule/route/[id]?stop=…) (Phase 6)
 *
 * No DOM, no stores, no SQL. The worker hands us Vehicle[]; this module
 * applies the user's view preferences and produces sorted bucketed rows
 * the UI just renders.
 */

import {
  bucketOf,
  compareForBoard,
  filterForStationView,
  type ArrivalBucket,
} from './buckets';
import type { Vehicle } from './types';

export interface BoardRow {
  vehicle: Vehicle;
  bucket: ArrivalBucket;
  /** Signed minutes (negative = past). Cached so the sort doesn't redo math. */
  etaMinutes: number;
}

export interface BoardPrefs {
  showDepartedVehicles: boolean;
  showDropOffOnly: boolean;
}

/** Minutes since local midnight for a UNIX ms timestamp. */
function nowMinSinceMidnight(nowMs: number): number {
  const d = new Date(nowMs);
  return d.getHours() * 60 + d.getMinutes();
}

/** Assemble the bucketed, filtered, sorted board for one station's
 *  worth of vehicles. Pure. The result is capped at 5 rows (see
 *  `capStationBoard` for the picking rule) so the card stays scannable. */
export function assembleStationBoard(
  vehicles: Vehicle[],
  prefs: BoardPrefs,
  nowMs: number,
): BoardRow[] {
  const nowMin = nowMinSinceMidnight(nowMs);
  const rows: BoardRow[] = vehicles.map((v) => ({
    vehicle: v,
    bucket: bucketOf(v.kind, {
      etaMinutes: v.eta?.minutes ?? 0,
      distanceToStopMeters: 0,
      scheduledArrivalMin: v.schedule?.scheduledArrival,
      scheduledDepartureMin: v.schedule?.scheduledDeparture,
      nowMin,
    }),
    etaMinutes: v.eta?.minutes ?? 0,
  }));
  const sorted = filterForStationView(rows, prefs).sort(compareForBoard);
  return capStationBoard(sorted);
}

/** Max rows shown on a single StationCard. Held here (not in NearyConfig)
 *  because it's a UX layout decision, not a transit-logic one. */
export const STATION_BOARD_MAX_ROWS = 5;

/** Cap the board to STATION_BOARD_MAX_ROWS using this rule:
 *   1. Take the first row of each bucket (1 max per bucket).
 *   2. If we still have slack, fill it with extra `incoming` rows (the
 *      bucket users most want to see more of — "how many buses are
 *      coming?").
 *  Output preserves the input's bucket-then-eta sort order. Pure. */
export function capStationBoard(rows: BoardRow[]): BoardRow[] {
  const seen = new Set<ArrivalBucket>();
  const picked: BoardRow[] = [];
  const incomingOverflow: BoardRow[] = [];
  for (const r of rows) {
    if (!seen.has(r.bucket)) {
      seen.add(r.bucket);
      picked.push(r);
    } else if (r.bucket === 'incoming') {
      incomingOverflow.push(r);
    }
  }
  while (picked.length < STATION_BOARD_MAX_ROWS && incomingOverflow.length > 0) {
    picked.push(incomingOverflow.shift()!);
  }
  // Picked respects input order (bucket-then-eta), but the expansion
  // appended incoming rows possibly after a `departed` first-pick — sort
  // once more so the on-screen order matches compareForBoard exactly.
  return picked.sort(compareForBoard).slice(0, STATION_BOARD_MAX_ROWS);
}
