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
 *   gtfs/sqlHelpers.ts     — selectAll
 *   @n3ary/gtfs-spec/spec  — DAY_KEY_COLS (GTFS calendar day-of-week columns)
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

import { bootstrap, closeCurrent, deleteFeedCache, getCachedFeedIds } from './gtfs/bootstrap';
import {
  ensureLiveTimer,
  subscribeReconciled,
  tickLive,
} from './gtfs/livePipeline';
import { subscribeStationBoards } from './gtfs/stationSubscribers';
import { ensureDb, state } from './gtfs/state';

import { getRouteDirectionEndpoints } from './gtfs/queries/routeEndpoints';
import { getRouteMapView } from './gtfs/queries/routeMapView';
import { getActiveRouteIdsInWindow, getRouteSchedule } from './gtfs/queries/routeSchedule';
import { getStopsAlongRouteDir, getStopsAlongTrip } from './gtfs/queries/routeStops';
import { getShapeForRouteDir } from './gtfs/queries/shapes';
import { getRouteById, getRoutes, getRoutesForStop, getRoutesForStops, getStopsForRoute, getStopsForRoutes } from './gtfs/queries/routes';
import { getNetworks } from './gtfs/queries/networks';
import { getTags } from './gtfs/queries/routeTags';
import { getFeedConfig } from './gtfs/queries/feedConfig';
import { getStationBoard, getStationBoardsNear } from './gtfs/queries/stationBoards';
import { getDeparturesFromStop, getOriginRoutesAtStop, getStopsByIds, getStopsNear, searchStops } from './gtfs/queries/stops';
import { getWeeklySchedule } from './gtfs/queries/weeklySchedule';
import { getRoutesThroughStations as getRoutesThroughStationsImpl, getStationsPage as getStationsPageImpl } from './gtfs/queries/favoritesQueries';

const api: GtfsRepo = {
  async setFeed(
    feed: Feed,
    onProgress?: (bytesReceived: number, totalBytes: number | null) => void,
  ): Promise<void> {
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
    // The static pipeline rewrites realtime.vehicle_positions to the
    // canonical gtfs-rt.n3ary.com proxy URL whenever the feed has a
    // per-feed config -- so the app can call it directly with no
    // same-origin proxy. null when the feed has no realtime (e.g.
    // Tursib today).
    state.currentFeedRtUrl = feed.realtime?.vehicle_positions ?? null;
    state.bootstrapping = bootstrap(feed, onProgress);
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
    // Cache feed-level dwell_sec so assembleLiveBoards doesn't have to
    // re-query _neary_config on every tick.
    state.currentDwellSec = getFeedConfig(state.currentDb).timing?.dwell_sec ?? 20;
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
  async getRouteTags() {
    return getTags(await ensureDb());
  },
  async getFeedConfig() {
    return getFeedConfig(await ensureDb());
  },
  async getRouteById(routeId) {
    return getRouteById(await ensureDb(), routeId);
  },
  async getRoutesForStop(stopId: string) {
    return getRoutesForStop(await ensureDb(), stopId);
  },
  async getRoutesForStops(stopIds: readonly string[]) {
    return getRoutesForStops(await ensureDb(), stopIds);
  },
  async getStopsForRoute(routeId: string) {
    return getStopsForRoute(await ensureDb(), routeId);
  },
  async getStopsForRoutes(routeIds: readonly string[]) {
    return getStopsForRoutes(await ensureDb(), routeIds);
  },

  // ── Stops ───────────────────────────────────────────────────────────
  async getStopsNear(lat, lon, radiusMeters, limit) {
    return getStopsNear(await ensureDb(), lat, lon, radiusMeters, limit);
  },  async searchStops(text, anchorLat, anchorLon, limit, sort) {
    return searchStops(await ensureDb(), text, anchorLat, anchorLon, limit, sort);
  },  async getDeparturesFromStop(stopId, localDate, localMinutesSinceMidnight, windowMinutes) {
    return getDeparturesFromStop(
      await ensureDb(),
      stopId,
      localDate,
      localMinutesSinceMidnight,
      windowMinutes,
    );
  },
  async getOriginRoutesAtStop(stopId: string) {
    return getOriginRoutesAtStop(await ensureDb(), stopId);
  },
  async getStopsByIds(stopIds: readonly string[]) {
    return getStopsByIds(await ensureDb(), stopIds);
  },
  async getRoutesThroughStations(filter) {
    return getRoutesThroughStationsImpl(await ensureDb(), {
      modes: filter.modes,
      networks: filter.networks,
      tags: filter.tags,
    });
  },
  async getStationsPage(query) {
    return getStationsPageImpl(await ensureDb(), {
      offset: query.offset,
      limit: query.limit,
      sortBy: query.sortBy,
      anchor: query.anchor,
      scope: query.scope ? new Set(query.scope) : undefined,
    });
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
  async getActiveRouteIdsInWindow(localDate, nowMin, windowMinutes) {
    return getActiveRouteIdsInWindow(
      await ensureDb(),
      localDate,
      nowMin,
      windowMinutes,
    );
  },
  async getStopsAlongTrip(tripId) {
    return getStopsAlongTrip(await ensureDb(), tripId);
  },
  async getStopsAlongRouteDir(routeId, directionId) {
    return getStopsAlongRouteDir(await ensureDb(), routeId, directionId);
  },
  async getShapeForRouteDir(routeId, directionId) {
    return getShapeForRouteDir(await ensureDb(), routeId, directionId);
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


  // ── Cache introspection / deletion ──────────────────────────────────
  //
  // Backs the Settings feed-picker trash button. Pairs with
  // opfsFileFor + pruneStaleFeedFiles in bootstrap so the worker
  // owns the only legitimate path into OPFS (page module can't
  // import sqlite3InitModule directly without duplicating bootstrap's
  // pool init, so going through the Comlink proxy keeps ownership
  // clear).
  async listCachedFeeds(feeds: readonly Feed[]) {
    return getCachedFeedIds(feeds);
  },
  async deleteFeedCache(feed: Feed) {
    return deleteFeedCache(feed);
  },
};

Comlink.expose(api);
