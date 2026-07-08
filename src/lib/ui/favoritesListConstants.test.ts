import { describe, expect, it } from 'vitest';
import { shouldPrefetchNextPage, STATIONS_PREFETCH_VIEWPORT_FACTOR } from './favoritesListConstants';

describe('shouldPrefetchNextPage', () => {
  const viewport = 800;

  it('prefetch when sentinel bottom is at the viewport bottom', () => {
    expect(shouldPrefetchNextPage({ sentinelBottom: 800, viewportHeight: viewport })).toBe(true);
  });

  it('prefetch when sentinel is one viewport below the visible area', () => {
    // sentinel at viewport + 1 viewport of prefetch margin
    expect(shouldPrefetchNextPage({ sentinelBottom: 1600, viewportHeight: viewport })).toBe(true);
  });

  it('does not prefetch when sentinel is beyond the prefetch margin', () => {
    expect(shouldPrefetchNextPage({ sentinelBottom: 2000, viewportHeight: viewport })).toBe(false);
  });

  it('handles negative sentinel (above viewport, never reached)', () => {
    expect(shouldPrefetchNextPage({ sentinelBottom: -100, viewportHeight: viewport })).toBe(true);
  });

  it('respects custom factor', () => {
    // factor=2: prefetch when sentinel is within 2 viewports of bottom
    // viewport=800, so threshold = 800 + 2*800 = 2400
    expect(shouldPrefetchNextPage({ sentinelBottom: 2300, viewportHeight: viewport, factor: 2 })).toBe(true);
    expect(shouldPrefetchNextPage({ sentinelBottom: 2500, viewportHeight: viewport, factor: 2 })).toBe(false);
  });

  it('uses default factor when omitted', () => {
    // STATIONS_PREFETCH_VIEWPORT_FACTOR = 1
    expect(STATIONS_PREFETCH_VIEWPORT_FACTOR).toBe(1);
    // viewport=800 -> threshold = 800 + 1*800 = 1600
    expect(shouldPrefetchNextPage({ sentinelBottom: 1599, viewportHeight: viewport })).toBe(true);
    expect(shouldPrefetchNextPage({ sentinelBottom: 1601, viewportHeight: viewport })).toBe(false);
  });

  it('returns false for zero / negative viewport (SSR or pre-paint)', () => {
    expect(shouldPrefetchNextPage({ sentinelBottom: 0, viewportHeight: 0 })).toBe(false);
    expect(shouldPrefetchNextPage({ sentinelBottom: 0, viewportHeight: -10 })).toBe(false);
  });
});