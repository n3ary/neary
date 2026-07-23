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
import { feedDbFiles, opfsFileFor, pruneStaleFeedFiles } from '../opfsFilenames';
import { shapeCache } from './shapeCache';
import { resetLiveSnapshot, stopLiveTimer } from './livePipeline';
import { state } from './state';

// ------------------------------------------------------------------------
// Source URL resolution per feed.
//
// gtfs publishes to Cloudflare R2 served via the custom domain
// gtfs.n3ary.com. Each feeds.json entry has `files.sqlite_gz` as a
// filename that embeds the first 12 hex chars of the gzipped-blob
// sha256, so the URL is content-addressed: a content change produces
// a new filename, and any cached copy at an old URL is by construction
// still correct for that URL. After first fetch the file lives in OPFS
// so we never re-download unless the hash changes.
// ------------------------------------------------------------------------

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

// ------------------------------------------------------------------------
// Lazy + feed-aware OPFS-SAH pool. Pool is created once (it persists
// across feed switches — multiple feed files coexist in OPFS). The
// per-feed Database is opened by `bootstrap()` below.
// ------------------------------------------------------------------------

let poolPromise: Promise<Awaited<ReturnType<Sqlite3Static['installOpfsSAHPoolVfs']>>> | null = null;

/** Bound on OPFS access-handle acquisition. A contested handle
 *  (another tab, a frozen zombie session from a previous instance)
 *  leaves `createSyncAccessHandle` pending forever — without a
 *  timeout the whole bootstrap hangs silently and the page sits on a
 *  permanent loading state. 10 s is far above honest acquisition
 *  time and well under the boot watchdog's stall window. */
const SAH_ACQUIRE_TIMEOUT_MS = 10_000;

/** No single stream read may take this long. A half-dead socket that
 *  stops delivering mid-body fails the attempt (and retries on a
 *  fresh connection) instead of hanging until the overall timeout. */
const SEED_READ_STALL_MS = 20_000;

/** Rejects with a descriptive error if `p` doesn't settle within `ms`.
 *  The wrapped promise is left to settle on its own; callers treat the
 *  operation as failed and retry (the pool init is re-entrant via
 *  `forceReinitIfPreviouslyFailed`). */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)),
        ms,
      ),
    ),
  ]);
}

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
      return await withTimeout(
        sqlite3.installOpfsSAHPoolVfs(opts),
        SAH_ACQUIRE_TIMEOUT_MS,
        'OPFS access-handle acquisition',
      );
    } catch (firstErr) {
      console.warn('[gtfs.worker] OPFS pool init failed, retrying in 250ms…', firstErr);
      await new Promise((r) => setTimeout(r, 250));
      try {
        return await withTimeout(
          sqlite3.installOpfsSAHPoolVfs(opts),
          SAH_ACQUIRE_TIMEOUT_MS,
          'OPFS access-handle acquisition',
        );
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
    // the feed picker to retry).
    poolPromise = null;
    throw e;
  });
  return poolPromise;
}

// ------------------------------------------------------------------------
// Streaming seed pipeline. Peeks the first chunk so we can decide whether
// to run the body through DecompressionStream (some dev servers like Vite's
// sirv auto-decompress `.gz` responses; R2 does not), reports progress over
// the raw compressed bytes, and yields decompressed chunks one at a time so
// the whole 700-MB-plus uncompressed blob is never held in the JS heap.
//
// Granularity tuning: SAH pool's importDb chunked-callback form has a fixed
// per-callback cost (JS↔WASM crossing + JS function call + await). At the
// fetch default chunk size (~64 KB) the callback count on a multi-hundred-MB
// uncompressed blob runs into the tens of thousands, and most of the
// wall-clock time goes to the callback overhead rather than the actual SAH
// writes. We coalesce the decompressed stream up to CHUNK_COALESCE_BYTES
// (~16 MB) before importDb, dropping the callback count by ~3 orders of
// magnitude. The compressed side gets a higher highWaterMark so
// DecompressionStream receives compressed inputs in ~1 MB batches (its
// native block size), gzip-decoding more efficiently. Peak worker heap =
// one ~16 MB coalesced chunk + DecompressionStream's own small internal
// buffer (~17 MB total) — still well under iOS Safari's per-tab ceiling
// and orders of magnitude below what buffering the whole blob would need.
// ------------------------------------------------------------------------
const CHUNK_COALESCE_BYTES = 16 * 1024 * 1024;
const COMPRESSED_HIGHWATERMARK_BYTES = 1024 * 1024;

