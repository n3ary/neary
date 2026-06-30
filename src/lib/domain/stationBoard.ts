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
import { predictArrivalFromGps } from './predictArrivalAlongShape';
import { projectOnPolyline, type Polyline } from './shapeProjection';
import {
  DEFAULT_FEED_SPEED_CONFIG,
  type FeedSpeedConfig,
} from './speedCascade';
import { clockToBucket, DEFAULT_TOD_PROFILE, type TodProfile } from './timeOfDay';
import type { Route, Vehicle, VehicleEta } from './types';

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
  /** Per-context-bucket cap (applied to `incoming` / `drop-off` /
   *  `departed`). Defaults to `DEFAULT_CONTEXT_BUCKET_CAP`. The
   *  now-group (`departing` / `at-station` / `arriving`) and
   *  `off-route` are always uncapped. */
  stationBoardMaxRows?: number;
}

/** Assemble the bucketed, filtered, sorted board for one station's
 *  worth of vehicles. Pure. The result obeys the per-bucket cap rule
 *  in `capStationBoard` (now-group + off-route uncapped; context
 *  buckets capped at `stationBoardMaxRows`).
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
  return capStationBoard(sorted, prefs.stationBoardMaxRows ?? DEFAULT_CONTEXT_BUCKET_CAP);
}

/** Default cap applied to context buckets (`incoming` / `drop-off` /
 *  `departed`) when the user hasn't picked a value. Now-group buckets
 *  (`departing` / `at-station` / `arriving`) and the diagnostic
 *  `off-route` bucket are always uncapped. */
export const DEFAULT_CONTEXT_BUCKET_CAP = 3;

/** Per-bucket cap. Returns `null` for buckets the rider should always
 *  see in full:
 *
 *    - Now-group: `departing` / `at-station` / `arriving` — the
 *      actionable set, never hidden.
 *    - `off-route`: diagnostic, opt-in via Advanced settings; if the
 *      user has enabled it, show all of them.
 *
 *  Context buckets (`incoming` / `drop-off` / `departed`) share the
 *  setting-driven cap. */
function bucketCap(bucket: ArrivalBucket, maxRows: number): number | null {
  if (
    bucket === 'departing' ||
    bucket === 'at-station' ||
    bucket === 'arriving' ||
    bucket === 'off-route'
  ) {
    return null;
  }
  return maxRows;
}

/** Cohort key for the per-`(route, direction)` dedup pass. Treats
 *  undefined and -1 direction as the same value so feeds without
 *  `direction_id` don't fragment their routes. */
function dedupKey(row: BoardRow): string {
  return `${row.vehicle.route.id}_${row.vehicle.directionId ?? -1}`;
}

/** Trim the bucketed row set to what the StationCard will render.
 *
 *  Algorithm:
 *    1. Detect single-route board: if every row belongs to the same
 *       `routeId` the board already represents the rider's chosen
 *       view (single-route stop, or filtered via route badge — both
 *       directions of the route still survive). Dedup is skipped;
 *       per-bucket caps still apply.
 *    2. Group rows by bucket, preserving the input order (rows arrive
 *       pre-sorted by `compareForBoard`).
 *    3. Per-`(route, direction)` dedup inside each bucket — keep the
 *       soonest row per pair. Active only when step 1 said so.
 *    4. `later`-trip filter (only when dedup is skipped): drop rows
 *       whose `tripPhase` is `later` — future trips that haven't
 *       departed origin yet. Pure timetable guesses, no useful
 *       position info; the station card focuses on what's happening
 *       NOW for this route. The schedule view answers "when does
 *       this route run next-after-next". Applies uniformly across
 *       every bucket (incoming, drop-off, departed, …) — wherever a
 *       `later` row would surface, it gets hidden. `tripPhase` is set
 *       on every emitted row by `scheduleScanner.assignTripPhases`.
 *    5. Per-bucket cap (`bucketCap`). Now-group and `off-route`
 *       buckets are uncapped; context buckets use `maxRows`.
 *    6. Re-sort with `compareForBoard` so the on-screen order matches
 *       the spec regardless of bucket-traversal order.
 *
 *  Pure. */
