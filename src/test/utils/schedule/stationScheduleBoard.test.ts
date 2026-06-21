/**
 * Tests for `buildStationDepartureBoard` — the data behind the Today/Tomorrow
 * schedule overlay. Focus is on the new past-departure window used to surface
 * a recently-passed run alongside the upcoming list (#21 follow-up).
 */

import { describe, it, expect } from 'vitest';
import { buildStationDepartureBoard } from '../../../utils/schedule/stationScheduleBoard';
import type { SchedulePayload, ScheduleStopTime } from '../../../types/schedule';
import type { TranzyRouteResponse } from '../../../types/rawTranzyApi';

const ROUTE: TranzyRouteResponse = {
  agency_id: 2,
  route_id: 21,
  route_short_name: '21',
  route_long_name: 'X',
  route_color: '#000',
  route_type: 3,
  route_desc: '',
};

/** Two-stop trip: depart `start` at stop 100, arrive `start + 10` at stop 101. */
function tripStops(start: number): ScheduleStopTime[] {
  return [
    { s: 100, q: 0, a: start, d: start },
    { s: 101, q: 1, a: start + 10, d: start + 10 },
  ];
}

/** Schedule active every day across a wide date range. */
function makeSchedule(trips: Record<string, number>): SchedulePayload {
  const stopTimes: Record<string, ScheduleStopTime[]> = {};
  const tripServiceMap: Record<string, string> = {};
  const tripRouteMap: Record<string, number> = {};
  for (const [tripId, start] of Object.entries(trips)) {
    stopTimes[tripId] = tripStops(start);
    tripServiceMap[tripId] = 'always';
    tripRouteMap[tripId] = ROUTE.route_id;
  }
  return {
    version: '2025-01-15T03:00:00Z',
    stopTimes,
    calendar: [
      {
        serviceId: 'always',
        monday: true, tuesday: true, wednesday: true, thursday: true,
        friday: true, saturday: true, sunday: true,
        startDate: '20000101', endDate: '20991231',
      },
    ],
    calendarExceptions: [],
    tripServiceMap,
    tripRouteMap,
    tripHeadsignMap: { trip_a: 'Center', trip_b: 'Center', trip_c: 'Center' },
  };
}

describe('buildStationDepartureBoard - past departure window', () => {
  const now = new Date(2025, 5, 16, 10, 0, 0); // 10:00 = 600 min

  it('returns only upcoming when no past window is requested (default)', () => {
    // 21_0_a: 09:55 (5 min ago); 21_0_b: 10:05; 21_0_c: 10:30
    const sched = makeSchedule({ '21_0_a': 595, '21_0_b': 605, '21_0_c': 630 });
    const board = buildStationDepartureBoard({
      scheduleData: sched, stopId: 100, date: now, fromMinutes: 600,
      routes: [ROUTE], routeId: 21,
    });

    expect(board).toHaveLength(2);
    expect(board.every((d) => !d.past)).toBe(true);
    expect(board.map((d) => d.departureMinutes)).toEqual([605, 630]);
  });

  it('prepends the soonest past departure within the window, marked past=true', () => {
    const sched = makeSchedule({ '21_0_a': 595, '21_0_b': 605, '21_0_c': 630 });
    const board = buildStationDepartureBoard({
      scheduleData: sched, stopId: 100, date: now, fromMinutes: 600,
      pastWindowMinutes: 10,
      routes: [ROUTE], routeId: 21,
    });

    expect(board.map((d) => ({ dep: d.departureMinutes, past: d.past === true })))
      .toEqual([
        { dep: 595, past: true },
        { dep: 605, past: false },
        { dep: 630, past: false },
      ]);
  });

  it('keeps only the SOONEST past departure (closest to now), not earlier ones', () => {
    // Two past departures within window: 9:50 (-10), 9:55 (-5). Soonest = 595.
    const sched = makeSchedule({ '21_0_a': 590, '21_0_b': 595, '21_0_c': 605 });
    const board = buildStationDepartureBoard({
      scheduleData: sched, stopId: 100, date: now, fromMinutes: 600,
      pastWindowMinutes: 15,
      routes: [ROUTE], routeId: 21,
    });

    const past = board.filter((d) => d.past);
    expect(past).toHaveLength(1);
    expect(past[0].departureMinutes).toBe(595);
  });

  it('excludes past departures older than the window', () => {
    // 9:45 is 15 min ago, outside the 10-min window.
    const sched = makeSchedule({ '21_0_a': 585, '21_0_b': 605 });
    const board = buildStationDepartureBoard({
      scheduleData: sched, stopId: 100, date: now, fromMinutes: 600,
      pastWindowMinutes: 10,
      routes: [ROUTE], routeId: 21,
    });

    expect(board.every((d) => !d.past)).toBe(true);
    expect(board.map((d) => d.departureMinutes)).toEqual([605]);
  });

  it('pinnedPastTripId surfaces a past departure even when older than the window', () => {
    // Trip "21_0_a" departed 25 min ago — far outside the 10-min window — but
    // pinning it makes it the past row anyway (the ghost-card use case).
    const sched = makeSchedule({ '21_0_a': 575, '21_0_b': 605 });
    const board = buildStationDepartureBoard({
      scheduleData: sched, stopId: 100, date: now, fromMinutes: 600,
      pastWindowMinutes: 10,
      pinnedPastTripId: '21_0_a',
      routes: [ROUTE], routeId: 21,
    });

    const past = board.filter((d) => d.past);
    expect(past).toHaveLength(1);
    expect(past[0].tripId).toBe('21_0_a');
    expect(past[0].departureMinutes).toBe(575);
  });

  it('pinnedPastTripId wins over a different in-window past departure', () => {
    // 21_0_a (pinned, 25 min ago) and 21_0_b (5 min ago, in window) compete.
    // Pinned wins because the ghost card always wants ITS run as the past row.
    const sched = makeSchedule({ '21_0_a': 575, '21_0_b': 595, '21_0_c': 605 });
    const board = buildStationDepartureBoard({
      scheduleData: sched, stopId: 100, date: now, fromMinutes: 600,
      pastWindowMinutes: 10,
      pinnedPastTripId: '21_0_a',
      routes: [ROUTE], routeId: 21,
    });

    const past = board.filter((d) => d.past);
    expect(past).toHaveLength(1);
    expect(past[0].tripId).toBe('21_0_a');
  });
});
