/**
 * GTFS Schedule Pipeline — Netlify scheduled function.
 *
 * Runs daily to fetch the public Cluj GTFS static feed, extract the relevant
 * CSV files in-memory, transform them into a compact JSON payload, and store
 * the result in Netlify Blobs for CDN delivery at `/data/schedule.json`.
 *
 * Design reference: .kiro/specs/gtfs-schedule-integration/design.md
 *   (Server-Side: Schedule Pipeline)
 *
 * This file is the SCAFFOLD only. It implements:
 *   - The scheduled function configuration (`@daily`)
 *   - GTFS ZIP fetching with a size guard
 *   - In-memory ZIP decompression via `fflate`
 *   - All-or-nothing error handling (previous blob is retained on failure)
 *
 * Downstream tasks fill the marked TODO seams:
 *   - Task 2.2: CSV parsing + transformation into `SchedulePayload`
 *   - Task 2.3: Netlify Blobs storage of the compact JSON
 */

import { getStore } from '@netlify/blobs';
import { unzipSync } from 'fflate';
import type { CompactSchedulePayload } from '../../src/types/schedule';
import { transformToPayload } from '../../src/utils/schedule/pipelineTransform';
import { compactifySchedule } from '../../src/utils/schedule/schedulePayloadCodec';

// ============================================================================
// Configuration
// ============================================================================

/** Netlify scheduled function configuration — runs once per day. */
export const config = {
  schedule: '@daily',
};

/** Public Cluj GTFS static feed (CC-BY-SA-4.0). */
const GTFS_FEED_URL = 'https://external.gtfs.ro/cluj/CLUJ.zip';

/**
 * Maximum allowed size of the GTFS ZIP archive (50 MB).
 * Guards against memory exhaustion in the serverless environment.
 */
const MAX_ZIP_SIZE_BYTES = 50 * 1024 * 1024;

/**
 * GTFS CSV files the pipeline extracts from the archive.
 * Only stop_times.txt and trips.txt are strictly required; calendar.txt and
 * calendar_dates.txt are OPTIONAL per the GTFS spec (the Cluj feed ships only
 * calendar.txt, for example). Missing optional files are simply skipped.
 */
const REQUIRED_GTFS_FILES = ['stop_times.txt', 'trips.txt'] as const;
const OPTIONAL_GTFS_FILES = ['calendar.txt', 'calendar_dates.txt'] as const;
const GTFS_FILES = [...REQUIRED_GTFS_FILES, ...OPTIONAL_GTFS_FILES] as const;

/**
 * Netlify Blobs store + key holding the compact schedule payload.
 *
 * These two literals are the single source of truth for where the payload
 * lives. They MUST stay in sync with the serving function
 * (`netlify/functions/schedule-serve.mts`), which reads the same store/key and
 * exposes it at the public `/data/schedule.json` URL via a netlify.toml rewrite.
 */
const SCHEDULE_BLOB_STORE = 'schedule';
const SCHEDULE_BLOB_KEY = 'current';

const LOG_PREFIX = '[SchedulePipeline]';

// ============================================================================
// Handler
// ============================================================================

export default async function handler(): Promise<Response> {
  try {
    // 1. Fetch the GTFS ZIP archive.
    const zipBytes = await fetchGtfsZip();

    // 2. Decompress the archive in-memory and pull out the required CSVs.
    const csvFiles = extractRequiredFiles(zipBytes);

    // 3. Transform the CSVs into the (expanded) SchedulePayload, then compact
    //    it for delivery. Pure logic lives in src/utils/schedule/ so it can be
    //    unit- and property-tested independently of this runtime.
    const payload = transformToPayload(csvFiles);

    if (!payload || Object.keys(payload.stopTimes).length === 0) {
      // All-or-nothing: nothing is written unless transformation yields trips.
      throw new Error('Transformation produced an empty payload');
    }

    // Deduplicate into the compact CDN format (~194 patterns vs ~14.7k trips
    // for Cluj → ~90% smaller download + localStorage footprint).
    const compact: CompactSchedulePayload = compactifySchedule(payload);

    // 4. Persist the compact JSON to Netlify Blobs (served at
    //    `/data/schedule.json`). Only reached after a fully successful fetch +
    //    transform, so the previous valid blob is retained on any earlier failure.
    await persistPayload(compact);

    return jsonResponse(200, {
      ok: true,
      version: compact.version,
      tripCount: Object.keys(compact.trips).length,
      patternCount: compact.patterns.length,
    });
  } catch (error) {
    // All-or-nothing write strategy: on any failure we do NOT touch the blob
    // store, so the previously published schedule.json remains available.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${LOG_PREFIX} pipeline run failed, retaining previous blob:`, message);

    return jsonResponse(500, {
      ok: false,
      error: message,
      note: 'Previous schedule blob retained (all-or-nothing write).',
    });
  }
}

