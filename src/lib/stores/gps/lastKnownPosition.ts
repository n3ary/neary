/**
 * lastKnownPosition — persists the user's most recent GPS fix so the
 * Stations page has a rider-useful fallback when acquisition stalls
 * (airplane mode kills A-GPS and a cold GNSS fix can take minutes,
 * especially indoors).
 *
 * Deliberately NOT the feed's bbox center: a regional bbox centroid
 * can be 100+ km from the rider, which is why the home page rejected
 * that fallback. The last real fix, by contrast, is almost always in
 * the rider's own city.
 *
 * Stored locally only; never leaves the device.
 */

export interface LastKnownPosition {
  lat: number;
  lon: number;
  /** Epoch ms of the fix — the UI shows "from N min ago". */
  t: number;
}

const KEY = 'neary-last-position';

export function readLastKnownPosition(): LastKnownPosition | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LastKnownPosition>;
    if (
      typeof parsed.lat !== 'number' ||
      typeof parsed.lon !== 'number' ||
      typeof parsed.t !== 'number'
    ) {
      return null;
    }
    return { lat: parsed.lat, lon: parsed.lon, t: parsed.t };
  } catch {
    // Corrupt entry (partial write, manual edit) — treat as absent.
    return null;
  }
}

export function writeLastKnownPosition(lat: number, lon: number): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ lat, lon, t: Date.now() }));
  } catch {
    // Quota / privacy mode — the fallback simply won't be there.
  }
}
