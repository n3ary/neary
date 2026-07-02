/*
 * Feed bootstrap — OPFS pool setup + per-feed seeding + the live-pipe
 * teardown that has to fire on every feed switch.
 *
 * Public surface:
 *   getPool()       — lazy, idempotent OPFS-SAH pool installer
 *   bootstrap(feed) — seed-or-open + return a per-feed Database
 *   closeCurrent()  — drop the current db, shape cache, and live timer
 *
 * The `setFeed` orchestration (call closeCurrent → bootstrap → start
 * the live timer) lives in the worker's API surface, not here, so
 * this module stays free of cross-concern wiring.
 */

import sqlite3InitModule, {
  type Database,
  type Sqlite3Static,
} from '@sqlite.org/sqlite-wasm';

import type { Feed } from '$lib/data/feeds';
import { opfsFileFor, pruneStaleFeedFiles } from '../opfsFilenames';
import { shapeCache } from './shapeCache';
import { resetLiveSnapshot, stopLiveTimer } from './livePipeline';
import { state } from './state';

// ---------------------------------------------------------------------------
// Source URL resolution per feed.
//
// neary-gtfs publishes to Cloudflare R2 served via the custom domain
// gtfs.n3ary.com. Each feeds.json entry has `files.sqlite_gz` as a
// filename that embeds the first 12 hex chars of the gzipped-blob
// sha256, so the URL is content-addressed: a content change produces
// a new filename, and any cached copy at an old URL is by construction
// still correct for that URL. After first fetch the file lives in OPFS
// so we never re-download unless the hash changes.
// ---------------------------------------------------------------------------

const BINARIES_BASE = 'https://gtfs.n3ary.com';
const OPFS_POOL_NAME = 'neary-gtfs';

// AbortController reasons used across the bootstrap → closeCurrent path.
// String reasons (not DOMExceptions) so error messages stay readable.
const ABORT_REASON_TIMEOUT = 'seed-download-timeout';
const ABORT_REASON_FEED_SWITCH = 'feed-switch-cancelled';

function seedUrlFor(feed: Feed): string {
  if (!feed.files.sqlite_gz) {
    throw new Error(`Feed "${feed.id}" has no sqlite_gz in feeds.json`);
  }
  return `${BINARIES_BASE}/${feed.files.sqlite_gz}`;
}

// ---------------------------------------------------------------------------
// Lazy + feed-aware OPFS-SAH pool. Pool is created once (it persists
// across feed switches — multiple feed files coexist in OPFS). The
// per-feed Database is opened by `bootstrap()` below.
// ---------------------------------------------------------------------------

let poolPromise: Promise<Awaited<ReturnType<Sqlite3Static['installOpfsSAHPoolVfs']>>> | null = null;

export async function getPool() {
  if (poolPromise) return poolPromise;
  poolPromise = (async () => {
    // The published type signature omits the init-options object, but
    // the runtime accepts it for redirecting SQLite's internal logging.
    const initFn = sqlite3InitModule as unknown as (opts: {
      print?: (msg: string) => void;
      printErr?: (msg: string) => void;
    }) => Promise<Sqlite3Static>;
    const sqlite3 = await initFn({
      print: (m: string) => console.log('[gtfs.worker:sqlite]', m),
      printErr: (m: string) => console.error('[gtfs.worker:sqlite]', m),
    });
    // OPFS access-handle pool. SAH is exclusive per-file across the
    // browser, so a stale handle from another tab or a not-yet-GC'd
    // worker can block init. `forceReinitIfPreviouslyFailed` lets a
    // retry attempt re-run init instead of replaying the cached
    // rejection. We also do one in-flight retry against transient
    // races (HMR worker swap, another tab still releasing).
    //
    // `verbosity: 0` silences the pool's own per-file 'storeErr'
    // logging. Those entries are one-per-blocked-slot during init
    // and the pool surfaces the failure as a thrown rejection
    // anyway — we already handle that here with retry + a
    // user-readable error, so the console noise is pure FUD.
    const opts = {
      name: OPFS_POOL_NAME,
      forceReinitIfPreviouslyFailed: true,
      verbosity: 0,
    } as const;
    try {
      return await sqlite3.installOpfsSAHPoolVfs(opts);
    } catch (firstErr) {
      console.warn('[gtfs.worker] OPFS pool init failed, retrying in 250ms…', firstErr);
      await new Promise((r) => setTimeout(r, 250));
      try {
        return await sqlite3.installOpfsSAHPoolVfs(opts);
      } catch (secondErr) {
        throw new Error(
          'Unable to open the offline schedule database. Another browser ' +
          'tab on this site is probably holding the file open — close other ' +
          'Neary tabs and reload. (Underlying: ' +
          (secondErr instanceof Error ? secondErr.message : String(secondErr)) +
          ')',
        );
      }
    }
  })().catch((e) => {
    // Drop the cached rejection so a later setFeed() can try again
    // (e.g. after the user has closed the conflicting tab and tapped
    // the agency picker to retry).
    poolPromise = null;
    throw e;
  });
  return poolPromise;
}

