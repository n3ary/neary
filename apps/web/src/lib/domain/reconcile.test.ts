import { describe, expect, it } from 'vitest';
import { reconcileWithLive } from './reconcile';
import type { LiveVehicleObservation } from '$lib/data/live/gtfsRtClient';
import type { Route, Vehicle } from './types';

const r24: Route = { id: 24, shortName: '24', color: '#ff0000' };

function scheduled(tripId: string): Vehicle {
  return {
    kind: 'scheduled',
    id: `trip:${tripId}`,
    route: r24,
    type: 'bus',
    confidence: 'low',
    schedule: { tripId, scheduledDeparture: 540 },
    eta: { distanceMeters: 0, minutes: 3, confidence: 'low' },
  } as Vehicle;
}

function obs(tripId: string, lat = 46.77, lon = 23.62, asOfMs = 1_700_000_000_000): LiveVehicleObservation {
  return {
    source: 'gtfs-rt',
    vehicleId: `v-${tripId}`,
    tripId,
    routeId: '24',
    directionId: 0,
    lat,
    lon,
    bearing: null,
    speedMs: null,
    currentStatus: null,
    nextStopId: null,
    asOfMs,
  };
}

describe('reconcileWithLive', () => {
  it('upgrades scheduled rows whose trip_id appears in the live feed', () => {
    const { vehicles, stats } = reconcileWithLive(
      [scheduled('t-1'), scheduled('t-2')],
      [obs('t-1', 46.7712, 23.6236)],
    );
    expect(stats).toEqual({ matched: 1, unmatched: 1 });
    expect(vehicles[0].kind).toBe('reconciled');
    expect(vehicles[0].position?.source).toBe('gps');
    expect(vehicles[0].position?.lat).toBeCloseTo(46.7712);
    expect(vehicles[0].position?.lon).toBeCloseTo(23.6236);
    expect(vehicles[1].kind).toBe('scheduled');
  });

  it('preserves the stable trip-based id across the upgrade', () => {
    const { vehicles } = reconcileWithLive([scheduled('t-1')], [obs('t-1')]);
    expect(vehicles[0].id).toBe('trip:t-1');
  });

  it('preserves headsign / route / eta / dropOffOnly from the scheduled row', () => {
    const sched: Vehicle = {
      ...scheduled('t-1'),
      headsign: 'Mănăștur',
      dropOffOnly: true,
    } as Vehicle;
    const { vehicles } = reconcileWithLive([sched], [obs('t-1')]);
    expect(vehicles[0].kind).toBe('reconciled');
    if (vehicles[0].kind === 'reconciled') {
      expect(vehicles[0].headsign).toBe('Mănăștur');
      expect(vehicles[0].dropOffOnly).toBe(true);
      expect(vehicles[0].eta?.minutes).toBe(3);
      expect(vehicles[0].liveSources).toEqual(['gtfs-rt']);
      expect(vehicles[0].confidence).toBe('medium');
    }
  });

  it('skips live observations without a trip_id (deadheading)', () => {
    const { vehicles, stats } = reconcileWithLive(
      [scheduled('t-1')],
      [{ ...obs(''), tripId: '' }],
    );
    expect(stats).toEqual({ matched: 0, unmatched: 1 });
    expect(vehicles[0].kind).toBe('scheduled');
  });

  it('is idempotent for already-promoted kinds', () => {
    const input: Vehicle[] = [
      {
        kind: 'reconciled',
        id: 'trip:t-1',
        route: r24,
        type: 'bus',
        confidence: 'medium',
        schedule: { tripId: 't-1', scheduledDeparture: 540 },
        position: { lat: 46.77, lon: 23.62, source: 'gps', asOf: 0 },
        liveSources: ['gtfs-rt'],
      },
    ];
    const { vehicles } = reconcileWithLive(input, [obs('t-1')]);
    expect(vehicles[0]).toBe(input[0]); // same reference, no copy
  });

  it('falls back to fetch time when the observation has no timestamp', () => {
    const before = Date.now();
    const { vehicles } = reconcileWithLive([scheduled('t-1')], [{ ...obs('t-1'), asOfMs: 0 }]);
    const after = Date.now();
    expect(vehicles[0].kind).toBe('reconciled');
    if (vehicles[0].kind === 'reconciled') {
      expect(vehicles[0].position.asOf).toBeGreaterThanOrEqual(before);
      expect(vehicles[0].position.asOf).toBeLessThanOrEqual(after);
    }
  });
});
