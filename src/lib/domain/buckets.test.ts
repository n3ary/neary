import { describe, expect, it } from 'vitest';
import {
  atStationLabel,
  atStationSubState,
  bucketOf,
  compareForBoard,
  bucketCounts,
  etaUrgency,
  filterForStationView,
  type ArrivalBucket,
} from './buckets';
import type { Vehicle } from './types';

function inputs(o: Partial<Parameters<typeof bucketOf>[1]> & { nowMin: number }) {
  return {
    etaMinutes: 5,
    distanceToStopMeters: 500,
    ...o,
  };
}

// Minimal Vehicle factories for the comparator test.
const route = { id: '1', shortName: '24', color: '#ff0000' };
function v(id: string, _kind: Vehicle['kind'] = 'scheduled'): Vehicle {
  return {
    kind: 'scheduled',
    id,
    route,
    type: 'bus',
    confidence: 'low',
    schedule: { tripId: `t-${id}`, scheduledDeparture: 540 },
    position: { lat: 0, lon: 0, source: 'predicted-from-schedule', asOf: 0 },
  } as Vehicle;
}

describe('bucketOf', () => {
  const now = 9 * 60; // 09:00

  it('returns incoming when far in the future', () => {
    expect(bucketOf('scheduled', inputs({ nowMin: now, etaMinutes: 10 }))).toBe('incoming');
  });

  it('returns at-station (close sub-state) when within 1 min', () => {
    expect(bucketOf('scheduled', inputs({ nowMin: now, etaMinutes: 1 }))).toBe('at-station');
    expect(bucketOf('scheduled', inputs({ nowMin: now, etaMinutes: 0 }))).toBe('at-station');
  });

  it('returns incoming when 2 min away (above the threshold)', () => {
    // The at-station window is `eta <= ARRIVING_THRESHOLD_MIN` (1 min by
    // default). A bus 2 minutes out is still incoming — the rider
    // has time, no need to start the urgency styling yet.
    expect(bucketOf('scheduled', inputs({ nowMin: now, etaMinutes: 2 }))).toBe('incoming');
  });

  it('returns departed when in the past (scanner gates trip-end)', () => {
    // Bucketer trusts the scheduleScanner to drop trips whose terminus
    // has already passed; anything past that reaches the bucketer is
    // still en route and belongs in 'departed', no recency cap.
    expect(bucketOf('scheduled', inputs({ nowMin: now, etaMinutes: -3 }))).toBe('departed');
    expect(bucketOf('scheduled', inputs({ nowMin: now, etaMinutes: -30 }))).toBe('departed');
  });

  it('off-route for live vehicles far from stop and off shape', () => {
    expect(
      bucketOf(
        'gps-only',
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
        'gps-only',
        inputs({
          nowMin: now,
          etaMinutes: 0,
          distanceToStopMeters: 20,
          vehicleSpeedKmh: 0,
          scheduledArrivalMin: now - 2,
          scheduledDepartureMin: now + 3,
        }),
      ),
    ).toBe('at-station');
  });

  it('at-station when live vehicle picks up speed at stop (about-to-leave sub-state)', () => {
    expect(
      bucketOf(
        'gps-only',
        inputs({
          nowMin: now,
          etaMinutes: 0,
          distanceToStopMeters: 20,
          vehicleSpeedKmh: 10,
          scheduledArrivalMin: now - 3,
          scheduledDepartureMin: now + 3,
        }),
      ),
    ).toBe('at-station');
  });

  it('at-station in last minute of scheduled dwell (about-to-leave sub-state)', () => {
    expect(
      bucketOf(
        'scheduled',
        inputs({
          nowMin: now,
          etaMinutes: 0,
          distanceToStopMeters: 0,
          scheduledArrivalMin: now - 3,
          scheduledDepartureMin: now,
        }),
      ),
    ).toBe('at-station');
  });

  it('at-station in first minute of scheduled dwell (just-arrived sub-state)', () => {
    expect(
      bucketOf(
        'scheduled',
        inputs({
          nowMin: now,
          etaMinutes: 0,
          distanceToStopMeters: 0,
          scheduledArrivalMin: now,
          scheduledDepartureMin: now + 3,
        }),
      ),
    ).toBe('at-station');
  });

  it('at-station on short dwell (gap < 1 min, mid-dwell sub-state)', () => {
    // dwell gap = 0 (arrival = departure = past) — vehicle is at the
    // stop but not in either window. The sub-state is mid-dwell.
    expect(
      bucketOf(
        'scheduled',
        inputs({
          nowMin: now,
          etaMinutes: 0,
          distanceToStopMeters: 0,
          scheduledArrivalMin: now - 2,
          scheduledDepartureMin: now - 2,
        }),
      ),
    ).toBe('at-station');
  });

  it('live vehicle physically at the stop, no timing match -> at-station', () => {
    // The bus is right there (GPS within 50 m), schedule says depart
    // later (4 min). User can board it now - bucket should be
    // 'at-station' (mid-dwell sub-state).
    expect(
      bucketOf(
        'tracked',
        inputs({
          nowMin: now,
          etaMinutes: 4,
          distanceToStopMeters: 30,
          scheduledArrivalMin: now + 4,
          scheduledDepartureMin: now + 4,
        }),
      ),
    ).toBe('at-station');
  });

  it('live vehicle physically at stop near scheduled departure -> at-station', () => {
    expect(
      bucketOf(
        'tracked',
        inputs({
          nowMin: now,
          etaMinutes: 0,
          distanceToStopMeters: 30,
          scheduledArrivalMin: now - 1,
          scheduledDepartureMin: now,
        }),
      ),
    ).toBe('at-station');
  });
});

