/*
 * appUpdate.ts — option-2 update flow: never reload a tab the rider
 * is looking at.
 *
 * SvelteKit's version poll flips `updated.current` when a new deploy
 * is live (see svelte.config.js `kit.version`). Previously the root
 * layout reloaded immediately — which yanked the Stations board out
 * from under a rider mid-read, the "app opens, then reloads a few
 * seconds later" complaint. Now the layout delegates here:
 *
 *   - tab hidden  → reload immediately; the rider comes back to the
 *                   new version and never sees an interruption.
 *   - tab visible → show a prompt banner with a manual Reload, and
 *                   keep watching `visibilitychange`; the first
 *                   backgrounding applies the update silently.
 *
 * Re-nag suppression: after ACTING on an update (any reload path),
 * stay quiet for UPDATE_REACT_GRACE_MS even if the poll still reports
 * a mismatch. The served shell legitimately lags the live
 * version.json — the new SW may still be installing (precaching is
 * slow on patchy signal) or the runtime HTML cache refresh may not
 * have landed yet — so an immediate re-prompt means "the update
 * couldn't apply", not "there's another update". Reloading again
 * can't help; nagging is worse. (Before this, the banner reappeared
 * within a minute of the reload it asked for.)
 *
 * The env seam (isHidden / onVisibilityChange / reload / showPrompt /
 * now / readLastActedAt / writeLastActedAt) keeps the module DOM-free
 * so the flow is unit-testable in node.
 */

export interface AppUpdateEnv {
  isHidden(): boolean;
  /** Register a visibility watcher; must return an unsubscribe. */
  onVisibilityChange(cb: () => void): () => void;
  reload(): void;
  /** Show the manual-update prompt. Receives the flow's own reload —
   *  the UI must call THIS (not a bare location.reload) or the grace
   *  window never learns the user acted and the banner returns. */
  showPrompt(reload: () => void): void;
  /** Clock + persistence for the grace window. Optional: without
   *  persistence there is no suppression (legacy behavior). */
  now?(): number;
  readLastActedAt?(): number | null;
  writeLastActedAt?(ts: number): void;
}

/** See the file header. 30 min is far longer than any honest SW
 *  install takes, short enough that a genuinely missed update still
 *  surfaces the same day. */
export const UPDATE_REACT_GRACE_MS = 30 * 60_000;

/**
 * Run the update flow once `updated.current` is true. Returns the
 * visibility-listener unsubscribe when a prompt was shown (the caller
 * uses it as its effect cleanup), nothing when it reloaded outright
 * or the grace window suppressed the flow.
 */
export function handleAppUpdate(env: AppUpdateEnv): (() => void) | void {
  const now = () => env.now?.() ?? Date.now();
  const lastActedAt = env.readLastActedAt?.() ?? null;
  if (lastActedAt != null && now() - lastActedAt < UPDATE_REACT_GRACE_MS) {
    return; // recently acted — suppress both prompt and auto-reload
  }
  const actAndReload = () => {
    env.writeLastActedAt?.(now());
    env.reload();
  };
  if (env.isHidden()) {
    actAndReload();
    return;
  }
  env.showPrompt(actAndReload);
  return env.onVisibilityChange(() => {
    if (env.isHidden()) actAndReload();
  });
}
