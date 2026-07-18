/**
 * feeds.test.ts — unit tests for the registry fetch, in particular the
 * localStorage fallback that keeps offline cold-starts able to bind a
 * feed whose sqlite is already in OPFS. fetch + localStorage are
 * stubbed on globalThis (the module guards both with `typeof` checks,
 * so the stub presence alone flips the behavior on).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { fetchFeeds, FEEDS_REGISTRY_URL } from './feeds.js';

const REGISTRY_PAYLOAD = {
  version: '1',
  generated_at: '2026-07-18T00:00:00Z',
  feeds: [{ id: 'cluj-napoca', hash: 'sha256-aaaa1111bbbb' }],
};

function makeLocalStorageStub() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    _store: store,
  };
}

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

let storage: ReturnType<typeof makeLocalStorageStub>;

beforeEach(() => {
  storage = makeLocalStorageStub();
  vi.stubGlobal('localStorage', storage);
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetchFeeds', () => {
  it('returns the live registry and persists it on success', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(okResponse(REGISTRY_PAYLOAD));

    const feeds = await fetchFeeds();

    expect(feeds).toEqual(REGISTRY_PAYLOAD.feeds);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith(FEEDS_REGISTRY_URL, {
      cache: 'no-cache',
    });
    const persisted = JSON.parse(storage._store.get('neary-feeds-registry')!);
    expect(persisted.feeds).toEqual(REGISTRY_PAYLOAD.feeds);
  });

  it('falls back to the persisted registry when the network fails', async () => {
    storage._store.set('neary-feeds-registry', JSON.stringify(REGISTRY_PAYLOAD));
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new TypeError('Load failed'));

    const feeds = await fetchFeeds();

    expect(feeds).toEqual(REGISTRY_PAYLOAD.feeds);
  });

  it('falls back to the persisted registry on a non-ok response', async () => {
    storage._store.set('neary-feeds-registry', JSON.stringify(REGISTRY_PAYLOAD));
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response('oops', { status: 500 }));

    const feeds = await fetchFeeds();

    expect(feeds).toEqual(REGISTRY_PAYLOAD.feeds);
  });

  it('throws the original error when no persisted copy exists', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new TypeError('Load failed'));

    await expect(fetchFeeds()).rejects.toThrow('Load failed');
  });

  it('throws the original error when the persisted copy is corrupt', async () => {
    storage._store.set('neary-feeds-registry', 'not json {');
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new TypeError('Load failed'));

    await expect(fetchFeeds()).rejects.toThrow('Load failed');
  });
});
