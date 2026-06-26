import { describe, expect, it } from 'vitest';
import { bucketOf, compareForBoard, bucketCounts, type ArrivalBucket } from './buckets';
import type { Vehicle } from './types';

function inputs(o: Partial<Parameters<typeof bucketOf>[1]> & { nowMin: number }) {
  return {
    etaMinutes: 5,
    distanceToStopMeters: 500,
    ...o,
  };
}

// Minimal Vehicle factories for the comparator test.
const route = { id: 1, shortName: '24', color: '#ff0000' };
function v(id: string, kind: Vehicle['kind'] = 'predicted'): Vehicle {
  return {
    kind: 'predicted',
    id,
    route,
    confidence: 'low',
    schedule: { tripId: `t-${id}`, scheduledDeparture: 540 },
    position: { lat: 0, lon: 0, source: 'predicted-from-schedule', asOf: 0 },
    checkedSources: [],
    // overwrite kind below if caller asked for another
    ...(kind === 'predicted' ? {} : ({} as never)),
  } as Vehicle;
}

describe('bucketOf', () => {
  const now = 9 * 60; // 09:00

  it('returns incoming when far in the future', () => {
    expect(bucketOf('predicted', inputs({ nowMin: now, etaMinutes: 10 }))).toBe('incoming');
  });

  it('returns arriving when within 2 min', () => {
    expect(bucketOf('predicted', inputs({ nowMin: now, etaMinutes: 2 }))).toBe('arriving');
    expect(bucketOf('predicted', inputs({ nowMin: now, etaMinutes: 1 }))).toBe('arriving');
  });

  it('returns departed within the 5 min recency window', () => {
    expect(bucketOf('predicted', inputs({ nowMin: now, etaMinutes: -3 }))).toBe('departed');
  });

  it('returns off-route once past the recency window', () => {
    expect(bucketOf('predicted', inputs({ nowMin: now, etaMinutes: -10 }))).toBe('off-route');
  });

  it('off-route for live vehicles far from stop and off shape', () => {
    expect(
      bucketOf(
        'live',
        inputs({
          nowMin: now,
          etaMinutes: 5,
          distanceToStopMeters: 500,
          onRouteShape: false,
        }),
      ),
    ).toBe('off-route');
  });

  it('at-station when physically at stop and stopped (live)', () => {
    expect(
      bucketOf(
        'live',
        inputs({
          nowMin: now,
          etaMinutes: 0,
          distanceToStopMeters: 20,
          vehicleSpeedKmh: 0,
          scheduledArrivalMin: now - 2,  // outside arriving window (-1..+1)
          scheduledDepartureMin: now + 3, // outside departing window (-1..+1), dwell gap = 5
        }),
      ),
    ).toBe('at-station');
  });

  it('departing when live vehicle picks up speed at stop', () => {
    expect(
      bucketOf(
        'live',
        inputs({
          nowMin: now,
          etaMinutes: 0,
          distanceToStopMeters: 20,
          vehicleSpeedKmh: 10,
          scheduledArrivalMin: now - 3, // outside arriving window
          scheduledDepartureMin: now + 3, // outside departing window
        }),
      ),
    ).toBe('departing');
  });

  it('departing in last minute of scheduled dwell (predicted vehicle)', () => {
    expect(
      bucketOf(
        'predicted',
        inputs({
          nowMin: now,
          etaMinutes: 0,
          distanceToStopMeters: 0,
          scheduledArrivalMin: now - 3,
          scheduledDepartureMin: now, // last-minute window covers now..now+1
        }),
      ),
    ).toBe('departing');
  });

  it('arriving in first minute of scheduled dwell (predicted vehicle)', () => {
    expect(
      bucketOf(
        'predicted',
        inputs({
          nowMin: now,
          etaMinutes: 0,
          distanceToStopMeters: 0,
          scheduledArrivalMin: now, // first-minute window covers now-1..now+1 -> picks arriving since (c) checks before (d)
          scheduledDepartureMin: now + 3,
        }),
      ),
    ).toBe('arriving');
  });

  it('arriving on short dwell (gap < 1 min) treated as just passing', () => {
    expect(
      bucketOf(
        'predicted',
        inputs({
          nowMin: now,
          etaMinutes: 0,
          distanceToStopMeters: 0,
          scheduledArrivalMin: now - 2, // past arriving window
          scheduledDepartureMin: now - 2, // past departing window, dwell gap = 0
        }),
      ),
    ).toBe('arriving');
  });
});

describe('compareForBoard', () => {
  it('orders by bucket then by eta then by id', () => {
    const items = [
      { vehicle: v('z'), bucket: 'incoming' as ArrivalBucket, etaMinutes: 5 },
      { vehicle: v('a'), bucket: 'at-station' as ArrivalBucket, etaMinutes: 0 },
      { vehicle: v('b'), bucket: 'incoming' as ArrivalBucket, etaMinutes: 3 },
      { vehicle: v('c'), bucket: 'incoming' as ArrivalBucket, etaMinutes: 3 },
    ];
    items.sort(compareForBoard);
    expect(items.map((i) => i.vehicle.id)).toEqual(['a', 'b', 'c', 'z']);
  });
});

describe('bucketCounts', () => {
  it('counts buckets', () => {
    const counts = bucketCounts(['incoming', 'incoming', 'arriving', 'departed']);
    expect(counts.incoming).toBe(2);
    expect(counts.arriving).toBe(1);
    expect(counts.departed).toBe(1);
    expect(counts['at-station']).toBe(0);
  });
});
