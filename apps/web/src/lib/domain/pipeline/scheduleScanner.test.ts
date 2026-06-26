import { describe, expect, it } from 'vitest';
import { scanSchedule, type ScheduleRow } from './scheduleScanner';

const row = (overrides: Partial<ScheduleRow> = {}): ScheduleRow => ({
  trip_id: 't-1',
  arrival_time: '09:05:00',
  departure_time: '09:06:00',
  pickup_type: 0,
  stop_sequence: 3,
  last_seq: 8,
  // Default to a trip that ends an hour after the default arrival, so past
  // arrivals are still 'en route' unless the test overrides this.
  trip_end_time: '10:05:00',
  // Default trip start: a few minutes before this row's arrival. Tests
  // can override per-trip when they want a specific origin time.
  trip_start_time: '09:00:00',
  direction_id: 0,
  first_seq: 1,
  route_id: '24',
  route_short_name: '24',
  route_color: 'ff0000',
  route_text_color: 'ffffff',
  route_type: 3,
  trip_headsign: 'Mănăștur',
  stop_lat: 46.7712,
  stop_lon: 23.6236,
  ...overrides,
});

describe('scanSchedule', () => {
  const now = 9 * 60; // 09:00
  const nowMs = new Date(2026, 5, 26, 9, 0, 0).getTime();

  it('produces a scheduled vehicle for a future arrival', () => {
    const out = scanSchedule({
      rows: [row({ arrival_time: '09:10:00', departure_time: '09:10:30' })],
      nowMinSinceMidnight: now,
      nowMs,
      windowMinutes: 60,
    });
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('scheduled');
    expect(out[0].eta?.minutes).toBe(10);
    expect(out[0].type).toBe('bus');
    expect(out[0].route.shortName).toBe('24');
    expect(out[0].schedule?.headsign).toBe('Mănăștur');
  });

  it('emits scheduled vehicles regardless of where in the trip window now falls', () => {
    // In the schedule-only path every emitted vehicle is 'scheduled'.
    // The bucketer downstream classifies dwell / arriving / departing
    // based on the row's scheduled times. The scanner doesn't pre-bucket.
    const out = scanSchedule({
      rows: [row({ arrival_time: '08:59:00', departure_time: '09:01:00' })],
      nowMinSinceMidnight: now,
      nowMs,
      windowMinutes: 60,
    });
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('scheduled');
  });

  it('drops future arrivals outside the window', () => {
    const out = scanSchedule({
      rows: [
        row({ arrival_time: '12:00:00', departure_time: '12:00:30', trip_end_time: '13:00:00' }),
      ],
      nowMinSinceMidnight: now,
      nowMs,
      windowMinutes: 60,
    });
    expect(out).toHaveLength(0);
  });

  it('drops past arrivals whose trip has already reached terminus', () => {
    // arrival 06:00, trip ended 06:30. now = 09:00 -> trip done, skip.
    const out = scanSchedule({
      rows: [
        row({ arrival_time: '06:00:00', departure_time: '06:00:30', trip_end_time: '06:30:00' }),
      ],
      nowMinSinceMidnight: now,
      nowMs,
      windowMinutes: 60,
    });
    expect(out).toHaveLength(0);
  });

  it('keeps past arrivals whose trip is still en route to terminus', () => {
    // arrival 08:50 (10 min ago), trip ends 09:30 -> still en route.
    const out = scanSchedule({
      rows: [
        row({ arrival_time: '08:50:00', departure_time: '08:50:30', trip_end_time: '09:30:00' }),
      ],
      nowMinSinceMidnight: now,
      nowMs,
      windowMinutes: 60,
    });
    expect(out).toHaveLength(1);
    expect(out[0].eta?.minutes).toBe(-10);
  });

  it('flags drop-off-only (pickup_type=1)', () => {
    const out = scanSchedule({
      rows: [row({ arrival_time: '09:05:00', pickup_type: 1 })],
      nowMinSinceMidnight: now,
      nowMs,
      windowMinutes: 60,
    });
    expect(out[0].dropOffOnly).toBe(true);
  });

  it('flags terminus arrival as drop-off-only even when pickup_type is null', () => {
    // Real-world case from Cluj: trip ends at this stop. pickup_type left
    // null by the operator, but stop_sequence === last_seq signals it's a
    // terminus arrival, so the scanner treats it as drop-off-only.
    const out = scanSchedule({
      rows: [row({
        arrival_time: '09:05:00',
        pickup_type: null,
        stop_sequence: 8,
        last_seq: 8,
      })],
      nowMinSinceMidnight: now,
      nowMs,
      windowMinutes: 60,
    });
    expect(out[0].dropOffOnly).toBe(true);
  });

  it('does NOT flag a mid-trip stop with null pickup_type', () => {
    const out = scanSchedule({
      rows: [row({
        arrival_time: '09:05:00',
        pickup_type: null,
        stop_sequence: 3,
        last_seq: 8,
      })],
      nowMinSinceMidnight: now,
      nowMs,
      windowMinutes: 60,
    });
    expect(out[0].dropOffOnly).toBeUndefined();
  });

  it('flags isAtTripStart when stop_sequence === first_seq', () => {
    const out = scanSchedule({
      rows: [row({
        arrival_time: '09:10:00',
        stop_sequence: 1,
        first_seq: 1,
      })],
      nowMinSinceMidnight: now,
      nowMs,
      windowMinutes: 60,
    });
    expect(out[0].schedule?.isAtTripStart).toBe(true);
  });

  it('does NOT flag isAtTripStart at intermediate stops', () => {
    const out = scanSchedule({
      rows: [row({ arrival_time: '09:10:00', stop_sequence: 3, first_seq: 1 })],
      nowMinSinceMidnight: now,
      nowMs,
      windowMinutes: 60,
    });
    expect(out[0].schedule?.isAtTripStart).toBe(false);
  });

});
