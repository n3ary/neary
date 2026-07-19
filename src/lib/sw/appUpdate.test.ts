import { describe, expect, it, vi } from 'vitest';
import { handleAppUpdate, UPDATE_REACT_GRACE_MS, type AppUpdateEnv } from './appUpdate';

function makeEnv(initialHidden: boolean) {
  const state = { hidden: initialHidden };
  const cbs: Array<() => void> = [];
  const env: AppUpdateEnv = {
    isHidden: () => state.hidden,
    onVisibilityChange: (cb) => {
      cbs.push(cb);
      return () => {
        const i = cbs.indexOf(cb);
        if (i >= 0) cbs.splice(i, 1);
      };
    },
    reload: vi.fn(),
    showPrompt: vi.fn(),
  };
  const fireVisibility = () => cbs.forEach((cb) => cb());
  return { state, cbs, env, fireVisibility };
}

describe('handleAppUpdate', () => {
  it('reloads immediately when the tab is already hidden — no prompt, no listener', () => {
    const { env, cbs } = makeEnv(true);
    const cleanup = handleAppUpdate(env);
    expect(env.reload).toHaveBeenCalledTimes(1);
    expect(env.showPrompt).not.toHaveBeenCalled();
    expect(cbs).toHaveLength(0);
    expect(cleanup).toBeUndefined();
  });

  it('shows the prompt without reloading when the tab is visible', () => {
    const { env } = makeEnv(false);
    handleAppUpdate(env);
    expect(env.showPrompt).toHaveBeenCalledTimes(1);
    expect(env.reload).not.toHaveBeenCalled();
  });

  it('applies the update on the first backgrounding after the prompt', () => {
    const { env, state, fireVisibility } = makeEnv(false);
    handleAppUpdate(env);
    state.hidden = true;
    fireVisibility();
    expect(env.reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload while the tab stays visible', () => {
    const { env, fireVisibility } = makeEnv(false);
    handleAppUpdate(env);
    fireVisibility(); // e.g. a bfcache/pageshow-style event while visible
    expect(env.reload).not.toHaveBeenCalled();
  });

  it('stops watching after cleanup — no reload on later backgrounding', () => {
    const { env, state, fireVisibility } = makeEnv(false);
    const cleanup = handleAppUpdate(env);
    cleanup?.();
    state.hidden = true;
    fireVisibility();
    expect(env.reload).not.toHaveBeenCalled();
  });
});

describe('re-nag suppression (grace window)', () => {
  const NOW = 1_700_000_000_000;

  function makePersistentEnv(initialHidden: boolean, lastActedAt: number | null) {
    const base = makeEnv(initialHidden);
    const store = { lastActedAt };
    const env: AppUpdateEnv = {
      ...base.env,
      now: () => NOW,
      readLastActedAt: () => store.lastActedAt,
      writeLastActedAt: (ts) => {
        store.lastActedAt = ts;
      },
    };
    return { ...base, env, store };
  }

  it('suppresses the flow entirely when the user acted within the grace window', () => {
    const { env, cbs } = makePersistentEnv(true, NOW - 60_000);
    const cleanup = handleAppUpdate(env);
    expect(env.reload).not.toHaveBeenCalled();
    expect(env.showPrompt).not.toHaveBeenCalled();
    expect(cbs).toHaveLength(0); // no visibility watcher either
    expect(cleanup).toBeUndefined();
  });

  it('suppresses the prompt for a visible tab within the grace window', () => {
    const { env } = makePersistentEnv(false, NOW - 60_000);
    handleAppUpdate(env);
    expect(env.showPrompt).not.toHaveBeenCalled();
    expect(env.reload).not.toHaveBeenCalled();
  });

  it('acts normally once the last action ages out of the grace window', () => {
    const { env } = makePersistentEnv(true, NOW - UPDATE_REACT_GRACE_MS - 1000);
    handleAppUpdate(env);
    expect(env.reload).toHaveBeenCalledTimes(1);
  });

  it('records the action when reloading a hidden tab', () => {
    const { env, store } = makePersistentEnv(true, null);
    handleAppUpdate(env);
    expect(env.reload).toHaveBeenCalledTimes(1);
    expect(store.lastActedAt).toBe(NOW);
  });

  it('records the action when the backgrounding watcher fires', () => {
    const { env, state, fireVisibility, store } = makePersistentEnv(false, null);
    handleAppUpdate(env);
    state.hidden = true;
    fireVisibility();
    expect(store.lastActedAt).toBe(NOW);
  });

  it('hands the prompt a reload that records the action (manual Reload button)', () => {
    const { env, store } = makePersistentEnv(false, null);
    handleAppUpdate(env);
    const promptReload = vi.mocked(env.showPrompt).mock.calls[0]?.[0];
    expect(typeof promptReload).toBe('function');
    promptReload!();
    expect(store.lastActedAt).toBe(NOW);
    expect(env.reload).toHaveBeenCalledTimes(1);
  });
});