// ============================================================================
// Fetching
// ============================================================================

/**
 * Fetches the GTFS ZIP archive and enforces the size guard.
 * Throws if the request fails or the archive exceeds {@link MAX_ZIP_SIZE_BYTES}.
 */
async function fetchGtfsZip(): Promise<Uint8Array> {
  console.log(`${LOG_PREFIX} fetching GTFS feed: ${GTFS_FEED_URL}`);

  const response = await fetch(GTFS_FEED_URL);

  if (!response.ok) {
    throw new Error(`GTFS fetch failed: ${response.status} ${response.statusText}`);
  }

  // Early guard using the advertised content length when present.
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_ZIP_SIZE_BYTES) {
    throw new Error(
      `GTFS archive too large: ${contentLength} bytes exceeds ${MAX_ZIP_SIZE_BYTES} byte limit`,
    );
  }

  const buffer = new Uint8Array(await response.arrayBuffer());

  // Authoritative guard against the actual downloaded size (headers can lie or
  // be absent for chunked responses).
  if (buffer.byteLength > MAX_ZIP_SIZE_BYTES) {
    throw new Error(
      `GTFS archive too large: ${buffer.byteLength} bytes exceeds ${MAX_ZIP_SIZE_BYTES} byte limit`,
    );
  }

  console.log(`${LOG_PREFIX} fetched ${buffer.byteLength} bytes`);
  return buffer;
}

// ============================================================================
// Decompression
// ============================================================================

/**
 * Decompresses the ZIP archive in-memory and returns the decoded text of each
 * GTFS CSV file present, keyed by filename. Throws if a REQUIRED file
 * (stop_times.txt, trips.txt) is missing; optional files (calendar.txt,
 * calendar_dates.txt) are skipped when absent.
 */
function extractRequiredFiles(zipBytes: Uint8Array): Record<string, string> {
  const unzipped = unzipSync(zipBytes, {
    filter: (file) => (GTFS_FILES as readonly string[]).includes(file.name),
  });

  const decoder = new TextDecoder('utf-8');
  const files: Record<string, string> = {};

  for (const name of GTFS_FILES) {
    const bytes = unzipped[name];
    if (bytes) {
      files[name] = decoder.decode(bytes);
    } else if ((REQUIRED_GTFS_FILES as readonly string[]).includes(name)) {
      throw new Error(`Required GTFS file missing from archive: ${name}`);
    }
    // Missing optional file -> skipped; the transform defaults it to empty.
  }

  console.log(`${LOG_PREFIX} extracted ${Object.keys(files).length} CSV files`);
  return files;
}

// ============================================================================
// Transformation
// ============================================================================
//
// CSV parsing and compaction into the SchedulePayload lives in the shared,
// testable module `src/utils/schedule/pipelineTransform.ts` (imported above as
// `transformToPayload`). Keeping it out of this runtime file lets task 2.4's
// property test exercise the transform directly.

// ============================================================================
// Persistence
// ============================================================================

/**
 * Persists the compact JSON payload to Netlify Blobs.
 *
 * All-or-nothing semantics: this is only invoked after a fully successful
 * fetch + transform (the handler throws before reaching here on any failure or
 * on an empty payload). A single overwrite of the `current` key in the
 * `schedule` store replaces the previously published data atomically — if this
 * run never gets here, the prior blob stays untouched and continues serving.
 *
 * Serving mechanism: Netlify Blobs are NOT publicly addressable on their own —
 * they are only reachable through the SDK from a function or edge runtime.
 * To expose the payload at the CDN URL `/data/schedule.json` (which the client
 * `scheduleStore` fetches), a companion serving function
 * (`netlify/functions/schedule-serve.mts`) reads this same store/key and a
 * netlify.toml rewrite maps `/data/schedule.json` → that function. We use a
 * rewrite-to-function rather than any "built-in" blob URL because Netlify Blobs
 * does not provide direct public HTTP access.
 */
async function persistPayload(payload: CompactSchedulePayload): Promise<void> {
  const store = getStore(SCHEDULE_BLOB_STORE);
  await store.setJSON(SCHEDULE_BLOB_KEY, payload);
  console.log(
    `${LOG_PREFIX} wrote payload to blobs store "${SCHEDULE_BLOB_STORE}" key "${SCHEDULE_BLOB_KEY}" (version ${payload.version})`,
  );
}

// ============================================================================
// Helpers
// ============================================================================

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
