// Pins the "first load = always moved" semantic and the >= threshold comparison so the Stations view's re-query gate doesn't drift into "every GPS jitter triggers a SQLite round-trip" territory.

import { describe, expect, it } from 'vitest';
import { hasMovedSignificantly } from './moveDistance';

describe('hasMovedSignificantly', () => {
  // ~111 m / 0.001 deg latitude, so each step is ~111 m east.
  const a = { lat: 46.77, lon: 23.59 };

  it('returns true when there is no previous position (first load)', () => {
    expect(hasMovedSignificantly(null, a, 50)).toBe(true);
    expect(hasMovedSignificantly(undefined, a, 50)).toBe(true);
  });

  it('returns false when movement is below the threshold', () => {
    // ~22 m east - well under the 50 m threshold.
    const close = { lat: 46.77, lon: 23.5902 };
    expect(hasMovedSignificantly(a, close, 50)).toBe(false);
  });

  it('returns true when movement is at the threshold (>=)', () => {
    // ~55 m east - past the 50 m threshold. 1 deg lon at lat 46.77
    // ~ 111 km * cos(46.77 deg) ~ 76 km, so 0.00072 deg ~ 55 m. The
    // helper uses >= so the boundary case must be considered moved.
    const at = { lat: 46.77, lon: 23.59072 };
    expect(hasMovedSignificantly(a, at, 50)).toBe(true);
  });

  it('returns true when movement is well past the threshold', () => {
    const far = { lat: 46.77, lon: 23.60 };
    expect(hasMovedSignificantly(a, far, 50)).toBe(true);
  });

  it('honors a non-default threshold (e.g. 200 m for a custom config)', () => {
    const mid = { lat: 46.77, lon: 23.592 }; // ~111 m east
    expect(hasMovedSignificantly(a, mid, 200)).toBe(false);
    expect(hasMovedSignificantly(a, mid, 50)).toBe(true);
  });

  it('handles north-south movement the same way', () => {
    // 0.0005 deg lat ~ 55 m north (1 deg lat ~ 111 km regardless of lon).
    const north = { lat: 46.7705, lon: 23.59 };
    expect(hasMovedSignificantly(a, north, 50)).toBe(true);
  });

  it('returns false for an identical position (stationary)', () => {
    expect(hasMovedSignificantly(a, a, 50)).toBe(false);
  });
});