// View-only state shared by Stations (/) + Station-detail (/station/[id]). Lives at module scope so it survives SvelteKit page remounts (route badge -> schedule -> back returns to same expansion/filter).

import { DEFAULT_CONFIG } from '../domain/config';
import { hasMovedSignificantly } from '../domain/moveDistance';
import type { LatLon } from '@n3ary/gtfs-spec/shape';
import type { StationBoardInput } from '../data/stationBoardsController.svelte';

class StationsViewStore {
  /** Stop id the user explicitly expanded on /. Null = no manual expansion (selector's auto-pick is honored). */
  expandedStopId = $state<string | null>(null);

  /** Flips to true on the first toggle. While true, the page stops falling back to the selector's auto-pick. Cleared with `expandedStopId`. */
  userHasExpandedChoice = $state(false);

  /** Per-stop route filter. Reading `null` = no filter for that stop. */
  routeFilterByStop = $state<Record<string, string | null>>({});

  /** Last lat/lon applied to the / nearby query. Drives the GPS hysteresis that prevents jitter from re-fetching. Threshold from `NearyConfig.significantMoveM`. */
  lastQueryPosition = $state<LatLon | null>(null);

  /** Last `boards` payload. Survives remount so first frame after nav-back is the prior frame, not the spinner. */
  lastBoards = $state<StationBoardInput[] | null>(null);

  /** Toggle a route filter for one stop. Same lifetime as expansion picks. */
  toggleRouteFilter(stopId: string, routeId: string): void {
    this.routeFilterByStop[stopId] = this.routeFilterByStop[stopId] === routeId
      ? null
      : routeId;
    this.userHasExpandedChoice = true;
  }

  /** Tap a route badge on a station card: toggles the per-stop filter
   *  and, when the tap sets a new filter on a stop that isn't the
   *  currently expanded one, also expands it. Issue #278 — collapsed
   *  card now expands on badge tap so the user sees the filter result
   *  in one gesture instead of having to discover the chevron.
   *  On the always-expanded /station/[id] view the expand branch is a
   *  no-op (the card is already expanded by the caller), so wiring
   *  this view through the same method is safe. */
  applyRouteBadgeTap(stopId: string, routeId: string): void {
    this.toggleRouteFilter(stopId, routeId);
    if (this.routeFilterByStop[stopId] != null && this.expandedStopId !== stopId) {
      this.expandedStopId = stopId;
    }
  }

  /** Set the route filter for one stop (or clear with `null`). Used by Station-detail's single-route view. */
  setRouteFilter(stopId: string, routeId: string | null): void {
    this.routeFilterByStop[stopId] = routeId;
    this.userHasExpandedChoice = true;
  }

  /** Pick (or clear with null) which station is expanded. Sets `userHasExpandedChoice`. */
  pickExpand(stopId: string | null): void {
    this.expandedStopId = stopId;
    this.userHasExpandedChoice = true;
  }

  /** True when a GPS change is large enough to justify a re-query. Also returns true on first call or when `force` is set. Threshold from `NearyConfig.significantMoveM`. */
  shouldRefetchByPosition(lat: number, lon: number, force: boolean): boolean {
    if (force) return true;
    return hasMovedSignificantly(
      this.lastQueryPosition, { lat, lon }, DEFAULT_CONFIG.significantMoveM,
    );
  }

  /** Mark a position as applied. Called by the page after a successful query so the next hysteresis check sees it. */
  recordQueryPosition(lat: number, lon: number): void {
    this.lastQueryPosition = { lat, lon };
  }

  /** Drop expansion + per-stop filters for stops no longer in the rendered
   *  list. Pass `keepStopIds` to preserve state for stops that survive
   *  a refetch; omit for the full wipe (feed swap). Doesn't touch
   *  `lastQueryPosition` or `lastBoards`. */
  resetUserChoices(keepStopIds?: Iterable<string>): void {
    if (!keepStopIds) {
      this.expandedStopId = null;
      this.userHasExpandedChoice = false;
      this.routeFilterByStop = {};
      return;
    }
    const keep = new Set(keepStopIds);
    const next: Record<string, string | null> = {};
    for (const [stopId, routeId] of Object.entries(this.routeFilterByStop)) {
      if (keep.has(stopId)) next[stopId] = routeId;
    }
    this.routeFilterByStop = next;
    if (this.expandedStopId && !keep.has(this.expandedStopId)) {
      this.expandedStopId = null;
      this.userHasExpandedChoice = false;
    }
  }

  /** Hard reset on feed-change. Tab swaps to /favorites or /settings are NOT a reset trigger — the rider's expansion + filter survive nav. */
  reset(): void {
    this.resetUserChoices();
    this.lastQueryPosition = null;
    this.lastBoards = null;
  }

  /** Cache the latest boards payload so the page can seed the prior frame on remount instead of the spinner. */
  cacheBoards(boards: StationBoardInput[]): void {
    this.lastBoards = boards;
  }
}

export const stationsViewStore = new StationsViewStore();
