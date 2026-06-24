/**
 * Synthesize SCHEDULED departures as station vehicles (Req 6, 12).
 *
 * This is the unifying seam that lets a scheduled trip render through the SAME
 * machinery as a live GPS vehicle (full vehicle card, map button, station
 * inclusion, departed-dedup) instead of a bespoke slim row. For each station
 * we build synthetic {@link StationVehicle}s for the scheduled trips that serve
 * it, in one of two phases:
 *
 *   - **Future** (trip not yet departed): shown ONLY at the trip's start
 *     station, positioned at that station's GPS coordinates with speed 0
 *     ("departs in X min"). enhanceVehicle's at-station detection yields speed 0
 *     naturally, so no special-casing is needed.
 *   - **Ghost** (scheduled departure passed, no live GPS): shown at the trip's
 *     not-yet-passed stations as a moving vehicle. Position is interpolated
 *     between the surrounding scheduled stops by elapsed time; speed is the
 *     average prediction produced by the normal `enhanceVehicle` flow (with
 *     forward prediction suppressed so it stays at the interpolated point), and
 *     GPS freshness is pegged to the last departed stop's scheduled time.
 *
 * A trip that has a live GPS vehicle is never synthesized (GPS wins, Req 7.4).
 * Everything degrades gracefully: no schedule data -> no synthetic vehicles.
 */

import type { SchedulePayload, ScheduleStopTime } from '../../types/schedule';
import type {
  TranzyStopResponse,
  TranzyRouteResponse,
  TranzyTripResponse,
  TranzyVehicleResponse,
} from '../../types/rawTranzyApi';
import type { StationVehicle } from '../../types/stationFilter';
import {
  enhanceVehicle,
  type EnhancedVehicleData,
} from '../vehicle/vehicleEnhancementUtils';
import { calculateStationDensityCenter } from '../vehicle/stationDensityUtils';
import { minutesSinceMidnight, resolveActiveServices as resolveActiveServicesForDate } from './activeServiceUtils';
import { computeHeadwayMinutes, shouldSuppressGhost, claimRunsAtStart, type RunStart, type GpsVehicleLite } from './ghostSuppression';
import { generateStatusMessage } from '../arrival/statusUtils';
import { calculateDistance, type Coordinates } from '../location/distanceUtils';
import { GHOST_VEHICLE_MATCH } from '../core/constants';
import { formatBoardTime } from './stationScheduleBoard';

/** Default look-ahead window for scheduled departures/arrivals, in minutes. */
const DEFAULT_WINDOW_MINUTES = 90;

/**
 * Cap (minutes) on how long a just-departed scheduled run keeps showing as
 * "Departed" at a stop it has left. The effective window is
 * `min(routeHeadway, this cap)`, so it always represents the immediately
 * previous run: on a high-frequency route a 10-min-old departure is two buses
 * ago (stale), so the headway shortens it; on an infrequent route the cap keeps
 * it from lingering for the whole trip. Mirrors a live GPS bus that fades from
 * "Departed" as it moves away.
 */
const DEPARTED_GHOST_WINDOW_CAP_MINUTES = 10;

/** stop_id -> the trips serving it, with that stop's stop-time entry. */
export type ScheduleStopIndex = Map<
  number,
  Array<{ tripId: string; entry: ScheduleStopTime }>
>;

// Memoize the (expensive) inverted index on the schedule payload reference.
// The payload only changes on a daily refresh, so this is rebuilt rarely even
// though the station filter re-runs every ~15s.
let cachedIndex: { source: SchedulePayload; index: ScheduleStopIndex } | null = null;

/**
 * Build (and cache) an inverted index mapping each stop_id to the trips that
 * serve it. One pass over all trips' stop times.
 */
