// Main-thread mirror of the GTFS worker's reconciliation broadcast — one source of truth for "current vehicles" across station card, map page, schedule view. The worker owns the whole live pipeline; this is just the main-thread subscription end.

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

  /** Idempotent — safe to call from multiple effects. */
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

  /** Trigger an immediate worker-side poll + reconcile cycle. Used by the header's manual refresh. */
  refresh(): void {
    void getGtfsRepo().refreshLive();
  }
}

export const reconciledVehiclesStore = new ReconciledVehiclesStore();