export function capStationBoard(rows: BoardRow[], maxRows = DEFAULT_CONTEXT_BUCKET_CAP): BoardRow[] {
  if (rows.length === 0) return rows;

  const routes = new Set<string>();
  for (const r of rows) routes.add(r.vehicle.route.id);
  const dedupActive = routes.size > 1;

  const byBucket = new Map<ArrivalBucket, BoardRow[]>();
  for (const r of rows) {
    const list = byBucket.get(r.bucket);
    if (list) list.push(r);
    else byBucket.set(r.bucket, [r]);
  }

  const out: BoardRow[] = [];
  for (const [bucket, bucketRows] of byBucket) {
    let kept: BoardRow[];
    if (dedupActive) {
      const seen = new Set<string>();
      kept = [];
      for (const r of bucketRows) {
        const k = dedupKey(r);
        if (seen.has(k)) continue;
        seen.add(k);
        kept.push(r);
      }
    } else {
      kept = bucketRows.filter((r) => r.vehicle.schedule?.tripPhase !== 'later');
    }
    const cap = bucketCap(bucket, maxRows);
    if (cap != null) kept = kept.slice(0, cap);
    out.push(...kept);
  }

  return out.sort(compareForBoard);
}

/* ---------------------------------------------------------------------- *
 * Top-level pipeline composer
 * ---------------------------------------------------------------------- *
 *
 * The Stations view (and any other consumer that wants a fully-resolved
 * board) calls this ONE function instead of chaining
 *   filter → mergeReconciledIntoStationBoard → applyGpsEta → assembleStationBoard
 * itself. Keeps pipeline composition + timezone discipline in the
 * domain layer; the UI just renders what comes back.
 *
 * Stage order matches docs/specs/vehicles-and-views.md:
 *   1. Route filter (visual scope chosen by the user) — applied first
 *      so the rest of the pipeline operates on the right subset.
 *   2. Reconciled-vehicle merge — join per-stop scheduled rows with
 *      the worker's global reconciled set by `tripId`. Matched rows
 *      become `kind: 'tracked'` (GPS-bearing); orphan live obs
 *      whose (route, dir) the station serves are appended as
 *      `kind: 'gps-only'` rows with a sibling-derived ETA seed.
 *   3. GPS-derived ETA (multi-tier speed cascade) on reconciled rows
 *      at intermediate stops. Origin rows keep the scheduled departure
 *      as their ETA because the bus isn't moving yet.
 *   4. Bucket + filter + sort + cap (assembleStationBoard).
 */

/** Inputs for `assembleLiveVehicles` — the worker-side half of the
 *  live pipeline (merge + GPS-ETA). The main-side bucket step lives
 *  separately so route filter + prefs (UI state) don't have to cross
 *  the worker IPC boundary. */
export interface AssembleLiveVehiclesInputs {
  /** Per-stop scheduled vehicles, all `kind: 'scheduled'`. */
  perStopVehicles: Vehicle[];
  stop: { lat?: number; lon?: number };
  /** Globally-reconciled vehicles from the worker's broadcast. */
  reconciledVehicles: Vehicle[];
  shapes: Record<string, Polyline>;
  stopDistancesByTrip?: Record<string, number[]>;
  nowMs: number;
  timezone: string;
  /** Seconds added per intermediate stop in the dwell walk. From the
   *  feed's _neary_config timing.dwell_sec; defaults to 20. */
  dwellSec?: number;
}

/** Merge + GPS-ETA — the heavy half of the live pipeline. Runs inside
 *  the worker (via `repo.subscribeStationBoards`) so shape polylines and
 *  stop-distance arrays never cross the IPC boundary. Pure function;
 *  exported for the worker query and for direct unit testing. */
export function assembleLiveVehicles(input: AssembleLiveVehiclesInputs): Vehicle[] {
  const nowMin = minSinceMidnightInTz(input.nowMs, input.timezone);
  const merged = mergeReconciledIntoStationBoard({
    perStopVehicles: input.perStopVehicles,
    reconciledVehicles: input.reconciledVehicles,
    nowMin,
  });
  // Sibling-shape fallback for orphans whose own trip_id isn't in the
  // shapes Map (Cluj trip-id drift case ~23%). All trips on a single
  // (route, direction) share their shape_id in every feed we've seen,
  // so any scheduled sibling's polyline projects an orphan onto the
  // correct route geometry.
  const shapesByRouteDir = buildShapesByRouteDir(input.perStopVehicles, input.shapes);
  return applyGpsEta(merged, input.shapes, input.stop, shapesByRouteDir, {
    nowMs: input.nowMs,
    timezone: input.timezone,
    stopDistancesByTrip: input.stopDistancesByTrip ?? {},
    dwellSec: input.dwellSec,
  });
}