export function buildScheduleStopIndex(scheduleData: SchedulePayload): ScheduleStopIndex {
  if (cachedIndex && cachedIndex.source === scheduleData) {
    return cachedIndex.index;
  }
  const index: ScheduleStopIndex = new Map();
  for (const [tripId, stopTimes] of Object.entries(scheduleData.stopTimes)) {
    for (const entry of stopTimes) {
      let arr = index.get(entry.s);
      if (!arr) {
        arr = [];
        index.set(entry.s, arr);
      }
      arr.push({ tripId, entry });
    }
  }
  cachedIndex = { source: scheduleData, index };
  return index;
}

/** First (lowest q) and last (highest q) stop times of a trip. */
function tripBounds(
  stopTimes: ScheduleStopTime[],
): { first: ScheduleStopTime; last: ScheduleStopTime } | null {
  if (stopTimes.length === 0) return null;
  let first = stopTimes[0];
  let last = stopTimes[0];
  for (const st of stopTimes) {
    if (st.q < first.q) first = st;
    if (st.q > last.q) last = st;
  }
  return { first, last };
}

/**
 * Resolve a scheduled trip's destination headsign. Prefers the authoritative
 * GTFS `trip_headsign` (per trip/direction); falls back to the last stop's name
 * for older payloads that don't carry headsigns.
 */
function resolveHeadsign(
  scheduleData: SchedulePayload,
  tripId: string,
  stopsById: Map<number, TranzyStopResponse>,
  lastStopId: number,
): string {
  const fromGtfs = scheduleData.tripHeadsignMap?.[tripId];
  if (fromGtfs) return fromGtfs;
  return stopsById.get(lastStopId)?.stop_name ?? '';
}

/** Stable, collision-resistant negative id for a synthetic vehicle from its trip id. */
function syntheticVehicleId(tripId: string): number {
  let hash = 0;
  for (let i = 0; i < tripId.length; i++) {
    hash = (hash * 31 + tripId.charCodeAt(i)) | 0;
  }
  // Negative space keeps synthetic ids from colliding with real vehicle ids.
  return -Math.abs(hash) - 1;
}

/** Local-day ISO timestamp for a given minutes-since-midnight value. */
function isoAtMinutes(now: Date, minutes: number): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  d.setMinutes(minutes);
  return d.toISOString();
}

/** Linear interpolation between two coordinates. */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Interpolate a ghost vehicle's current position between the scheduled stops
 * that surround `nowMin`. Returns the most recently departed stop's scheduled
 * departure minute too (for GPS-freshness pegging).
 */
function interpolateGhostPosition(
  stopTimes: ScheduleStopTime[],
  stopsById: Map<number, TranzyStopResponse>,
  nowMin: number,
): { lat: number; lon: number; lastDepartedMin: number } | null {
  const ordered = [...stopTimes].sort((l, r) => l.q - r.q);
  for (let i = 0; i < ordered.length - 1; i++) {
    const a = ordered[i];
    const b = ordered[i + 1];
    // Between a's departure and b's arrival -> on this segment.
    if (a.d <= nowMin && nowMin <= b.a) {
      const sa = stopsById.get(a.s);
      const sb = stopsById.get(b.s);
      if (!sa || !sb) return null;
      const span = b.a - a.d;
      const frac = span > 0 ? (nowMin - a.d) / span : 0;
      return {
        lat: lerp(sa.stop_lat, sb.stop_lat, frac),
        lon: lerp(sa.stop_lon, sb.stop_lon, frac),
        lastDepartedMin: a.d,
      };
    }
  }
  // Dwelling at a stop (between its arrival and departure): use that stop.
  for (const st of ordered) {
    if (st.a <= nowMin && nowMin <= st.d) {
      const s = stopsById.get(st.s);
      if (!s) return null;
      return { lat: s.stop_lat, lon: s.stop_lon, lastDepartedMin: st.d };
    }
  }
  return null;
}

