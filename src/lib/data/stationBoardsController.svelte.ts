// Shared boards-and-assembly controller for /+page.svelte (GPS-based nearby stations) and /station/[id]/+page.svelte (URL-id single station). Same "render list of assembled boards" need, different selection mechanisms. Module owns the shared half: page state for boards, worker subscription delivering per-stop GPS-adjusted vehicles, per-board $derived.by that buckets for display. Caller owns selection (calls setBoards() from its own $effect with the query result) and route-filter state (per-stop on /, single on /station).
//
// Architecture: heavy merge + GPS-ETA + per-tick scheduled-board re-query all run inside the worker. Main subscribes once via `repo.subscribeStationBoards(stopIds, cb)`; the worker pushes `Array<{ stopId, vehicles }>` every live tick AND on every stop-set change (so a fresh selection paints within a microtask instead of waiting up to one poll). No per-tick IPC request from main. Shape polylines / stop-distance arrays never cross the boundary.

import * as Comlink from 'comlink';
import { getGtfsRepo } from '$lib/data/gtfs/repo';
import type {
  StationBoardPush,
  StationBoardsSubscription,
  StopWithDistance,
} from '$lib/data/gtfs/types';
import {
  bucketLiveBoardMemo,
  routesFromVehicles,
  type BoardRow,
} from '$lib/domain/stationBoard';
import type { Route, Vehicle } from '$lib/domain/types';
import { feedsStore } from '$lib/stores/feedsStore.svelte';
import { nowTicker } from '$lib/stores/nowTicker.svelte';
import { userPrefs } from '$lib/stores/userPrefs.svelte';

export type StationBoardInput = {
  stop: StopWithDistance;
  vehicles: Vehicle[];
};

export type AssembledStationBoard = {
  stop: StopWithDistance;
  vehicles: Vehicle[];
  rows: BoardRow[];
  allRoutes: Route[];
};

export type StationBoardsController = {
  setBoards(next: StationBoardInput[] | null): void;
  readonly assembled: AssembledStationBoard[];
  readonly rawTotal: number;
  readonly filteredTotal: number;
};

export function createStationBoardsController(opts: {
  /**
   * Called per-stop during bucketing. Read reactive state inside so the
   * $derived.by traces it (e.g. `() => routeFilters[stopId] ?? null`).
   */
  routeFilterFor: (stopId: string) => string | null;
}): StationBoardsController {
  let boards = $state<StationBoardInput[] | null>(null);
  // Per-stop vehicles pushed by the worker subscription. Keyed by
  // stop.id. Pre-seeded from boards.vehicles (scheduled-only fallback)
  // so the first assembled render already has correct at-station vehicles
  // rather than relying on the GPS push arriving first and showing only
  // incoming vehicles, which would cause an incoming-first flicker in
  // StationCard groups before at-station arrives.
  let livePerStop = $state<Record<string, Vehicle[]>>(
    Object.fromEntries((boards ?? []).map((b) => [b.stop.id, b.vehicles])),
  );

  // ---- Subscription lifecycle -------------------------------------------
  // One persistent worker subscription per controller instance. We track
  // the in-flight subscribe Promise so concurrent setBoards calls during
  // the initial async registration coalesce into a single subscription,
  // and we always apply the latest stop-set after registration completes.
  let subscription: StationBoardsSubscription | null = null;
  let subscribing: Promise<StationBoardsSubscription | null> | null = null;
  let pendingIds: string[] = [];
  // Set in the teardown $effect so a subscribe that resolves AFTER the
  // controller is gone doesn't install a worker listener that pushes
  // into stale $state (which surfaces as Comlink "Unserializable return
  // value" unhandled rejections on the next worker push).
  let disposed = false;

  const onPush = (payload: StationBoardPush) => {
    // Guard: skip pushes that don't cover all current board stop IDs.
    // This handles the race where the catch-up push fires with the stop IDs
    // the subscription was registered with (oldStops) while boards has already
    // been updated to a new set (GPS returned newStops). The guard lets that
    // stale push pass through without overwriting livePerStop — the
    // subscription's setStopIds will fire shortly with the correct new IDs.
    const boardIds = new Set((boards ?? []).map((b) => b.stop.id));
    const pushIds = new Set(payload.map((p) => p.stopId));
    for (const id of boardIds) {
      if (!pushIds.has(id)) return;
    }
    const next: Record<string, Vehicle[]> = {};
    for (const { stopId, vehicles } of payload) next[stopId] = vehicles;
    livePerStop = next;
  };

  function applyIds(ids: string[]): void {
    pendingIds = ids;
    if (subscription) {
      subscription.setStopIds(ids);
      return;
    }
    if (subscribing) return; // in-flight; will pick up pendingIds when it resolves
    subscribing = (async () => {
      try {
        const repo = getGtfsRepo();
        const sub = await repo.subscribeStationBoards(pendingIds, Comlink.proxy(onPush));
        if (disposed) {
          sub.unsubscribe();
          return null;
        }
        subscription = sub;
        // pendingIds may have changed during the await — push the latest
        // set if it diverged from what we registered with.
        if (pendingIds !== ids) sub.setStopIds(pendingIds);
        return sub;
      } catch (err) {
        console.warn('[stationBoardsController] subscribe failed', err);
        return null;
      } finally {
        subscribing = null;
      }
    })();
  }

  $effect(() => {
    const ids = boards?.map((b) => b.stop.id) ?? [];
    if (ids.length === 0) {
      pendingIds = [];
      if (subscription) {
        subscription.setStopIds([]);
        // Keep the subscription alive across "empty" intervals so the
        // next setBoards doesn't pay re-registration cost; the worker
        // treats an empty stop set as a no-op push.
      }
      // Do NOT reset livePerStop to {} here — the fallback in assembled
      // (livePerStop[stop.id] ?? vehicles) handles the no-IDs case. Keeping
      // the last known live data avoids a flicker when switching back to
      // the same stops (e.g. quick map → home → map nav).
      return;
    }
    applyIds(ids);
  });

  // Tear down the subscription when the consuming component unmounts.
  $effect(() => () => {
    disposed = true;
    subscription?.unsubscribe();
    subscription = null;
  });

  // ---- Derived render state ---------------------------------------------
  const feedTimezone = $derived(feedsStore.activeTimezone);
  const nowMs = $derived(nowTicker.ms);

  const assembled = $derived.by<AssembledStationBoard[]>(() => {
    if (!boards) return [];
    return boards.map(({ stop, vehicles }) => {
      // Until the first worker push lands for this stop, fall back
      // to scheduled-only vehicles so the card paints something.
      const live = livePerStop[stop.id] ?? vehicles;
      return {
        stop,
        vehicles,
        rows: bucketLiveBoardMemo({
          vehicles: live,
          stop,
          prefs: userPrefs,
          nowMs,
          timezone: feedTimezone,
          routeFilterId: opts.routeFilterFor(stop.id),
        }),
        allRoutes: routesFromVehicles(vehicles),
      };
    });
  });
  const rawTotal = $derived(assembled.reduce((n, b) => n + b.vehicles.length, 0));
  const filteredTotal = $derived(assembled.reduce((n, b) => n + b.rows.length, 0));

  return {
    setBoards(next) { boards = next; },
    get assembled() { return assembled; },
    get rawTotal() { return rawTotal; },
    get filteredTotal() { return filteredTotal; },
  };
}
