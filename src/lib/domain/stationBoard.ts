/*
 * stationBoard — pure helpers for turning a raw Vehicle[] into a
 * ready-to-render board for a single station. Used by:
 *   - the Stations view (/) per nearby stop
 *   - the Schedule drill-down (/schedule/route/[id]?stop=…)
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
import { predictEta } from './predictEta';
import { reconcileWithLive } from './reconcile';
import type { LiveVehicleObservation } from '$lib/data/live/gtfsRtClient';
import { projectOnPolyline, type Polyline } from './shapeProjection';
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
  /** Maximum vehicle rows per station card. Defaults to STATION_BOARD_MAX_ROWS. */
  stationBoardMaxRows?: number;
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
  const rows: BoardRow[] = vehicles.map((v) => {
    const rawBucket = bucketOf(v.kind, {
      etaMinutes: v.eta?.minutes ?? 0,
      distanceToStopMeters:
        v.position && typeof stop.lat === 'number' && typeof stop.lon === 'number'
          ? haversineMeters(v.position.lat, v.position.lon, stop.lat, stop.lon)
          : Number.POSITIVE_INFINITY,
      scheduledArrivalMin: v.schedule?.scheduledArrival,
      scheduledDepartureMin: v.schedule?.scheduledDeparture,
      nowMin,
    });
    // Drop-off-only vehicles can't be boarded — segregate into their own
    // section so they don't pollute incoming/arriving. Departed ones keep
    // 'departed' (the drop-off flag is irrelevant once the vehicle has left).
    const bucket = v.dropOffOnly && rawBucket !== 'departed' ? 'drop-off' : rawBucket;
    return { vehicle: v, bucket, etaMinutes: v.eta?.minutes ?? 0 };
  });
  const sorted = filterForStationView(rows, prefs).sort(compareForBoard);
  return capStationBoard(sorted, prefs.stationBoardMaxRows ?? STATION_BOARD_MAX_ROWS);
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
export function capStationBoard(rows: BoardRow[], maxRows = STATION_BOARD_MAX_ROWS): BoardRow[] {
  const seen = new Set<ArrivalBucket>();
  const firsts: BoardRow[] = [];
  const extraDropOff: BoardRow[] = [];
  const extraIncoming: BoardRow[] = [];
  // Whether the guaranteed drop-off slot was filled by a live vehicle.
  // If so, we also want the first scheduled drop-off (next in line).
  let dropOffGuaranteedIsLive = false;
  let firstScheduledDropOff: BoardRow | null = null;

  for (const r of rows) {
    if (!seen.has(r.bucket)) {
      seen.add(r.bucket);
      firsts.push(r);
      if (r.bucket === 'drop-off') {
        const v = r.vehicle;
        dropOffGuaranteedIsLive =
          v.kind === 'live' || v.kind === 'reconciled' || v.kind === 'corroborated';
      }
    } else if (r.bucket === 'drop-off') {
      const v = r.vehicle;
      const isLive = v.kind === 'live' || v.kind === 'reconciled' || v.kind === 'corroborated';
      if (isLive) {
        extraDropOff.push(r);
      } else if (!firstScheduledDropOff) {
        firstScheduledDropOff = r;
      }
    } else if (r.bucket === 'incoming') {
      extraIncoming.push(r);
    }
  }
  // When the guaranteed slot is live, also surface the soonest scheduled
  // drop-off so riders see what's coming next in the queue.
  if (firstScheduledDropOff && dropOffGuaranteedIsLive) {
    extraDropOff.push(firstScheduledDropOff);
  }
  const slots = Math.max(0, maxRows - firsts.length);
  return [...firsts, ...extraDropOff, ...extraIncoming].slice(0, firsts.length + slots).sort(compareForBoard);
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
 * Stage order matches docs/specs/vehicles-and-views.md:
 *   1. Route filter (visual scope chosen by the user) — applied first
 *      so the rest of the pipeline operates on the right subset.
 *   2. Live reconciliation (route+direction+startTime match).
 *   3. GPS-derived ETA (predictEta) on reconciled rows at intermediate
 *      stops. Origin rows keep the scheduled departure as their ETA
 *      because the bus isn't moving yet.
 *   4. Bucket + filter + sort + cap (assembleStationBoard).
 */

export interface AssembleLiveBoardInputs {
  vehicles: Vehicle[];
  stop: { lat?: number; lon?: number };
  liveObservations: LiveVehicleObservation[];
  /** Route shapes keyed by trip_id, from the worker (cached).
   *  Trips without a shape entry just keep their scheduled ETA.
   *  Pass `{}` to disable GPS-derived ETA altogether. */
  shapes: Record<string, Polyline>;
  prefs: BoardPrefs;
  nowMs: number;
  /** Feed's IANA timezone, e.g. 'Europe/Bucharest'. Used uniformly by
   *  the reconciler and bucketer for every minute-since-midnight
   *  comparison. Must match the timezone of the static GTFS feed that
   *  produced `vehicles`. */
  timezone: string;
  /** Optional view-only route filter from the StationCard badge row.
   *  Applied as the very first pipeline stage so it scopes the rest. */
  routeFilterId?: string | null;
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
  // Sibling-shape fallback for orphans whose own trip_id isn't in the
  // shapes Map (Cluj trip-id drift case ~23%). All trips on a single
  // (route, direction) share their shape_id in every feed we've seen,
  // so any scheduled sibling's polyline projects an orphan onto the
  // correct route geometry.
  const shapesByRouteDir = buildShapesByRouteDir(scoped, input.shapes);
  const predicted = applyGpsEta(reconciled, input.shapes, input.stop, shapesByRouteDir);
  return assembleStationBoard(predicted, input.stop, input.prefs, input.nowMs, input.timezone);
}

function buildShapesByRouteDir(
  scheduled: Vehicle[],
  shapes: Record<string, Polyline>,
): Record<string, Polyline> {
  const out: Record<string, Polyline> = {};
  for (const v of scheduled) {
    const dir = v.directionId;
    if (dir !== 0 && dir !== 1) continue;
    const key = `${v.route.id}|${dir}`;
    if (key in out) continue;
    const tid = v.tripId;
    if (!tid) continue;
    const shape = shapes[tid];
    if (!shape || shape.length < 2) continue;
    out[key] = shape;
  }
  return out;
}

/** Replace the schedule-based ETA on rows with a live position
 *  (`kind: 'reconciled'` and `kind: 'live'` orphans) with a GPS-
 *  derived one, where possible.
 *
 *  Shape lookup is two-step:
 *    1. By the row's own `tripId` (Cluj reconciled rows always
 *       resolve here; ~77% of orphans do too).
 *    2. By `(routeId, directionId)` from the sibling-shape fallback
 *       built in `assembleLiveBoard` — handles orphans whose own
 *       trip_id is in the live feed but absent from static (the
 *       remaining ~23% with HHMM/run drift in Cluj).
 *
 *  Skipped at trip origin:
 *   - For reconciled rows: when `v.schedule.isAtTripStart === true`.
 *     The schedule scanner labels the origin stop; predictEta would
 *     just produce noise from a parked bus's near-zero speed.
 *   - For orphan kind:'live' rows: detected from the GPS projection
 *     itself — bus's `distAlong` on the shape is < AT_ORIGIN_DIST_M
 *     AND its speed is < AT_ORIGIN_SPEED_MS (or unknown). When the
 *     bus is detected at origin we keep the reconciler's sibling-
 *     derived ETA seed (see reconcile.ts) instead of overwriting
 *     with a GPS-derived noise estimate. The detection re-runs
 *     every render tick, so the ETA self-corrects to GPS-derived
 *     the moment the bus starts moving — handles early departures.
 *
 *  Pure. */
export function applyGpsEta(
  vehicles: Vehicle[],
  shapes: Record<string, Polyline>,
  stop: { lat?: number; lon?: number },
  shapesByRouteDir: Record<string, Polyline> = {},
): Vehicle[] {
  if (typeof stop.lat !== 'number' || typeof stop.lon !== 'number') return vehicles;
  const stopPos = { lat: stop.lat, lon: stop.lon };
  return vehicles.map<Vehicle>((v) => {
    if (v.kind !== 'reconciled' && v.kind !== 'live') return v;
    if (v.kind === 'reconciled' && v.schedule.isAtTripStart === true) return v;
    if (!v.position) return v;
    const polyline = pickShape(v, shapes, shapesByRouteDir);
    if (!polyline || polyline.length < 2) return v;
    // For live orphans: detect "parked at origin" — keep the
    // sibling-derived ETA seed the reconciler attached, don't
    // overwrite with a GPS estimate driven by FALLBACK_SPEED_MS.
    if (v.kind === 'live') {
      const proj = projectOnPolyline(
        { lat: v.position.lat, lon: v.position.lon },
        polyline,
      );
      const speed = v.position.speedMs ?? 0;
      const atOrigin =
        proj.distAlongM < AT_ORIGIN_DIST_M && speed < AT_ORIGIN_SPEED_MS;
      if (atOrigin && v.eta != null) return v;
    }
    const p = predictEta({
      vehiclePos: { lat: v.position.lat, lon: v.position.lon },
      stopPos,
      polyline,
      vehicleSpeedMs: v.position.speedMs ?? null,
    });
    return {
      ...v,
      eta: {
        minutes: Math.round(p.minutes),
        distanceMeters: p.distanceMeters,
        confidence: p.confidence,
      },
    };
  });
}

/** Bus is "at origin" when its projection onto the trip shape is
 *  within this distance of the shape's start vertex. */
const AT_ORIGIN_DIST_M = 100;
/** And its reported speed (m/s) is below this. Includes null/undefined
 *  speed (parked buses often don't transmit speed). */
const AT_ORIGIN_SPEED_MS = 1;

function pickShape(
  v: Vehicle,
  shapes: Record<string, Polyline>,
  shapesByRouteDir: Record<string, Polyline>,
): Polyline | undefined {
  const tid = v.tripId;
  if (tid && shapes[tid]) return shapes[tid];
  const dir = v.directionId;
  if (dir !== 0 && dir !== 1) return undefined;
  return shapesByRouteDir[`${v.route.id}|${dir}`];
}

/** Deduped, sorted route list for a station based on the schedule.
 *  Lives in the domain so consumers (Stations page, future map view,
 *  showcase) all read routes the same way — numeric short-names sort
 *  numerically, alpha after. */
export function routesFromVehicles(vehicles: Vehicle[]): Route[] {
  const map = new Map<string, Route>();
  for (const v of vehicles) map.set(v.route.id, v.route);
  return Array.from(map.values()).sort((a, b) => {
    const an = Number(a.shortName);
    const bn = Number(b.shortName);
    if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn;
    return a.shortName.localeCompare(b.shortName);
  });
}