describe('compareForBoard', () => {
  it('orders by bucket (at-station first, incoming, dropped off, departed) then by sub-state, eta, id', () => {
    const items = [
      { vehicle: v('z'), bucket: 'incoming' as ArrivalBucket, etaMinutes: 5 },
      { vehicle: v('a'), bucket: 'at-station' as ArrivalBucket, etaMinutes: 0 },
      { vehicle: v('b'), bucket: 'incoming' as ArrivalBucket, etaMinutes: 3 },
      { vehicle: v('c'), bucket: 'incoming' as ArrivalBucket, etaMinutes: 3 },
      { vehicle: v('d'), bucket: 'at-station' as ArrivalBucket, etaMinutes: 0, atStationSubState: 'about-to-leave' as const },
    ];
    items.sort(compareForBoard);
    // 'd' is about-to-leave (priority 0), 'a' is mid-dwell (priority 2), both at-station.
    expect(items.map((i) => i.vehicle.id)).toEqual(['d', 'a', 'b', 'c', 'z']);
  });

  it('sorts departed by most-recent first (smallest |eta|)', () => {
    const items = [
      { vehicle: v('a'), bucket: 'departed' as ArrivalBucket, etaMinutes: -10 },
      { vehicle: v('b'), bucket: 'departed' as ArrivalBucket, etaMinutes: -1 },
      { vehicle: v('c'), bucket: 'departed' as ArrivalBucket, etaMinutes: -5 },
    ];
    items.sort(compareForBoard);
    expect(items.map((i) => i.vehicle.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('etaUrgency', () => {
  it("returns 'go' for incoming within the imminent threshold", () => {
    expect(etaUrgency('incoming', 5)).toBe('go');
    expect(etaUrgency('incoming', 3)).toBe('go');
  });

  it("returns 'neutral' for incoming beyond the imminent threshold", () => {
    expect(etaUrgency('incoming', 11)).toBe('neutral');
    expect(etaUrgency('incoming', 20)).toBe('neutral');
  });

  it("returns 'neutral' for at-station, drop-off, departed, off-route", () => {
    // The at-station group carries its own urgency via atStationLabel;
    // etaUrgency is only meaningful for non-at-station rows.
    expect(etaUrgency('at-station', 0)).toBe('neutral');
    expect(etaUrgency('drop-off', 1)).toBe('neutral');
    expect(etaUrgency('departed', -3)).toBe('neutral');
    expect(etaUrgency('off-route', 99)).toBe('neutral');
  });
});

describe('atStationSubState', () => {
  const baseInputs = (o: Partial<Parameters<typeof atStationSubState>[1]>) => ({
    distanceToStopMeters: 20,
    nowMin: 9 * 60,
    ...o,
  });

  it('returns undefined for buckets outside the at-station section', () => {
    expect(atStationSubState('incoming', baseInputs({}))).toBeUndefined();
    expect(atStationSubState('drop-off', baseInputs({}))).toBeUndefined();
    expect(atStationSubState('departed', baseInputs({}))).toBeUndefined();
    expect(atStationSubState('off-route', baseInputs({}))).toBeUndefined();
  });

  it('returns "close" when not at the stop but in the at-station bucket', () => {
    expect(
      atStationSubState('at-station', baseInputs({ distanceToStopMeters: 500 })),
    ).toBe('close');
  });

  it('returns "about-to-leave" when a live vehicle at the stop is picking up speed', () => {
    expect(
      atStationSubState('at-station', baseInputs({ vehicleSpeedKmh: 10 })),
    ).toBe('about-to-leave');
  });

  it('returns "about-to-leave" when at the stop, last minute of scheduled dwell', () => {
    const nowMin = 9 * 60;
    expect(
      atStationSubState('at-station', baseInputs({
        nowMin,
        scheduledArrivalMin: nowMin - 4,
        scheduledDepartureMin: nowMin,
      })),
    ).toBe('about-to-leave');
  });

  it('returns "just-arrived" when at the stop, first minute of scheduled dwell', () => {
    const nowMin = 9 * 60;
    expect(
      atStationSubState('at-station', baseInputs({
        nowMin,
        scheduledArrivalMin: nowMin,
        scheduledDepartureMin: nowMin + 3,
      })),
    ).toBe('just-arrived');
  });

  it('returns "mid-dwell" when at the stop mid-dwell', () => {
    const nowMin = 9 * 60;
    expect(
      atStationSubState('at-station', baseInputs({
        nowMin,
        scheduledArrivalMin: nowMin - 2,
        scheduledDepartureMin: nowMin + 3,
      })),
    ).toBe('mid-dwell');
  });

  it('returns "mid-dwell" when at the stop with no schedule anchor', () => {
    expect(
      atStationSubState('at-station', baseInputs({})),
    ).toBe('mid-dwell');
  });
});

describe('atStationLabel', () => {
  const baseInputs = (o: { etaMinutes?: number; vehicleSpeedKmh?: number }) => ({
    etaMinutes: 0,
    ...o,
  });

  it('"now" red when about-to-leave and moving', () => {
    expect(
      atStationLabel('about-to-leave', baseInputs({ vehicleSpeedKmh: 10 })),
    ).toEqual({ text: 'now', urgency: 'stop' });
  });

  it('"departing now" red when about-to-leave but stationary (scheduled last minute)', () => {
    expect(
      atStationLabel('about-to-leave', baseInputs({})),
    ).toEqual({ text: 'departing now', urgency: 'stop' });
  });

  it('"arriving now" green when just-arrived', () => {
    expect(
      atStationLabel('just-arrived', baseInputs({})),
    ).toEqual({ text: 'arriving now', urgency: 'go' });
  });

  it('"at station" green when mid-dwell', () => {
    expect(
      atStationLabel('mid-dwell', baseInputs({})),
    ).toEqual({ text: 'at station', urgency: 'go' });
  });

  it('relative ETA when close (not at the stop)', () => {
    expect(
      atStationLabel('close', baseInputs({ etaMinutes: 2 })),
    ).toEqual({ text: 'in 2 min', urgency: 'go' });
  });

  it('"now" when close sub-state has eta=0 (vehicle is at the stop by eta)', () => {
    expect(
      atStationLabel('close', baseInputs({ etaMinutes: 0 })),
    ).toEqual({ text: 'now', urgency: 'go' });
  });
});

describe('bucketCounts', () => {
  it('counts buckets', () => {
    const counts = bucketCounts(['incoming', 'incoming', 'at-station', 'departed']);
    expect(counts.incoming).toBe(2);
    expect(counts['at-station']).toBe(1);
    expect(counts.departed).toBe(1);
    expect(counts['drop-off']).toBe(0);
    expect(counts['off-route']).toBe(0);
  });
});

describe('filterForStationView', () => {
  const base = (b: ArrivalBucket, dropOffOnly = false, kind: Vehicle['kind'] = 'scheduled') => ({
    vehicle: { ...v('x', kind), dropOffOnly, kind } as Vehicle,
    bucket: b,
  });
  const allowAll = {
    showDepartedVehicles: true,
    showDropOffOnly: true,
    showOffRouteVehicles: true,
  };

  it('drops off-route by default (showOffRouteVehicles=false)', () => {
    const out = filterForStationView(
      [base('off-route'), base('incoming')],
      { ...allowAll, showOffRouteVehicles: false },
    );
    expect(out.map((e) => e.bucket)).toEqual(['incoming']);
  });

  it('keeps off-route when the advanced toggle is on', () => {
    const out = filterForStationView(
      [base('off-route'), base('incoming')],
      allowAll,
    );
    expect(out.map((e) => e.bucket)).toEqual(['off-route', 'incoming']);
  });

  it('drops departed when showDepartedVehicles is off', () => {
    const out = filterForStationView(
      [base('departed'), base('incoming')],
      { ...allowAll, showDepartedVehicles: false },
    );
    expect(out.map((e) => e.bucket)).toEqual(['incoming']);
  });

  it('keeps departed when showDepartedVehicles is on', () => {
    const out = filterForStationView(
      [base('departed'), base('incoming')],
      allowAll,
    );
    expect(out.map((e) => e.bucket)).toEqual(['departed', 'incoming']);
  });

  it('drops drop-off-only vehicles when showDropOffOnly is off', () => {
    const out = filterForStationView(
      [base('drop-off', true), base('at-station', false)],
      { ...allowAll, showDropOffOnly: false },
    );
    expect(out).toHaveLength(1);
    expect(out[0].vehicle.dropOffOnly).toBeFalsy();
  });

  it('keeps drop-off-only DEPARTED vehicles even when showDropOffOnly is off', () => {
    // dropOffOnly is about future boardability; for past vehicles it's
    // meaningless. The departed bucket honors only its own toggle.
    const out = filterForStationView(
      [base('departed', true)],
      { ...allowAll, showDropOffOnly: false },
    );
    expect(out).toHaveLength(1);
    expect(out[0].bucket).toBe('departed');
  });
});