interface Candidate {
  tripId: string;
  routeId: number;
  serviceId: string;
  minutesUntil: number;
  /** Lifecycle phase at THIS station: upcoming departure, approaching, or just departed. */
  kind: 'future' | 'approaching' | 'departed';
  departed: boolean;
  position: { lat: number; lon: number };
  lastKnownMin: number;
  headsign: string;
  /**
   * When this is a "tomorrow" placeholder (no more today departures at a start
   * station), holds the departure minute-of-day for the label "Tomorrow HH:MM".
   * Undefined for all normal today candidates.
   */
  tomorrowDepartureMin?: number;
}

export interface ScheduledVehiclesParams {
  scheduleData: SchedulePayload | null;
  /** trip_id -> route_id (prefer payload.tripRouteMap; fallback Tranzy map). */
  tripRouteMap: Record<string, number>;
  /** Service ids active for the current local date (from scheduleStore). */
  activeServiceIds: Set<string>;
  /** Station stop_ids to compute scheduled vehicles for (the near stations). */
  stopIds: number[];
  stops: TranzyStopResponse[];
  routes: TranzyRouteResponse[];
  /** Tranzy trips, used to find a representative shape_id/direction per route. */
  tranzyTrips: TranzyTripResponse[];
  /** Trip ids that already have a live GPS vehicle (GPS wins, Req 7.4). */
  gpsVehicleTripIds: Set<string>;
  /** Live vehicles, used for ghost speed averaging (same as real predictions). */
  realVehicles: EnhancedVehicleData[];
  /** Tranzy stop_times, to resolve each live vehicle's trip origin/terminus. */
  tranzyStopTimes?: { trip_id: string; stop_id: number; stop_sequence: number }[];
  now?: Date;
  windowMinutes?: number;
}

/**
 * Build synthetic scheduled {@link StationVehicle}s keyed by stop_id for the
 * requested stations. Returns an empty map when schedule data is unavailable.
 */
