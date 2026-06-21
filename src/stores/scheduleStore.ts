// ScheduleStore - Client-side GTFS schedule data management
//
// Fetches the compact schedule payload from the CDN, caches it in IndexedDB for
// offline access, and exposes freshness/state to schedule-consuming features.
//
// Design principles (see .kiro/specs/gtfs-schedule-integration/design.md):
//   - Additive only: when schedule data is unavailable, the app keeps working on
//     GPS-only behavior. This store never throws to consumers.
//   - Follows existing store conventions (Zustand + persist middleware,
//     loading/error states, cache freshness checks).
//   - Persists to localStorage with gzip compression via the shared
//     compressed-storage adapter (issue #29), the same mechanism used by other
//     large stores. The compact payload (~200-300KB gzipped) fits well within
//     the localStorage quota.
//
// This file implements the store scaffold, CDN fetching, and freshness (task 4.1).
// Query methods (task 4.2) and active service resolution (task 4.3) are downstream
// tasks; clear seams are marked below.

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

import type {
  SchedulePayload,
  CompactSchedulePayload,
  ScheduleStopTime,
  UpcomingDeparture,
} from '../types/schedule';
import { API_CACHE_DURATION } from '../utils/core/constants';
import { createCompressedStorage } from '../utils/core/compressedStorage';
import {
  resolveActiveServices as resolveActiveServicesForDate,
  minutesSinceMidnight,
  isTimeInWindow,
} from '../utils/schedule/activeServiceUtils';
import {
  expandSchedule,
  compactifySchedule,
  isCompactSchedulePayload,
} from '../utils/schedule/schedulePayloadCodec';
import {
  scheduleUrlForAgency,
  hasScheduleForAgency,
} from '../utils/schedule/agencyFeeds';
import { useConfigStore } from './configStore';

/**
 * Optional GPS/route context supplied by the caller of `getUpcomingDepartures`.
 *
 * The schedule store deliberately does not import the vehicle store (to avoid
 * coupling/cycles). Instead, a caller (hook or component) reads current GPS
 * vehicle state from the existing `vehicleStore` and passes it in here:
 *
 *   - `gpsVehicleTripIds`: trip ids that currently have a GPS-visible vehicle
 *     assigned. Used to set `hasGpsVehicle` so departures can indicate
 *     GPS-assigned vs schedule-only (Req 6.4).
 *   - `tripRouteMap`: a trip_id -> route_id mapping. The compact schedule
 *     payload has no trip->route association, so when this is supplied the
 *     store can populate `routeId` and filter departures by the `routeIds`
 *     argument (Req 6.1). When omitted, `routeId` stays a documented
 *     placeholder (0) and no route filtering is applied.
 */
export interface UpcomingDeparturesContext {
  /** Trip ids with a currently GPS-visible vehicle assigned. */
  gpsVehicleTripIds?: ReadonlySet<string>;
  /** Mapping of trip_id -> route_id, supplied from existing trip data. */
  tripRouteMap?: ReadonlyMap<string, number> | Record<string, number>;
}

/** Read a trip's route id from either a Map or a plain record, or null. */
function lookupRouteId(
  tripRouteMap: UpcomingDeparturesContext['tripRouteMap'],
  tripId: string,
): number | null {
  if (!tripRouteMap) return null;
  if (tripRouteMap instanceof Map) {
    return tripRouteMap.get(tripId) ?? null;
  }
  return Object.prototype.hasOwnProperty.call(tripRouteMap, tripId)
    ? tripRouteMap[tripId]
    : null;
}

/** 24-hour TTL for cached schedule data (Requirement 3.3). */
const SCHEDULE_TTL_MS = API_CACHE_DURATION.STATIC_DATA;

const LOG_PREFIX = '[ScheduleStore]';

/**
 * Format a `Date` as a `YYYYMMDD` key from its local calendar fields.
 *
 * Used to detect midnight crossings: when the local day changes, the key
 * changes, signalling that active services must be recomputed (Req 4.4).
 */
function localDateKey(date: Date): string {
  const year = date.getFullYear().toString().padStart(4, '0');
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  return `${year}${month}${day}`;
}

interface ScheduleStore {
  // Data
  /** Full schedule payload, or null when unavailable (graceful degradation). */
  scheduleData: SchedulePayload | null;
  /**
   * Service IDs active for the current date. Populated by active service
   * resolution (task 4.3); kept here so query methods (task 4.2) can read it.
   */
  activeServiceIds: Set<string>;
  /**
   * Local date (`YYYYMMDD`) for which `activeServiceIds` was last resolved.
   * Used to detect midnight crossings without timers (Req 4.4). Transient —
   * not persisted, so it is recomputed on demand after rehydration.
   */
  lastResolvedDate: string | null;

