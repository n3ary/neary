import { describe, expect, it, beforeEach } from 'vitest';
import { stationsViewStore } from './stationsViewStore.svelte';
import { DEFAULT_CONFIG } from '$lib/domain/config';

describe('stationsViewStore hysteresis (issue #203)', () => {
  beforeEach(() => {
    stationsViewStore.reset();
  });

  it('treats the first ever position as needing a refetch', () => {
    expect(
      stationsViewStore.shouldRefetchByPosition(46.77, 23.62, false),
    ).toBe(true);
  });

  it('skips refetch on jitter under the configured threshold', () => {
    stationsViewStore.recordQueryPosition(46.77, 23.62);
    // ~22 m east at lat 46.77 - under the 50 m threshold.
    expect(
      stationsViewStore.shouldRefetchByPosition(46.77, 23.6202, false),
    ).toBe(false);
  });

  it('refetches once GPS drift crosses the configured threshold', () => {
    stationsViewStore.recordQueryPosition(46.77, 23.62);
    // ~76 m east at lat 46.77 - past the 50 m threshold.
    expect(
      stationsViewStore.shouldRefetchByPosition(46.77, 23.62072, false),
    ).toBe(true);
  });

  it('always refetches on manual refresh, even at 0 m drift', () => {
    stationsViewStore.recordQueryPosition(46.77, 23.62);
    expect(
      stationsViewStore.shouldRefetchByPosition(46.77, 23.62, true),
    ).toBe(true);
  });

  it('reads the threshold from NearyConfig.significantMoveM', () => {
    expect(DEFAULT_CONFIG.significantMoveM).toBe(50);
  });
});

describe('stationsViewStore selection persistence (issue #203)', () => {
  beforeEach(() => {
    stationsViewStore.reset();
  });

  it('toggleRouteFilter sets then clears the filter for a stop', () => {
    stationsViewStore.toggleRouteFilter('stop-1', 'route-24');
    expect(stationsViewStore.routeFilterByStop['stop-1']).toBe('route-24');
    stationsViewStore.toggleRouteFilter('stop-1', 'route-24');
    expect(stationsViewStore.routeFilterByStop['stop-1']).toBeNull();
  });

  it('toggleRouteFilter only affects the targeted stop', () => {
    stationsViewStore.toggleRouteFilter('stop-1', 'route-24');
    stationsViewStore.toggleRouteFilter('stop-2', 'route-35');
    expect(stationsViewStore.routeFilterByStop['stop-1']).toBe('route-24');
    expect(stationsViewStore.routeFilterByStop['stop-2']).toBe('route-35');
  });

  it('pickExpand marks the user as having overridden the selector', () => {
    expect(stationsViewStore.userHasExpandedChoice).toBe(false);
    stationsViewStore.pickExpand('stop-1');
    expect(stationsViewStore.expandedStopId).toBe('stop-1');
    expect(stationsViewStore.userHasExpandedChoice).toBe(true);
    stationsViewStore.pickExpand(null);
    expect(stationsViewStore.expandedStopId).toBeNull();
    expect(stationsViewStore.userHasExpandedChoice).toBe(true);
  });

  it('resetUserChoices wipes expansion + filters, preserves GPS cache', () => {
    stationsViewStore.pickExpand('stop-1');
    stationsViewStore.toggleRouteFilter('stop-1', 'route-24');
    stationsViewStore.recordQueryPosition(46.77, 23.62);
    stationsViewStore.resetUserChoices();
    expect(stationsViewStore.expandedStopId).toBeNull();
    expect(stationsViewStore.routeFilterByStop).toEqual({});
    expect(stationsViewStore.userHasExpandedChoice).toBe(false);
    // lastQueryPosition survives - caller still wants the hysteresis to
    // hold across an in-view reset.
    expect(stationsViewStore.lastQueryPosition).toEqual({
      lat: 46.77, lon: 23.62,
    });
  });

  it('resetUserChoices also preserves lastBoards for remount seeding', () => {
    // Regression guard for the spinner-stuck-after-settings bug: the
    // home page seeds its local `boards` state from
    // stationsViewStore.lastBoards so a remount renders the prior
    // frame instead of the spinner. If resetUserChoices wiped the
    // cache, every expansion toggle (which calls resetUserChoices
    // indirectly via the "moved" branch of the boards effect on the
    // next refetch) would re-introduce the spinner.
    stationsViewStore.cacheBoards([] as never);
    stationsViewStore.pickExpand('stop-1');
    stationsViewStore.resetUserChoices();
    expect(stationsViewStore.lastBoards).not.toBeNull();
  });

  it('resetUserChoices(stopIds) preserves state for stops still in the list (issue #235)', () => {
    // User expanded stop-1 and picked route-24 on stop-1 + route-35 on stop-2.
    // A GPS-driven refetch returns the same stops (just reordered by distance);
    // both pieces of state must survive.
    stationsViewStore.pickExpand('stop-1');
    stationsViewStore.toggleRouteFilter('stop-1', 'route-24');
    stationsViewStore.toggleRouteFilter('stop-2', 'route-35');
    stationsViewStore.resetUserChoices(['stop-1', 'stop-2']);
    expect(stationsViewStore.expandedStopId).toBe('stop-1');
    expect(stationsViewStore.userHasExpandedChoice).toBe(true);
    expect(stationsViewStore.routeFilterByStop).toEqual({
      'stop-1': 'route-24',
      'stop-2': 'route-35',
    });
  });

  it('resetUserChoices(stopIds) prunes filter entries for stops that left the list', () => {
    // stop-2 left the rendered list (out of nearbyRadiusM). Its filter
    // entry must drop; stop-1's survives.
    stationsViewStore.toggleRouteFilter('stop-1', 'route-24');
    stationsViewStore.toggleRouteFilter('stop-2', 'route-35');
    stationsViewStore.resetUserChoices(['stop-1']);
    expect(stationsViewStore.routeFilterByStop).toEqual({
      'stop-1': 'route-24',
    });
  });

  it('resetUserChoices(stopIds) clears expansion when the expanded stop left the list', () => {
    // The expanded stop is no longer in the new boards list, so the
    // expansion has to drop - otherwise effectiveExpandedStopId would
    // resolve to null against the empty intersection (lying about a
    // phantom pick). userHasExpandedChoice also drops so the selector
    // auto-pick takes over on the next render.
    stationsViewStore.pickExpand('stop-1');
    stationsViewStore.toggleRouteFilter('stop-1', 'route-24');
    stationsViewStore.resetUserChoices(['stop-2']);
    expect(stationsViewStore.expandedStopId).toBeNull();
    expect(stationsViewStore.userHasExpandedChoice).toBe(false);
    // And the orphaned filter entry is pruned in the same pass.
    expect(stationsViewStore.routeFilterByStop).toEqual({});
  });

  it('reset() wipes everything including GPS cache and boards', () => {
    stationsViewStore.pickExpand('stop-1');
    stationsViewStore.toggleRouteFilter('stop-1', 'route-24');
    stationsViewStore.recordQueryPosition(46.77, 23.62);
    stationsViewStore.cacheBoards([] as never);
    stationsViewStore.reset();
    expect(stationsViewStore.expandedStopId).toBeNull();
    expect(stationsViewStore.routeFilterByStop).toEqual({});
    expect(stationsViewStore.lastQueryPosition).toBeNull();
    expect(stationsViewStore.lastBoards).toBeNull();
  });
});

