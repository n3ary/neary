import { describe, expect, it } from 'vitest';
import { clockToBucket, type TodProfile } from './timeOfDay';

const profile: TodProfile = {
  peak_windows: [
    { from: '07:00', to: '09:30' },
    { from: '16:00', to: '19:00' },
  ],
  night_window: { from: '22:30', to: '05:30' },
};

describe('clockToBucket', () => {
  it('returns offpeak for daytime non-peak hours', () => {
    expect(clockToBucket(12 * 60, profile)).toBe('offpeak');
    expect(clockToBucket(15 * 60 + 59, profile)).toBe('offpeak');
  });

  it('returns peak inside a peak window', () => {
    expect(clockToBucket(7 * 60, profile)).toBe('peak');
    expect(clockToBucket(8 * 60 + 30, profile)).toBe('peak');
    expect(clockToBucket(17 * 60, profile)).toBe('peak');
  });

  it('treats the upper bound of a peak window as exclusive', () => {
    expect(clockToBucket(9 * 60 + 30, profile)).toBe('offpeak');
    expect(clockToBucket(19 * 60, profile)).toBe('offpeak');
  });

  it('detects night across the midnight wrap', () => {
    expect(clockToBucket(22 * 60 + 30, profile)).toBe('night');
    expect(clockToBucket(23 * 60, profile)).toBe('night');
    expect(clockToBucket(0, profile)).toBe('night');
    expect(clockToBucket(3 * 60, profile)).toBe('night');
  });

  it('exits night at the upper bound of the night window', () => {
    expect(clockToBucket(5 * 60 + 30, profile)).toBe('offpeak');
    expect(clockToBucket(6 * 60, profile)).toBe('offpeak');
  });

  // GTFS extended time (24h+) wraps and 01:00 is in the night window.
  it('handles GTFS-style 24h+ minutes (post-midnight night routes)', () => {
    expect(clockToBucket(25 * 60, profile)).toBe('night');
  });

  it('night wins over peak on overlapping windows', () => {
    const conflicting: TodProfile = {
      peak_windows: [{ from: '04:00', to: '06:00' }],
      night_window: { from: '22:00', to: '05:00' },
    };
    expect(clockToBucket(4 * 60 + 30, conflicting)).toBe('night');
  });
});