function makeChunkCoalescer(
  maxBytes: number,
): TransformStream<Uint8Array, Uint8Array> {
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  const flush = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (pendingBytes === 0) return;
    if (pending.length === 1) {
      controller.enqueue(pending[0]);
    } else {
      const merged = new Uint8Array(pendingBytes);
      let off = 0;
      for (const c of pending) {
        merged.set(c, off);
        off += c.byteLength;
      }
      controller.enqueue(merged);
    }
    pending = [];
    pendingBytes = 0;
  };
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending.push(chunk);
      pendingBytes += chunk.byteLength;
      if (pendingBytes >= maxBytes) flush(controller);
    },
    flush(controller) {
      flush(controller);
    },
  });
}

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

  const rebuilt = new ReadableStream<Uint8Array>(
    {
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
        try {
          await src.cancel(reason);
        } catch {}
      },
    },
    {
      // Byte-based highWaterMark so DecompressionStream sees compressed
      // input in ~1 MB batches instead of one fetch chunk (~64 KB) at a
      // time — gzip's deflate blocks work best on bigger windows.
      highWaterMark: COMPRESSED_HIGHWATERMARK_BYTES,
      size: (chunk) => chunk.byteLength,
    },
  );

  const coalescer = makeChunkCoalescer(CHUNK_COALESCE_BYTES);
  if (!isGzip) return rebuilt.pipeThrough(coalescer);
  // The DOM lib types DecompressionStream's writable as
  // WritableStream<BufferSource>, which TS refuses to unify with our
  // ReadableStream<Uint8Array<ArrayBuffer>>. The runtime does accept
  // Uint8Array — the cast is safe.
  const decompressor = new DecompressionStream('gzip') as unknown as {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  };
  return rebuilt.pipeThrough(decompressor).pipeThrough(coalescer);
}

/** Download the seed blob for `feed` and stream-import it into OPFS
 *  as `opfsFile`, pruning older snapshots of the same feed on success.
 *  Throws — leaving no partial file behind — on network, import, or
 *  truncation failure. Extracted from bootstrap() so the seed step can
 *  be wrapped in a single try/catch whose fallback opens a previous
 *  OPFS generation when the network is unreachable. */
async function downloadSeed(
  poolUtil: Awaited<ReturnType<typeof getPool>>,
  feed: Feed,
  opfsFile: string,
  onProgress?: (bytesReceived: number, totalBytes: number | null) => void,
): Promise<void> {
  const url = seedUrlFor(feed);
  console.log(`[gtfs.worker] Seeding OPFS for feed ${feed.id} from`, url);
  // 10-minute hard timeout: covers the largest published sqlite_gz
  // (currently ~120 MB compressed) on a slow connection with
  // headroom. Without this, a stalled fetch would hang forever with
  // no user-visible signal — precisely the class of failure that
  // made large feeds appear "silently empty".
  //
  // The controller is also stored on `state.currentDownloadAbort`
  // so `closeCurrent()` can cancel an in-flight download when the
  // user switches feeds mid-stream. Different abort
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

  // Retry the WHOLE download — connect failures AND mid-body stream
  // failures alike. On patchy signal a socket dies mid-body at least
  // as often as at connect time, and previously the streaming phase
  // had no retry at all. Restarting from byte 0 is wasteful but
  // correct (importDb writes the sqlite in one streaming pass, so a
  // Range resume isn't an option); the per-read stall bound keeps
  // each doomed attempt cheap. 5 attempts with backoff, bounded
  // overall by the 10-minute abort above.
  const MAX_ATTEMPTS = 5;
  const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000];
  let lastError: Error | null = null;
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (controller.signal.aborted) break;
      try {
        await downloadSeedAttempt(poolUtil, feed, url, opfsFile, controller, onProgress);
        return;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        // Our own aborts (10-min timeout, feed switch/suspend) and
        // explicitly non-retryable failures (e.g. HTTP 0) surface
        // immediately, with the accurate abort prefix.
        if (controller.signal.aborted || (err as { retryable?: boolean }).retryable === false) {
          throw new Error(abortPrefix(err.message));
        }
        lastError = err;
        console.warn(
          `[gtfs.worker] ${feed.id}: seed attempt ${attempt}/${MAX_ATTEMPTS} failed: ${err.message}`,
        );
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt - 1] ?? 8_000));
        }
      }
    }
    throw new Error(
      abortPrefix(lastError?.message ?? `Seed download for feed "${feed.id}" failed`),
    );
  } finally {
    clearDownloadState();
  }
}

