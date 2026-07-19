/**
 * locationStore.test.ts — the persistence wiring behind the stalled-GPS
 * fallback, and the retry() used by the escape card. geolocation +
 * permissions + localStorage are stubbed; the module is re-imported
 * per test so the singleton is constructed against the stubs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type GeoSuccess = (pos: GeolocationPosition) => void;
type GeoError = (err: GeolocationPositionError) => void;

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

function stubGeo() {
  const captured: { success?: GeoSuccess; error?: GeoError } = {};
  const watchPosition = vi.fn((s: GeoSuccess, e?: GeoError) => {
    captured.success = s;
    captured.error = e;
    return 42;
  });
  const clearWatch = vi.fn();
  const getCurrentPosition = vi.fn();
  const permissionsQuery = vi.fn(async () => ({
    state: 'prompt',
    addEventListener: () => {},
    removeEventListener: () => {},
    onchange: null,
  }));
  vi.stubGlobal('navigator', {
    geolocation: { watchPosition, clearWatch, getCurrentPosition },
    permissions: { query: permissionsQuery },
  });
  return { captured, watchPosition, clearWatch };
}

const FIX = {
  coords: {
    latitude: 46.7712,
    longitude: 23.6236,
    accuracy: 10,
    altitude: null,
    altitudeAccuracy: null,
    heading: null,
    speed: null,
  },
  timestamp: Date.now(),
} as GeolocationPosition;

let storage: ReturnType<typeof makeStorage>;

beforeEach(() => {
  storage = makeStorage();
  vi.stubGlobal('localStorage', storage);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('locationStore', () => {
  it('persists every fix as the last known position', async () => {
    const geo = stubGeo();
    const { locationStore } = await import('./locationStore.svelte.js');

    locationStore.enable();
    expect(geo.watchPosition).toHaveBeenCalledTimes(1);

    geo.captured.success!(FIX);

    const stored = JSON.parse(storage._store.get('neary-last-position')!);
    expect(stored.lat).toBe(46.7712);
    expect(stored.lon).toBe(23.6236);
    expect(typeof stored.t).toBe('number');
    expect(locationStore.position?.coords.latitude).toBe(46.7712);
  });

  it('retry() drops the watch and error state and re-registers', async () => {
    const geo = stubGeo();
    const { locationStore } = await import('./locationStore.svelte.js');

    locationStore.enable();
    geo.captured.error!({ code: 3, message: 'Timeout' } as GeolocationPositionError);
    expect(locationStore.error).not.toBeNull();

    locationStore.retry();

    expect(locationStore.error).toBeNull();
    expect(geo.clearWatch).toHaveBeenCalledWith(42);
    expect(geo.watchPosition).toHaveBeenCalledTimes(2);
  });
});
