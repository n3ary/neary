import type { Database } from '@sqlite.org/sqlite-wasm';
import type { Network } from '$lib/domain/types';
import { selectAll } from '../sqlHelpers';
import { rotateHueOklch, oklabDistance } from '$lib/domain/oklch';

/** Fallback anchor when a network has no usable route colors in the feed. */
const ANCHOR = '5B2D8E';
const DISTINCT_THRESHOLD = 0.15;

/**
 * For each collision group (≥2 networks sharing the same modal color),
 * keep the one with the most routes at that color and rotate the rest
 * around the OKLCh hue wheel, nudging ±15° until each is ≥ 0.15 OKLab
 * away from every already-assigned color.
 */
function resolveCollisions(
  ids: string[],
  colors: Map<string, string>,
  countAtModal: Map<string, number>,
): Map<string, string> {
  const assigned = new Map<string, string>(colors);
  const allColors = new Set<string>(assigned.values());

  const byColor = new Map<string, string[]>();
  for (const [id, color] of assigned) {
    if (!byColor.has(color)) byColor.set(color, []);
    byColor.get(color)!.push(id);
  }

  for (const [baseColor, group] of byColor) {
    if (group.length < 2) continue;
    group.sort((a, b) => (countAtModal.get(b) ?? 0) - (countAtModal.get(a) ?? 0));
    const step = 360 / group.length;
    const forbidden = new Set<string>([...allColors].filter((c) => c !== baseColor));
    for (let i = 1; i < group.length; i++) {
      const idealDeg = i * step;
      const candidates = [idealDeg];
      for (let off = 15; off <= 180; off += 15) {
        candidates.push(idealDeg + off, idealDeg - off);
      }
      let newColor = rotateHueOklch(baseColor, idealDeg);
      for (const deg of candidates) {
        const c = rotateHueOklch(baseColor, deg);
        const minDist = [...forbidden].reduce(
          (min, fc) => Math.min(min, oklabDistance(c, fc)),
          Infinity,
        );
        if (minDist >= DISTINCT_THRESHOLD) { newColor = c; break; }
      }
      assigned.set(group[i], newColor);
      allColors.add(newColor);
      forbidden.add(newColor);
    }
  }

  return assigned;
}

/** All networks present in the feed, from `networks.txt`, with colors
 *  derived from each network's modal route_color and collision-resolved
 *  so every chip has a perceptually distinct hue.
 *  Returns an empty array for feeds that pre-date networks.txt support. */
export function getNetworks(db: Database): Network[] {
  const tables = selectAll<{ name: string }>(
    db,
    `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('networks','route_networks');`,
  );
  const hasNetworks = tables.some((t) => t.name === 'networks');
  const hasRouteNetworks = tables.some((t) => t.name === 'route_networks');
  if (!hasNetworks) return [];

  const rows = selectAll<{ id: string; name: string }>(
    db,
    `SELECT network_id AS id, network_name AS name FROM networks ORDER BY network_id;`,
  );
  if (rows.length === 0) return [];

  // Build modal-color and route-count maps from the feed's route colors.
  const modalColors = new Map<string, string>();
  const countAtModal = new Map<string, number>();

  if (hasRouteNetworks) {
    const colorRows = selectAll<{ network_id: string; route_color: string; cnt: number }>(
      db,
      `SELECT rn.network_id, r.route_color, COUNT(*) AS cnt
       FROM route_networks rn
       JOIN routes r ON r.route_id = rn.route_id
       WHERE r.route_color IS NOT NULL AND r.route_color != '' AND r.route_color != '000000'
       GROUP BY rn.network_id, r.route_color
       ORDER BY rn.network_id, cnt DESC`,
    );
    for (const row of colorRows) {
      if (!modalColors.has(row.network_id)) {
        modalColors.set(row.network_id, row.route_color);
        countAtModal.set(row.network_id, row.cnt);
      }
    }
  }

  // Seed networks that have no usable route colors from the anchor.
  for (const n of rows) {
    if (!modalColors.has(n.id)) modalColors.set(n.id, ANCHOR);
  }

  const finalColors = resolveCollisions(rows.map((n) => n.id), modalColors, countAtModal);

  return rows.map((n) => ({
    id: n.id,
    name: n.name,
    color: `#${finalColors.get(n.id) ?? ANCHOR}`,
  }));
}
