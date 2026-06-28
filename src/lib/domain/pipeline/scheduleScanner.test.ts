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

  it('flags isFirstStop when stop_sequence === first_seq', () => {
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
    expect(out[0].schedule?.isFirstStop).toBe(true);
  });

  it('does NOT flag isFirstStop at intermediate stops', () => {
    const out = scanSchedule({
      rows: [row({ arrival_time: '09:10:00', stop_sequence: 3, first_seq: 1 })],
      nowMinSinceMidnight: now,
      nowMs,
      windowMinutes: 60,
    });
    expect(out[0].schedule?.isFirstStop).toBe(false);
  });

});

describe('scanSchedule tripPhase', () => {
  const now = 9 * 60; // 09:00
  const nowMs = new Date(2026, 5, 26, 9, 0, 0).getTime();
  // Origin factory: at a trip's first stop, trip_start_time IS the row's
  // departure_time, so we default trip_start_time to the override's
  // arrival_time when a test specifies one. Keeps the test data
  // consistent with how GTFS actually models origin rows.
  const origin = (overrides: Partial<ScheduleRow>): ScheduleRow =>
    row({
      stop_sequence: 1,
      first_seq: 1,
      trip_start_time: overrides.arrival_time ?? '09:00:00',
      ...overrides,
    });

  it('marks the next future origin departure as `next`', () => {
    const out = scanSchedule({
      rows: [
        origin({ trip_id: 'T1', arrival_time: '09:05:00', departure_time: '09:05:00' }),
        origin({ trip_id: 'T2', arrival_time: '09:20:00', departure_time: '09:20:00' }),
      ],
      nowMinSinceMidnight: now,
      nowMs,
      windowMinutes: 60,
    });
    const t1 = out.find((v) => v.tripId === 'T1')!;
    const t2 = out.find((v) => v.tripId === 'T2')!;
    expect(t1.schedule?.tripPhase).toBe('next');
    expect(t2.schedule?.tripPhase).toBe('later');
  });

  it('marks the most recent past origin departure as `last`', () => {
    const out = scanSchedule({
      rows: [
        origin({
          trip_id: 'T0',
          arrival_time: '08:55:00',
          departure_time: '08:55:00',
          trip_end_time: '09:30:00',
        }),
        origin({ trip_id: 'T1', arrival_time: '09:05:00', departure_time: '09:05:00' }),
      ],
      nowMinSinceMidnight: now,
      nowMs,
      windowMinutes: 60,
    });
    expect(out.find((v) => v.tripId === 'T0')?.schedule?.tripPhase).toBe('last');
    expect(out.find((v) => v.tripId === 'T1')?.schedule?.tripPhase).toBe('next');
  });

  it('marks tripPhase on non-origin rows based on the trip’s origin departure', () => {
    // Non-origin row at stop_seq=3. trip_start_time='09:00:00' (= now), so
    // the trip has just departed origin and is the only running trip on
    // this route at this stop → phase is `last`.
    const out = scanSchedule({
      rows: [
        row({
          trip_id: 'T1',
          arrival_time: '09:05:00',
          stop_sequence: 3,
          first_seq: 1,
          trip_start_time: '09:00:00',
        }),
      ],
      nowMinSinceMidnight: now,
      nowMs,
      windowMinutes: 60,
    });
    expect(out[0].schedule?.tripPhase).toBe('last');
  });

  it('scopes next/last per route', () => {
    const out = scanSchedule({
      rows: [
        origin({ trip_id: 'A1', route_id: 'A', route_short_name: 'A', arrival_time: '09:05:00', departure_time: '09:05:00' }),
        origin({ trip_id: 'A2', route_id: 'A', route_short_name: 'A', arrival_time: '09:15:00', departure_time: '09:15:00' }),
        origin({ trip_id: 'B1', route_id: 'B', route_short_name: 'B', arrival_time: '09:08:00', departure_time: '09:08:00' }),
      ],
      nowMinSinceMidnight: now,
      nowMs,
      windowMinutes: 60,
    });
    expect(out.find((v) => v.tripId === 'A1')?.schedule?.tripPhase).toBe('next');
    expect(out.find((v) => v.tripId === 'A2')?.schedule?.tripPhase).toBe('later');
    expect(out.find((v) => v.tripId === 'B1')?.schedule?.tripPhase).toBe('next');
  });

  it('scopes next/last per direction within the same route', () => {
    // Stop that's the origin for dir 0 AND the terminus for dir 1 of
    // the same route: both directions emit rows in the same scan, but
    // each direction must get its own `next` / `last`. Without
    // direction in the cohort key, an earlier dir-1 arrival would
    // steal `next` from the soonest dir-0 origin departure and leave
    // it classified `later`, hiding its action buttons.
    const out = scanSchedule({
      rows: [
        // dir 0 origin trips: depart 09:20, 09:40 from this stop.
        origin({
          trip_id: 'D0-1',
          direction_id: 0,
          arrival_time: '09:20:00',
          departure_time: '09:20:00',
        }),
        origin({
          trip_id: 'D0-2',
          direction_id: 0,
          arrival_time: '09:40:00',
          departure_time: '09:40:00',
        }),
        // dir 1 terminus trips: started from the other end at 09:00,
        // arrive here at 09:15. tripStartMin (09:00) is smaller than
        // any dir 0 trip's, so without the direction scope this row
        // would win the route-wide `next` slot.
        row({
          trip_id: 'D1-1',
          direction_id: 1,
          arrival_time: '09:15:00',
          departure_time: '09:15:00',
          trip_start_time: '09:00:00',
          stop_sequence: 12,
          last_seq: 12,
          first_seq: 1,
        }),
      ],
      nowMinSinceMidnight: now,
      nowMs,
      windowMinutes: 60,
    });
    expect(out.find((v) => v.tripId === 'D0-1')?.schedule?.tripPhase).toBe('next');
    expect(out.find((v) => v.tripId === 'D0-2')?.schedule?.tripPhase).toBe('later');
    // The dir-1 terminus trip started at 09:00 (past); it's the only
    // trip in its cohort, so it's classified `last` (most recent past
    // departure on dir 1, still running).
    expect(out.find((v) => v.tripId === 'D1-1')?.schedule?.tripPhase).toBe('last');
  });

  it('tie-breaks equal departure times by tripId lexicographic order', () => {
    const out = scanSchedule({
      rows: [
        origin({ trip_id: 'TB', arrival_time: '09:10:00', departure_time: '09:10:00' }),
        origin({ trip_id: 'TA', arrival_time: '09:10:00', departure_time: '09:10:00' }),
      ],
      nowMinSinceMidnight: now,
      nowMs,
      windowMinutes: 60,
    });
    // TA sorts before TB → TA is `next`, TB is `later`.
    expect(out.find((v) => v.tripId === 'TA')?.schedule?.tripPhase).toBe('next');
    expect(out.find((v) => v.tripId === 'TB')?.schedule?.tripPhase).toBe('later');
  });

  it('marks `last` only when there is a past origin departure', () => {
    // Only future origin rows: nobody is `last`.
    const out = scanSchedule({
      rows: [
        origin({ trip_id: 'T1', arrival_time: '09:05:00', departure_time: '09:05:00' }),
        origin({ trip_id: 'T2', arrival_time: '09:20:00', departure_time: '09:20:00' }),
      ],
      nowMinSinceMidnight: now,
      nowMs,
      windowMinutes: 60,
    });
    expect(out.find((v) => v.tripId === 'T1')?.schedule?.tripPhase).toBe('next');
    expect(out.find((v) => v.tripId === 'T2')?.schedule?.tripPhase).toBe('later');
    expect(out.some((v) => v.schedule?.tripPhase === 'last')).toBe(false);
  });

  it('marks `next` only when there is a future origin departure', () => {
    // Only a past origin row still in transit: it's `last`, no `next`.
    const out = scanSchedule({
      rows: [
        origin({
          trip_id: 'T0',
          arrival_time: '08:50:00',
          departure_time: '08:50:00',
          trip_end_time: '09:30:00',
        }),
      ],
      nowMinSinceMidnight: now,
      nowMs,
      windowMinutes: 60,
    });
    expect(out.find((v) => v.tripId === 'T0')?.schedule?.tripPhase).toBe('last');
    expect(out.some((v) => v.schedule?.tripPhase === 'next')).toBe(false);
  });

  it('marks earlier past departures still running as `on-route`', () => {
    // Three trips have already left; all three are still en route (trip_end
    // in the future). Only the most-recent is `last`; the earlier two are
    // `on-route`.
    const out = scanSchedule({
      rows: [
        origin({
          trip_id: 'P1',
          arrival_time: '08:30:00',
          departure_time: '08:30:00',
          trip_end_time: '09:30:00',
        }),
        origin({
          trip_id: 'P2',
          arrival_time: '08:40:00',
          departure_time: '08:40:00',
          trip_end_time: '09:40:00',
        }),
        origin({
          trip_id: 'P3',
          arrival_time: '08:55:00',
          departure_time: '08:55:00',
          trip_end_time: '09:55:00',
        }),
        origin({ trip_id: 'F1', arrival_time: '09:10:00', departure_time: '09:10:00' }),
      ],
      nowMinSinceMidnight: now,
      nowMs,
      windowMinutes: 60,
    });
    expect(out.find((v) => v.tripId === 'P1')?.schedule?.tripPhase).toBe('on-route');
    expect(out.find((v) => v.tripId === 'P2')?.schedule?.tripPhase).toBe('on-route');
    expect(out.find((v) => v.tripId === 'P3')?.schedule?.tripPhase).toBe('last');
    expect(out.find((v) => v.tripId === 'F1')?.schedule?.tripPhase).toBe('next');
  });

  it('bumps confidence to `high` on the `next` origin row', () => {
    const out = scanSchedule({
      rows: [
        origin({ trip_id: 'T1', arrival_time: '09:05:00', departure_time: '09:05:00' }),
        origin({ trip_id: 'T2', arrival_time: '09:20:00', departure_time: '09:20:00' }),
        origin({
          trip_id: 'T0',
          arrival_time: '08:50:00',
          departure_time: '08:50:00',
          trip_end_time: '09:30:00',
        }),
      ],
      nowMinSinceMidnight: now,
      nowMs,
      windowMinutes: 60,
    });
    const t1 = out.find((v) => v.tripId === 'T1')!; // next
    const t2 = out.find((v) => v.tripId === 'T2')!; // later
    const t0 = out.find((v) => v.tripId === 'T0')!; // last
    expect(t1.confidence).toBe('high');
    expect(t1.eta?.confidence).toBe('high');
    expect(t2.confidence).toBe('medium');
    expect(t2.eta?.confidence).toBe('medium');
    expect(t0.confidence).toBe('medium');
    expect(t0.eta?.confidence).toBe('medium');
  });

  it('keeps intermediate-stop rows at low confidence even with a phase set', () => {
    // Non-origin rows now do get a phase (per-row classification), but the
    // confidence bump only fires on origin (`isFirstStop`) rows. So a
    // downstream `next` row still reads at low confidence.
    const out = scanSchedule({
      rows: [
        row({
          trip_id: 'T1',
          arrival_time: '09:10:00',
          stop_sequence: 3,
          first_seq: 1,
          trip_start_time: '09:05:00',
        }),
      ],
      nowMinSinceMidnight: now,
      nowMs,
      windowMinutes: 60,
    });
    expect(out[0].schedule?.tripPhase).toBe('next');
    expect(out[0].confidence).toBe('low');
  });
});
