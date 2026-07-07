// Pure helpers: Vehicle[] → ready-to-render BoardRow[] for one station. No DOM, no SQL. Timezone contract: all minutes-since-midnight values are FEED-local.

import {
  bucketOf,
  compareForBoard,
  filterForStationView,
  type ArrivalBucket,
} from './buckets';
import { haversineMeters } from '@n3ary/gtfs-spec/shape';
import { minSinceMidnightInTz } from './pipeline/timeUtils';
import { predictArrivalFromGps } from './predictArrivalAlongShape';
import { projectOnPolyline, type Polyline } from '@n3ary/gtfs-spec/shape';
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
  /** Advanced: include off-route vehicles. */
  showOffRouteVehicles: boolean;
  /** Per-context-bucket cap. Defaults to DEFAULT_CONTEXT_BUCKET_CAP. Now-group + off-route are always uncapped. */
  stationBoardMaxRows?: number;
}

/** Assemble the bucketed, filtered, sorted board. `stop` coords feed the bucketer's at-station check (Infinity for schedule-only vehicles keeps them out of the at-stop branch). */
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
    // Drop-off-only vehicles can't be boarded — segregate into their own bucket; departed ones keep 'departed' (the flag is moot post-departure).
    const bucket = v.dropOffOnly && rawBucket !== 'departed' ? 'drop-off' : rawBucket;
    return { vehicle: v, bucket, etaMinutes: v.eta?.minutes ?? 0 };
  });
  const sorted = filterForStationView(rows, prefs).sort(compareForBoard);
  return capStationBoard(sorted, prefs.stationBoardMaxRows ?? DEFAULT_CONTEXT_BUCKET_CAP);
}

/** Default cap applied to context buckets when the user hasn't picked a value. Now-group + off-route are always uncapped. */
export const DEFAULT_CONTEXT_BUCKET_CAP = 3;

// Now-group (departing/at-station/arriving) and off-route are uncapped; context buckets (incoming/drop-off/departed) share the setting-driven cap.
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

// Treats undefined and -1 direction as the same value so feeds without direction_id don't fragment routes.
function dedupKey(row: BoardRow): string {
  return `${row.vehicle.route.id}_${row.vehicle.directionId ?? -1}`;
}

/** Trim the bucketed row set for the StationCard. Algorithm: single-route boards skip dedup and the `later`-trip filter (the rider's chosen view already collapses to one route); multi-route boards dedup per (route, direction) inside each bucket, drop `later`-phase rows (pure timetable guesses with no useful position info), apply per-bucket caps, and re-sort. */
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

// Top-level pipeline composer — the Stations view and any other consumer that wants a fully-resolved board calls assembleLiveVehicles + bucketLiveBoardMemo instead of chaining the 4 stages themselves. Stage order matches docs/specs/vehicles-and-views.md.

/** Inputs for `assembleLiveVehicles` — the worker-side half (merge + GPS-ETA). Main-side bucket step lives separately so route filter + prefs don't cross the worker IPC boundary. */
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
  /** Per-intermediate-stop dwell. From feed's _neary_config timing.dwell_sec; defaults to 20. */
  dwellSec?: number;
}

/** Worker-side merge + GPS-ETA. Pure — exported for unit testing. */
export function assembleLiveVehicles(input: AssembleLiveVehiclesInputs): Vehicle[] {
  const nowMin = minSinceMidnightInTz(input.nowMs, input.timezone);
  const merged = mergeReconciledIntoStationBoard({
    perStopVehicles: input.perStopVehicles,
    reconciledVehicles: input.reconciledVehicles,
    nowMin,
  });
  // Sibling-shape fallback for orphans whose own trip_id isn't in shapes. All trips on a single (route, dir) share their shape_id, so any sibling's polyline projects an orphan onto the correct geometry.
  const shapesByRouteDir = buildShapesByRouteDir(input.perStopVehicles, input.shapes);
  return applyGpsEta(merged, input.shapes, input.stop, shapesByRouteDir, {
    nowMs: input.nowMs,
    timezone: input.timezone,
    stopDistancesByTrip: input.stopDistancesByTrip ?? {},
    dwellSec: input.dwellSec,
  });
}

