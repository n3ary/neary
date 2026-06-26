/*
 * stationBoard — pure helpers for turning a raw Vehicle[] into a
 * ready-to-render board for a single station. Used by:
 *   - the Stations view (/) per nearby stop
 *   - the Schedule drill-down (/schedule/route/[id]?stop=…) (Phase 6)
 *
 * No DOM, no stores, no SQL. The worker hands us Vehicle[]; this module
 * applies the user's view preferences and produces sorted bucketed rows
 * the UI just renders.
 *
 * Timezone contract: every minute-since-midnight value in the pipeline
 * (scheduledDeparture, scheduledArrival, tripStartMin) is in the FEED's
 * local timezone. Callers must supply the feed timezone explicitly so
 * we don't silently mix system-local minutes with feed-local ones.
 */

import {
  bucketOf,
  compareForBoard,
  filterForStationView,
  type ArrivalBucket,
} from './buckets';
import { haversineMeters } from './distance';
import { minSinceMidnightInTz } from './pipeline/timeUtils';
import { reconcileWithLive } from './reconcile';
import type { LiveVehicleObservation } from '$lib/data/live/gtfsRtClient';
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
  /** Advanced: include vehicles bucketed as `off-route` in the board. */
  showOffRouteVehicles: boolean;
}

/** Assemble the bucketed, filtered, sorted board for one station's
 *  worth of vehicles. Pure. The result is capped at 5 rows (see
 *  `capStationBoard` for the picking rule) so the card stays scannable.
 *
 *  `stop` supplies the coordinates we need to measure how far each live
 *  vehicle actually is from the stop — the bucketer's at-station check
 *  is meaningful only with a real distance. Schedule-only vehicles (no
 *  position) get Infinity, which keeps them out of the at-stop branch.
 *
 *  `timezone` is the feed's IANA timezone (e.g. 'Europe/Bucharest'). It
 *  determines how `nowMs` is converted to minutes-since-midnight so the
 *  bucketer compares apples to apples with the schedule's HH:MM:SS
 *  values (which are feed-local by GTFS spec). */
export function assembleStationBoard(
  vehicles: Vehicle[],
  stop: { lat?: number; lon?: number },
  prefs: BoardPrefs,
  nowMs: number,
  timezone: string,
): BoardRow[] {
  const nowMin = minSinceMidnightInTz(nowMs, timezone);
  const rows: BoardRow[] = vehicles.map((v) => ({
    vehicle: v,
    bucket: bucketOf(v.kind, {
      etaMinutes: v.eta?.minutes ?? 0,
      distanceToStopMeters:
        v.position && typeof stop.lat === 'number' && typeof stop.lon === 'number'
          ? haversineMeters(v.position.lat, v.position.lon, stop.lat, stop.lon)
          : Number.POSITIVE_INFINITY,
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
 *  Output is re-sorted with compareForBoard so the on-screen order
 *  matches the spec regardless of where extras got appended. Pure. */
export function capStationBoard(rows: BoardRow[]): BoardRow[] {
  const seen = new Set<ArrivalBucket>();
  const firsts: BoardRow[] = [];
  const extraIncoming: BoardRow[] = [];
  for (const r of rows) {
    if (!seen.has(r.bucket)) {
      seen.add(r.bucket);
      firsts.push(r);
    } else if (r.bucket === 'incoming') {
      extraIncoming.push(r);
    }
  }
  const slots = Math.max(0, STATION_BOARD_MAX_ROWS - firsts.length);
  return [...firsts, ...extraIncoming.slice(0, slots)].sort(compareForBoard);
}

/* ---------------------------------------------------------------------- *
 * Top-level pipeline composer
 * ---------------------------------------------------------------------- *
 *
 * The Stations view (and any other consumer that wants a fully-resolved
 * board) calls this ONE function instead of chaining
 *   filter → reconcileWithLive → assembleStationBoard
 * itself. Keeps pipeline composition + timezone discipline in the
 * domain layer; the UI just renders what comes back.
 *
 * Stage order matches docs/rebuild-v2/vehicles-and-views.md §5.5:
 *   1. Route filter (visual scope chosen by the user) — applied first
 *      so the rest of the pipeline operates on the right subset.
 *   2. Live reconciliation (route+direction+startTime match).
 *   3. Bucket + filter + sort + cap (assembleStationBoard).
 */

export interface AssembleLiveBoardInputs {
  vehicles: Vehicle[];
  stop: { lat?: number; lon?: number };
  liveObservations: LiveVehicleObservation[];
  prefs: BoardPrefs;
  nowMs: number;
  /** Feed's IANA timezone, e.g. 'Europe/Bucharest'. Used uniformly by
   *  the reconciler and bucketer for every minute-since-midnight
   *  comparison. Must match the timezone of the static GTFS feed that
   *  produced `vehicles`. */
  timezone: string;
  /** Optional view-only route filter from the StationCard badge row.
   *  Applied as the very first pipeline stage so it scopes the rest. */
  routeFilterId?: number | null;
}

export function assembleLiveBoard(input: AssembleLiveBoardInputs): BoardRow[] {
  const scoped =
    input.routeFilterId != null
      ? input.vehicles.filter((v) => v.route.id === input.routeFilterId)
      : input.vehicles;
  const { vehicles: reconciled } = reconcileWithLive(scoped, input.liveObservations, {
    nowMs: input.nowMs,
    timezone: input.timezone,
  });
  return assembleStationBoard(reconciled, input.stop, input.prefs, input.nowMs, input.timezone);
}

/** Deduped, sorted route list for a station based on the schedule.
 *  Lives in the domain so consumers (Stations page, future map view,
 *  showcase) all read routes the same way — numeric short-names sort
 *  numerically, alpha after. */
export function routesFromVehicles(vehicles: Vehicle[]): Route[] {
  const map = new Map<number, Route>();
  for (const v of vehicles) map.set(v.route.id, v.route);
  return Array.from(map.values()).sort((a, b) => {
    const an = Number(a.shortName);
    const bn = Number(b.shortName);
    if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn;
    return a.shortName.localeCompare(b.shortName);
  });
}