describe('stationsViewStore route badge tap expansion (issue #278)', () => {
  beforeEach(() => {
    stationsViewStore.reset();
  });

  it('expands the card when a badge is tapped on a collapsed stop', () => {
    // Initial: two stations in the list, the closest (stop-1) is
    // auto-expanded via the selector. stop-2 is the one the user
    // taps - currently collapsed. Single tap should both apply the
    // filter and flip expansion to stop-2.
    expect(stationsViewStore.expandedStopId).toBeNull();
    expect(stationsViewStore.userHasExpandedChoice).toBe(false);
    stationsViewStore.applyRouteBadgeTap('stop-2', 'route-24');
    expect(stationsViewStore.routeFilterByStop['stop-2']).toBe('route-24');
    expect(stationsViewStore.expandedStopId).toBe('stop-2');
    expect(stationsViewStore.userHasExpandedChoice).toBe(true);
  });

  it('does not flip expansion when a badge is tapped on the currently expanded stop', () => {
    // User already has stop-1 expanded (either via prior tap or chevron).
    // Tapping a badge on stop-1 should set the filter but leave the
    // expansion pick alone - the page's effective-expansion derived
    // already returns stop-1, so a re-write would be a no-op but
    // we still want to assert the no-op shape.
    stationsViewStore.pickExpand('stop-1');
    stationsViewStore.applyRouteBadgeTap('stop-1', 'route-24');
    expect(stationsViewStore.routeFilterByStop['stop-1']).toBe('route-24');
    expect(stationsViewStore.expandedStopId).toBe('stop-1');
  });

  it('switches the expansion to the tapped stop when the user has picked a different one', () => {
    // User previously expanded stop-1, then taps a badge on stop-2.
    // Expansion should follow the tap: stop-2 becomes the expanded
    // stop, the old pick (stop-1) drops. The page's effective-expansion
    // then returns stop-2 and the card for stop-1 collapses.
    stationsViewStore.pickExpand('stop-1');
    stationsViewStore.applyRouteBadgeTap('stop-2', 'route-35');
    expect(stationsViewStore.routeFilterByStop['stop-2']).toBe('route-35');
    expect(stationsViewStore.expandedStopId).toBe('stop-2');
  });

  it('clears the filter on a re-tap but leaves the card expanded (issue #278 design choice)', () => {
    // The issue's text suggested "second tap clears the filter AND
    // collapses", but collapsing strands the user in a state they
    // didn't ask for when they had the card open from a different
    // gesture. We keep the card expanded: the user just moved from
    // "filtered" to "all routes at this stop" - both are valid
    // exploration states and the chevron owns the collapse intent.
    stationsViewStore.applyRouteBadgeTap('stop-2', 'route-24');
    expect(stationsViewStore.expandedStopId).toBe('stop-2');
    stationsViewStore.applyRouteBadgeTap('stop-2', 'route-24');
    expect(stationsViewStore.routeFilterByStop['stop-2']).toBeNull();
    expect(stationsViewStore.expandedStopId).toBe('stop-2');
  });
});