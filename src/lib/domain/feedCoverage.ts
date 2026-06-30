/*
 * feedCoverage — check whether a GPS position falls inside a feed's
 * declared bounding box. Pure.
 *
 * Used by views that surface an empty-state to disambiguate "no stops
 * here yet" from "you picked a feed that doesn't cover your location"
 * (e.g. Bucharest selected while standing in Cluj).
 */

import type { Feed } from '$lib/data/feeds';

/** Approximate great-circle distance in km between two lat/lon pairs.
 *  Coarse enough for a "you're ~300 km from this feed" message;
 *  Haversine would be more accurate but isn't worth the import. */
export function approxKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const dLat = (a.lat - b.lat) * (Math.PI / 180);
  const dLon = (a.lon - b.lon) * (Math.PI / 180);
  const meanLat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const x = dLon * Math.cos(meanLat);
  return Math.sqrt(dLat * dLat + x * x) * 6371;
}

/** True when the position is inside (or on the border of) the feed's
 *  declared bbox. */
export function isPositionInFeedBbox(
  position: { lat: number; lon: number },
  feed: Pick<Feed, 'bbox'>,
): boolean {
  const { minLat, minLon, maxLat, maxLon } = feed.bbox;
  return (
    position.lat >= minLat &&
    position.lat <= maxLat &&
    position.lon >= minLon &&
    position.lon <= maxLon
  );
}

/** Approximate distance in km from a position to the nearest edge of
 *  the feed's bbox (0 when the position is inside). Used only to
 *  produce a human-readable hint in empty-state copy. */
export function distanceToFeedBboxKm(
  position: { lat: number; lon: number },
  feed: Pick<Feed, 'bbox' | 'center'>,
): number {
  if (isPositionInFeedBbox(position, feed)) return 0;
  // Project the position onto the bbox edge (clamp).
  const lat = Math.min(Math.max(position.lat, feed.bbox.minLat), feed.bbox.maxLat);
  const lon = Math.min(Math.max(position.lon, feed.bbox.minLon), feed.bbox.maxLon);
  return approxKm(position, { lat, lon });
}

/** Find the feed whose bbox is closest to `position`. Distance is 0
 *  when the position is inside the bbox. Returns null when no feeds
 *  are available. Stable for ties (returns the first match in input
 *  order). */
export function findNearestFeed<F extends Pick<Feed, 'bbox' | 'center'>>(
  position: { lat: number; lon: number },
  feeds: readonly F[],
): { feed: F; distanceKm: number } | null {
  let best: { feed: F; distanceKm: number } | null = null;
  for (const f of feeds) {
    const km = distanceToFeedBboxKm(position, f);
    if (best == null || km < best.distanceKm) best = { feed: f, distanceKm: km };
  }
  return best;
}
