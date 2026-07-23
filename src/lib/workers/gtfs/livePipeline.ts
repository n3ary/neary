/*
 * Live-reconciliation pipeline — owned entirely by the worker.
 *
 * Every `livePollMs` (15 s today) the worker:
 *   1. Fetches GTFS-RT vehicle positions from the URL stored on
 *      `state.currentFeedRtUrl` (the canonical gtfs-rt.n3ary.com
 *      proxy URL from feeds.json; CORS `*` so direct browser calls
 *      work).
 *   2. Queries `getActiveTrips` against the open feed DB.
 *   3. Runs `reconcileWithLive` to produce a global Vehicle[] mix of
 *      `kind: 'scheduled' | 'tracked' | 'verified' | 'gps-only'`.
 *   4. Broadcasts the snapshot to every subscriber on main.
 *
 * Subscribers are kept across feed switches (they belong to the
 * main-side reconciledVehiclesStore which survives feed swaps);
 * the snapshot is reset on each switch so the new feed's first
 * tick replaces it.
 */

import * as Comlink from 'comlink';

import type { ReconciledSnapshot } from '$lib/data/gtfs/types';
import { fetchVehiclePositions, RtUnavailableError } from '$lib/data/live/gtfsRtClient';
import { DEFAULT_CONFIG } from '$lib/domain/config';
import { enrichObservations } from '$lib/domain/enrichObservations';
import { reconcileWithLive } from '$lib/domain/reconcile';
import { measurePolyline, type MeasuredPolyline } from '@n3ary/gtfs-spec/shape';
import type { Vehicle } from '$lib/domain/types';

import { getActiveTrips } from './queries/activeTrips';
import { getShapesForTrips } from './queries/shapes';
import { pushAllStationSubscribers } from './stationSubscribers';
import { ensureDb, state } from './state';

// ------------------------------------------------------------------------
// Tuning constants.
//
// LOOKBACK_MIN  — how far back to include trips that started in the past
//                 and may still be running. 120 min comfortably covers
//                 typical end-to-end runtimes plus operator delay.
// LOOKAHEAD_MIN — how far forward to include trips parked at origin
//                 that haven't departed yet. 30 min catches the next
//                 service window without growing the cohort excessively.
// ------------------------------------------------------------------------

const LIVE_RECONCILE_LOOKBACK_MIN = 120;
const LIVE_RECONCILE_LOOKAHEAD_MIN = 30;

type ReconciledListener = (snap: ReconciledSnapshot) => void;

let livePollTimerId: ReturnType<typeof setInterval> | null = null;
let liveInFlight = false;
let lastSnapshot: ReconciledSnapshot | null = null;
const liveListeners = new Set<ReconciledListener>();
/** Feeds for which the RT proxy has returned 404 / non-protobuf in
 *  this session. Marked so we don't spin up 404s every 15 s and so
 *  the UI doesn't flash a persistent error for feeds that legitimately
 *  don't have a working live-data endpoint. Cleared on feed close. */
const rtUnavailableFeeds = new Set<string>();

export function stopLiveTimer(): void {
  if (livePollTimerId !== null) {
    clearInterval(livePollTimerId);
    livePollTimerId = null;
  }
}

export function ensureLiveTimer(): void {
  if (livePollTimerId !== null || typeof setInterval === 'undefined') return;
  livePollTimerId = setInterval(() => void tickLive(), DEFAULT_CONFIG.livePollMs);
  // Fire eagerly on first start so `lastSnapshot` is populated before any
  // late-subscriber catch-up fires. Without this, the catch-up in
  // `subscribeStationBoards` sees `lastSnapshot = null` (no live data yet)
  // and sends only scheduled vehicles — causing a flicker in StationCard
  // groups as only-incoming vehicles arrive before the merged push.
  void tickLive();
}

/** Drop the cached snapshot — used on feed switch so the new feed's
 *  first tick replaces the previous feed's data. Listeners stay
 *  registered. Also forgets the "RT unavailable" marker on the
 *  previous feed so re-selecting it retries once. */
export function resetLiveSnapshot(): void {
  lastSnapshot = null;
  rtUnavailableFeeds.clear();
}

function broadcast(snap: ReconciledSnapshot): void {
  for (const cb of liveListeners) {
    try {
      // Each listener is a Comlink-proxied main-thread function, so
      // invoking it returns a Promise we don't await — fire-and-forget.
      void cb(snap);
    } catch (e) {
      console.warn('[gtfs.worker] reconciled listener threw', e);
    }
  }
}

/** Run one fetch + reconcile cycle and broadcast the result.
 *  Idempotent under overlap (`liveInFlight` guard) and against feed
 *  swap mid-fetch (`feedId !== currentFeedId` guard). */