/** One seed-download attempt: fetch, stream (with a per-read stall
 *  bound), import, truncation check, stale-file prune. Throws raw
 *  (unprefixed) errors; the caller decides retry vs. abort-prefix. */
async function downloadSeedAttempt(
  poolUtil: Awaited<ReturnType<typeof getPool>>,
  feed: Feed,
  url: string,
  opfsFile: string,
  controller: AbortController,
  onProgress?: (bytesReceived: number, totalBytes: number | null) => void,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (e) {
    throw new Error(`Seed download for feed "${feed.id}" failed with network error: ${(e as Error).message}`);
  }
  if (!res.ok) {
    const err = new Error(`Seed download for feed "${feed.id}" failed (HTTP ${res.status})`) as Error & { retryable?: boolean };
    // Status 0 (opaque failure) never improves on retry.
    if (res.status === 0) err.retryable = false;
    throw err;
  }
  if (!res.body) {
    throw new Error(`Seed download for feed "${feed.id}" returned empty body (HTTP ${res.status})`);
  }

  // The largest published feeds uncompress to multi-hundred-MB sqlite
  // blobs. Buffering the full blob in the worker heap before calling
  // importDb pushes iOS Safari past its per-tab ceiling and the tab is
  // killed. Instead: pipe fetch → (optional) DecompressionStream →
  // importDb's chunked-callback form, so at any moment we only hold
  // one stream chunk (~64 KB) beyond what SQLite writes to the SAH
  // file. Content-Length comes from R2's response; progress is
  // reported over compressed bytes (matches the UI's byte-count
  // convention).
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
      // Per-read stall bound: a half-dead socket that stops delivering
      // mid-body would otherwise hang until the 10-minute overall
      // abort — 20 s without a chunk fails the attempt so the retry
      // loop can try a fresh connection (and the boot watchdog's
      // progress beats keep flowing on patchy signal).
      const { done, value } = await withTimeout(
        reader.read(),
        SEED_READ_STALL_MS,
        `Seed download for feed "${feed.id}" stalled (no data)`,
      );
      if (done) return undefined;
      imported += value.byteLength;
      return value;
    });
  } catch (e) {
    try { await reader.cancel(); } catch {}
    // Best-effort cleanup: leave nothing partial in OPFS so a retry
    // isn't blocked by a corrupt file that seems to already exist.
    try { poolUtil.unlink(opfsFile); } catch {}
    throw new Error(`Import into OPFS failed for feed "${feed.id}": ${(e as Error).message}`);
  }
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

export async function bootstrap(
  feed: Feed,
  onProgress?: (bytesReceived: number, totalBytes: number | null) => void,
): Promise<Database> {
  const poolUtil = await getPool();
  // Resume from a background suspend: re-acquire the access handles
  // suspendForBackground() released. Contention gets the same bound
  // as initial acquisition so a zombie holder can't hang the resume.
  if (poolUtil.isPaused()) {
    await withTimeout(poolUtil.unpauseVfs(), SAH_ACQUIRE_TIMEOUT_MS, 'OPFS pool unpause');
  }
  let opfsFile = opfsFileFor(feed);

  if (!poolUtil.getFileNames().includes(opfsFile)) {
    try {
      await downloadSeed(poolUtil, feed, opfsFile, onProgress);
    } catch (e) {
      // The registry the app binds against can name a build newer than
      // anything on the device: the SW's feeds.json runtime cache
      // refreshes in the background, so it can sit one nightly publish
      // ahead of the downloaded sqlite. Offline the re-download always
      // fails — but an older snapshot of the same feed may still be in
      // OPFS, and a day-old schedule beats a dead app. The wanted file
      // is never a candidate (a failed import already unlinked it), so
      // any match is by construction a previous generation.
      const fallback = feedDbFiles(poolUtil, feed.id).find((name) => name !== opfsFile);
      if (!fallback) throw e;
      console.warn(
        `[gtfs.worker] Seed for feed "${feed.id}" unavailable (${(e as Error).message}); ` +
        `falling back to previous OPFS snapshot ${fallback}`,
      );
      opfsFile = fallback;
    }
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
    // Soft-probe for `frequencies` (added by gtfs-publisher#252). Cached
    // blobs that pre-date the DDL addition report false; the
    // per-time query modules gate the expansion path on this flag so
    // the app degrades to schedule-only behaviour without throwing.
    // The flag is consumed by `state.currentFeedHasFrequencies`, set
    // by the caller below.
    const hasFrequencies = (db.selectValue(
      `SELECT count(*) FROM sqlite_master WHERE type='table' AND name='frequencies'`,
    ) as number) === 1;
    // Lift the probe into the worker state so the per-time query
    // modules can read it without re-running the PRAGMA on every
    // call. Read by the frequency-expansion gate in
    // `frequencyExpansion.ts` callers (activeTrips, stationArrivals,
    // routeSchedule, routeMapView, weeklySchedule).
    state.currentFeedHasFrequencies = hasFrequencies;
  } catch (e) {
    try { db?.close(); } catch {}
    try { poolUtil.unlink(opfsFile); } catch {}
    throw new Error(`Feed "${feed.id}" failed integrity check: ${(e as Error).message}`);
  }
  return db;
}