export function buildScheduledStationVehicles(
  params: ScheduledVehiclesParams,
): Map<number, StationVehicle[]> {
  const result = new Map<number, StationVehicle[]>();
  const {
    scheduleData,
    tripRouteMap,
    activeServiceIds,
    stopIds,
    stops,
    routes,
    tranzyTrips,
    gpsVehicleTripIds,
    realVehicles,
    tranzyStopTimes = [],
    now = new Date(),
    windowMinutes = DEFAULT_WINDOW_MINUTES,
  } = params;

  if (!scheduleData) return result;

  // Prefer the authoritative trip->route map embedded in the payload.
  const routeMap =
    scheduleData.tripRouteMap && Object.keys(scheduleData.tripRouteMap).length > 0
      ? scheduleData.tripRouteMap
      : tripRouteMap;

  const stopsById = new Map(stops.map((s) => [s.stop_id, s]));
  const routesById = new Map(routes.map((r) => [r.route_id, r]));
  const index = buildScheduleStopIndex(scheduleData);
  const stationDensityCenter = calculateStationDensityCenter(stops);
  const nowMin = minutesSinceMidnight(now);

  // Each live vehicle's CURRENT trip origin (its first stop_id) from Tranzy stop
  // times, so a vehicle terminating at a turnaround can't claim the outbound
  // departure that originates there.
  const tripOrigin = new Map<string, { stopId: number; seq: number }>();
  for (const st of tranzyStopTimes) {
    const cur = tripOrigin.get(st.trip_id);
    if (!cur || st.stop_sequence < cur.seq) {
      tripOrigin.set(st.trip_id, { stopId: st.stop_id, seq: st.stop_sequence });
    }
  }

  // Per-route live GPS coverage, for ghost suppression (Req 7, 12):
  //  - lite vehicle (position + speed + trip origin) per route, used for the
  //    positional match, high-frequency blanket rule, and start-station claim.
  const routeVehicles = new Map<number, GpsVehicleLite[]>();
  for (const v of realVehicles) {
    if (v.route_id === null || v.route_id === undefined) continue;
    const arr = routeVehicles.get(v.route_id) ?? [];
    arr.push({
      position: { lat: v.latitude, lon: v.longitude },
      speed: v.speed ?? 0,
      originStopId: v.trip_id ? tripOrigin.get(v.trip_id)?.stopId ?? null : null,
    });
    routeVehicles.set(v.route_id, arr);
  }

  // Per-route active start-station departures (one pass), for headway/frequency,
  // plus per (route, start stop) run lists for start-station claiming.
  const routeStartDepartures = new Map<number, number[]>();
  const runsByRouteStart = new Map<string, { routeId: number; startStopId: number; runs: RunStart[] }>();
  for (const [tripId, stopTimes] of Object.entries(scheduleData.stopTimes)) {
    const routeId = routeMap[tripId];
    if (routeId === undefined) continue;
    const serviceId = scheduleData.tripServiceMap[tripId] ?? '';
    if (!activeServiceIds.has(serviceId)) continue;
    const bounds = tripBounds(stopTimes);
    if (!bounds) continue;
    const arr = routeStartDepartures.get(routeId) ?? [];
    arr.push(bounds.first.d);
    routeStartDepartures.set(routeId, arr);

    const key = `${routeId}:${bounds.first.s}`;
    const group =
      runsByRouteStart.get(key) ?? { routeId, startStopId: bounds.first.s, runs: [] };
    group.runs.push({ tripId, startMin: bounds.first.d });
    runsByRouteStart.set(key, group);
  }

  // Runs covered by a GPS vehicle waiting at their start stop (Req: waiting bus
  // before departure, and LATE bus that just pulled in). These are suppressed
  // regardless of the on-time interpolated ghost position.
  const coveredRunIds = new Set<string>();
  for (const { routeId, startStopId, runs } of runsByRouteStart.values()) {
    const vehiclesOnRoute = routeVehicles.get(routeId);
    if (!vehiclesOnRoute || vehiclesOnRoute.length === 0) continue;
    const startStop = stopsById.get(startStopId);
    if (!startStop) continue;
    const claimed = claimRunsAtStart(
      runs,
      { lat: startStop.stop_lat, lon: startStop.stop_lon },
      startStopId,
      vehiclesOnRoute,
      nowMin,
      windowMinutes,
    );
    claimed.forEach((id) => coveredRunIds.add(id));
  }

  // Memoized headway per route (computed lazily as routes are encountered).
  const headwayByRoute = new Map<number, number | null>();
  const getHeadway = (routeId: number): number | null => {
    if (headwayByRoute.has(routeId)) return headwayByRoute.get(routeId)!;
    const h = computeHeadwayMinutes(routeStartDepartures.get(routeId) ?? [], nowMin);
    headwayByRoute.set(routeId, h);
    return h;
  };

  for (const stopId of stopIds) {
    const entries = index.get(stopId);
    if (!entries || entries.length === 0) continue;

    // Per route+direction, keep the soonest FUTURE departure AND the soonest
    // departed GHOST separately. The user wants both visible (a just-departed
    // run with no GPS plus the next upcoming one), and keying by direction stops
    // an arriving inbound run from masking the outbound departure at a station
    // that is a start for one direction and a terminus for the other.
    const perKey = new Map<string, { future?: Candidate; approaching?: Candidate; departed?: Candidate }>();

    for (const { tripId, entry } of entries) {
      const routeId = routeMap[tripId];
      if (routeId === undefined) continue;

      const serviceId = scheduleData.tripServiceMap[tripId] ?? '';
      if (!activeServiceIds.has(serviceId)) continue;

      // GPS wins: never synthesize a trip that has a live vehicle — either by
      // exact trip id, or because a GPS bus is waiting at / late to its start.
      if (gpsVehicleTripIds.has(tripId) || coveredRunIds.has(tripId)) continue;

      const stopTimes = scheduleData.stopTimes[tripId];
      const bounds = tripBounds(stopTimes);
      if (!bounds) continue;

      const firstDep = bounds.first.d;
      const lastArr = bounds.last.a;
      const departed = firstDep < nowMin;
      const isStart = entry.q === bounds.first.q;

      let candidate: Candidate | null = null;

      if (!departed) {
        // Future departure: only surface it at the trip's START station.
        if (!isStart) continue;
        const minutesUntil = firstDep - nowMin;
        if (minutesUntil < 0) continue;
        // At a start station, ALWAYS show the next scheduled future departure
        // regardless of how far away it is — the rider needs to know when the
        // next bus leaves from here. The 90-min window only applies to ghosts
        // at intermediate stops (where showing a bus 6 hours away is noise).
        const startStop = stopsById.get(stopId);
        if (!startStop) continue;
        candidate = {
          tripId,
          routeId,
          serviceId,
          minutesUntil,
          kind: 'future',
          departed: false,
          position: { lat: startStop.stop_lat, lon: startStop.stop_lon },
          lastKnownMin: nowMin,
          headsign: resolveHeadsign(scheduleData, tripId, stopsById, bounds.last.s),
        };
      } else {
        // Ghost: trip is en route (departed its start, not yet finished).
        if (nowMin > lastArr) continue; // trip already finished

        const headway = getHeadway(routeId);

        // This stop is either AHEAD (approaching) or recently BEHIND (just
        // departed this stop — shown as "Departed", mirroring a live GPS bus
        // that just left). The "just departed" window is min(headway, cap), so
        // it always represents the immediately previous run.
        const ahead = entry.a >= nowMin;
        const minutesUntil = ahead ? entry.a - nowMin : entry.d - nowMin; // negative when behind
        if (ahead) {
          // No window cap for approaching ghosts — show the next scheduled
          // vehicle regardless of how far away it is. The rider needs to know
          // when the next bus is coming even if it's 2 hours out.
        } else {
          const departedWindow = Math.min(
            headway ?? DEPARTED_GHOST_WINDOW_CAP_MINUTES,
            DEPARTED_GHOST_WINDOW_CAP_MINUTES,
          );
          if (nowMin - entry.d > departedWindow) continue;
        }

        const pos = interpolateGhostPosition(stopTimes, stopsById, nowMin);
        if (!pos) continue;

        // Suppress the ghost when the live feed already covers this run:
        // positionally (a GPS vehicle on the route is within the headway-scaled
        // distance) or on a high-frequency route that already has GPS vehicles.
        // EXCLUDE vehicles still within the run's start zone: a bus sitting near
        // the start is interpreted by the start-station claim as the NEXT
        // departure, so using it to cover THIS (just-departed) run would create
        // a flip-flop. Only a vehicle that has actually left the start can cover
        // a departed ghost.
        const runStart = stopsById.get(bounds.first.s);
        const coveringPositions = (routeVehicles.get(routeId) ?? [])
          .filter((v) => {
            if (!runStart) return true;
            try {
              return (
                calculateDistance(v.position, { lat: runStart.stop_lat, lon: runStart.stop_lon }) >
                GHOST_VEHICLE_MATCH.START_CLAIM_PROXIMITY_METERS
              );
            } catch {
              return true;
            }
          })
          .map((v) => v.position);
        if (shouldSuppressGhost(headway, coveringPositions.length > 0, { lat: pos.lat, lon: pos.lon }, coveringPositions)) {
          continue;
        }

        candidate = {
          tripId,
          routeId,
          serviceId,
          minutesUntil,
          kind: ahead ? 'approaching' : 'departed',
          departed: true,
          position: { lat: pos.lat, lon: pos.lon },
          lastKnownMin: pos.lastDepartedMin,
          headsign: resolveHeadsign(scheduleData, tripId, stopsById, bounds.last.s),
        };
      }

      // Key by route + direction so the two directions don't collapse together.
      const dirKey = parseDirection(tripId) ?? candidate.headsign;
      const key = `${routeId}:${dirKey}`;
      const slot = perKey.get(key) ?? {};
      if (candidate.kind === 'departed') {
        // Most-recent departure (largest entry.d, i.e. minutesUntil closest to 0).
        if (!slot.departed || candidate.minutesUntil > slot.departed.minutesUntil) {
          slot.departed = candidate;
        }
      } else if (candidate.kind === 'approaching') {
        if (!slot.approaching || candidate.minutesUntil < slot.approaching.minutesUntil) {
          slot.approaching = candidate;
        }
      } else if (!slot.future || candidate.minutesUntil < slot.future.minutesUntil) {
        slot.future = candidate;
      }
      perKey.set(key, slot);
    }

    // When no candidates at all (service ended, all ghosts expired) but this
    // stop IS a start station for some route, try tomorrow's first departure so
    // the station still surfaces with a "Tomorrow HH:MM" card.
    if (perKey.size === 0) {
      // Check if this stop is a start station for any active route.
      const tomorrowVehicles = synthesizeTomorrowOnlyCards(
        stopId, scheduleData, routeMap, stopsById, routesById, tranzyTrips,
        realVehicles, stops, stationDensityCenter, nowMin, now,
      );
      if (tomorrowVehicles.length > 0) {
        result.set(stopId, tomorrowVehicles);
      }
      continue;
    }

    const stationVehicles: StationVehicle[] = [];
    for (const [key, slot] of perKey.entries()) {
      // At a start station without a future departure (no more trips today),
      // look up tomorrow's first departure and synthesize a placeholder so the
      // rider knows when service resumes. This only fires when `slot.future`
      // is absent and the station IS a start for this (route, direction).
      if (!slot.future && (slot.departed || slot.approaching)) {
        const [routeIdStr, dirKeyStr] = key.split(':');
        const slotRouteId = Number(routeIdStr);
        // Check whether this stop is actually a start station for this route.
        // We do this by checking if any future trip for this (route, direction)
        // has its first stop at this stopId (i.e. the slot HAD candidates with
        // isStart). We already know it does because only start stations generate
        // future candidates — if we have departed/approaching but no future, it
        // means the last bus already left and there are none remaining today.
        const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
        const tomorrowActive = resolveActiveServicesForDate(
          scheduleData.calendar,
          scheduleData.calendarExceptions,
          tomorrow,
        );
        // Find the earliest trip tomorrow for this (route, direction) starting at this stop.
        let earliestTomorrow: { tripId: string; startMin: number; headsign: string } | null = null;
        for (const [tripId, sts] of Object.entries(scheduleData.stopTimes)) {
          const tripRouteId = routeMap[tripId];
          if (tripRouteId !== slotRouteId) continue;
          const tripDir = parseDirection(tripId);
          const dirMatch = dirKeyStr === '0' || dirKeyStr === '1'
            ? tripDir === Number(dirKeyStr)
            : true; // non-numeric dirKey = headsign-based, less strict
          if (!dirMatch) continue;
          const svcId = scheduleData.tripServiceMap[tripId] ?? '';
          if (!tomorrowActive.has(svcId)) continue;
          const b = tripBounds(sts);
          if (!b || b.first.s !== stopId) continue;
          if (!earliestTomorrow || b.first.d < earliestTomorrow.startMin) {
            earliestTomorrow = {
              tripId,
              startMin: b.first.d,
              headsign: resolveHeadsign(scheduleData, tripId, stopsById, b.last.s),
            };
          }
        }
        if (earliestTomorrow) {
          const startStop = stopsById.get(stopId);
          if (startStop) {
            // Synthesize a placeholder future card: "Tomorrow HH:MM"
            const tomorrowCandidate: Candidate = {
              tripId: earliestTomorrow.tripId,
              routeId: slotRouteId,
              serviceId: scheduleData.tripServiceMap[earliestTomorrow.tripId] ?? '',
              minutesUntil: (24 * 60 - nowMin) + earliestTomorrow.startMin, // rough — just for sort order
              kind: 'future',
              departed: false,
              position: { lat: startStop.stop_lat, lon: startStop.stop_lon },
              lastKnownMin: nowMin,
              headsign: earliestTomorrow.headsign,
              tomorrowDepartureMin: earliestTomorrow.startMin,
            };
            slot.future = tomorrowCandidate;
          }
        }
      }

      // Show the just-departed ghost, the approaching ghost, AND the next future
      // departure (mirrors live GPS: a recently-departed bus + upcoming ones).
      const candidates = [slot.departed, slot.approaching, slot.future].filter(
        (c): c is Candidate => !!c,
      );
      for (const candidate of candidates) {
        stationVehicles.push(
          synthesizeStationVehicle(candidate, {
            routesById,
            tranzyTrips,
            stops,
            stationDensityCenter,
            realVehicles,
            now,
          }),
        );
      }
    }
    result.set(stopId, stationVehicles);
  }

  return result;
}

