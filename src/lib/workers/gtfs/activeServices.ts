/*
 * Service-calendar resolver. Returns the set of `service_id`s active
 * on a given local YYYYMMDD considering both `calendar` (weekly
 * pattern + validity range) and `calendar_dates` (exceptions:
 * 1 = added, 2 = removed).
 *
 * Used by every query that filters trips by "what's running today":
 * stationArrivals, routeSchedule, routeMapView, activeTrips.
 */

import type { Database } from '@sqlite.org/sqlite-wasm';
import { DAY_KEY_COLS } from '@n3ary/gtfs-spec/spec';
import { selectAll } from './sqlHelpers';

export function activeServicesOn(db: Database, localDate: string): string[] {
  const dow = new Date(
    Number(localDate.slice(0, 4)),
    Number(localDate.slice(4, 6)) - 1,
    Number(localDate.slice(6, 8)),
  ).getDay();
  const dayCol = DAY_KEY_COLS[(dow + 6) % 7];

  type IdRow = { service_id: string };
  const base = selectAll<IdRow>(
    db,
    `SELECT service_id FROM calendar
     WHERE ${dayCol} = 1
       AND start_date <= ?
       AND end_date >= ?;`,
    [localDate, localDate],
  ).map((r) => r.service_id);

  const removed = new Set(
    selectAll<IdRow>(
      db,
      `SELECT service_id FROM calendar_dates WHERE date = ? AND exception_type = 2;`,
      [localDate],
    ).map((r) => r.service_id),
  );

  const added = selectAll<IdRow>(
    db,
    `SELECT service_id FROM calendar_dates WHERE date = ? AND exception_type = 1;`,
    [localDate],
  ).map((r) => r.service_id);

  return Array.from(new Set([...base.filter((id) => !removed.has(id)), ...added]));
}