  // State
  loading: boolean;
  error: string | null;
  lastUpdated: number | null;
  dataVersion: string | null;
  /**
   * Tranzy agency_id the currently loaded/cached payload belongs to. Used to
   * self-heal the cache when the user switches agency: a cache for a different
   * agency is treated as unusable and refetched (or cleared when the new agency
   * has no published schedule). Null when no payload is loaded.
   */
  dataAgencyId: number | null;

  // Actions
  /** Fetch the schedule payload from the CDN, using fresh cache when available. */
  loadSchedule: () => Promise<void>;

  // Query methods (task 4.2). All return null/empty gracefully when no data is
  // loaded, never throwing to consumers (see design "Graceful degradation").
  /** O(1) lookup of all stop times for a trip, or null when unavailable. */
  getStopTimesForTrip: (tripId: string) => ScheduleStopTime[] | null;
  /** Scheduled arrival (minutes since midnight) for a trip/stop, or null. */
  getScheduledArrival: (tripId: string, stopId: number) => number | null;
  /** Scheduled departure (minutes since midnight) for a trip/stop, or null. */
  getScheduledDeparture: (tripId: string, stopId: number) => number | null;
  /** Whether a trip's service is active on the current local date (Req 4.3). */
  isTripActiveToday: (tripId: string) => boolean;
  /** First stop's departure (minutes since midnight) for a trip, or null. */
  getTripStartTime: (tripId: string) => number | null;
  /**
   * Upcoming scheduled departures from a station within `windowMinutes` of now
   * (default 60), sorted by departure time ascending (Req 6.1, 6.2, 6.5).
   *
   * Pass `context` to wire in GPS vehicle presence and trip->route association
   * supplied by the caller (the store stays decoupled from the vehicle store):
   *   - `hasGpsVehicle` is set from `context.gpsVehicleTripIds` (Req 6.4).
   *   - When `context.tripRouteMap` is provided, `routeId` is populated and
   *     departures are filtered by the `routeIds` argument (Req 6.1); otherwise
   *     `routeId` is a documented placeholder (0) and no route filtering occurs.
   */
  getUpcomingDepartures: (
    stopId: number,
    routeIds: number[],
    windowMinutes?: number,
    context?: UpcomingDeparturesContext,
  ) => UpcomingDeparture[];
  /**
   * Recompute `activeServiceIds` from the loaded calendar + exceptions for the
   * current local date (Req 4.1, 4.2). Clears the set when no data is loaded.
   */
  resolveActiveServices: () => void;
  /**
   * Recompute active services only if the local date has changed since the last
   * resolution (midnight crossing, Req 4.4). Lightweight, on-demand, no timers.
   */
  ensureActiveServicesForToday: () => void;
  clearSchedule: () => void;
  clearError: () => void;

  // Freshness
  /** True when cached data exists and is younger than the 24-hour TTL. */
  isDataFresh: (maxAgeMs?: number) => boolean;
}

