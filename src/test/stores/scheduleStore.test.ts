/**
 * Schedule Store Tests
 *
 * Unit tests for the schedule store scaffold, CDN fetching, and freshness
 * (task 4.1). Validates Requirements 3.1, 3.3, 3.4, 3.5.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useScheduleStore } from '../../stores/scheduleStore';
import { useConfigStore } from '../../stores/configStore';
import type { SchedulePayload, CalendarEntry } from '../../types/schedule';
import { compactifySchedule } from '../../utils/schedule/schedulePayloadCodec';

/** Tranzy agency_id with a registered GTFS feed (CTP Cluj). */
const TEST_AGENCY_ID = 2;

/** A calendar entry active on every weekday across a very wide date range. */
function allDaysEntry(serviceId: string): CalendarEntry {
  return {
    serviceId,
    monday: true,
    tuesday: true,
    wednesday: true,
    thursday: true,
    friday: true,
    saturday: true,
    sunday: true,
    startDate: '20000101',
    endDate: '20991231',
  };
}

const SAMPLE_PAYLOAD: SchedulePayload = {
  version: '2025-01-15T03:00:00Z',
  stopTimes: {
    trip_1: [{ s: 4521, q: 0, a: 305, d: 305 }],
  },
  calendar: [],
  calendarExceptions: [],
  tripServiceMap: { trip_1: 'Mon-Fri' },
  tripRouteMap: { trip_1: 24 },
  tripHeadsignMap: { trip_1: 'Test Destination' },
};

function resetStore() {
  useScheduleStore.setState({
    scheduleData: null,
    activeServiceIds: new Set<string>(),
    lastResolvedDate: null,
    loading: false,
    error: null,
    lastUpdated: null,
    dataVersion: null,
    dataAgencyId: null,
  });
}

