/*
 * reconciledVehiclesStore — main-thread mirror of the GTFS worker's
 * reconciliation broadcast. ONE source of truth for "current vehicles"
 * across every view (station card, map page, schedule view).
 *
 * The worker owns the whole live pipeline: it polls GTFS-RT every 15 s,
 * computes the active-trip set in SQL, runs `reconcileWithLive`, and
 * pushes a `ReconciledSnapshot` back to every subscriber. This store
 * is just the main-thread end of that subscription.
 *
 * Replaces the old `liveVehiclesStore` which polled + parsed on main
 * and forced every view to run its own `reconcileWithLive` (driving
 * the route-24B duplicate-marker bug because string-equality tripId
 * lookups in the map page didn't match the reconciler's (route, dir,
 * tripStartMin) tolerance).
 */

import * as Comlink from 'comlink';

import { getGtfsRepo } from '$lib/data/gtfs/repo';
import type { ReconciledSnapshot } from '$lib/data/gtfs/types';
import type { ReconcileStats } from '$lib/domain/reconcile';
import type { Vehicle } from '$lib/domain/types';

class ReconciledVehiclesStore {
  vehicles = $state<Vehicle[]>([]);
  lastFetchMs = $state<number | null>(null);
  stats = $state<ReconcileStats | null>(null);
  error = $state<string | null>(null);

  private subscribePromise: Promise<void> | null = null;
  private unsubFn: (() => void) | null = null;

  /** Subscribe to the worker's broadcast. Idempotent; safe to call
   *  from any place that needs reconciled data. */
  bind(): void {
    if (this.subscribePromise) return;
    this.subscribePromise = (async () => {
      const repo = getGtfsRepo();
      this.unsubFn = await repo.subscribeReconciled(
        Comlink.proxy((snap: ReconciledSnapshot) => {
          this.vehicles = snap.vehicles;
          this.lastFetchMs = snap.lastFetchMs;
          this.stats = snap.stats;
          this.error = snap.error;
        }),
      );
    })().catch((e) => {
      console.warn('[reconciledVehiclesStore] subscribe failed', e);
      this.subscribePromise = null;
    });
  }

  /** Tear down the subscription (used on app shutdown / tests). */
  unbind(): void {
    if (this.unsubFn) {
      try {
        this.unsubFn();
      } catch (e) {
        console.warn('[reconciledVehiclesStore] unsubscribe threw', e);
      }
      this.unsubFn = null;
    }
    this.subscribePromise = null;
  }

  /** Trigger an immediate worker-side poll + reconcile cycle. Used by
   *  the manual refresh button in the header. */
  refresh(): void {
    void getGtfsRepo().refreshLive();
  }
}

export const reconciledVehiclesStore = new ReconciledVehiclesStore();
