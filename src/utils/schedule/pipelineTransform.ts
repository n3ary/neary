/**
 * GTFS CSV parsing and compaction into the {@link SchedulePayload}.
 *
 * This module holds the PURE transformation logic for the schedule pipeline so
 * it can be unit- and property-tested without the Netlify runtime. The
 * server-side scheduled function (`netlify/functions/schedule-pipeline.mts`)
 * imports {@link transformToPayload} and supplies the extracted CSV text.
 *
 * Responsibilities:
 *   - Parse the four required GTFS CSV files (RFC 4180-style quoting).
 *   - Convert `HH:MM:SS` times to minutes-since-midnight integers.
 *   - Build `stopTimes` keyed by trip_id (ordered by stop_sequence), the
 *     `calendar` and `calendarExceptions` arrays, and the `tripServiceMap`.
 *   - Stamp the payload with an ISO `version` timestamp.
 *
 * Design reference: .kiro/specs/gtfs-schedule-integration/design.md
 *   (Server-Side: Schedule Pipeline, Compact JSON Format, Property 1)
 */

import type {
  CalendarEntry,
  CalendarException,
  ScheduleStopTime,
  SchedulePayload,
} from '../../types/schedule';
import { gtfsTimeToMinutes } from './timeEncoding';

/** Filenames the transform expects to be present in the CSV map. */
export const GTFS_FILENAMES = {
  stopTimes: 'stop_times.txt',
  calendar: 'calendar.txt',
  calendarDates: 'calendar_dates.txt',
  trips: 'trips.txt',
} as const;

/** A parsed CSV table: ordered header names plus row records keyed by header. */
interface ParsedCsv {
  headers: string[];
  rows: Array<Record<string, string>>;
}

// ============================================================================
// CSV parsing
// ============================================================================

/**
 * Parse CSV text into header-keyed row records.
 *
 * Supports the subset of RFC 4180 used by GTFS feeds:
 *   - Comma field separator
 *   - Double-quoted fields that may contain commas, newlines, and escaped
 *     quotes (`""`)
 *   - `\n` and `\r\n` line endings
 *   - A leading UTF-8 BOM (stripped)
 *
 * Blank trailing lines are ignored. Rows with fewer columns than the header
 * are padded with empty strings; extra columns are dropped.
 */
export function parseCsv(text: string): ParsedCsv {
  const records = tokenizeCsv(text);
  if (records.length === 0) {
    return { headers: [], rows: [] };
  }

  const headers = records[0].map((h) => h.trim());
  const rows: Array<Record<string, string>> = [];

  for (let i = 1; i < records.length; i++) {
    const fields = records[i];
    // Skip fully blank lines (single empty field from a trailing newline).
    if (fields.length === 1 && fields[0] === '') continue;

    const row: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      row[headers[c]] = fields[c] ?? '';
    }
    rows.push(row);
  }

  return { headers, rows };
}

/**
 * Tokenize CSV text into an array of records, each an array of raw field
 * strings. Handles quoting, escaped quotes, and embedded newlines.
 */
function tokenizeCsv(text: string): string[][] {
  // Strip a leading UTF-8 BOM if present.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          // Escaped quote.
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      record.push(field);
      field = '';
    } else if (char === '\n') {
      record.push(field);
      records.push(record);
      field = '';
      record = [];
    } else if (char === '\r') {
      // Swallow CR; the following LF (if any) finalizes the record.
      if (input[i + 1] !== '\n') {
        record.push(field);
        records.push(record);
        field = '';
        record = [];
      }
    } else {
      field += char;
    }
  }

  // Flush the final field/record if the file did not end with a newline.
  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  return records;
}

// ============================================================================
// Transformation
// ============================================================================

/**
 * Transform the extracted GTFS CSV files into the compact
 * {@link SchedulePayload}.
 *
 * @param csvFiles Map of GTFS filename → raw CSV text (as produced by the
 *   pipeline's `extractRequiredFiles`)
 * @param now Processing timestamp source (injectable for deterministic tests);
 *   defaults to the current time
 * @returns The assembled compact payload
 * @throws If a required CSV file is missing from `csvFiles`
 */
export function transformToPayload(
  csvFiles: Record<string, string>,
  now: Date = new Date(),
): SchedulePayload {
  // Only stop_times.txt and trips.txt are strictly required. Per the GTFS spec,
  // calendar.txt and calendar_dates.txt are optional and many real feeds (e.g.
  // Cluj) ship only one of them — treat missing ones as empty rather than
  // failing the whole pipeline.
  requireFile(csvFiles, GTFS_FILENAMES.stopTimes);
  requireFile(csvFiles, GTFS_FILENAMES.trips);

  const stopTimes = buildStopTimes(csvFiles[GTFS_FILENAMES.stopTimes]);
  const calendarCsv = csvFiles[GTFS_FILENAMES.calendar];
  const calendar = calendarCsv ? buildCalendar(calendarCsv) : [];
  const calendarDatesCsv = csvFiles[GTFS_FILENAMES.calendarDates];
  const calendarExceptions = calendarDatesCsv
    ? buildCalendarExceptions(calendarDatesCsv)
    : [];
  const tripServiceMap = buildTripServiceMap(csvFiles[GTFS_FILENAMES.trips]);
  const tripRouteMap = buildTripRouteMap(csvFiles[GTFS_FILENAMES.trips]);
  const tripHeadsignMap = buildTripHeadsignMap(csvFiles[GTFS_FILENAMES.trips]);

  return {
    version: now.toISOString(),
    stopTimes,
    calendar,
    calendarExceptions,
    tripServiceMap,
    tripRouteMap,
    tripHeadsignMap,
  };
}

