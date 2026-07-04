/*
 * Tiny SQL helper. Shared by every query module so they don't reach
 * into the worker's sqlite primitives directly.
 *
 * The day-of-week column names used to live here too; they moved to
 * @n3ary/gtfs-spec (DAY_KEY_COLS) since they're GTFS-spec, not
 * app-specific.
 */

import type { BindableValue, Database } from '@sqlite.org/sqlite-wasm';

/** Run a SELECT and return rows as plain JS objects.
 *  Cleaner than the `resultRows`-mutate-in-place pattern. */
export function selectAll<T>(
  db: Database,
  sql: string,
  bind?: readonly BindableValue[],
): T[] {
  return db.exec({
    sql,
    bind: bind as BindableValue[],
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as unknown as T[];
}