export const useScheduleStore = create<ScheduleStore>()(
  persist(
    (set, get) => ({
      // Data
      scheduleData: null,
      activeServiceIds: new Set<string>(),
      lastResolvedDate: null,

      // State
      loading: false,
      error: null,
      lastUpdated: null,
      dataVersion: null,
      dataAgencyId: null,

      // Actions
      loadSchedule: async () => {
        const currentState = get();

        // Avoid duplicate requests if already loading
        if (currentState.loading) {
          return;
        }

        // The schedule layer is per-agency: fetch the payload for the agency the
        // user is currently configured for. The agency_id is the same one the
        // app uses for Tranzy (configStore / X-Agency-Id header).
        const agencyId = useConfigStore.getState().agency_id;

        // No agency selected, or no schedule is published for it: the schedule
        // layer is unavailable. Drop any payload left over from a different
        // agency and degrade to GPS-only WITHOUT surfacing an error (additive).
        if (!hasScheduleForAgency(agencyId)) {
          if (currentState.scheduleData || currentState.dataAgencyId !== null) {
            get().clearSchedule();
          }
          return;
        }

        // Use cached data without refetching when it is still fresh (Req 3.3),
        // belongs to THIS agency, AND has the current schema (route/headsign
        // maps). A cache for a different agency or an older schema is treated as
        // unusable so an agency switch or format upgrade self-heals instead of
        // waiting out the 24h TTL.
        const cached = currentState.scheduleData;
        const cacheUsable =
          !!cached &&
          currentState.dataAgencyId === agencyId &&
          currentState.isDataFresh() &&
          !!cached.tripRouteMap &&
          Object.keys(cached.tripRouteMap).length > 0 &&
          !!cached.tripHeadsignMap &&
          Object.keys(cached.tripHeadsignMap).length > 0;
        if (cacheUsable) {
          get().ensureActiveServicesForToday();
          return;
        }

        set({ loading: true, error: null });

        try {
          const response = await fetch(scheduleUrlForAgency(agencyId), { cache: 'no-cache' });

          if (!response.ok) {
            throw new Error(`Schedule fetch failed with status ${response.status}`);
          }

          const data = (await response.json()) as unknown;

          // Guard against malformed payloads - treat as a fetch failure
          if (!isCompactSchedulePayload(data)) {
            throw new Error('Malformed schedule payload');
          }

          // Expand the compact CDN payload into the queryable in-memory form.
          const expanded = expandSchedule(data);

          set({
            scheduleData: expanded,
            dataAgencyId: agencyId,
            dataVersion: data.version ?? null,
            lastUpdated: Date.now(),
            loading: false,
            error: null,
          });

          // Resolve active services for the current date on data load (Req 4.1).
          get().resolveActiveServices();
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to load schedule';
          const { scheduleData, dataAgencyId } = get();

          if (scheduleData && dataAgencyId === agencyId) {
            // Req 3.4: CDN fetch failed but cache for THIS agency exists - keep
            // using it. Reduced freshness is derivable via isDataFresh().
            console.warn(`${LOG_PREFIX} CDN fetch failed, using cached data: ${message}`);
            set({ loading: false, error: null });
          } else {
            // Req 3.5: CDN fetch failed and no usable cache - expose error,
            // disable schedule features. The app continues on GPS-only behavior.
            console.error(`${LOG_PREFIX} CDN fetch failed, no cache available: ${message}`);
            set({ loading: false, error: message, scheduleData: null, dataAgencyId: null });
          }
        }
      },

      // Query methods (task 4.2)
      //
      // All methods degrade gracefully: when `scheduleData` is null they return
      // null or an empty array rather than throwing, so consumers can fall back
      // to GPS-only behavior without try/catch (see design "Graceful degradation").

      getStopTimesForTrip: (tripId) => {
        const { scheduleData } = get();
        if (!scheduleData) return null;
        return scheduleData.stopTimes[tripId] ?? null;
      },

      getScheduledArrival: (tripId, stopId) => {
        const stopTimes = get().getStopTimesForTrip(tripId);
        if (!stopTimes) return null;
        const match = stopTimes.find((s) => s.s === stopId);
        return match ? match.a : null;
      },

      getScheduledDeparture: (tripId, stopId) => {
        const stopTimes = get().getStopTimesForTrip(tripId);
        if (!stopTimes) return null;
        const match = stopTimes.find((s) => s.s === stopId);
        return match ? match.d : null;
      },

      isTripActiveToday: (tripId) => {
        const { scheduleData } = get();
        if (!scheduleData) return false;
        // Handle date-crossing so membership reflects the current local day.
        get().ensureActiveServicesForToday();
        const serviceId = scheduleData.tripServiceMap[tripId];
        if (!serviceId) return false;
        return get().activeServiceIds.has(serviceId);
      },

      getTripStartTime: (tripId) => {
        const stopTimes = get().getStopTimesForTrip(tripId);
        if (!stopTimes || stopTimes.length === 0) return null;
        // First stop is the one with the lowest sequence (q). Don't assume the
        // array is pre-sorted — pick the minimum explicitly.
        let first = stopTimes[0];
        for (const s of stopTimes) {
          if (s.q < first.q) first = s;
        }
        return first.d;
      },

      getUpcomingDepartures: (stopId, routeIds, windowMinutes = 60, context) => {
        const { scheduleData } = get();
        if (!scheduleData) return [];

        // Ensure active-service membership reflects the current local day.
        get().ensureActiveServicesForToday();

        const currentMinutes = minutesSinceMidnight(new Date());
        const departures: UpcomingDeparture[] = [];

        const gpsVehicleTripIds = context?.gpsVehicleTripIds;
        const tripRouteMap = context?.tripRouteMap;
        // Route filtering only applies when the caller both supplies a
        // trip->route map (so a route can be derived) and a non-empty route
        // filter. Otherwise every active trip serving the stop is included.
        const filterByRoute = Boolean(tripRouteMap) && routeIds.length > 0;
        const routeFilter = filterByRoute ? new Set(routeIds) : null;

        // Iterate active trips that serve the given station within the window.
        for (const tripId of Object.keys(scheduleData.stopTimes)) {
          if (!get().isTripActiveToday(tripId)) continue;

          const stopTimes = scheduleData.stopTimes[tripId];
          const stopEntry = stopTimes.find((s) => s.s === stopId);
          if (!stopEntry) continue;

          const departureMinutes = stopEntry.d;
          if (!isTimeInWindow(departureMinutes, currentMinutes, windowMinutes)) {
            continue;
          }

          // Resolve the route from the caller-supplied map when available.
          // Without a map, the compact schedule payload cannot associate a trip
          // with a route, so routeId stays a documented placeholder (0).
          const resolvedRouteId = lookupRouteId(tripRouteMap, tripId);
          if (routeFilter && !(resolvedRouteId !== null && routeFilter.has(resolvedRouteId))) {
            continue;
          }

          departures.push({
            tripId,
            routeId: resolvedRouteId ?? 0,
            departureMinutes,
            minutesUntil: departureMinutes - currentMinutes,
            // GPS-assigned vs schedule-only indicator (Req 6.4). True when the
            // caller reports a GPS-visible vehicle on this trip; otherwise the
            // departure is schedule-only.
            hasGpsVehicle: gpsVehicleTripIds?.has(tripId) ?? false,
            // Ghost detection is wired in task 8.1; defaults to false here.
            isGhost: false,
          });
        }

        // Req 6.5: sort by scheduled departure time ascending.
        departures.sort((a, b) => a.departureMinutes - b.departureMinutes);
        return departures;
      },

      clearSchedule: () =>
        set({
          scheduleData: null,
          activeServiceIds: new Set<string>(),
          lastResolvedDate: null,
          error: null,
          lastUpdated: null,
          dataVersion: null,
          dataAgencyId: null,
        }),

      clearError: () => set({ error: null }),

      resolveActiveServices: () => {
        const { scheduleData } = get();
        const today = localDateKey(new Date());

        if (!scheduleData) {
          // No data loaded: nothing is active, but record the date so the
          // midnight check does not repeatedly attempt to resolve.
          set({ activeServiceIds: new Set<string>(), lastResolvedDate: today });
          return;
        }

        const active = resolveActiveServicesForDate(
          scheduleData.calendar,
          scheduleData.calendarExceptions,
          new Date(),
        );
        set({ activeServiceIds: active, lastResolvedDate: today });
      },

      ensureActiveServicesForToday: () => {
        const today = localDateKey(new Date());
        if (get().lastResolvedDate !== today) {
          get().resolveActiveServices();
        }
      },

      // Freshness
      isDataFresh: (maxAgeMs = SCHEDULE_TTL_MS) => {
        const { lastUpdated } = get();
        if (!lastUpdated) return false;
        return Date.now() - lastUpdated < maxAgeMs;
      },
    }),
    {
      name: 'schedule-store',
      // Persist the schedule payload to localStorage with gzip compression via
      // the shared compressed-storage adapter (issue #29). The compact payload
      // (~200-300KB gzipped) fits comfortably in localStorage, and this reuses
      // the same persistence mechanism as other large stores instead of a
      // bespoke adapter.
      storage: createJSONStorage(() => createCompressedStorage(LOG_PREFIX)),
      // Only persist the schedule payload and metadata; activeServiceIds is
      // recomputed and transient loading/error state is not persisted. The
      // payload is stored in its COMPACT form to keep the localStorage footprint
      // small (~0.1 MB vs ~7 MB expanded); `merge` re-expands it on hydration.
      partialize: (state) => ({
        schedule: state.scheduleData ? compactifySchedule(state.scheduleData) : null,
        dataVersion: state.dataVersion,
        dataAgencyId: state.dataAgencyId,
        lastUpdated: state.lastUpdated,
      }),
      merge: (persistedState, currentState) => {
        const persisted = persistedState as
          | Partial<{
              schedule: CompactSchedulePayload | null;
              dataVersion: string | null;
              dataAgencyId: number | null;
              lastUpdated: number | null;
            }>
          | undefined;
        return {
          ...currentState,
          scheduleData: persisted?.schedule ? expandSchedule(persisted.schedule) : null,
          dataVersion: persisted?.dataVersion ?? null,
          dataAgencyId: persisted?.dataAgencyId ?? null,
          lastUpdated: persisted?.lastUpdated ?? null,
        };
      },
    }
  )
);