/**
 * Standalone "tomorrow" card synthesizer for a start station with zero today
 * candidates. Iterates active routes at this stop, checks if the stop is the
 * FIRST stop for any trip tomorrow, and yields one synthetic future card per
 * (route, direction) with "Tomorrow HH:MM".
 */
function synthesizeTomorrowOnlyCards(
  stopId: number,
  scheduleData: SchedulePayload,
  routeMap: Record<string, number>,
  stopsById: Map<number, TranzyStopResponse>,
  routesById: Map<number, TranzyRouteResponse>,
  tranzyTrips: TranzyTripResponse[],
  realVehicles: EnhancedVehicleData[],
  stops: TranzyStopResponse[],
  stationDensityCenter: { lat: number; lon: number },
  nowMin: number,
  now: Date,
): StationVehicle[] {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
  const tomorrowActive = resolveActiveServicesForDate(
    scheduleData.calendar,
    scheduleData.calendarExceptions,
    tomorrow,
  );

  // Find earliest tomorrow departure per (route, direction) starting at this stop.
  const earliest = new Map<string, { tripId: string; startMin: number; routeId: number; headsign: string }>();
  for (const [tripId, sts] of Object.entries(scheduleData.stopTimes)) {
    const routeId = routeMap[tripId];
    if (routeId === undefined) continue;
    const svcId = scheduleData.tripServiceMap[tripId] ?? '';
    if (!tomorrowActive.has(svcId)) continue;
    const bounds = tripBounds(sts);
    if (!bounds || bounds.first.s !== stopId) continue;
    const dir = parseDirection(tripId) ?? 'x';
    const key = `${routeId}:${dir}`;
    const existing = earliest.get(key);
    if (!existing || bounds.first.d < existing.startMin) {
      earliest.set(key, {
        tripId,
        startMin: bounds.first.d,
        routeId,
        headsign: resolveHeadsign(scheduleData, tripId, stopsById, bounds.last.s),
      });
    }
  }

  if (earliest.size === 0) return [];

  const startStop = stopsById.get(stopId);
  if (!startStop) return [];

  const vehicles: StationVehicle[] = [];
  for (const entry of earliest.values()) {
    const candidate: Candidate = {
      tripId: entry.tripId,
      routeId: entry.routeId,
      serviceId: scheduleData.tripServiceMap[entry.tripId] ?? '',
      minutesUntil: (24 * 60 - nowMin) + entry.startMin,
      kind: 'future',
      departed: false,
      position: { lat: startStop.stop_lat, lon: startStop.stop_lon },
      lastKnownMin: nowMin,
      headsign: entry.headsign,
      tomorrowDepartureMin: entry.startMin,
    };
    vehicles.push(
      synthesizeStationVehicle(candidate, {
        routesById,
        tranzyTrips,
        stops,
        stationDensityCenter,
        realVehicles,
        now,
      }),
    );
  }
  return vehicles;
}