/** Cache-introspection helpers — list / delete the OPFS files belonging
 *  to a feed without booting it. Drives the trash button on the
 *  Settings feed picker; intentionally cheap so the UI can poll after
 *  each delete + feed-registry refresh.
 *
 *  Naming intentionally matches `pruneStaleFeedFiles`'s
 *  legacy + versioned match rule so deleting and then re-adding a
 *  feed on the same id can't strand files we don't recognise. */
export async function getCachedFeedIds(feeds: readonly Feed[]): Promise<string[]> {
  const poolUtil = await getPool();
  const names = new Set(poolUtil.getFileNames());
  const ids: string[] = [];
  for (const feed of feeds) {
    if (names.has(opfsFileFor(feed))) ids.push(feed.id);
  }
  return ids;
}

/** Remove every OPFS file belonging to `feed.id` (legacy + every
 *  hash-versioned snapshot). Returns the number of files removed.
 *  If the feed is the active one, `closeCurrent()` runs first so
 *  the next call into the worker doesn't try to reopen a file the
 *  pool has just dropped under it. Safe to call when the feed was
 *  never bootstrapped — `pruneStaleFeedFiles` is a no-op then. */
export async function deleteFeedCache(feed: Feed): Promise<number> {
  if (state.currentFeedId === feed.id) closeCurrent();
  const poolUtil = await getPool();
  return pruneStaleFeedFiles(poolUtil, feed.id, '/__never_exists__');
}

/** Close the currently-open DB, if any. The OPFS file stays put.
 *  Also clears feed-scoped caches and stops the live timer so a
 *  feed switch can't briefly broadcast stale vehicles. Listeners
 *  on the live pipeline are intentionally NOT cleared — they belong
 *  to the main-side store which survives feed switches. */
export function closeCurrent(): void {
  // Cancel any seed download that's still in flight for the outgoing
  // feed. The bootstrap() catch handles cleanup of the
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
  state.currentFeedRtUrl = null;
  state.currentFeedHasFrequencies = false;
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

/** Background suspend. Closes the current DB (and aborts any in-flight
 *  seed download) via closeCurrent(), then releases the SAH pool's OPFS
 *  sync-access handles so this session — likely about to be frozen by
 *  the OS — never blocks another instance's bootstrap. Without this, a
 *  frozen-but-not-killed page keeps the handles indefinitely and the
 *  next cold start's pool init hangs (or, with SAH_ACQUIRE_TIMEOUT_MS,
 *  fails) until the user fully kills the app. The OPFS files stay put;
 *  bootstrap() unpauses the pool and re-opens the DB on resume, so a
 *  resume costs a pool re-acquire + DB open, not a re-seed.
 *
 *  Best-effort and idempotent — safe to call on every backgrounding,
 *  including mid-bootstrap: the aborted bootstrap is awaited so no Db
 *  can be opened after the pause (pauseVfs requires all DBs closed). */
export async function suspendForBackground(): Promise<void> {
  // Capture before closeCurrent() nulls it.
  const inFlight = state.bootstrapping;
  closeCurrent();
  if (inFlight) {
    try {
      await inFlight;
    } catch {
      // Aborted by closeCurrent() — expected.
    }
  }
  if (!poolPromise) return; // pool never created — nothing holds handles
  const poolUtil = await poolPromise;
  if (!poolUtil.isPaused()) {
    try {
      poolUtil.pauseVfs();
    } catch (e) {
      console.warn('[gtfs.worker] pauseVfs failed', e);
    }
  }
}
