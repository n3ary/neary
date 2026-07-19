/*
 * bootWatchdog.ts — decision core for the boot-stall watchdog.
 *
 * The inline copy of this logic lives in src/app.html and MUST stay
 * in sync — it is duplicated there deliberately: the watchdog has to
 * run even when the JS bundle itself fails to load (precache evicted,
 * stalled chunk fetch, SW asset mismatch), which is exactly the
 * failure class it exists to catch. Only the decision function is
 * shared-shaped so the behavior is unit-testable; the DOM/timer
 * plumbing stays inline.
 *
 * Policy: when a boot (or resume re-bind) doesn't reach a healthy
 * state within BOOT_STALL_MS, auto-reload — but only
 * BOOT_MAX_AUTO_RELOADS times within BOOT_RELOAD_WINDOW_MS, then stop
 * reloading and show a blocking overlay with a manual Reload button.
 * The budget breaks crash-loops (a persistent failure — offline with
 * an evicted precache, a deploy whose assets never arrived — would
 * otherwise reload forever and burn data).
 */

export const BOOT_STALL_MS = 15_000;
/** Longer window while a feed bind is in flight: a seed download on
 *  patchy signal can legitimately go tens of seconds without a byte
 *  (per-read stall bound + retry backoff), and progress beats only
 *  fire on bytes received. 60 s tolerates the worst honest beat gap
 *  (20 s read stall + retry delay + reconnect) with headroom, while
 *  still bounding a genuinely wedged bind to about a minute. */
export const BOOT_BIND_STALL_MS = 60_000;
export const BOOT_MAX_AUTO_RELOADS = 2;
export const BOOT_RELOAD_WINDOW_MS = 10 * 60_000;

export type BootAction = 'reload' | 'overlay';

/** Given the timestamps of recent auto-reloads, decide what a stall
 *  should do now. Callers record a timestamp only when they actually
 *  reload. */
export function decideBootAction(
  reloadTimestamps: readonly number[],
  nowMs: number,
): BootAction {
  const recent = reloadTimestamps.filter((t) => nowMs - t < BOOT_RELOAD_WINDOW_MS);
  return recent.length < BOOT_MAX_AUTO_RELOADS ? 'reload' : 'overlay';
}