/** Inputs for `bucketLiveBoardMemo` — the main-side half of the live
 *  pipeline. Vehicles are already merged + GPS-ETA-adjusted by the
 *  worker (`repo.subscribeStationBoards`); main only filters by route and
 *  buckets/caps for display. */
export interface BucketLiveBoardInputs {
  /** Per-stop vehicles, already through `assembleLiveVehicles` in the
   *  worker — `kind` is final and ETA is GPS-adjusted where applicable. */
  vehicles: Vehicle[];
  stop: { lat?: number; lon?: number };
  prefs: BoardPrefs;
  nowMs: number;
  timezone: string;
  routeFilterId?: string | null;
}

const bucketLiveBoardCache = new WeakMap<object, {
  inputs: BucketLiveBoardInputs;
  result: BoardRow[];
}>();

/** Memoised main-side bucketing for vehicles already assembled by the
 *  worker. Replaces `assembleLiveBoardMemo` once the worker owns the
 *  shape / GPS-ETA half of the pipeline. */
export function bucketLiveBoardMemo(input: BucketLiveBoardInputs): BoardRow[] {
  const cached = bucketLiveBoardCache.get(input.stop);
  if (
    cached &&
    cached.inputs.vehicles === input.vehicles &&
    cached.inputs.prefs === input.prefs &&
    cached.inputs.nowMs === input.nowMs &&
    cached.inputs.timezone === input.timezone &&
    cached.inputs.routeFilterId === input.routeFilterId
  ) {
    return cached.result;
  }
  const scoped = input.routeFilterId != null
    ? input.vehicles.filter((v) => v.route.id === input.routeFilterId)
    : input.vehicles;
  const result = assembleStationBoard(scoped, input.stop, input.prefs, input.nowMs, input.timezone);
  bucketLiveBoardCache.set(input.stop, { inputs: input, result });
  return result;
}

/* ---------------------------------------------------------------------- *
 * Station-side merge with the worker's reconciled vehicles
 * ---------------------------------------------------------------------- *
 *
 * The worker emits a GLOBAL reconciled vehicle set (no per-stop
 * context). The station view has a PER-STOP scheduled board with
 * arrival times at this specific stop. This helper joins them:
 *
 *   - Matched (`tripId` present in both): promote the per-stop row
 *     to `kind: 'tracked'`, keeping its per-stop schedule and
 *     copying the GPS position + freshness from the worker.
 *   - Orphans (worker `kind: 'gps-only'` rows whose (route, dir) is on
 *     the per-stop board): emit as `kind: 'gps-only'` rows on the
 *     station's board, with an ETA seed computed from a per-stop
 *     sibling's travel-time-from-origin (so a bus parked at the
 *     trip origin gets a sensible "arrives in N min" instead of
 *     waiting for GPS speed > 0).
 *
 * Pure. */
export interface StationMergeInputs {
  perStopVehicles: Vehicle[];
  reconciledVehicles: Vehicle[];
  /** Minutes since local midnight at the feed's timezone. Used for
   *  the orphan ETA seed only. */
  nowMin: number;
}

