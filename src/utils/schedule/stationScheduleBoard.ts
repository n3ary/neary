/**
 * Station departure board (Today / Tomorrow schedule views).
 *
 * Produces the list of SCHEDULED departures from a station for a given day,
 * from the GTFS payload — independent of live GPS. "Today" is filtered to
 * upcoming departures (>= now); "Tomorrow" lists the whole day. Terminus stops
 * (where a trip ends and doesn't depart onward) are excluded.
 *
 * Pure functions — no I/O, no store access.
 */

import type { SchedulePayload } from '../../types/schedule';
import type { TranzyRouteResponse } from '../../types/rawTranzyApi';
import { resolveActiveServices } from './activeServiceUtils';
import { buildScheduleStopIndex } from './scheduledStationVehicles';

export interface BoardDeparture {
  tripId: string;
  routeId: number | null;
  /** Route short name for the badge (e.g. "24", "1A"). */
  routeShortName: string;
  /** Destination headsign for this trip's direction. */
  headsign: string;
  /** Scheduled departure from the station, minutes since midnight. */
  departureMinutes: number;
}

export interface StationBoardParams {
  scheduleData: SchedulePayload | null;
  /** Fallback trip_id -> route_id (payload's own map is preferred when present). */
  tripRouteMap?: Record<string, number>;
  /** The station to build the board for. */
  stopId: number;
  /** The local date whose service calendar applies (today or tomorrow). */
  date: Date;
  /** When set, only departures at/after this minute-of-day are kept (Today). */
  fromMinutes?: number | null;
  routes: TranzyRouteResponse[];
  /** When set, keep only departures of this route. */
  routeId?: number | null;
  /** When set, keep only departures in this GTFS direction (0/1). */
  directionId?: number | null;
}

/** GTFS direction (0/1) encoded as the 2nd token of the trip id, or null. */
function parseDirection(tripId: string): number | null {
  const token = tripId.split('_')[1];
  if (token === '0') return 0;
  if (token === '1') return 1;
  return null;
}

/** Format minutes-since-midnight as `HH:MM` (24h, wraps past-midnight service). */
export function formatBoardTime(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/**
 * Build the scheduled departure board for a station on a given day.
 */
export function buildStationDepartureBoard(params: StationBoardParams): BoardDeparture[] {
  const { scheduleData, stopId, date, fromMinutes = null, routes, routeId = null, directionId = null } = params;
  if (!scheduleData) return [];

  const routeMap =
    scheduleData.tripRouteMap && Object.keys(scheduleData.tripRouteMap).length > 0
      ? scheduleData.tripRouteMap
      : params.tripRouteMap ?? {};
  const headsignMap = scheduleData.tripHeadsignMap ?? {};
  const routesById = new Map(routes.map((r) => [r.route_id, r]));

  const active = resolveActiveServices(scheduleData.calendar, scheduleData.calendarExceptions, date);
  const index = buildScheduleStopIndex(scheduleData);
  const entries = index.get(stopId) ?? [];

  const board: BoardDeparture[] = [];
  for (const { tripId, entry } of entries) {
    const serviceId = scheduleData.tripServiceMap[tripId] ?? '';
    if (!active.has(serviceId)) continue;

    const tripRouteId = routeMap[tripId] ?? null;
    if (routeId != null && tripRouteId !== routeId) continue;
    if (directionId != null && parseDirection(tripId) !== directionId) continue;

    // Exclude the terminus stop: a trip that ENDS here doesn't depart onward.
    const stopTimes = scheduleData.stopTimes[tripId];
    if (!stopTimes || stopTimes.length === 0) continue;
    let lastQ = stopTimes[0].q;
    for (const st of stopTimes) if (st.q > lastQ) lastQ = st.q;
    if (entry.q === lastQ) continue;

    const dep = entry.d;
    if (fromMinutes != null && dep < fromMinutes) continue;

    board.push({
      tripId,
      routeId: tripRouteId,
      routeShortName: tripRouteId != null ? routesById.get(tripRouteId)?.route_short_name ?? String(tripRouteId) : '?',
      headsign: headsignMap[tripId] ?? '',
      departureMinutes: dep,
    });
  }

  board.sort((a, b) => a.departureMinutes - b.departureMinutes);
  return board;
}
