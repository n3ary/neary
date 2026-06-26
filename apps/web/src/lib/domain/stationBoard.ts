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
import type { Route, Vehicle } from './types';

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
 *  worth of vehicles. Pure. The `departed` bucket is collapsed to one
 *  row per route (the most-recent departure) so it doesn't dominate
 *  the board with 20+ minutes of past trips when the user opts in. */
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
  return collapseDepartedByRoute(sorted);
}

/** Within the `departed` bucket, keep only the most-recent row per route.
 *  Other buckets pass through untouched. Sort order is assumed to already
 *  have most-recent-first inside `departed` (see compareForBoard).
 *  Pulled out as its own helper for testability. */
export function collapseDepartedByRoute(rows: BoardRow[]): BoardRow[] {
  const seen = new Set<number>();
  const out: BoardRow[] = [];
  for (const r of rows) {
    if (r.bucket === 'departed') {
      if (seen.has(r.vehicle.route.id)) continue;
      seen.add(r.vehicle.route.id);
    }
    out.push(r);
  }
  return out;
}

/** Deduplicated, naturally-sorted list of routes from a `Vehicle[]`.
 *  Numeric route shortNames sort numerically; the rest fall back to
 *  lexicographic. Used to render the badge row on a StationCard. */
export function dedupRoutes(vehicles: Vehicle[]): Route[] {
  const map = new Map<number, Route>();
  for (const v of vehicles) map.set(v.route.id, v.route);
  return Array.from(map.values()).sort((a, b) => {
    const an = Number(a.shortName);
    const bn = Number(b.shortName);
    if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn;
    return a.shortName.localeCompare(b.shortName);
  });
}