/** Inputs for `bucketLiveBoardMemo` — the main-side half. Vehicles are already merged + GPS-ETA-adjusted by the worker; main only filters by route and buckets for display. */
export interface BucketLiveBoardInputs {
  /** Already through `assembleLiveVehicles` in the worker — `kind` is final and ETA is GPS-adjusted. */
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

/** Memoised main-side bucketing. Cache key is the stop object identity + reference-equal inputs. */
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

// Station-side merge with the worker's global reconciled set: per-stop scheduled rows + worker gps-only orphans. Orphans get an ETA seed from per-stop sibling travel-time-from-origin so a parked bus doesn't wait for GPS speed.

export interface StationMergeInputs {
  perStopVehicles: Vehicle[];
  reconciledVehicles: Vehicle[];
  /** Minutes since local midnight at the feed's timezone. Used for the orphan ETA seed only. */
  nowMin: number;
}

export function mergeReconciledIntoStationBoard(inputs: StationMergeInputs): Vehicle[] {
  const { perStopVehicles, reconciledVehicles, nowMin } = inputs;

  // Index reconciled `tracked` rows by tripId for O(1) promotion.
  const reconciledByTripId = new Map<string, Vehicle>();
  for (const v of reconciledVehicles) {
    if (v.kind !== 'tracked') continue;
    if (!v.tripId) continue;
    reconciledByTripId.set(v.tripId, v);
  }

  // Per-stop (route, dir) representative: travelTimeMin = scheduledArrival - tripStartMin, dropOffOnly carried through so live orphans at a terminus / drop-off-only stop inherit the flag and route to the `drop-off` bucket (not the now-group).
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

  // Promote matched per-stop scheduled rows to `tracked`. Keep the per-stop schedule (arrival at THIS stop); attach GPS position + confidence from the worker.
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

  // Emit orphan kind:'gps-only' rows whose (route, dir) this station serves. The worker already gated against the global active-trip set; this is the per-station tightening.
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
  /** Feed's IANA timezone. Combined with `nowMs` for the feed-local TOD bucket used by the speed cascade. */
  timezone: string;
  /** Per-feed speed config; defaults to the generic defaults. */
  feedConfig?: FeedSpeedConfig;
  /** Time-of-day profile (peak/night windows); defaults to the generic profile. */
  todProfile?: TodProfile;
  /** trip_id -> ordered stop distances. Enables per-segment dwell walk. */
  stopDistancesByTrip?: Record<string, number[]>;
  /** Per-intermediate-stop dwell. From feed's _neary_config; defaults to 20. */
  dwellSec?: number;
}

/** Replace schedule-based ETA on rows with a live position with a GPS-derived one via the multi-tier speed cascade. Skipped at trip origin (a parked bus would just produce noise from near-zero speed). */
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
    // Live orphans: if the bus is parked at the origin (distance < AT_ORIGIN_DIST_M and speed < AT_ORIGIN_SPEED_MS), keep the reconciler's sibling-derived ETA seed instead of overwriting with noise. Re-checks every render tick, so the ETA self-corrects to GPS-derived the moment the bus starts moving.
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
    // Overwrite `position` with dead-reckoned coords so the downstream bucketer's haversine distance-to-stop reads the same "where is the bus right now?" the ETA does. `source: 'predicted-from-gps'` flags the mutation so consumers can tell apart raw GTFS-RT fix vs projected-to-nowMs. Falls through unchanged when dead-reckon returned null (very-stale fix).
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

// Bus is "at origin" when its projection onto the trip shape is within this distance of the shape's start vertex.
const AT_ORIGIN_DIST_M = 100;
// Includes null/undefined speed — parked buses often don't transmit speed.
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

/** Deduped, sorted route list for a station based on the schedule. Numeric short-names sort numerically, alpha after. */
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
