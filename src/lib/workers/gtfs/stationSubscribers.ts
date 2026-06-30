/*
 * Per-stop station-board subscribers — push-based replacement for the
 * pull `assembleLiveBoards(boards, nowMs)` IPC method.
 *
 * Main subscribes a callback with a set of stop_ids; the worker pushes
 * `Array<{ stopId, vehicles }>` to that callback on every successful
 * `tickLive` and on `setStopIds` (so a fresh subscriber or a stop-set
 * change sees data within a microtask instead of waiting up to one
 * poll interval).
 *
 * Vehicles in the payload are already merged + GPS-ETA-adjusted via
 * `assembleLiveBoards` (the helper, not the deleted IPC method). Main
 * thread does no shape / stop-distance fetching at all.
 *
 * The global `subscribeReconciled` broadcast stays — the map view
 * filters that for its markers and doesn't need per-stop assembly.
 * See GitHub issue #122 for the design rationale.
 */

import * as Comlink from 'comlink';

import type { ReconciledSnapshot, StationBoardPush } from '$lib/data/gtfs/types';
import { DEFAULT_CONFIG } from '$lib/domain/config';
import type { Vehicle } from '$lib/domain/types';

import { assembleLiveBoards } from './queries/assembleLiveBoards';
import { getStationBoard } from './queries/stationBoards';
import { getReconciledSnapshot } from './livePipeline';
import { ensureDb, state } from './state';

type StationListener = (payload: StationBoardPush) => void;

type StationSub = {
  stopIds: Set<number>;
  cb: StationListener;
};

const subscribers = new Map<symbol, StationSub>();

export async function subscribeStationBoards(
  initialStopIds: readonly number[],
  cb: StationListener,
): Promise<{ unsubscribe: () => void; setStopIds: (next: readonly number[]) => void }> {
  const key = Symbol();
  const sub: StationSub = { stopIds: new Set(initialStopIds), cb };
  subscribers.set(key, sub);
  // Late-subscriber catch-up: push immediately with whatever snapshot
  // we have. Without this the page would wait up to one poll interval
  // (15 s) for its first live data.
  void pushOne(sub, getReconciledSnapshot());
  // Proxy the whole handle so Comlink keeps it as a remote reference.
  // Per-method Comlink.proxy() doesn't help here — Comlink only checks
  // the proxy marker at the TOP of the returned value, so a plain
  // object containing proxied functions trips structuredClone with
  // "Unserializable return value".
  return Comlink.proxy({
    unsubscribe: () => {
      subscribers.delete(key);
    },
    setStopIds: (next: readonly number[]) => {
      sub.stopIds = new Set(next);
      // Push right away so a stop-set change (user moved, refresh
      // changed selection, navigation) is reflected without waiting
      // for the next tick.
      void pushOne(sub, getReconciledSnapshot());
    },
  });
}

/** Called from `tickLive` after a successful reconcile + broadcast.
 *  Pushes the current snapshot to every station subscriber. */
export function pushAllStationSubscribers(snap: ReconciledSnapshot | null): void {
  for (const sub of subscribers.values()) {
    void pushOne(sub, snap);
  }
}

async function pushOne(sub: StationSub, snap: ReconciledSnapshot | null): Promise<void> {
  if (sub.stopIds.size === 0) {
    try { void sub.cb([]); } catch { /* swallow */ }
    return;
  }
  if (!state.currentDb || !state.currentFeedId) return;
  try {
    const db = await ensureDb();
    const tz = state.currentFeedTz ?? 'UTC';
    // Anchor to snapshot freshness when available so merge's nowMin
    // matches what the reconciler used; fall back to Date.now() on
    // the very first push before any tick has completed.
    const nowMs = snap?.lastFetchMs ?? Date.now();
    // Resolve scheduled boards for the current stop set. Re-querying
    // per tick keeps the worker as the source of truth for scheduled
    // data; the queries are indexed and cheap (~ms for ~10 stops).
    const scheduled: Array<{
      stopId: number;
      stop: { lat?: number; lon?: number };
      vehicles: Vehicle[];
    }> = [];
    for (const stopId of sub.stopIds) {
      const board = getStationBoard(db, tz, stopId, nowMs, DEFAULT_CONFIG.arrivalsWindowMin);
      if (!board) continue;
      scheduled.push({
        stopId: board.stop.id,
        stop: { lat: board.stop.lat, lon: board.stop.lon },
        vehicles: board.vehicles,
      });
    }
    const assembled = assembleLiveBoards(db, tz, snap, scheduled, nowMs, state.currentDwellSec);
    void sub.cb(assembled);
  } catch (e) {
    console.warn('[gtfs.worker] station push failed', e);
  }
}