describe('ScheduleStore', () => {
  beforeEach(() => {
    resetStore();
    // The schedule layer is per-agency; configure an agency that has a feed so
    // loadSchedule fetches rather than degrading to GPS-only.
    useConfigStore.setState({ agency_id: TEST_AGENCY_ID });
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('initializes with empty/default state', () => {
    const state = useScheduleStore.getState();
    expect(state.scheduleData).toBeNull();
    expect(state.activeServiceIds.size).toBe(0);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
    expect(state.lastUpdated).toBeNull();
    expect(state.dataVersion).toBeNull();
  });

  describe('isDataFresh', () => {
    it('returns false when no data has been loaded', () => {
      expect(useScheduleStore.getState().isDataFresh()).toBe(false);
    });

    it('returns true when lastUpdated is within the 24-hour TTL', () => {
      useScheduleStore.setState({ lastUpdated: Date.now() - 1000 });
      expect(useScheduleStore.getState().isDataFresh()).toBe(true);
    });

    it('returns false when lastUpdated exceeds the 24-hour TTL', () => {
      useScheduleStore.setState({ lastUpdated: Date.now() - (25 * 60 * 60 * 1000) });
      expect(useScheduleStore.getState().isDataFresh()).toBe(false);
    });
  });

  describe('loadSchedule', () => {
    it('fetches the payload from the CDN and populates state (Req 3.1)', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => compactifySchedule(SAMPLE_PAYLOAD),
      });
      vi.stubGlobal('fetch', fetchMock);

      await useScheduleStore.getState().loadSchedule();

      const state = useScheduleStore.getState();
      expect(fetchMock).toHaveBeenCalledWith('https://raw.githubusercontent.com/ciotlosm/neary-gtfs/releases/agency-2-schedule.json', { cache: 'no-cache' });
      expect(state.scheduleData).toEqual(SAMPLE_PAYLOAD);
      expect(state.dataVersion).toBe(SAMPLE_PAYLOAD.version);
      expect(state.lastUpdated).not.toBeNull();
      expect(state.loading).toBe(false);
      expect(state.error).toBeNull();
    });

    it('skips refetching when cached data is fresh (Req 3.3)', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      useScheduleStore.setState({
        scheduleData: SAMPLE_PAYLOAD,
        dataAgencyId: TEST_AGENCY_ID,
        lastUpdated: Date.now() - 1000,
      });

      await useScheduleStore.getState().loadSchedule();

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('keeps cached data and stays error-free when the fetch fails (Req 3.4)', async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
      vi.stubGlobal('fetch', fetchMock);

      // Stale cache so it attempts a refetch
      useScheduleStore.setState({
        scheduleData: SAMPLE_PAYLOAD,
        dataAgencyId: TEST_AGENCY_ID,
        dataVersion: SAMPLE_PAYLOAD.version,
        lastUpdated: Date.now() - (25 * 60 * 60 * 1000),
      });

      await useScheduleStore.getState().loadSchedule();

      const state = useScheduleStore.getState();
      expect(state.scheduleData).toEqual(SAMPLE_PAYLOAD);
      expect(state.error).toBeNull();
      expect(state.loading).toBe(false);
    });

    it('sets error state and null data when fetch fails with no cache (Req 3.5)', async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
      vi.stubGlobal('fetch', fetchMock);

      await useScheduleStore.getState().loadSchedule();

      const state = useScheduleStore.getState();
      expect(state.scheduleData).toBeNull();
      expect(state.error).toBe('network down');
      expect(state.loading).toBe(false);
    });

    it('treats a non-OK response as a failure', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
      vi.stubGlobal('fetch', fetchMock);

      await useScheduleStore.getState().loadSchedule();

      const state = useScheduleStore.getState();
      expect(state.scheduleData).toBeNull();
      expect(state.error).toContain('503');
    });

    it('treats a malformed payload as a failure', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: 'x' }) });
      vi.stubGlobal('fetch', fetchMock);

      await useScheduleStore.getState().loadSchedule();

      const state = useScheduleStore.getState();
      expect(state.scheduleData).toBeNull();
      expect(state.error).toBe('Malformed schedule payload');
    });
  });

  describe('clearSchedule / clearError', () => {
    it('clearSchedule resets data and metadata', () => {
      useScheduleStore.setState({
        scheduleData: SAMPLE_PAYLOAD,
        dataVersion: SAMPLE_PAYLOAD.version,
        lastUpdated: Date.now(),
        activeServiceIds: new Set(['Mon-Fri']),
        lastResolvedDate: '20250115',
      });

      useScheduleStore.getState().clearSchedule();

      const state = useScheduleStore.getState();
      expect(state.scheduleData).toBeNull();
      expect(state.dataVersion).toBeNull();
      expect(state.lastUpdated).toBeNull();
      expect(state.activeServiceIds.size).toBe(0);
      expect(state.lastResolvedDate).toBeNull();
    });

    it('clearError clears only the error field', () => {
      useScheduleStore.setState({ error: 'boom', scheduleData: SAMPLE_PAYLOAD });
      useScheduleStore.getState().clearError();
      expect(useScheduleStore.getState().error).toBeNull();
      expect(useScheduleStore.getState().scheduleData).toEqual(SAMPLE_PAYLOAD);
    });
  });

  describe('resolveActiveServices', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('clears activeServiceIds when no schedule data is loaded', () => {
      useScheduleStore.setState({ activeServiceIds: new Set(['stale']) });

      useScheduleStore.getState().resolveActiveServices();

      const state = useScheduleStore.getState();
      expect(state.activeServiceIds.size).toBe(0);
      expect(state.lastResolvedDate).not.toBeNull();
    });

    it('resolves services active for the current date from the calendar (Req 4.1)', () => {
      // 2025-06-16 is a Monday in local time.
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2025, 5, 16, 10, 0, 0));

      const mondayOnly: CalendarEntry = { ...allDaysEntry('weekday'), saturday: false, sunday: false };
      const weekendOnly: CalendarEntry = {
        ...allDaysEntry('weekend'),
        monday: false, tuesday: false, wednesday: false, thursday: false, friday: false,
      };

      useScheduleStore.setState({
        scheduleData: {
          ...SAMPLE_PAYLOAD,
          calendar: [mondayOnly, weekendOnly],
          calendarExceptions: [],
        },
      });

      useScheduleStore.getState().resolveActiveServices();

      const { activeServiceIds, lastResolvedDate } = useScheduleStore.getState();
      expect(activeServiceIds.has('weekday')).toBe(true);
      expect(activeServiceIds.has('weekend')).toBe(false);
      expect(lastResolvedDate).toBe('20250616');
    });

    it('applies calendar exceptions: adds type 1 and removes type 2 (Req 4.2)', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2025, 5, 16, 10, 0, 0)); // 20250616

      useScheduleStore.setState({
        scheduleData: {
          ...SAMPLE_PAYLOAD,
          calendar: [allDaysEntry('base'), allDaysEntry('removed')],
          calendarExceptions: [
            { serviceId: 'added', date: '20250616', exceptionType: 1 },
            { serviceId: 'removed', date: '20250616', exceptionType: 2 },
            { serviceId: 'other-day', date: '20250617', exceptionType: 1 },
          ],
        },
      });

      useScheduleStore.getState().resolveActiveServices();

      const { activeServiceIds } = useScheduleStore.getState();
      expect(activeServiceIds.has('base')).toBe(true);
      expect(activeServiceIds.has('added')).toBe(true);
      expect(activeServiceIds.has('removed')).toBe(false);
      expect(activeServiceIds.has('other-day')).toBe(false);
    });

    it('resolves active services after a successful CDN load (Req 4.1)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2025, 5, 16, 10, 0, 0));

      const payload: SchedulePayload = {
        ...SAMPLE_PAYLOAD,
        calendar: [allDaysEntry('always')],
        calendarExceptions: [],
      };
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => compactifySchedule(payload) });
      vi.stubGlobal('fetch', fetchMock);

      await useScheduleStore.getState().loadSchedule();

      const { activeServiceIds, lastResolvedDate } = useScheduleStore.getState();
      expect(activeServiceIds.has('always')).toBe(true);
      expect(lastResolvedDate).toBe('20250616');
    });

    it('resolves active services for fresh cached data without refetching (Req 3.3, 4.1)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2025, 5, 16, 10, 0, 0));

      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      // Fresh cache, but active services not yet resolved (e.g. after rehydration)
      useScheduleStore.setState({
        scheduleData: {
          ...SAMPLE_PAYLOAD,
          calendar: [allDaysEntry('always')],
          calendarExceptions: [],
        },
        dataAgencyId: TEST_AGENCY_ID,
        lastUpdated: Date.now() - 1000,
        activeServiceIds: new Set<string>(),
        lastResolvedDate: null,
      });

      await useScheduleStore.getState().loadSchedule();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(useScheduleStore.getState().activeServiceIds.has('always')).toBe(true);
    });
  });

  describe('ensureActiveServicesForToday (midnight crossing, Req 4.4)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('recalculates active services when the local date has changed', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2025, 5, 16, 23, 59, 0)); // 20250616

      useScheduleStore.setState({
        scheduleData: {
          ...SAMPLE_PAYLOAD,
          calendar: [
            { ...allDaysEntry('mon'),
              tuesday: false, wednesday: false, thursday: false, friday: false, saturday: false, sunday: false },
            { ...allDaysEntry('tue-only'),
              monday: false, wednesday: false, thursday: false, friday: false, saturday: false, sunday: false },
          ],
          calendarExceptions: [],
        },
      });

      useScheduleStore.getState().resolveActiveServices();
      expect(useScheduleStore.getState().activeServiceIds.has('mon')).toBe(true);
      expect(useScheduleStore.getState().lastResolvedDate).toBe('20250616');

      // Cross midnight into Tuesday 2025-06-17
      vi.setSystemTime(new Date(2025, 5, 17, 0, 1, 0));
      useScheduleStore.getState().ensureActiveServicesForToday();

      const state = useScheduleStore.getState();
      expect(state.lastResolvedDate).toBe('20250617');
      expect(state.activeServiceIds.has('tue-only')).toBe(true);
      expect(state.activeServiceIds.has('mon')).toBe(false);
    });

    it('does not recompute when the date is unchanged', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2025, 5, 16, 10, 0, 0));

      useScheduleStore.setState({
        scheduleData: { ...SAMPLE_PAYLOAD, calendar: [allDaysEntry('always')], calendarExceptions: [] },
      });
      useScheduleStore.getState().resolveActiveServices();

      // Mutate the set to a sentinel; a no-op ensure must not overwrite it.
      const sentinel = new Set(['sentinel']);
      useScheduleStore.setState({ activeServiceIds: sentinel });

      useScheduleStore.getState().ensureActiveServicesForToday();

      expect(useScheduleStore.getState().activeServiceIds).toBe(sentinel);
    });
  });

  describe('query methods (task 4.2)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Payload with two stops on a trip for arrival/departure lookups. */
    const QUERY_PAYLOAD: SchedulePayload = {
      version: '2025-01-15T03:00:00Z',
      stopTimes: {
        trip_a: [
          { s: 20, q: 1, a: 610, d: 611 },
          { s: 10, q: 0, a: 600, d: 600 },
        ],
        trip_b: [
          { s: 20, q: 0, a: 605, d: 605 },
          { s: 30, q: 1, a: 615, d: 615 },
        ],
        trip_inactive: [{ s: 20, q: 0, a: 602, d: 602 }],
      },
      calendar: [allDaysEntry('svc')],
      calendarExceptions: [],
      tripServiceMap: {
        trip_a: 'svc',
        trip_b: 'svc',
        trip_inactive: 'inactive',
      },
    };

    describe('getStopTimesForTrip', () => {
      it('returns null when no schedule data is loaded', () => {
        expect(useScheduleStore.getState().getStopTimesForTrip('trip_a')).toBeNull();
      });

      it('returns the stop times for a known trip (O(1) lookup)', () => {
        useScheduleStore.setState({ scheduleData: QUERY_PAYLOAD });
        expect(useScheduleStore.getState().getStopTimesForTrip('trip_a')).toEqual(
          QUERY_PAYLOAD.stopTimes.trip_a,
        );
      });

      it('returns null for an unknown trip', () => {
        useScheduleStore.setState({ scheduleData: QUERY_PAYLOAD });
        expect(useScheduleStore.getState().getStopTimesForTrip('missing')).toBeNull();
      });
    });

    describe('getScheduledArrival / getScheduledDeparture', () => {
      beforeEach(() => {
        useScheduleStore.setState({ scheduleData: QUERY_PAYLOAD });
      });

      it('returns the arrival minutes for a matching trip/stop', () => {
        expect(useScheduleStore.getState().getScheduledArrival('trip_a', 20)).toBe(610);
      });

      it('returns the departure minutes for a matching trip/stop', () => {
        expect(useScheduleStore.getState().getScheduledDeparture('trip_a', 20)).toBe(611);
      });

      it('returns null when the stop is not part of the trip', () => {
        expect(useScheduleStore.getState().getScheduledArrival('trip_a', 999)).toBeNull();
        expect(useScheduleStore.getState().getScheduledDeparture('trip_a', 999)).toBeNull();
      });

      it('returns null when no schedule data is loaded', () => {
        resetStore();
        expect(useScheduleStore.getState().getScheduledArrival('trip_a', 20)).toBeNull();
        expect(useScheduleStore.getState().getScheduledDeparture('trip_a', 20)).toBeNull();
      });
    });

    describe('getTripStartTime', () => {
      it('returns the first stop (lowest sequence) departure regardless of array order', () => {
        useScheduleStore.setState({ scheduleData: QUERY_PAYLOAD });
        // trip_a's first stop (q=0) is stop 10 with departure 600, even though it
        // appears second in the array.
        expect(useScheduleStore.getState().getTripStartTime('trip_a')).toBe(600);
      });

      it('returns null for an unknown trip or when no data is loaded', () => {
        expect(useScheduleStore.getState().getTripStartTime('trip_a')).toBeNull();
        useScheduleStore.setState({ scheduleData: QUERY_PAYLOAD });
        expect(useScheduleStore.getState().getTripStartTime('missing')).toBeNull();
      });
    });

    describe('isTripActiveToday (Req 4.3)', () => {
      it('returns true when the trip service is active today', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2025, 5, 16, 10, 0, 0));
        useScheduleStore.setState({ scheduleData: QUERY_PAYLOAD });
        expect(useScheduleStore.getState().isTripActiveToday('trip_a')).toBe(true);
      });

      it('returns false when the trip service is not active today', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2025, 5, 16, 10, 0, 0));
        useScheduleStore.setState({ scheduleData: QUERY_PAYLOAD });
        expect(useScheduleStore.getState().isTripActiveToday('trip_inactive')).toBe(false);
      });

      it('returns false for an unknown trip and when no data is loaded', () => {
        expect(useScheduleStore.getState().isTripActiveToday('trip_a')).toBe(false);
        useScheduleStore.setState({ scheduleData: QUERY_PAYLOAD });
        expect(useScheduleStore.getState().isTripActiveToday('missing')).toBe(false);
      });
    });

    describe('getUpcomingDepartures (Req 6.1, 6.2, 6.5)', () => {
      it('returns active trips serving the stop within the window, sorted ascending', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2025, 5, 16, 10, 0, 0)); // 600 minutes since midnight
        useScheduleStore.setState({ scheduleData: QUERY_PAYLOAD });

        const result = useScheduleStore.getState().getUpcomingDepartures(20, [], 60);

        // trip_b (d=605) and trip_a (d=611) serve stop 20 and are active;
        // trip_inactive is excluded. Sorted by departureMinutes ascending.
        expect(result.map((d) => d.tripId)).toEqual(['trip_b', 'trip_a']);
        expect(result[0]).toMatchObject({
          tripId: 'trip_b',
          routeId: 0,
          departureMinutes: 605,
          minutesUntil: 5,
          hasGpsVehicle: false,
          isGhost: false,
        });
        expect(result[1].minutesUntil).toBe(11);
      });

      it('excludes departures outside the time window', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2025, 5, 16, 10, 0, 0)); // 600
        useScheduleStore.setState({ scheduleData: QUERY_PAYLOAD });

        // A 5-minute window only includes trip_b (d=605); trip_a (d=611) is out.
        const result = useScheduleStore.getState().getUpcomingDepartures(20, [], 5);
        expect(result.map((d) => d.tripId)).toEqual(['trip_b']);
      });

      it('excludes departures in the past', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2025, 5, 16, 10, 12, 0)); // 612, after both departures
        useScheduleStore.setState({ scheduleData: QUERY_PAYLOAD });

        const result = useScheduleStore.getState().getUpcomingDepartures(20, [], 60);
        expect(result).toEqual([]);
      });

      it('defaults to a 60-minute window when none is provided', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2025, 5, 16, 10, 0, 0));
        useScheduleStore.setState({ scheduleData: QUERY_PAYLOAD });

        const result = useScheduleStore.getState().getUpcomingDepartures(20, []);
        expect(result.map((d) => d.tripId)).toEqual(['trip_b', 'trip_a']);
      });

      it('returns an empty array when no schedule data is loaded', () => {
        expect(useScheduleStore.getState().getUpcomingDepartures(20, [], 60)).toEqual([]);
      });

      describe('GPS presence and route association (Req 6.4, 6.1)', () => {
        beforeEach(() => {
          vi.useFakeTimers();
          vi.setSystemTime(new Date(2025, 5, 16, 10, 0, 0)); // 600 minutes
          useScheduleStore.setState({ scheduleData: QUERY_PAYLOAD });
        });

        it('marks departures whose trip has a GPS-visible vehicle as GPS-assigned (Req 6.4)', () => {
          const result = useScheduleStore.getState().getUpcomingDepartures(20, [], 60, {
            gpsVehicleTripIds: new Set(['trip_b']),
          });

          const byTrip = Object.fromEntries(result.map((d) => [d.tripId, d]));
          // trip_b has a GPS vehicle assigned; trip_a does not (schedule-only).
          expect(byTrip.trip_b.hasGpsVehicle).toBe(true);
          expect(byTrip.trip_a.hasGpsVehicle).toBe(false);
        });

        it('treats all departures as schedule-only when no GPS trip ids are supplied (Req 6.4)', () => {
          const result = useScheduleStore.getState().getUpcomingDepartures(20, [], 60);
          expect(result.every((d) => d.hasGpsVehicle === false)).toBe(true);
        });

        it('populates routeId from the supplied trip->route map', () => {
          const result = useScheduleStore.getState().getUpcomingDepartures(20, [], 60, {
            tripRouteMap: new Map([
              ['trip_a', 24],
              ['trip_b', 25],
            ]),
          });

          const byTrip = Object.fromEntries(result.map((d) => [d.tripId, d]));
          expect(byTrip.trip_a.routeId).toBe(24);
          expect(byTrip.trip_b.routeId).toBe(25);
        });

        it('accepts a plain record as the trip->route map', () => {
          const result = useScheduleStore.getState().getUpcomingDepartures(20, [], 60, {
            tripRouteMap: { trip_a: 24, trip_b: 25 },
          });

          const byTrip = Object.fromEntries(result.map((d) => [d.tripId, d]));
          expect(byTrip.trip_a.routeId).toBe(24);
          expect(byTrip.trip_b.routeId).toBe(25);
        });

        it('filters departures by routeIds when a trip->route map is provided (Req 6.1)', () => {
          const result = useScheduleStore.getState().getUpcomingDepartures(20, [25], 60, {
            tripRouteMap: new Map([
              ['trip_a', 24],
              ['trip_b', 25],
            ]),
          });

          // Only trip_b is on route 25; trip_a (route 24) is filtered out.
          expect(result.map((d) => d.tripId)).toEqual(['trip_b']);
          expect(result[0].routeId).toBe(25);
        });

        it('does not filter by route when routeIds is empty even if a map is provided', () => {
          const result = useScheduleStore.getState().getUpcomingDepartures(20, [], 60, {
            tripRouteMap: new Map([
              ['trip_a', 24],
              ['trip_b', 25],
            ]),
          });
          expect(result.map((d) => d.tripId)).toEqual(['trip_b', 'trip_a']);
        });

        it('ignores routeIds filtering when no trip->route map is supplied (placeholder routeId 0)', () => {
          // routeIds is non-empty but without a map the route cannot be derived,
          // so the placeholder behavior applies: no filtering, routeId 0.
          const result = useScheduleStore.getState().getUpcomingDepartures(20, [99], 60);
          expect(result.map((d) => d.tripId)).toEqual(['trip_b', 'trip_a']);
          expect(result.every((d) => d.routeId === 0)).toBe(true);
        });

        it('excludes trips missing from the route map when route filtering is active', () => {
          const result = useScheduleStore.getState().getUpcomingDepartures(20, [24], 60, {
            // trip_b is absent from the map, so it has no resolvable route and is
            // excluded when filtering by route 24.
            tripRouteMap: new Map([['trip_a', 24]]),
          });
          expect(result.map((d) => d.tripId)).toEqual(['trip_a']);
        });

        it('combines GPS presence and route filtering', () => {
          const result = useScheduleStore.getState().getUpcomingDepartures(20, [24, 25], 60, {
            gpsVehicleTripIds: new Set(['trip_a']),
            tripRouteMap: new Map([
              ['trip_a', 24],
              ['trip_b', 25],
            ]),
          });

          expect(result.map((d) => d.tripId)).toEqual(['trip_b', 'trip_a']);
          const byTrip = Object.fromEntries(result.map((d) => [d.tripId, d]));
          expect(byTrip.trip_a).toMatchObject({ routeId: 24, hasGpsVehicle: true });
          expect(byTrip.trip_b).toMatchObject({ routeId: 25, hasGpsVehicle: false });
        });
      });
    });
  });
});
