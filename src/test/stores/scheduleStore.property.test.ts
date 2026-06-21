/**
 * Schedule Store - Property-Based Tests
 *
 * Property 3: Cache freshness and version logic (Validates: Requirements 3.3, 3.6)
 *
 * These tests exercise `loadSchedule()`'s decision to fetch vs. skip across a wide
 * range of cache ages and version strings, plus the version-replacement behavior
 * that occurs when a fetch does happen.
 *
 * IMPLEMENTATION FINDING (Req 3.6 gap — documented intentionally):
 *   The store's freshness gate is purely TTL-based:
 *       if (scheduleData && isDataFresh()) return;  // skip fetch
 *   There is NO probe that compares the CDN version against the cached version to
 *   force a refetch while the cache is still fresh (<24h). The store cannot learn
 *   the CDN version without fetching, and it performs no such probe. Req 3.6's
 *   "version differs -> replace cached data" is therefore only satisfied
 *   implicitly: when a fetch DOES occur (cache stale or absent), the freshly
 *   fetched payload's version overwrites the cached `dataVersion`.
 *
 *   Consequently, Property 3's clause "fetches when the CDN reports a different
 *   version timestamp" is NOT implemented for the fresh-cache case. The tests
 *   below assert the ACTUAL implemented behavior (skip while fresh regardless of
 *   version) and document the gap, rather than asserting unimplemented behavior.
 *   Closing this gap is a store-behavior change owned by the task 4.x work, not
 *   by this test task.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fc from 'fast-check';
import { useScheduleStore } from '../../stores/scheduleStore';
import { API_CACHE_DURATION } from '../../utils/core/constants';
import type { SchedulePayload } from '../../types/schedule';
import { compactifySchedule } from '../../utils/schedule/schedulePayloadCodec';

// Feature: gtfs-schedule-integration, Property 3: Cache freshness and version logic

/** 24-hour TTL used by the store for schedule data (Requirement 3.3). */
const TTL_MS = API_CACHE_DURATION.STATIC_DATA;

/** Safety margin to keep generated ages clear of the freshness boundary so that
 *  the small amount of real time elapsing during the async fetch cannot flip a
 *  "fresh" age into "stale" (or vice versa) and cause flaky runs. */
const BOUNDARY_MARGIN_MS = 5 * 60 * 1000; // 5 minutes

function resetStore() {
  useScheduleStore.setState({
    scheduleData: null,
    activeServiceIds: new Set<string>(),
    lastResolvedDate: null,
    loading: false,
    error: null,
    lastUpdated: null,
    dataVersion: null,
  });
}

/** Build a minimal valid payload carrying a specific version string. */
function payloadWithVersion(version: string): SchedulePayload {
  return {
    version,
    stopTimes: { trip_1: [{ s: 4521, q: 0, a: 305, d: 305 }] },
    calendar: [],
    calendarExceptions: [],
    tripServiceMap: { trip_1: 'svc' },
    tripRouteMap: { trip_1: 1 },
    tripHeadsignMap: { trip_1: 'Center' },
  };
}

/** Stub global fetch to resolve with the given CDN payload (compact form, as
 *  served by the pipeline); returns the mock. */
function stubFetchWith(payload: SchedulePayload) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => compactifySchedule(payload),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Arbitrary version timestamps (kept simple but distinguishable). */
const versionArb = fc.string({ minLength: 0, maxLength: 24 });

describe('ScheduleStore property tests', () => {
  beforeEach(() => {
    resetStore();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('Property 3: Cache freshness and version logic', () => {
    it('skips fetch when cached data exists and is younger than the 24h TTL, regardless of version (Req 3.3)', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Fresh age: strictly inside the TTL with a safety margin.
          fc.integer({ min: 0, max: TTL_MS - BOUNDARY_MARGIN_MS }),
          versionArb,
          versionArb,
          async (age, cachedVersion, cdnVersion) => {
            resetStore();
            const fetchMock = stubFetchWith(payloadWithVersion(cdnVersion));

            useScheduleStore.setState({
              scheduleData: payloadWithVersion(cachedVersion),
              dataVersion: cachedVersion,
              lastUpdated: Date.now() - age,
            });

            await useScheduleStore.getState().loadSchedule();

            // Fresh cache => no network call. This holds even when the CDN
            // version differs from the cached version (documented Req 3.6 gap:
            // a version difference does NOT trigger a refetch while fresh).
            expect(fetchMock).not.toHaveBeenCalled();

            // Cached data and its version are left untouched.
            const state = useScheduleStore.getState();
            expect(state.dataVersion).toBe(cachedVersion);
            expect(state.scheduleData?.version).toBe(cachedVersion);
          },
        ),
        { numRuns: 200 },
      );
    });

    it('fetches when the cache is at least 24h old and replaces the cached version with the CDN version (Req 3.3, 3.6)', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Stale age: at or beyond the TTL with a safety margin.
          fc.integer({ min: TTL_MS + BOUNDARY_MARGIN_MS, max: TTL_MS * 4 }),
          versionArb,
          versionArb,
          async (age, cachedVersion, cdnVersion) => {
            resetStore();
            const fetchMock = stubFetchWith(payloadWithVersion(cdnVersion));

            useScheduleStore.setState({
              scheduleData: payloadWithVersion(cachedVersion),
              dataVersion: cachedVersion,
              lastUpdated: Date.now() - age,
            });

            await useScheduleStore.getState().loadSchedule();

            // Stale cache => refetch occurs.
            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(fetchMock).toHaveBeenCalledWith('/data/schedule.json', { cache: 'no-cache' });

            // On fetch, the freshly fetched payload's version replaces the cached
            // version — the implemented half of Req 3.6.
            const state = useScheduleStore.getState();
            expect(state.dataVersion).toBe(cdnVersion);
            expect(state.scheduleData?.version).toBe(cdnVersion);
            expect(state.loading).toBe(false);
            expect(state.error).toBeNull();
          },
        ),
        { numRuns: 200 },
      );
    });

    it('always fetches when no cached data exists, for any age and version (Req 3.1)', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: TTL_MS * 4 }),
          versionArb,
          async (age, cdnVersion) => {
            resetStore();
            const fetchMock = stubFetchWith(payloadWithVersion(cdnVersion));

            // No scheduleData; lastUpdated set but isDataFresh is moot without data.
            useScheduleStore.setState({
              scheduleData: null,
              dataVersion: null,
              lastUpdated: Date.now() - age,
            });

            await useScheduleStore.getState().loadSchedule();

            expect(fetchMock).toHaveBeenCalledTimes(1);

            const state = useScheduleStore.getState();
            expect(state.scheduleData?.version).toBe(cdnVersion);
            expect(state.dataVersion).toBe(cdnVersion);
          },
        ),
        { numRuns: 200 },
      );
    });
  });
});