function requireFile(csvFiles: Record<string, string>, name: string): void {
  if (typeof csvFiles[name] !== 'string') {
    throw new Error(`Missing required GTFS file for transformation: ${name}`);
  }
}

/**
 * Build the `stopTimes` record keyed by trip_id. Each trip's stop times are
 * ordered by `stop_sequence` ascending. When only one of arrival/departure is
 * present for a row, the present value is used for both.
 */
function buildStopTimes(
  csv: string,
): Record<string, ScheduleStopTime[]> {
  const { rows } = parseCsv(csv);
  const stopTimes: Record<string, ScheduleStopTime[]> = {};

  for (const row of rows) {
    const tripId = row['trip_id'];
    if (!tripId) continue;

    const arrivalRaw = row['arrival_time']?.trim() ?? '';
    const departureRaw = row['departure_time']?.trim() ?? '';

    // GTFS allows empty times at non-timepoint stops; fall back to whichever
    // value is present. Skip rows that have neither.
    const arrivalSource = arrivalRaw || departureRaw;
    const departureSource = departureRaw || arrivalRaw;
    if (!arrivalSource || !departureSource) continue;

    const stopTime: ScheduleStopTime = {
      s: Number(row['stop_id']),
      q: Number(row['stop_sequence']),
      a: gtfsTimeToMinutes(arrivalSource),
      d: gtfsTimeToMinutes(departureSource),
    };

    (stopTimes[tripId] ??= []).push(stopTime);
  }

  for (const tripId of Object.keys(stopTimes)) {
    stopTimes[tripId].sort((left, right) => left.q - right.q);
  }

  return stopTimes;
}

/** Parse a GTFS `0`/`1` flag into a boolean (anything other than `1` is false). */
function parseFlag(value: string | undefined): boolean {
  return value?.trim() === '1';
}

/** Build the `calendar` array from calendar.txt. */
function buildCalendar(csv: string): CalendarEntry[] {
  const { rows } = parseCsv(csv);
  const entries: CalendarEntry[] = [];

  for (const row of rows) {
    const serviceId = row['service_id'];
    if (!serviceId) continue;

    entries.push({
      serviceId,
      monday: parseFlag(row['monday']),
      tuesday: parseFlag(row['tuesday']),
      wednesday: parseFlag(row['wednesday']),
      thursday: parseFlag(row['thursday']),
      friday: parseFlag(row['friday']),
      saturday: parseFlag(row['saturday']),
      sunday: parseFlag(row['sunday']),
      startDate: row['start_date']?.trim() ?? '',
      endDate: row['end_date']?.trim() ?? '',
    });
  }

  return entries;
}

/** Build the `calendarExceptions` array from calendar_dates.txt. */
function buildCalendarExceptions(csv: string): CalendarException[] {
  const { rows } = parseCsv(csv);
  const exceptions: CalendarException[] = [];

  for (const row of rows) {
    const serviceId = row['service_id'];
    if (!serviceId) continue;

    const exceptionType = Number(row['exception_type']) === 2 ? 2 : 1;
    exceptions.push({
      serviceId,
      date: row['date']?.trim() ?? '',
      exceptionType,
    });
  }

  return exceptions;
}

/** Build the `tripServiceMap` (trip_id → service_id) from trips.txt. */
function buildTripServiceMap(csv: string): Record<string, string> {
  const { rows } = parseCsv(csv);
  const map: Record<string, string> = {};

  for (const row of rows) {
    const tripId = row['trip_id'];
    const serviceId = row['service_id'];
    if (!tripId || !serviceId) continue;
    map[tripId] = serviceId;
  }

  return map;
}

/**
 * Build the `tripRouteMap` (trip_id → route_id) from trips.txt.
 *
 * This is the AUTHORITATIVE trip→route association from the GTFS feed. The
 * client relies on it (not the partial Tranzy `/trips` set, which only returns
 * currently-relevant trips) to associate scheduled trips with their route.
 */
function buildTripRouteMap(csv: string): Record<string, number> {
  const { rows } = parseCsv(csv);
  const map: Record<string, number> = {};

  for (const row of rows) {
    const tripId = row['trip_id'];
    const routeRaw = row['route_id']?.trim();
    if (!tripId || !routeRaw) continue;
    const routeId = Number(routeRaw);
    if (Number.isFinite(routeId)) map[tripId] = routeId;
  }

  return map;
}

/**
 * Build the `tripHeadsignMap` (trip_id → trip_headsign) from trips.txt.
 *
 * The GTFS headsign is the trip's direction-specific destination text. The
 * client uses it so a scheduled departure shows its OWN destination rather than
 * a heuristic (e.g. the last stop's name, which can collide with other routes).
 */
function buildTripHeadsignMap(csv: string): Record<string, string> {
  const { rows } = parseCsv(csv);
  const map: Record<string, string> = {};

  for (const row of rows) {
    const tripId = row['trip_id'];
    const headsign = row['trip_headsign']?.trim();
    if (!tripId || !headsign) continue;
    map[tripId] = headsign;
  }

  return map;
}
