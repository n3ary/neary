import { describe, it, expect } from 'vitest';
import { parseCsv, transformToPayload, GTFS_FILENAMES } from '../../../utils/schedule/pipelineTransform';

const STOP_TIMES = `trip_id,arrival_time,departure_time,stop_id,stop_sequence
T1,05:05:00,05:05:00,4521,0
T1,05:08:00,05:08:00,4522,1
T1,05:12:00,05:13:00,4523,2
T2,25:30:00,25:31:00,9001,0`;

const CALENDAR = `service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date
Mon-Fri,1,1,1,1,1,0,0,20250101,20251231
Weekend,0,0,0,0,0,1,1,20250101,20251231`;

const CALENDAR_DATES = `service_id,date,exception_type
Mon-Fri,20250501,2
Weekend,20250501,1`;

const TRIPS = `route_id,service_id,trip_id,trip_headsign
24,Mon-Fri,T1,Center
24,Weekend,T2,Center`;

function files(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    [GTFS_FILENAMES.stopTimes]: STOP_TIMES,
    [GTFS_FILENAMES.calendar]: CALENDAR,
    [GTFS_FILENAMES.calendarDates]: CALENDAR_DATES,
    [GTFS_FILENAMES.trips]: TRIPS,
    ...overrides,
  };
}

describe('parseCsv', () => {
  it('parses headers and rows keyed by header', () => {
    const { headers, rows } = parseCsv('a,b,c\n1,2,3\n4,5,6');
    expect(headers).toEqual(['a', 'b', 'c']);
    expect(rows).toEqual([
      { a: '1', b: '2', c: '3' },
      { a: '4', b: '5', c: '6' },
    ]);
  });

  it('handles quoted fields containing commas and escaped quotes', () => {
    const { rows } = parseCsv('name,note\n"Cluj, RO","a ""quoted"" word"');
    expect(rows[0]).toEqual({ name: 'Cluj, RO', note: 'a "quoted" word' });
  });

  it('handles CRLF line endings and a leading BOM', () => {
    const { headers, rows } = parseCsv('\uFEFFa,b\r\n1,2\r\n');
    expect(headers).toEqual(['a', 'b']);
    expect(rows).toEqual([{ a: '1', b: '2' }]);
  });

  it('tolerates columns in any order via header keys', () => {
    const { rows } = parseCsv('b,a\nx,y');
    expect(rows[0]).toEqual({ a: 'y', b: 'x' });
  });
});

describe('transformToPayload', () => {
  const fixedNow = new Date('2025-01-15T03:00:00.000Z');

  it('keys stop times by trip_id with compact fields and minute encoding', () => {
    const payload = transformToPayload(files(), fixedNow);
    expect(payload.stopTimes['T1']).toEqual([
      { s: 4521, q: 0, a: 305, d: 305 },
      { s: 4522, q: 1, a: 308, d: 308 },
      { s: 4523, q: 2, a: 312, d: 313 },
    ]);
    // Overnight trip preserved beyond 24:00.
    expect(payload.stopTimes['T2']).toEqual([{ s: 9001, q: 0, a: 1530, d: 1531 }]);
  });

  it('orders stop times within a trip by stop_sequence', () => {
    const shuffled = `trip_id,arrival_time,departure_time,stop_id,stop_sequence
T1,05:12:00,05:13:00,4523,2
T1,05:05:00,05:05:00,4521,0
T1,05:08:00,05:08:00,4522,1`;
    const payload = transformToPayload(files({ [GTFS_FILENAMES.stopTimes]: shuffled }), fixedNow);
    expect(payload.stopTimes['T1'].map((st) => st.q)).toEqual([0, 1, 2]);
  });

  it('builds calendar entries with weekday booleans and date ranges', () => {
    const payload = transformToPayload(files(), fixedNow);
    expect(payload.calendar).toContainEqual({
      serviceId: 'Mon-Fri',
      monday: true,
      tuesday: true,
      wednesday: true,
      thursday: true,
      friday: true,
      saturday: false,
      sunday: false,
      startDate: '20250101',
      endDate: '20251231',
    });
  });

  it('builds calendar exceptions with typed exception kinds', () => {
    const payload = transformToPayload(files(), fixedNow);
    expect(payload.calendarExceptions).toEqual([
      { serviceId: 'Mon-Fri', date: '20250501', exceptionType: 2 },
      { serviceId: 'Weekend', date: '20250501', exceptionType: 1 },
    ]);
  });

  it('builds tripServiceMap for every trip', () => {
    const payload = transformToPayload(files(), fixedNow);
    expect(payload.tripServiceMap).toEqual({ T1: 'Mon-Fri', T2: 'Weekend' });
  });

  it('stamps an ISO version timestamp', () => {
    const payload = transformToPayload(files(), fixedNow);
    expect(payload.version).toBe('2025-01-15T03:00:00.000Z');
  });

  it('falls back to the present time when one of arrival/departure is empty', () => {
    const partial = `trip_id,arrival_time,departure_time,stop_id,stop_sequence
T1,,05:05:00,4521,0`;
    const payload = transformToPayload(files({ [GTFS_FILENAMES.stopTimes]: partial }), fixedNow);
    expect(payload.stopTimes['T1']).toEqual([{ s: 4521, q: 0, a: 305, d: 305 }]);
  });

  it('throws when a required file is missing', () => {
    const incomplete = files();
    delete incomplete[GTFS_FILENAMES.trips];
    expect(() => transformToPayload(incomplete, fixedNow)).toThrow(/trips\.txt/);
  });

  it('treats calendar_dates.txt as optional (Cluj feed omits it)', () => {
    const without = files();
    delete without[GTFS_FILENAMES.calendarDates];
    const payload = transformToPayload(without, fixedNow);
    expect(payload.calendarExceptions).toEqual([]);
    // calendar + stop times still parsed normally
    expect(payload.calendar.length).toBeGreaterThan(0);
    expect(Object.keys(payload.stopTimes).length).toBeGreaterThan(0);
  });

  it('treats calendar.txt as optional', () => {
    const without = files();
    delete without[GTFS_FILENAMES.calendar];
    const payload = transformToPayload(without, fixedNow);
    expect(payload.calendar).toEqual([]);
    expect(Object.keys(payload.stopTimes).length).toBeGreaterThan(0);
  });
});