// ---------------------------------------------------------------------------
// Streaming seed pipeline. Peeks the first chunk so we can decide whether
// to run the body through DecompressionStream (some dev servers like Vite's
// sirv auto-decompress `.gz` responses; R2 does not), reports progress over
// the raw compressed bytes, and yields decompressed chunks one at a time so
// the whole 700-MB-plus uncompressed blob is never held in the JS heap.
// ---------------------------------------------------------------------------
async function buildImportStream(
  body: ReadableStream<Uint8Array>,
  reportBytes: (compressedBytesRead: number) => void,
): Promise<ReadableStream<Uint8Array>> {
  const src = body.getReader();
  const first = await src.read();
  if (first.done || !first.value) {
    src.releaseLock();
    throw new Error('Empty response body');
  }
  const firstChunk = first.value;
  const isGzip =
    firstChunk.byteLength >= 2 && firstChunk[0] === 0x1f && firstChunk[1] === 0x8b;

  let compressedTally = firstChunk.byteLength;
  let lastReportMs = 0;
  const REPORT_INTERVAL_MS = 250;
  const maybeReport = (force = false) => {
    const now = performance.now();
    if (force || now - lastReportMs >= REPORT_INTERVAL_MS) {
      reportBytes(compressedTally);
      lastReportMs = now;
    }
  };
  maybeReport(true);

  const rebuilt = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(firstChunk);
    },
    async pull(controller) {
      const { done, value } = await src.read();
      if (done) {
        maybeReport(true);
        controller.close();
        return;
      }
      compressedTally += value.byteLength;
      maybeReport();
      controller.enqueue(value);
    },
    async cancel(reason) {
      try { await src.cancel(reason); } catch {}
    },
  });

  if (!isGzip) return rebuilt;
  // The DOM lib types DecompressionStream's writable as
  // WritableStream<BufferSource>, which TS refuses to unify with our
  // ReadableStream<Uint8Array<ArrayBuffer>>. The runtime does accept
  // Uint8Array — the cast is safe.
  const decompressor = new DecompressionStream('gzip') as unknown as {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  };
  return rebuilt.pipeThrough(decompressor);
}