interface SynthDeps {
  routesById: Map<number, TranzyRouteResponse>;
  tranzyTrips: TranzyTripResponse[];
  stops: TranzyStopResponse[];
  stationDensityCenter: { lat: number; lon: number };
  realVehicles: EnhancedVehicleData[];
  now: Date;
}

/** Parse the GTFS direction (0/1) encoded as the 2nd token of the trip id. */
function parseDirection(tripId: string): number | null {
  const token = tripId.split('_')[1];
  if (token === '0') return 0;
  if (token === '1') return 1;
  return null;
}

/** Build the synthetic StationVehicle for a candidate, reusing enhanceVehicle. */
function synthesizeStationVehicle(candidate: Candidate, deps: SynthDeps): StationVehicle {
  const { routesById, tranzyTrips, stops, stationDensityCenter, realVehicles, now } = deps;

  // Find a representative Tranzy trip for shape/direction (best-effort).
  const dir = parseDirection(candidate.tripId);
  const repTrip =
    (dir !== null
      ? tranzyTrips.find((t) => t.route_id === candidate.routeId && t.direction_id === dir)
      : undefined) ?? tranzyTrips.find((t) => t.route_id === candidate.routeId);

  const rawVehicle: TranzyVehicleResponse = {
    id: syntheticVehicleId(candidate.tripId),
    label: '',
    latitude: candidate.position.lat,
    longitude: candidate.position.lon,
    timestamp: isoAtMinutes(now, candidate.lastKnownMin),
    speed: 0,
    route_id: candidate.routeId,
    trip_id: candidate.tripId,
    vehicle_type: 3,
    bike_accessible: 'BIKE_INACCESSIBLE',
    wheelchair_accessible: 'WHEELCHAIR_INACCESSIBLE',
  };

  // Reuse the normal enhancement so speed is predicted like every other vehicle.
  // Forward prediction is suppressed so the vehicle stays at our schedule-derived
  // position; at-station detection yields speed 0 for the future (start-station)
  // phase, while ghosts mid-segment get the averaged speed prediction.
  const enhanced = enhanceVehicle(rawVehicle, {
    suppressForwardPrediction: true,
    stops,
    nearbyVehicles: realVehicles,
    stationDensityCenter,
  });
  enhanced.isScheduled = true;
  enhanced.scheduledDepartureMinutes = candidate.minutesUntil;
  enhanced.isGhost = candidate.departed;

  const trip: TranzyTripResponse = {
    trip_id: candidate.tripId,
    route_id: candidate.routeId,
    service_id: candidate.serviceId,
    trip_headsign: candidate.headsign,
    direction_id: dir ?? repTrip?.direction_id ?? 0,
    block_id: 0,
    shape_id: repTrip?.shape_id ?? '',
  };

  return {
    vehicle: enhanced,
    route: routesById.get(candidate.routeId) ?? null,
    trip,
    arrivalTime: {
      estimatedMinutes: candidate.minutesUntil,
      // Single source of the scheduled ETA text. Reuses the canonical GPS
      // "In X minutes" wording (generateStatusMessage) so scheduled and live
      // share one format, with a friendlier boundary phrase at <1 min. The
      // "Scheduled" badge marks it as schedule-derived. (No "(est.)": the time
      // is the exact scheduled time, not a prediction.)
      statusMessage:
        candidate.kind === 'departed'
          ? generateStatusMessage('departed', candidate.minutesUntil)
          : candidate.tomorrowDepartureMin != null
            // Tomorrow candidate: show "Tomorrow HH:MM" instead of a
            // meaningless "In 840 minutes".
            ? `Tomorrow ${formatBoardTime(candidate.tomorrowDepartureMin)}`
            : candidate.minutesUntil < 1
              ? candidate.kind === 'approaching'
                ? 'Arriving now'
                : 'Departing now'
              : generateStatusMessage('in_minutes', candidate.minutesUntil),
      confidence: 'low',
      calculationMethod: 'schedule',
    },
  };
}
