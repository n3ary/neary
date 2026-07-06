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