export async function bootstrap(
  feed: Feed,
  onProgress?: (bytesReceived: number, totalBytes: number | null) => void,
): Promise<Database> {
  const poolUtil = await getPool();
  const opfsFile = opfsFileFor(feed);

  if (!poolUtil.getFileNames().includes(opfsFile)) {
    const url = seedUrlFor(feed);
    console.log(`[gtfs.worker] Seeding OPFS for feed ${feed.id} from`, url);
    // 10-minute hard timeout: covers the ~122 MB Swiss feed on a slow
    // connection with headroom. Without this, a stalled fetch would
    // hang forever with no user-visible signal — precisely the class
    // of failure that made large feeds appear "silently empty".
    //
    // The controller is also stored on `state.currentDownloadAbort`
    // so `closeCurrent()` can cancel an in-flight download when the
    // user switches feeds mid-stream (issue #148). Different abort
    // reasons let the catch block produce accurate error prefixes.
    const controller = new AbortController();
    state.currentDownloadAbort = controller;
    const timeoutId = setTimeout(() => controller.abort(ABORT_REASON_TIMEOUT), 10 * 60_000);
    const clearDownloadState = () => {
      clearTimeout(timeoutId);
      if (state.currentDownloadAbort === controller) {
        state.currentDownloadAbort = null;
      }
    };
    const abortPrefix = (fallback: string) => {
      if (!controller.signal.aborted) return fallback;
      switch (controller.signal.reason) {
        case ABORT_REASON_TIMEOUT:
          return `Seed download for feed "${feed.id}" timed out`;
        case ABORT_REASON_FEED_SWITCH:
          return `Seed download for feed "${feed.id}" was cancelled (feed switched)`;
        default:
          return `Seed download for feed "${feed.id}" was aborted`;
      }
    };
    let res: Response;
    try {
      res = await fetch(url, { signal: controller.signal });
    } catch (e) {
      clearDownloadState();
      throw new Error(`${abortPrefix(`Seed download for feed "${feed.id}" failed with network error`)}: ${(e as Error).message}`);
    }
    if (!res.ok || !res.body) {
      clearDownloadState();
      throw new Error(`Seed download for feed "${feed.id}" failed (HTTP ${res.status})`);
    }

    // The uncompressed Swiss sqlite is ~778 MB. Buffering it in the
    // worker heap before calling importDb pushes iOS Safari past its
    // per-tab ceiling and the tab is killed. Instead: pipe fetch →
    // (optional) DecompressionStream → importDb's chunked-callback
    // form, so at any moment we only hold one stream chunk (~64 KB)
    // beyond what SQLite writes to the SAH file. Content-Length comes
    // from R2's response; progress is reported over compressed bytes
    // (matches the UI's byte-count convention).
    const totalHeader = res.headers.get('content-length');
    const totalBytes = totalHeader ? Number(totalHeader) : null;

    let compressedRead = 0;
    const decompressed = await buildImportStream(res.body, (compressedBytes) => {
      compressedRead = compressedBytes;
      if (!onProgress) return;
      try { onProgress(compressedBytes, Number.isFinite(totalBytes) ? totalBytes : null); } catch {}
    });

    const reader = decompressed.getReader();
    let imported = 0;
    console.log(`[gtfs.worker] Streaming import into ${opfsFile}…`);
    try {
      await poolUtil.importDb(opfsFile, async () => {
        // Bail cheaply if the user switched feeds mid-import. SAH pool
        // writes aren't cancellable, but returning undefined here stops
        // any further writes and the outer catch cleans up the OPFS file.
        if (controller.signal.aborted) throw new Error(String(controller.signal.reason ?? 'aborted'));
        const { done, value } = await reader.read();
        if (done) return undefined;
        imported += value.byteLength;
        return value;
      });
    } catch (e) {
      clearDownloadState();
      try { await reader.cancel(); } catch {}
      // Best-effort cleanup: leave nothing partial in OPFS so a retry
      // isn't blocked by a corrupt file that seems to already exist.
      try { poolUtil.unlink(opfsFile); } catch {}
      throw new Error(`${abortPrefix(`Import into OPFS failed for feed "${feed.id}"`)}: ${(e as Error).message}`);
    }
    clearDownloadState();
    console.log(`[gtfs.worker] Imported ${imported} bytes into ${opfsFile}`);
    // Truncation guard. importDb only checks that the total bytes written
    // is >=512 and a multiple of 512; a short-but-page-aligned read can
    // therefore slip through and produce an OPFS file that opens cleanly
    // but has empty data pages (the downstream integrity check catches
    // this, but only after we've marked the file as available). Compare
    // what we actually pulled off the wire against Content-Length so we
    // fail fast, unlink the partial file, and force a fresh re-download.
    if (
      totalBytes !== null &&
      Number.isFinite(totalBytes) &&
      compressedRead < totalBytes
    ) {
      try { poolUtil.unlink(opfsFile); } catch {}
      throw new Error(
        `Seed download for feed "${feed.id}" was truncated: received ${compressedRead} of ${totalBytes} compressed bytes`,
      );
    }
    // After a successful import, drop any older snapshot of THIS feed
    // so OPFS doesn't fill with one file per upstream rebuild.
    const removed = pruneStaleFeedFiles(poolUtil, feed.id, opfsFile);
    if (removed > 0) console.log(`[gtfs.worker] Pruned ${removed} stale OPFS file(s) for ${feed.id}`);
  }

  let db: Database | undefined;
  try {
    db = new poolUtil.OpfsSAHPoolDb(opfsFile);
    db.exec('PRAGMA query_only = 1;');
    // Integrity check: a truncated or empty file may open cleanly but
    // return zero rows, presenting as "search shows no results". If
    // the schedule table is empty, treat as corrupt and force a
    // re-download on the next attempt.
    const hasTable = db.selectValue('SELECT count(*) FROM sqlite_master WHERE type=\'table\' AND name=\'stop_times\'') as number | null;
    if (hasTable !== 1) {
      throw new Error('sqlite is missing the stop_times table (schema mismatch or truncated import)');
    }
    const hasRows = db.selectValue('SELECT EXISTS(SELECT 1 FROM stop_times LIMIT 1)') as 0 | 1;
    if (!hasRows) {
      throw new Error('stop_times is empty (truncated import or upstream produced an empty feed)');
    }
  } catch (e) {
    try { db?.close(); } catch {}
    try { poolUtil.unlink(opfsFile); } catch {}
    throw new Error(`Feed "${feed.id}" failed integrity check: ${(e as Error).message}`);
  }
  return db;
}

/** Close the currently-open DB, if any. The OPFS file stays put.
 *  Also clears feed-scoped caches and stops the live timer so a
 *  feed switch can't briefly broadcast stale vehicles. Listeners
 *  on the live pipeline are intentionally NOT cleared — they belong
 *  to the main-side store which survives feed switches. */
export function closeCurrent(): void {
  // Cancel any seed download that's still in flight for the outgoing
  // feed (issue #148). The bootstrap() catch handles cleanup of the
  // partial OPFS file; here we only trip the signal.
  if (state.currentDownloadAbort) {
    try {
      state.currentDownloadAbort.abort(ABORT_REASON_FEED_SWITCH);
    } catch (e) {
      console.warn('[gtfs.worker] aborting in-flight seed download failed', e);
    }
    state.currentDownloadAbort = null;
  }
  if (state.currentDb) {
    try {
      state.currentDb.close();
    } catch (e) {
      console.warn('[gtfs.worker] db.close() failed', e);
    }
    state.currentDb = null;
  }
  state.currentFeedTz = null;
  state.bootstrapping = null;
  // Shape polylines are feed-scoped — invalidate so the next feed
  // can't see stale entries from this one.
  shapeCache.clear();
  // Live-pipeline state is feed-scoped too: stop the timer and drop
  // the cached snapshot so the next feed doesn't briefly broadcast
  // stale vehicles.
  stopLiveTimer();
  resetLiveSnapshot();
}
