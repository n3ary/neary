/**
 * lastKnownPosition.test.ts — the persistence behind the stalled-GPS
 * fallback. localStorage is stubbed on globalThis.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { readLastKnownPosition, writeLastKnownPosition } from './lastKnownPosition.js';

function makeStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    _store: store,
  };
}

let storage: ReturnType<typeof makeStorage>;

beforeEach(() => {
  storage = makeStorage();
  vi.stubGlobal('localStorage', storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('lastKnownPosition', () => {
  it('round-trips a fix', () => {
    writeLastKnownPosition(46.7712, 23.6236);

    const got = readLastKnownPosition();

    expect(got?.lat).toBe(46.7712);
    expect(got?.lon).toBe(23.6236);
    expect(typeof got?.t).toBe('number');
  });

  it('returns null when nothing is stored', () => {
    expect(readLastKnownPosition()).toBeNull();
  });

  it('returns null on corrupt JSON', () => {
    storage._store.set('neary-last-position', '{oops');
    expect(readLastKnownPosition()).toBeNull();
  });

  it('returns null on a wrong-shaped entry', () => {
    storage._store.set('neary-last-position', JSON.stringify({ lat: 'x', lon: 23, t: 1 }));
    expect(readLastKnownPosition()).toBeNull();
    storage._store.set('neary-last-position', JSON.stringify([46.77, 23.62]));
    expect(readLastKnownPosition()).toBeNull();
  });

  it('is SSR-safe: no localStorage means null and a no-op write', () => {
    vi.unstubAllGlobals();
    expect(readLastKnownPosition()).toBeNull();
    expect(() => writeLastKnownPosition(46.77, 23.62)).not.toThrow();
  });
});
