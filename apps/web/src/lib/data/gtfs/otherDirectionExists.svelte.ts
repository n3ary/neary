/**
 * useOtherDirectionExists — reactive probe for whether a route+direction
 * has a meaningful "other side" worth offering a swap to.
 *
 * Why a helper: both the schedule view and the map view need the same
 * gate on their "Swap direction" button, and we previously had two
 * copies of the same effect drifting apart. One file, one source of
 * truth. Callers pass getters so they can wire it to their reactive
 * routeId / direction state.
 *
 * Behaviour:
 *   - Returns a reactive `.value`: `true | false | null` (null while
 *     pending / not yet probed, e.g. before a feed is bound).
 *   - Probes via the existing `getRouteDirectionEndpoints` repo call
 *     which already returns `null` when the opposite direction has no
 *     trips — no new worker method needed.
 *   - On error, assumes the swap is OK rather than disabling a
 *     working button on transient flakes. Worst case the user taps
 *     and lands on the destination view's own empty state.
 */
import { getGtfsRepo } from './repo';
import { feedsStore } from '$lib/stores/feedsStore.svelte';

export interface OtherDirectionGate {
  /** `true` when the opposite direction has trips; `false` when it
   *  doesn't; `null` while the probe is pending. */
  readonly value: boolean | null;
}

export function useOtherDirectionExists(
  getRouteId: () => string,
  getDirection: () => 0 | 1 | null,
): OtherDirectionGate {
  let value = $state<boolean | null>(null);

  $effect(() => {
    const fid = feedsStore.boundFeedId;
    const rid = getRouteId();
    const dir = getDirection();
    if (!fid || dir == null || rid.length === 0) {
      value = null;
      return;
    }
    const otherDir = (dir === 0 ? 1 : 0) as 0 | 1;
    value = null;
    (async () => {
      try {
        const repo = getGtfsRepo();
        const ep = await repo.getRouteDirectionEndpoints(rid, otherDir);
        value = ep != null;
      } catch {
        value = true;
      }
    })();
  });

  return {
    get value() { return value; },
  };
}
