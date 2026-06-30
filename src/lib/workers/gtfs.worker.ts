/*
 * GTFS Worker — Comlink entry point.
 *
 * This file is the worker's public API surface, nothing else: it
 * imports the lifecycle + query implementations and wires them into
 * the `GtfsRepo` shape main consumes via Comlink.
 *
 * Where everything actually lives:
 *
 *   gtfs/state.ts          — currentFeedId/Tz/Db + ensureDb()
 *   gtfs/bootstrap.ts      — OPFS pool, per-feed bootstrap, closeCurrent
 *   gtfs/livePipeline.ts   — live poll + reconcile + broadcast
 *   gtfs/sqlHelpers.ts     — selectAll, dayKeyCols
 *   gtfs/shapeCache.ts     — shape polyline cache (singleton)
 *   gtfs/activeServices.ts — service_id calendar resolution
 *   gtfs/queries/*.ts      — one file per query (or small cluster)
 *
 * On feed change `setFeed` orchestrates the four lifecycle steps:
 * close current → bootstrap new → mark state → start live timer.
 */

import * as Comlink from 'comlink';

import type { Feed } from '$lib/data/feeds';
import type { GtfsRepo } from '$lib/data/gtfs/types';

import { bootstrap, closeCurrent } from './gtfs/bootstrap';
import {
  ensureLiveTimer,
  subscribeReconciled,
  tickLive,
} from './gtfs/livePipeline';
import { subscribeStationBoards } from './gtfs/stationSubscribers';
import { ensureDb, state } from './gtfs/state';

import { getRouteDirectionEndpoints } from './gtfs/queries/routeEndpoints';
import { getRouteMapView } from './gtfs/queries/routeMapView';
import { getRouteSchedule } from './gtfs/queries/routeSchedule';
import { getStopsAlongTrip } from './gtfs/queries/routeStops';
import { getRouteById, getRoutes, getRoutesForStop } from './gtfs/queries/routes';
import { getNetworks } from './gtfs/queries/networks';
import { getStationBoard, getStationBoardsNear } from './gtfs/queries/stationBoards';
import { getDeparturesFromStop, getOriginRoutesAtStop, getStopsNear } from './gtfs/queries/stops';
import { getWeeklySchedule } from './gtfs/queries/weeklySchedule';

const api: GtfsRepo = {
  async setFeed(feed: Feed): Promise<void> {
    // Already bound to this exact feed build — nothing to do. We key on
    // (id, hash) rather than id alone so a fresher publish of the same
    // feed (new hash → new OPFS file via opfsFileFor()) re-bootstraps
    // instead of silently reusing the stale blob.
    if (
      state.currentFeedId === feed.id &&
      state.currentFeedHash === feed.hash &&
      state.currentDb
    ) return;
    if (
      state.currentFeedId === feed.id &&
      state.currentFeedHash === feed.hash &&
      state.bootstrapping
    ) {
      await state.bootstrapping;
      return;
    }
    closeCurrent();
    state.currentFeedId = feed.id;
    state.currentFeedHash = feed.hash ?? null;
    state.currentFeedTz = feed.timezone || 'UTC';
    state.bootstrapping = bootstrap(feed);
    try {
      state.currentDb = await state.bootstrapping;
    } catch (e) {
      // Failure leaves us without a current db so subsequent calls fail
      // loudly. Reset the feed tracker so a later setFeed(sameFeed) can
      // retry.
      state.currentFeedId = null;
      state.currentFeedHash = null;
      throw e;
    } finally {
      state.bootstrapping = null;
    }
    // DB is open — start the live pipeline. One immediate poll + a
    // 15 s interval. Subscribers (if any are registered from a prior
    // feed) start receiving the new feed's vehicles on the very next
    // tick.
    ensureLiveTimer();
    void tickLive();
  },


  // ── Routes ──────────────────────────────────────────────────────────
  async getRoutes() {
    return getRoutes(await ensureDb());
  },
  async getNetworks() {
    return getNetworks(await ensureDb());
  },
  async getRouteById(routeId) {
    return getRouteById(await ensureDb(), routeId);
  },
  async getRoutesForStop(stopId: number) {
    return getRoutesForStop(await ensureDb(), stopId);
  },

  // ── Stops ───────────────────────────────────────────────────────────
  async getStopsNear(lat, lon, radiusMeters, limit) {
    return getStopsNear(await ensureDb(), lat, lon, radiusMeters, limit);
  },
  async getDeparturesFromStop(stopId, localDate, localMinutesSinceMidnight, windowMinutes) {
    return getDeparturesFromStop(
      await ensureDb(),
      stopId,
      localDate,
      localMinutesSinceMidnight,
      windowMinutes,
    );
  },
  async getOriginRoutesAtStop(stopId: number) {
    return getOriginRoutesAtStop(await ensureDb(), stopId);
  },

  // ── Station boards ──────────────────────────────────────────────────

  async getStationBoard(stopId, nowMs, windowMinutes) {
    return getStationBoard(
      await ensureDb(),
      state.currentFeedTz ?? 'UTC',
      stopId,
      nowMs,
      windowMinutes,
    );
  },
  async getStationBoardsNear(lat, lon, radiusMeters, maxStations, nowMs, windowMinutes) {
    return getStationBoardsNear(
      await ensureDb(),
      state.currentFeedTz ?? 'UTC',
      lat,
      lon,
      radiusMeters,
      maxStations,
      nowMs,
      windowMinutes,
    );
  },

  // ── Per-route views ─────────────────────────────────────────────────
  async getRouteSchedule(routeId, directionId, localDate, fromMin, windowMinutes) {
    return getRouteSchedule(
      await ensureDb(),
      routeId,
      directionId,
      localDate,
      fromMin,
      windowMinutes,
    );
  },
  async getStopsAlongTrip(tripId) {
    return getStopsAlongTrip(await ensureDb(), tripId);
  },
  async getWeeklySchedule(routeId, directionId) {
    return getWeeklySchedule(await ensureDb(), routeId, directionId);
  },
  async getRouteDirectionEndpoints(routeId, directionId) {
    return getRouteDirectionEndpoints(await ensureDb(), routeId, directionId);
  },
  async getRouteMapView(routeId, directionId, localDate, localMin, lookbackMin, lookaheadMin) {
    return getRouteMapView(
      await ensureDb(),
      routeId,
      directionId,
      localDate,
      localMin,
      lookbackMin,
      lookaheadMin,
    );
  },


  // ── Live pipeline ──────────────────────────────────────────────────────────────
  async subscribeReconciled(cb) {
    return subscribeReconciled(cb);
  },
  async refreshLive() {
    await tickLive();
  },
  async subscribeStationBoards(initialStopIds, cb) {
    return subscribeStationBoards(initialStopIds, cb);
  },
};

Comlink.expose(api);
