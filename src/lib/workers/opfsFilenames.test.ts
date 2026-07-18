import { describe, it, expect } from 'vitest';
import {
  feedDbFiles,
  opfsFileFor,
  opfsFileForLegacy,
  pruneStaleFeedFiles,
  type SahPoolLike,
} from './opfsFilenames';
import type { Feed } from '$lib/data/feeds';

function feed(overrides: Partial<Feed> = {}): Feed {
  return {
    id: 'cluj-napoca',
    name: 'Cluj-Napoca',
    country: 'RO',
    timezone: 'Europe/Bucharest',
    bbox: { minLat: 0, minLon: 0, maxLat: 1, maxLon: 1 },
    center: { lat: 0, lon: 0 },
    agencies: [],
    source: { type: 'remote', publisher: 'cluj-napoca-gtfs-adapter' },
    files: {
      sqlite_gz: 'cluj-napoca.sqlite3.gz',
      gtfs_zip: 'cluj-napoca.gtfs.zip',
    },
    size_bytes: { sqlite_gz: 1, gtfs_zip: 2 },
    hash: 'sha256-79e19efee5c2bc6926b9f9fda62ea140cafe4ade86d943a2c9831fbcf94ed8bb',
    generated_at: '2026-06-27T14:43:04.671Z',
    license: { attribution_text: '' },
    ...overrides,
  };
}

/** In-memory stand-in for the SQLite-WASM SAHPoolUtil. */
function fakePool(initial: string[]): SahPoolLike & { files: Set<string> } {
  const files = new Set(initial);
  return {
    files,
    getFileNames: () => Array.from(files),
    unlink: (name) => files.delete(name),
  };
}

describe('opfsFileFor', () => {
  it('builds a hash-suffixed filename from feed.hash', () => {
    expect(opfsFileFor(feed())).toBe('/cluj-napoca-79e19efee5c2.sqlite3');
  });

  it('strips the sha256- prefix before slicing', () => {
    const f = feed({ hash: 'sha256-abcdef0123456789' });
    expect(opfsFileFor(f)).toBe('/cluj-napoca-abcdef012345.sqlite3');
  });

  it('falls back to the legacy unsuffixed name when hash is missing', () => {
    // `hash` is required on the Feed type but legacy registry entries
    // could in principle send '' or null — exercise both shapes via cast.
    expect(opfsFileFor({ ...feed(), hash: '' as unknown as string })).toBe('/cluj-napoca.sqlite3');
    expect(opfsFileFor({ ...feed(), hash: undefined as unknown as string })).toBe('/cluj-napoca.sqlite3');
  });

  it('changes when the hash changes', () => {
    const a = opfsFileFor(feed({ hash: 'sha256-aaaaaaaaaaaa1111' }));
    const b = opfsFileFor(feed({ hash: 'sha256-bbbbbbbbbbbb2222' }));
    expect(a).not.toBe(b);
  });
});

describe('opfsFileForLegacy', () => {
  it('produces the pre-versioning filename', () => {
    expect(opfsFileForLegacy('cluj-napoca')).toBe('/cluj-napoca.sqlite3');
  });
});

