/*
 * stationsViewStore - view-only state shared by the Stations (/) and
 * Station-detail (/station/[id]) pages. Lives at module scope so it
 * survives SvelteKit page remounts: tapping a route badge -> schedule
 * -> back returns to the same expansion / route-filter selection.
 *
 * State stored:
 *
 *   - `expandedStopId`           which stop the user explicitly expanded
 *                                on the Stations home view. Null =
 *                                no manual expansion, selector's auto-
 *                                pick is honored.
 *   - `userHasExpandedChoice`    flips to true the first time the rider
 *                                toggles expansion. While true, the
 *                                page ignores the selector's auto-pick
 *                                on refresh - the rider's choice wins
 *                                until they reset by navigating away
 *                                or moving significantly.
 *   - `routeFilterByStop`        per-stop route filter. Reading `null` =
 *                                no filter for that stop.
 *   - `lastQueryPosition`        last lat/lon the / page used for the
 *                                nearby query. Drives the GPS hysteresis
 *                                that prevents jitter from re-fetching
 *                                and re-ordering the board. Threshold
 *                                lives in NearyConfig.significantMoveM.
 *   - `lastBoards`               last successfully-fetched boards list
 *                                for /. Cached so a remount (e.g. after
 *                                returning from a drill-down) renders
 *                                the prior frame before the next query
 *                                resolves, instead of flashing the
 *                                spinner.
 *
 * Reset semantics - only flip back to the defaults on:
 *
 *   - Rider navigates to /favorites or /settings (handled by +layout).
 *     Drilldowns (/map/..., /schedule/...) intentionally do NOT reset.
 *   - Rider moves >= `significantMoveM` meters (handled by the / page
 *     effect). Below that threshold the rider is "still here"; the
 *     boards query may still fire (manual refresh, large jitter), but
 *     their expansion + filter survive.
 *   - Bound feed changes (handled by the +layout effect: a new feed =
 *     new geography, old selections are stale).
 *
 * Manual refresh (header refresh button) is NOT a reset trigger - the
 * rider asked for fresh data, not for their view to be wiped.
 */

import { DEFAULT_CONFIG } from '../domain/config';
import { hasMovedSignificantly, type LatLon } from '../domain/moveDistance';
import type { StationBoardInput } from '../data/stationBoardsController.svelte';

export type { LatLon };

class StationsViewStore {
  /** Stop id the user explicitly expanded on the Stations home view.
   *  Null = no manual expansion (selector's auto-pick is honored). */
  expandedStopId = $state<string | null>(null);

  /** Flips to true the first time the rider toggles expansion or
   *  picks a route filter. While true, the page stops falling back
   *  to the selector's auto-pick on refresh. Cleared together with
   *  `expandedStopId` by `resetUserChoices` / `resetForTabSwap`. */
  userHasExpandedChoice = $state(false);

  /** Per-stop route filter. Reading `null` = no filter for that stop. */
  routeFilterByStop = $state<Record<string, string | null>>({});

  /** Last lat/lon applied to the / nearby query. Null until first run. */
  lastQueryPosition = $state<LatLon | null>(null);

  /** Last `boards` payload fetched for /. Survives remount so the
   *  first frame after navigating back is the previous frame, not the
   *  spinner. Replaced on every successful query. */
  lastBoards = $state<StationBoardInput[] | null>(null);

  /** Toggle a route filter for one stop. Same semantics as the page's
   *  previous inline helper, just lifted to module scope. */
  toggleRouteFilter(stopId: string, routeId: string): void {
    this.routeFilterByStop[stopId] = this.routeFilterByStop[stopId] === routeId
      ? null
      : routeId;
    // Toggling a filter is an explicit user choice - same lifetime as
    // expansion picks.
    this.userHasExpandedChoice = true;
  }

  /** Set the route filter for one stop (or clear it with `null`).
   *  Used by Station-detail's single-route view. */
  setRouteFilter(stopId: string, routeId: string | null): void {
    this.routeFilterByStop[stopId] = routeId;
    this.userHasExpandedChoice = true;
  }

  /** Pick (or clear with null) which station is expanded. Sets the
   *  `userHasExpandedChoice` flag so the selector's auto-pick stops
   *  overriding on subsequent refreshes. */
  pickExpand(stopId: string | null): void {
    this.expandedStopId = stopId;
    this.userHasExpandedChoice = true;
  }

  /** True when a GPS change is large enough to justify a re-query.
   *  Also returns true on the first call (no prior position), and
   *  when `force` is set (manual refresh). Threshold comes from
   *  `NearyConfig.significantMoveM`. */
  shouldRefetchByPosition(lat: number, lon: number, force: boolean): boolean {
    if (force) return true;
    return hasMovedSignificantly(this.lastQueryPosition, { lat, lon }, DEFAULT_CONFIG.significantMoveM);
  }

  /** Mark a position as applied. Called by the page after a successful
   *  query so the next `shouldRefetchByPosition` call sees it. */
  recordQueryPosition(lat: number, lon: number): void {
    this.lastQueryPosition = { lat, lon };
  }

  /** Clear explicit user choices (expanded station + route filters +
   *  the choice flag). Does NOT touch `lastQueryPosition` or
   *  `lastBoards` - the caller manages those after a refetch. */
  resetUserChoices(): void {
    this.expandedStopId = null;
    this.userHasExpandedChoice = false;
    this.routeFilterByStop = {};
  }

  /** Wipe everything for a hard reset: tab swap to /favorites or
   *  /settings, or feed change in +layout. */
  reset(): void {
    this.resetUserChoices();
    this.lastQueryPosition = null;
    this.lastBoards = null;
  }

  /** Cache the latest boards payload. Used by the page to seed its
   *  local `boards` state on remount so the first frame is the prior
   *  frame, not the spinner. */
  cacheBoards(boards: StationBoardInput[]): void {
    this.lastBoards = boards;
  }
}

export const stationsViewStore = new StationsViewStore();