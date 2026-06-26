/*
 * liveVehiclesStore — singleton service that polls GTFS-RT
 * VehiclePositions for the currently-bound feed and exposes the latest
 * observations reactively.
 *
 * Lifecycle:
 *   - `bind(feedId)` is called by +layout once `feedsStore.boundFeedId`
 *     resolves. Switching feeds is idempotent — the existing poll
 *     interval is reused with the new id.
 *   - `unbind()` stops the timer; observations stay reactively visible
 *     until cleared.
 *
 * Stays on the main thread for now — protobuf decode of Cluj's ~15 KB
 * is single-digit ms. Promote to a worker if measured perf demands it.
 *
 * Exposed reactively:
 *   - `observations`   - the latest LiveVehicleObservation[]
 *   - `feedTimestampMs`- the upstream feed's timestamp (NOT the fetch time)
 *   - `lastFetchMs`    - main-thread fetch completion time
 *   - `error`          - last error message (cleared on next success)
 */

import { DEFAULT_CONFIG } from '$lib/domain/config';
import {
  fetchVehiclePositions,
  type LiveVehicleObservation,
} from '$lib/data/live/gtfsRtClient';

class LiveVehiclesStore {
  observations = $state<LiveVehicleObservation[]>([]);
  feedTimestampMs = $state<number | null>(null);
  lastFetchMs = $state<number | null>(null);
  error = $state<string | null>(null);

  private currentFeedId: string | null = null;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  /** Bind to (or rebind across) a feed. Idempotent for the same id. */
  bind(feedId: string): void {
    if (this.currentFeedId === feedId) {
      // Already polling this feed — ensure the timer is alive.
      this.ensureTimer();
      return;
    }
    this.currentFeedId = feedId;
    this.observations = [];
    this.feedTimestampMs = null;
    this.lastFetchMs = null;
    this.error = null;
    this.ensureTimer();
    // Fire one immediately so the user sees data within ~1 s, not 15.
    void this.poll();
  }

  /** Stop polling. Existing observations stay visible until cleared. */
  unbind(): void {
    this.currentFeedId = null;
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  /** Force an immediate refetch from outside (e.g. refresh button). */
  refresh(): void {
    void this.poll();
  }

  private ensureTimer(): void {
    if (this.timerId !== null || typeof setInterval === 'undefined') return;
    this.timerId = setInterval(() => void this.poll(), DEFAULT_CONFIG.livePollMs);
  }

  private async poll(): Promise<void> {
    if (this.inFlight) return; // skip overlapping fetches
    const feedId = this.currentFeedId;
    if (!feedId) return;
    this.inFlight = true;
    try {
      const snap = await fetchVehiclePositions(feedId);
      // Guard against feed switch mid-flight.
      if (feedId !== this.currentFeedId) return;
      this.observations = snap.vehicles;
      this.feedTimestampMs = snap.feedTimestampMs;
      this.lastFetchMs = Date.now();
      this.error = null;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.inFlight = false;
    }
  }
}

export const liveVehiclesStore = new LiveVehiclesStore();