export function mergeReconciledIntoStationBoard(inputs: StationMergeInputs): Vehicle[] {
  const { perStopVehicles, reconciledVehicles, nowMin } = inputs;

  // Index reconciled (GPS-matched) rows by tripId for O(1) promotion.
  // We keep ONLY `kind: 'tracked'` here; orphans are handled below.
  const reconciledByTripId = new Map<string, Vehicle>();
  for (const v of reconciledVehicles) {
    if (v.kind !== 'tracked') continue;
    if (!v.tripId) continue;
    reconciledByTripId.set(v.tripId, v);
  }

  // Per-stop representative per (route, dir) for orphan ETA seed:
  // travelTimeMin = scheduledArrival at THIS stop − tripStartMin at
  // origin. Same recipe the old reconciler used per-station, just
  // moved here since the worker doesn't know the consumer's stop.
  // `dropOffOnly` also tracked here so live orphans at a terminus or
  // a drop-off-only stop inherit the flag from their scheduled
  // siblings — without it the orphan would leak into the now-group
  // buckets (arriving / at-station / departing) instead of routing
  // to `drop-off` in `assembleStationBoard`.
  const repByKey = new Map<string, {
    headsign: string | undefined;
    travelTimeMin: number | undefined;
    dropOffOnly: boolean | undefined;
  }>();
  for (const v of perStopVehicles) {
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
      (existing.travelTimeMin == null && travelTimeMin != null) ||
      (existing.dropOffOnly !== true && v.dropOffOnly === true)
    ) {
      repByKey.set(key, {
        headsign: v.headsign ?? existing?.headsign,
        travelTimeMin: travelTimeMin ?? existing?.travelTimeMin,
        dropOffOnly: v.dropOffOnly === true ? true : existing?.dropOffOnly,
      });
    }
  }

  // Promote matched per-stop scheduled rows to `kind: 'tracked'`.
  // Keep the per-stop schedule (arrival times at THIS stop) — we just
  // attach the GPS position and confidence from the worker's row.
  const promoted: Vehicle[] = perStopVehicles.map((v) => {
    if (v.kind !== 'scheduled') return v;
    const tid = v.tripId;
    if (!tid) return v;
    const reconciled = reconciledByTripId.get(tid);
    if (!reconciled || !reconciled.position) return v;
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
      position: reconciled.position,
      liveSources: ['gtfs-rt'],
    };
  });

  // Emit orphan kind:'gps-only' rows for live obs the worker couldn't
  // match to any active trip but whose (route, dir) this station
  // serves. Two gates:
  //   1) (route, dir) appears in `repByKey` — station-side scope.
  //      The worker already gated against the global active-trip
  //      set, so this is a per-station tightening.
  //   2) The reconciled row has a position (always true for
  //      kind:'gps-only' per the type union).
  const orphans: Vehicle[] = [];
  for (const v of reconciledVehicles) {
    if (v.kind !== 'gps-only') continue;
    const dir = v.directionId;
    if (dir !== 0 && dir !== 1) continue;
    const key = `${v.route.id}|${dir}`;
    const rep = repByKey.get(key);
    if (!rep) continue;
    let etaSeed: VehicleEta | undefined;
    const obsStartMin = v.schedule?.tripStartMin;
    if (obsStartMin != null && rep.travelTimeMin != null) {
      etaSeed = {
        minutes: Math.round(obsStartMin + rep.travelTimeMin - nowMin),
        distanceMeters: 0,
        confidence: 'low',
      };
    }
    orphans.push({
      ...v,
      headsign: v.headsign ?? rep.headsign,
      eta: etaSeed,
      // At a terminus or drop-off-only stop the matched sibling
      // carries dropOffOnly=true; propagate so this orphan routes
      // to the `drop-off` bucket in assembleStationBoard.
      dropOffOnly: v.dropOffOnly ?? rep.dropOffOnly,
    });
  }

  return [...promoted, ...orphans];
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

/** Context for `applyGpsEta` — wall clock + feed-tuned tuning. */
export interface ApplyGpsEtaContext {
  /** Unix ms wall clock. */
  nowMs: number;
  /** Feed's IANA timezone. Combined with `nowMs` to compute the
   *  feed-local TOD bucket used by the speed cascade. */
  timezone: string;
  /** Per-feed speed config. Defaults to the Cluj-tuned defaults; when
   *  the feed registry eventually publishes `timing` blocks per feed,
   *  callers will pass that through here. */
  feedConfig?: FeedSpeedConfig;
  /** Time-of-day profile (peak/night windows). Defaults to the
   *  Cluj-tuned profile. */
  todProfile?: TodProfile;
  /** Optional trip_id -> ordered stop distances. Enables per-segment
   *  dwell-aware walk in predictArrivalAlongShape. */
  stopDistancesByTrip?: Record<string, number[]>;
  /** Seconds added per intermediate stop in the dwell walk. Feed-
   *  specific value from _neary_config; defaults to 20. */
  dwellSec?: number;
}

