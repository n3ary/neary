import { describe, expect, it } from 'vitest';
import { enrichObservations, indexActiveTripsByTripId } from './enrichObservations';
import type { LiveVehicleObservation } from '$lib/data/live/gtfsRtClient';
import type { Route, Vehicle } from './types';

const r14: Route = { id: '14', shortName: '14', color: '#ff0000' };

function sched(opts: {
  tripId: string;
  directionId: 0 | 1;
  tripStartMin: number;
}): Vehicle {
  return {
    kind: 'scheduled',
    id: `trip:${opts.tripId}`,
    route: r14,
    type: 'bus',
    tripId: opts.tripId,
    directionId: opts.directionId,
    confidence: 'low',
    schedule: {
      tripId: opts.tripId,
      scheduledDeparture: opts.tripStartMin,
      directionId: opts.directionId,
      tripStartMin: opts.tripStartMin,
    },
    eta: { distanceMeters: 0, minutes: 3, confidence: 'low' },
  } as Vehicle;
}

function obs(opts: Partial<LiveVehicleObservation> & { tripId: string }): LiveVehicleObservation {
  return {
    source: 'gtfs-rt',
    vehicleId: `v-${opts.tripId}`,
    tripId: opts.tripId,
    routeId: opts.routeId ?? '14',
    directionId: opts.directionId ?? 0,
    startTime: opts.startTime ?? '',
    lat: 46.77,
    lon: 23.62,
    bearing: null,
    speedMs: null,
    currentStatus: null,
    nextStopId: null,
    asOfMs: opts.asOfMs ?? 0,
  };
}

describe('indexActiveTripsByTripId', () => {
  it('keeps only entries with a tripId, valid direction, and tripStartMin', () => {
    const idx = indexActiveTripsByTripId([
      sched({ tripId: 'A', directionId: 0, tripStartMin: 10 * 60 }),
      sched({ tripId: 'B', directionId: 1, tripStartMin: 11 * 60 }),
    ]);
    expect(idx.size).toBe(2);
    expect(idx.get('A')).toEqual({ directionId: 0, tripStartMin: 600 });
  });
});

describe('enrichObservations — static-feed first', () => {
  const active = [
    sched({ tripId: 'A', directionId: 1, tripStartMin: 14 * 60 + 23 }),
    sched({ tripId: 'B', directionId: 0, tripStartMin: 15 * 60 + 7 }),
  ];

  it("uses static-feed direction + start_time when obs.tripId is in active", () => {
    // The feed reports a (possibly broken) direction and no start_time;
    // enrichment should overwrite both with authoritative values from
    // the active set.
    const out = enrichObservations(
      [obs({ tripId: 'A', directionId: 0, startTime: '' })],
      active,
    );
    expect(out[0].directionId).toBe(1);
    expect(out[0].startTime).toBe('14:23:00');
  });

  it('overrides even a non-broken canonical field — static is authoritative', () => {
    const out = enrichObservations(
      [obs({ tripId: 'A', directionId: 0, startTime: '99:99:00' })],
      active,
    );
    expect(out[0].directionId).toBe(1);
    expect(out[0].startTime).toBe('14:23:00');
  });
});

describe('enrichObservations — orphan passthrough', () => {
  it('leaves canonical fields untouched when trip is NOT in active set', () => {
    // No active trips, so the observation flows through unchanged.
    // Downstream (reconciler) will treat it as an unmatched orphan.
    // The tripId here does NOT match the TEMP cluj recovery regex
    // (no `<route>_<dir>_<service>_<run>_<HHMM>` shape).
    const out = enrichObservations(
      [obs({ tripId: 'opaque-orphan-abc', directionId: 0, startTime: '' })],
      [],
    );
    expect(out[0].directionId).toBe(0);
    expect(out[0].startTime).toBe('');
  });

  it('returns the original obs reference when no enrichment happens', () => {
    const o = obs({ tripId: 'opaque-orphan' });
    const out = enrichObservations([o], []);
    expect(out[0]).toBe(o); // same reference: no allocation when nothing changed
  });
});

describe('enrichObservations — TEMP cluj trip_id recovery', () => {
  // REMOVE this describe block when `packages/gtfs-rt` ships canonical
  // direction_id + start_time upstream (see
  // https://github.com/n3ary/gtfs/issues/36)
  // step 4). The block under test lives in enrichObservations.ts.

  it('recovers direction_id + start_time from a Cluj-shaped trip_id when start_time is empty', () => {
    const out = enrichObservations(
      [obs({ tripId: '14_1_LV_99_1423', directionId: 0, startTime: '' })],
      [],
    );
    expect(out[0].directionId).toBe(1);
    expect(out[0].startTime).toBe('14:23:00');
  });

  it('does not override a populated start_time even when trip_id matches the regex', () => {
    // Canonical fields win — if the feed publishes a non-empty
    // start_time, trust it (the recovery is a fallback for the broken
    // upstream case, not a normaliser).
    const out = enrichObservations(
      [obs({ tripId: '14_1_LV_99_1423', directionId: 0, startTime: '08:00:00' })],
      [],
    );
    expect(out[0].directionId).toBe(0);
    expect(out[0].startTime).toBe('08:00:00');
  });

  it('does not recover for trip_ids that do not match the Cluj shape', () => {
    const out = enrichObservations(
      [obs({ tripId: 'some-other-feed:42', directionId: 1, startTime: '' })],
      [],
    );
    expect(out[0].directionId).toBe(1);
    expect(out[0].startTime).toBe('');
  });

  it('static-feed enrichment still wins over Cluj recovery when active set has the trip', () => {
    const active = [sched({ tripId: '14_1_LV_99_1423', directionId: 0, tripStartMin: 9 * 60 + 30 })];
    const out = enrichObservations(
      [obs({ tripId: '14_1_LV_99_1423', directionId: 0, startTime: '' })],
      active,
    );
    expect(out[0].directionId).toBe(0);
    expect(out[0].startTime).toBe('09:30:00');
  });
});