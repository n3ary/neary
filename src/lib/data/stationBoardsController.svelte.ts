// Shared boards-and-assembly controller for /+page.svelte (GPS-based
// nearby stations) and /station/[id]/+page.svelte (URL-id single
// station). The two pages have identical "render a list of assembled
// station boards" needs but different selection mechanisms — this
// module owns the shared half: page state for boards, the worker
// subscription that delivers per-stop GPS-adjusted vehicles, and the
// per-board $derived.by that buckets the result for display.
//
// The caller (page) owns selection — it calls setBoards() from its own
// $effect with whatever boards came back from its query. The caller
// also owns route-filter state (since /'s is per-stop and /station's
// is single) and passes a getter via routeFilterFor.
//
// Architecture (post issue #122): heavy merge + GPS-ETA + per-tick
// scheduled-board re-query all run inside the worker. Main subscribes
// once via `repo.subscribeStationBoards(stopIds, cb)`; the worker
// pushes `Array<{ stopId, vehicles }>` every live tick AND on every
// stop-set change (so a fresh selection paints within a microtask
// instead of waiting up to one poll). No per-tick IPC request from
// main. Shape polylines / stop-distance arrays never cross the
// boundary.

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
  routeFilterFor: (stopId: number) => string | null;
}): StationBoardsController {
  let boards = $state<StationBoardInput[] | null>(null);
  // Per-stop vehicles pushed by the worker subscription. Keyed by
  // stop.id. Empty record before the first push lands.
  let livePerStop = $state<Record<number, Vehicle[]>>({});

  // ---- Subscription lifecycle -------------------------------------------
  // One persistent worker subscription per controller instance. We track
  // the in-flight subscribe Promise so concurrent setBoards calls during
  // the initial async registration coalesce into a single subscription,
  // and we always apply the latest stop-set after registration completes.
  let subscription: StationBoardsSubscription | null = null;
  let subscribing: Promise<StationBoardsSubscription | null> | null = null;
  let pendingIds: number[] = [];
  // Set in the teardown $effect so a subscribe that resolves AFTER the
  // controller is gone doesn't install a worker listener that pushes
  // into stale $state (which surfaces as Comlink "Unserializable return
  // value" unhandled rejections on the next worker push).
  let disposed = false;

  const onPush = (payload: StationBoardPush) => {
    const next: Record<number, Vehicle[]> = {};
    for (const { stopId, vehicles } of payload) next[stopId] = vehicles;
    livePerStop = next;
  };

  function applyIds(ids: number[]): void {
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
      livePerStop = {};
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