describe('pruneStaleFeedFiles', () => {
  it('removes the legacy file when a versioned one is kept', () => {
    const pool = fakePool([
      '/cluj-napoca.sqlite3',
      '/cluj-napoca-79e19efee5c2.sqlite3',
    ]);
    const removed = pruneStaleFeedFiles(pool, 'cluj-napoca', '/cluj-napoca-79e19efee5c2.sqlite3');
    expect(removed).toBe(1);
    expect(pool.files.has('/cluj-napoca.sqlite3')).toBe(false);
    expect(pool.files.has('/cluj-napoca-79e19efee5c2.sqlite3')).toBe(true);
  });

  it('removes older versioned siblings, keeps the requested one', () => {
    const pool = fakePool([
      '/cluj-napoca-79e19efee5c2.sqlite3',
      '/cluj-napoca-aaaaaaaaaaaa.sqlite3',
      '/cluj-napoca-bbbbbbbbbbbb.sqlite3',
    ]);
    const removed = pruneStaleFeedFiles(pool, 'cluj-napoca', '/cluj-napoca-79e19efee5c2.sqlite3');
    expect(removed).toBe(2);
    expect(pool.files.size).toBe(1);
    expect(pool.files.has('/cluj-napoca-79e19efee5c2.sqlite3')).toBe(true);
  });

  it('leaves other feeds alone', () => {
    const pool = fakePool([
      '/cluj-napoca.sqlite3',
      '/bucuresti-ilfov.sqlite3',
      '/bucuresti-ilfov-deadbeefcafe.sqlite3',
    ]);
    const removed = pruneStaleFeedFiles(pool, 'cluj-napoca', '/cluj-napoca-79e19efee5c2.sqlite3');
    expect(removed).toBe(1);
    expect(pool.files.has('/bucuresti-ilfov.sqlite3')).toBe(true);
    expect(pool.files.has('/bucuresti-ilfov-deadbeefcafe.sqlite3')).toBe(true);
  });

  it('does NOT prefix-match a sibling feed whose id starts the same', () => {
    // A future feed could be called e.g. 'cluj-napoca-night'.
    // Naive `startsWith('/cluj-napoca')` would wrongly delete it.
    const pool = fakePool([
      '/cluj-napoca-79e19efee5c2.sqlite3',
      '/cluj-napoca-night.sqlite3',
      '/cluj-napoca-night-aaaaaaaaaaaa.sqlite3',
    ]);
    const removed = pruneStaleFeedFiles(pool, 'cluj-napoca', '/cluj-napoca-79e19efee5c2.sqlite3');
    expect(removed).toBe(0);
    expect(pool.files.has('/cluj-napoca-night.sqlite3')).toBe(true);
    expect(pool.files.has('/cluj-napoca-night-aaaaaaaaaaaa.sqlite3')).toBe(true);
  });

  it('returns 0 and changes nothing when the feed has no other files', () => {
    const pool = fakePool(['/cluj-napoca-79e19efee5c2.sqlite3']);
    const removed = pruneStaleFeedFiles(pool, 'cluj-napoca', '/cluj-napoca-79e19efee5c2.sqlite3');
    expect(removed).toBe(0);
    expect(pool.files.size).toBe(1);
  });
});

describe('feedDbFiles', () => {
  it('lists the legacy file and every versioned snapshot of the feed', () => {
    const pool = fakePool([
      '/cluj-napoca.sqlite3',
      '/cluj-napoca-79e19efee5c2.sqlite3',
      '/cluj-napoca-aaaaaaaaaaaa.sqlite3',
    ]);
    expect(feedDbFiles(pool, 'cluj-napoca').sort()).toEqual([
      '/cluj-napoca-79e19efee5c2.sqlite3',
      '/cluj-napoca-aaaaaaaaaaaa.sqlite3',
      '/cluj-napoca.sqlite3',
    ]);
  });

  it('leaves other feeds and same-prefix siblings out', () => {
    const pool = fakePool([
      '/cluj-napoca-79e19efee5c2.sqlite3',
      '/cluj-napoca-night.sqlite3',
      '/cluj-napoca-night-aaaaaaaaaaaa.sqlite3',
      '/bucuresti-ilfov.sqlite3',
    ]);
    expect(feedDbFiles(pool, 'cluj-napoca')).toEqual(['/cluj-napoca-79e19efee5c2.sqlite3']);
  });

  it('rejects malformed versioned names (non-hex or wrong-length tail)', () => {
    const pool = fakePool([
      '/cluj-napoca-xyzxyzxyzxyz.sqlite3',
      '/cluj-napoca-79e19efee5c2ff.sqlite3',
      '/cluj-napoca-79e19efee5.sqlite3',
    ]);
    expect(feedDbFiles(pool, 'cluj-napoca')).toEqual([]);
  });
});