export async function tickLive(): Promise<void> {
  const feedId = state.currentFeedId;
  const rtUrl = state.currentFeedRtUrl;
  if (!feedId || !state.currentDb) return;
  // No realtime configured for this feed -- nothing to poll. Skip
  // silently; the UI already shows schedule-only data when there's
  // no live update.
  if (!rtUrl) return;
  if (rtUnavailableFeeds.has(feedId)) return;
  if (liveInFlight) return;
  liveInFlight = true;
  try {
    const snap = await fetchVehiclePositions(feedId, rtUrl);
    if (feedId !== state.currentFeedId) return;
    const nowMs = Date.now();
    const tz = state.currentFeedTz ?? 'UTC';
    const db = await ensureDb();
    const active = getActiveTrips(
      db,
      tz,
      nowMs,
      LIVE_RECONCILE_LOOKBACK_MIN,
      LIVE_RECONCILE_LOOKAHEAD_MIN,
      state.currentFeedHasFrequencies,
    );
    // Enrich observations with authoritative static-feed direction +
    // start_time via a SQL-backed lookup against `active`. Observations
    // whose tripId isn't in the active set flow through unchanged; the
    // reconciler treats them as orphans. See domain/enrichObservations.ts
    // for the full layering.
    const observations = enrichObservations(snap.vehicles, active);
    const shapesByCohort = buildShapesByCohort(db, active);
    const { vehicles, stats } = reconcileWithLive(active, observations, {
      nowMs,
      timezone: tz,
      shapesByCohort,
    });
    const payload: ReconciledSnapshot = {
      vehicles,
      feedTimestampMs: snap.feedTimestampMs,
      lastFetchMs: nowMs,
      stats,
      error: null,
    };
    lastSnapshot = payload;
    broadcast(payload);
    // Push the assembled per-stop boards to every station subscriber
    // in the same tick — keeps station UI in lockstep with map UI.
    pushAllStationSubscribers(payload);
  } catch (e) {
    // RtUnavailableError = the feed's gtfs-rt proxy has no snapshot
    // yet (404 from the new server, or a non-protobuf response
    // from a misconfigured proxy). Suppress from the UI, mark the
    // feed as no-RT for this session so we don't keep hammering
    // the same endpoint every 15 s, and broadcast a clean snapshot
    // so any "Live feed error" toast disappears.
    if (e instanceof RtUnavailableError) {
      rtUnavailableFeeds.add(feedId);
      console.info(`[gtfs.worker] ${feedId}: ${e.message} — schedule-only from now on`);
      const payload: ReconciledSnapshot = {
        vehicles: lastSnapshot?.vehicles ?? [],
        feedTimestampMs: null,
        lastFetchMs: Date.now(),
        stats: lastSnapshot?.stats ?? null,
        error: null,
      };
      lastSnapshot = payload;
      broadcast(payload);
      return;
    }
    const msg = e instanceof Error ? e.message : String(e);
    // Keep the previous vehicles + status so the UI stays usable; just
    // surface the error so the StatusBar can show "Refresh failed".
    const payload: ReconciledSnapshot = {
      vehicles: lastSnapshot?.vehicles ?? [],
      feedTimestampMs: lastSnapshot?.feedTimestampMs ?? null,
      lastFetchMs: lastSnapshot?.lastFetchMs ?? null,
      stats: lastSnapshot?.stats ?? null,
      error: msg,
    };
    lastSnapshot = payload;
    broadcast(payload);
  } finally {
    liveInFlight = false;
  }
}

/** Subscribe a main-thread callback to the broadcast. Late subscribers
 *  receive the last good snapshot immediately so the new view doesn't
 *  wait up to one poll interval to see vehicles. */
export async function subscribeReconciled(
  cb: ReconciledListener,
): Promise<() => void> {
  liveListeners.add(cb);
  if (lastSnapshot) {
    try { void cb(lastSnapshot); } catch (e) {
      console.warn('[gtfs.worker] late-subscribe broadcast threw', e);
    }
  }
  return Comlink.proxy(() => {
    liveListeners.delete(cb);
  });
}

/** Latest broadcast payload, or null before the first successful poll. */
export function getReconciledSnapshot(): ReconciledSnapshot | null {
  return lastSnapshot;
}

/** Build one representative `MeasuredPolyline` per `(routeId, dir)` cohort
 *  for the active set, used by the reconciler's route-order pairing.
 *
 *  Picks the first tripId per cohort, looks up its shape via
 *  `getShapesForTrips` (worker shape cache hits keep this cheap on
 *  steady-state polls), and measures it. Cohorts with no usable shape
 *  are absent from the result map; the reconciler falls back to
 *  greedy-by-timing for those.
 *
 *  Caching: `MeasuredPolyline` could be cached per `shape_id` too, but
 *  the per-poll cost of `measurePolyline` (one Haversine per vertex) is
 *  sub-millisecond on the largest polylines we've measured. Skip the
 *  optimisation until measurement says otherwise. */
function buildShapesByCohort(
  db: Awaited<ReturnType<typeof ensureDb>>,
  active: readonly Vehicle[],
): Map<string, MeasuredPolyline> {
  const cohortToTripId = new Map<string, string>();
  for (const v of active) {
    if (v.directionId !== 0 && v.directionId !== 1) continue;
    if (!v.tripId) continue;
    const key = `${v.route.id}|${v.directionId}`;
    if (!cohortToTripId.has(key)) cohortToTripId.set(key, v.tripId);
  }
  if (cohortToTripId.size === 0) return new Map();
  const tripShapes = getShapesForTrips(db, Array.from(cohortToTripId.values()));
  const out = new Map<string, MeasuredPolyline>();
  for (const [key, tripId] of cohortToTripId) {
    const poly = tripShapes[tripId];
    if (!poly || poly.length < 2) continue;
    out.set(key, measurePolyline(poly));
  }
  return out;
}