/** Replace the schedule-based ETA on rows with a live position
 *  (`kind: 'tracked'` and `kind: 'gps-only'` orphans) with a GPS-
 *  derived one via the multi-tier speed cascade, where possible.
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
 *   - For reconciled rows: when `v.schedule.isFirstStop === true`.
 *     The schedule scanner labels the origin stop; the predictor
 *     would just produce noise from a parked bus's near-zero speed.
 *   - For orphan kind:'gps-only' rows: detected from the GPS projection
 *     itself — bus's `distAlong` on the shape is < AT_ORIGIN_DIST_M
 *     AND its speed is < AT_ORIGIN_SPEED_MS (or unknown). When the
 *     bus is detected at origin we keep the reconciler's sibling-
 *     derived ETA seed (see reconcile.ts) instead of overwriting
 *     with a noise estimate. The detection re-runs every render
 *     tick, so the ETA self-corrects to GPS-derived the moment the
 *     bus starts moving — handles early departures.
 *
 *  Pure. */
export function applyGpsEta(
  vehicles: Vehicle[],
  shapes: Record<string, Polyline>,
  stop: { lat?: number; lon?: number },
  shapesByRouteDir: Record<string, Polyline> = {},
  ctx: ApplyGpsEtaContext = { nowMs: Date.now(), timezone: 'UTC' },
): Vehicle[] {
  if (typeof stop.lat !== 'number' || typeof stop.lon !== 'number') return vehicles;
  const stopPos = { lat: stop.lat, lon: stop.lon };
  const feedConfig = ctx.feedConfig ?? DEFAULT_FEED_SPEED_CONFIG;
  const todProfile = ctx.todProfile ?? DEFAULT_TOD_PROFILE;
  const stopDistancesByTrip = ctx.stopDistancesByTrip ?? {};
  const todBucket = clockToBucket(minSinceMidnightInTz(ctx.nowMs, ctx.timezone), todProfile);
  return vehicles.map<Vehicle>((v) => {
    if (v.kind !== 'tracked' && v.kind !== 'gps-only') return v;
    if (v.kind === 'tracked' && v.schedule.isFirstStop === true) return v;
    if (!v.position) return v;
    const polyline = pickShape(v, shapes, shapesByRouteDir);
    if (!polyline || polyline.length < 2) return v;
    // For live orphans: detect "parked at origin" — keep the
    // sibling-derived ETA seed the reconciler attached, don't
    // overwrite with a fallback-driven estimate.
    if (v.kind === 'gps-only') {
      const proj = projectOnPolyline(
        { lat: v.position.lat, lon: v.position.lon },
        polyline,
      );
      const speed = v.position.speedMs ?? 0;
      const atOrigin =
        proj.distAlongM < AT_ORIGIN_DIST_M && speed < AT_ORIGIN_SPEED_MS;
      if (atOrigin && v.eta != null) return v;
    }
    // Single domain entry point for GPS-anchored arrival prediction.
    // It encapsulates the dead-reckon + per-segment + dwell walk so
    // map and station can never disagree about the physics. Falls back
    // to single-segment when this trip has no shape_dist_traveled.
    const { arrival: p, positionAtNow } = predictArrivalFromGps({
      obs: {
        lat: v.position.lat,
        lon: v.position.lon,
        speedMs: v.position.speedMs ?? null,
        asOfMs: v.position.asOf,
      },
      polyline,
      stopPos,
      nowMs: ctx.nowMs,
      todBucket,
      feedConfig,
      vehicleDirectionId: v.directionId,
      dwellStopDistAlongM: v.tripId ? stopDistancesByTrip[v.tripId] : undefined,
      dwellSecondsPerStop: ctx.dwellSec ?? 20,
      ctx: { feedConfig, timezone: ctx.timezone, todProfile },
    });
    // Also overwrite `position` with the dead-reckoned coords so the
    // downstream bucketer's haversine distance-to-stop (see
    // `assembleStationBoard`) reads the same "where is the bus right
    // now?" the ETA does. Without this update, a stale fix could
    // produce a dead-reckoned ETA that says "departed" while the
    // bucketer still sees the bus 1 km from the stop and routes the
    // row into `arriving`. `source: 'predicted-from-gps'` flags the
    // mutation so consumers can tell apart "raw GTFS-RT fix" vs
    // "projected to nowMs"; `asOf` advances to nowMs because that's
    // when this position is true. Falls through unchanged when
    // dead-reckon returned null (very-stale fix).
    const position = positionAtNow
      ? {
          ...v.position,
          lat: positionAtNow.lat,
          lon: positionAtNow.lon,
          source: 'predicted-from-gps' as const,
          asOf: ctx.nowMs,
        }
      : v.position;
    return {
      ...v,
      position,
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
