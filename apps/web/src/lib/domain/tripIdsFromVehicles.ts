/**
 * Pull the schedule trip IDs out of a vehicle list, dropping the
 * non-scheduled (live-only / unmatched) ones. Both the Stations view
 * and the Station-detail view need this exact shape to fetch shape
 * payloads for ETA composition; previously each repeated the same
 * three-line `.map(...).filter(...)` incantation.
 *
 * Pure: no IO, no reactivity. Lives in domain/ alongside the other
 * vehicle-list shapers (routesFromVehicles, assembleLiveBoard, etc.).
 */
import type { Vehicle } from './types';

export function tripIdsFromVehicles(vehicles: readonly Vehicle[]): string[] {
  const out: string[] = [];
  for (const v of vehicles) {
    const id = v.schedule?.tripId;
    if (id) out.push(id);
  }
  return out;
}
