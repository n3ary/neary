/**
 * Shared GTFS schedule pipeline core (server-only).
 *
 * Contains the fetch → unzip → transform → persist logic for ONE agency, plus a
 * driver that runs it for every agency in the {@link AGENCY_FEEDS} registry.
 * Both Netlify functions reuse this:
 *   - `schedule-pipeline.mts`        — the daily scheduled run (all agencies).
 *   - `schedule-pipeline-trigger.mts`— an HTTP-invocable manual run (for seeding
 *     a fresh deploy / forcing a refresh without waiting for `@daily`).
 *
 * This module imports `@netlify/blobs` and `fflate`, so it is server-only and
 * must never be pulled into the client bundle (only the two functions import
 * it).
 *
 * Per-agency all-or-nothing: a failure for one agency (fetch, transform, or
 * empty payload) leaves THAT agency's previously published blob untouched and
 * does not abort the other agencies.
 */

import { getStore } from '@netlify/blobs';
import { unzipSync } from 'fflate';
import type { CompactSchedulePayload } from '../../src/types/schedule';
import { transformToPayload } from '../../src/utils/schedule/pipelineTransform';
import { compactifySchedule } from '../../src/utils/schedule/schedulePayloadCodec';
import {
  AGENCY_FEEDS,
  scheduleBlobKey,
  type AgencyFeed,
} from '../../src/utils/schedule/agencyFeeds';

/** Netlify Blobs store holding every agency's compact schedule payload. */
export const SCHEDULE_BLOB_STORE = 'schedule';

/**
 * Maximum allowed size of a GTFS ZIP archive (50 MB). Guards against memory
 * exhaustion in the serverless environment.
 */
const MAX_ZIP_SIZE_BYTES = 50 * 1024 * 1024;

/** GTFS CSV files extracted from each archive. */
const REQUIRED_GTFS_FILES = ['stop_times.txt', 'trips.txt'] as const;
const OPTIONAL_GTFS_FILES = ['calendar.txt', 'calendar_dates.txt'] as const;
const GTFS_FILES = [...REQUIRED_GTFS_FILES, ...OPTIONAL_GTFS_FILES] as const;

const LOG_PREFIX = '[SchedulePipeline]';

/** Outcome of a single agency's pipeline run. */
export interface AgencyPipelineResult {
  agencyId: number;
  name: string;
  ok: boolean;
  /** Populated on success. */
  version?: string;
  tripCount?: number;
  patternCount?: number;
  /** Populated on failure. */
  error?: string;
}

/**
 * Run the pipeline for every registered agency. Each agency is independent —
 * one failure never blocks the others (per-agency all-or-nothing write).
 */
export async function runSchedulePipeline(): Promise<AgencyPipelineResult[]> {
  const results: AgencyPipelineResult[] = [];
  for (const feed of AGENCY_FEEDS) {
    results.push(await runAgencyPipeline(feed));
  }
  return results;
}

/**
 * Run the pipeline for a single agency. Never throws — failures are captured in
 * the returned result and the agency's previous blob is left intact.
 */
export async function runAgencyPipeline(feed: AgencyFeed): Promise<AgencyPipelineResult> {
  try {
    const zipBytes = await fetchGtfsZip(feed);
    const csvFiles = extractRequiredFiles(zipBytes);
    const payload = transformToPayload(csvFiles);

    if (!payload || Object.keys(payload.stopTimes).length === 0) {
      throw new Error('Transformation produced an empty payload');
    }

    const compact: CompactSchedulePayload = compactifySchedule(payload);
    // Stamp the agency id so the client can detect and self-heal a cache that
    // belongs to a different agency (e.g. after the user switches agency).
    compact.agencyId = feed.agencyId;

    await persistPayload(feed.agencyId, compact);

    return {
      agencyId: feed.agencyId,
      name: feed.name,
      ok: true,
      version: compact.version,
      tripCount: Object.keys(compact.trips).length,
      patternCount: compact.patterns.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `${LOG_PREFIX} agency ${feed.agencyId} (${feed.name}) failed, retaining previous blob:`,
      message,
    );
    return { agencyId: feed.agencyId, name: feed.name, ok: false, error: message };
  }
}

/** Fetch an agency's GTFS ZIP archive and enforce the size guard. */
async function fetchGtfsZip(feed: AgencyFeed): Promise<Uint8Array> {
  console.log(`${LOG_PREFIX} agency ${feed.agencyId}: fetching ${feed.feedUrl}`);

  const response = await fetch(feed.feedUrl);
  if (!response.ok) {
    throw new Error(`GTFS fetch failed: ${response.status} ${response.statusText}`);
  }

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_ZIP_SIZE_BYTES) {
    throw new Error(
      `GTFS archive too large: ${contentLength} bytes exceeds ${MAX_ZIP_SIZE_BYTES} byte limit`,
    );
  }

  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > MAX_ZIP_SIZE_BYTES) {
    throw new Error(
      `GTFS archive too large: ${buffer.byteLength} bytes exceeds ${MAX_ZIP_SIZE_BYTES} byte limit`,
    );
  }

  console.log(`${LOG_PREFIX} agency ${feed.agencyId}: fetched ${buffer.byteLength} bytes`);
  return buffer;
}

/**
 * Decompress the ZIP in-memory and return the decoded text of each GTFS CSV
 * present. Throws if a REQUIRED file is missing; optional files are skipped.
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
  }

  return files;
}

/**
 * Persist an agency's compact payload to Netlify Blobs. Only reached after a
 * fully successful fetch + transform, so a failed run leaves the prior blob
 * serving (all-or-nothing).
 */
async function persistPayload(agencyId: number, payload: CompactSchedulePayload): Promise<void> {
  const store = getStore(SCHEDULE_BLOB_STORE);
  const key = scheduleBlobKey(agencyId);
  await store.setJSON(key, payload);
  console.log(
    `${LOG_PREFIX} agency ${agencyId}: wrote blob "${SCHEDULE_BLOB_STORE}/${key}" (version ${payload.version})`,
  );
}
