/**
 * URL parsing for the `[id]_[dir]` segment used by /schedule/route/...
 * and /map/route/... — e.g. `40_0` → `{ routeId: '40', direction: 0 }`,
 * `40` (bare) → `{ routeId: '40', direction: null }`.
 *
 * Lives in lib/data/gtfs/ because the convention is part of the
 * route-URL contract both views share. Pure: no SQL, no DOM, just a
 * regex — but kept here (not in domain/) since it's specific to the
 * GTFS-route URL shape rather than a general formatter.
 */
export function parseRouteIdWithDirection(
  idSegment: string,
): { routeId: string; direction: 0 | 1 | null } {
  const m = idSegment.match(/^(.+)_([01])$/);
  if (m) return { routeId: m[1], direction: Number(m[2]) as 0 | 1 };
  return { routeId: idSegment, direction: null };
}
