# GTFS frequencies.txt support

Issue: #347. Closes when the app consumes
`frequencies.txt` to expand frequency-based trips into per-departure
rows in the active set, the station board, the schedule view, the
map view, and the weekly pattern. The publisher-side prerequisite
lives in [n3ary/gtfs-publisher#252](https://github.com/n3ary/gtfs-publisher/pull/252)
(merged first; the DDL addition is what makes the table present in
the SQLite blob the app downloads).

## What "frequency-based trip" means in this app

A row in `frequencies.txt` says: "for this `trip_id`, run every
`headway_secs` seconds from `start_time` to `end_time`, applying the
anchor trip's `stop_times` as offsets relative to each departure
time". The cluj-napoca adapter emits these rows for `*-range`
annotations (e.g. M26 `05:05-22:40` / `10-20min` is the live case;
see
[gtfs-adapters#…/cluj-napoca/docs/known-limitations.md](https://github.com/n3ary/gtfs-adapters)).

In the app, a frequency-based trip becomes **N `kind: 'scheduled'`
rows in the active set, one per generated departure**, each with
its own `schedule.tripStartMin` (the k-th departure's effective
origin time) and its own `Vehicle.id`
(`trip:<tripId>@<effectiveStartMin>`). The reconciler already
matches on `(routeId, directionId, tripStartMin)`; the active set
just needs more rows.

## Design

### Data model

No new domain types. The discriminated union at
`src/lib/domain/types.ts:188-217` is unchanged. A frequency-based
trip's N generated rows are N `kind: 'scheduled'` Vehicles with
distinct `schedule.tripStartMin` values and distinct `id` strings
(the `@<min>` suffix). This is the same shape as the existing
schedule-based rows; the only difference is the id suffix and the
fact that the row's `tripStartMin` doesn't equal the anchor's
`stop_times[0].departure_time`.

The `id` encoding choice — `trip:<tripId>@<effectiveStartMin>` —
is a public contract: the per-stop promotion path in
`stationBoard.ts` uses Vehicle.id as a stable Svelte key, and the
reconciler's matched-scheduled index in
`stationBoard.ts:mergeReconciledIntoStationBoard` keys off the
reconciled row's `schedule.tripStartMin` (matched against the
per-stop row's `schedule.tripStartMin`) to gate the kind: 'tracked'
promotion. Without the per-row `tripStartMin` match, every per-stop
row for an anchor trip would get the same GPS position.

### Helper module

`src/lib/workers/gtfs/queries/frequencyExpansion.ts` is the
shared core. Five exports:

| Export | Purpose |
|---|---|
| `hasFrequenciesTable(db)` | PRAGMA probe. Returns false on cached blobs that pre-date the publisher's DDL addition; callers fall back to schedule-only behaviour. |
| `getFrequenciesForServices(db, serviceIds)` | SQL query joining `frequencies` to `trips.service_id`. Filters out `exact_times=1` (rare, per spec). |
| `expandFrequencyToDepartures(freq, windowStart, windowEnd)` | Pure JS. One `GeneratedDeparture` per k-th departure in the window. The end-time bound is exclusive per spec ("up to but not including end_time"). |
| `expandFrequenciesToDepartures(freqs, windowStart, windowEnd)` | Convenience wrapper. Returns `Map<tripId, GeneratedDeparture[]>`. |
| `getAnchorStopTimes(db, tripId)` | Per-trip stop_times rows in `stop_sequence ASC` order. Used by the per-stop expansion path to derive per-stop offset times. |

The expansion is pure JS (no recursive SQL CTE) because (a) the
window is small (typical M26 case: 71 generated departures in a
17.5-hour window) and (b) keeping it pure makes the load-bearing
function unit-testable without a DB fixture.

### Per-time query changes

Every per-time query gains a `hasFrequencies: boolean` parameter
(passed in by the worker from
`state.currentFeedHasFrequencies`). When true, after the existing
SQL scan, the query calls `getFrequenciesForServices` + the
expansion helpers and merges the generated rows with the
schedule-based rows. The five queries touched:

| Query | Expansion model |
|---|---|
| `getActiveTrips` | One `Vehicle` per generated departure. `schedule.tripStartMin` = effectiveStartMin, `schedule.scheduledArrival` = anchor.trip_end_time + k*headway. |
| `getStationArrivals` | One `ScheduleRow` per generated departure whose effective time at THIS stop falls in the query window. The effective per-stop arrival is `anchor.stop_times[stop_id].arrival_time + k*headway_min`. The row's `id` is `trip:<tripId>@<effectiveStartMin>`. |
| `getRouteSchedule` | One `ScheduleTrip` per generated departure, with the same composite key. |
| `getActiveRouteIdsInWindow` | Boolean: a route is "active right now" iff any frequency row on it overlaps the query window. Per-row expansion is unnecessary — the route set is all we return. |
| `getRouteMapView` | Same as `getActiveTrips` but for the per-(route, direction) view; shape_id is shared per anchor (shape doesn't change per generated departure). |
| `getWeeklySchedule` | Expand each frequency row into synthetic minute slots for each matching day pattern. Headway 15 min × 17.5 h on weekdays = 67 synthetic minutes added to the `weekday` set. |

The frequency-based rows are appended to the schedule-based rows
in the same `Vehicle[]` (or `ScheduleTrip[]`, etc.) and the rest of
the pipeline is unaware. `scanSchedule` accepts an optional
`ScheduleRow.id` override so the per-stop rows get the right
`@<min>`-suffixed id (the default `trip:<tripId>` is used when
undefined).

### Reconciler

No change. The reconciler at `src/lib/domain/reconcile.ts:37-203`
matches on `(routeId, directionId, tripStartMin)` — the
`tripStartMin` field is already on the active set rows, and the
generated rows have distinct values. The match tolerance
(`computeTolerance`, lines 212-235) works unchanged; a
15-minute-headway cohort's median gap is 15 min, so the median/2
tolerance is 7-8 min, which is wider than any reasonable
observation drift.

### `enrichObservations` composite key

`src/lib/domain/enrichObservations.ts:10-19` previously indexed
the active set by `tripId` alone. With multiple generated rows per
tripId, that map would collapse to the last-written entry and every
observation would match the wrong generated departure. Fixed by
keying on `${tripId}|${tripStartMin}` (the primary index) and
keeping a `tripId`-only fallback for observations missing
`startTime` (preserves the legacy lenient behaviour for
non-conforming producers; for frequency-based trips, the fallback
resolves to the k=0 entry, which is the anchor's first departure).

### `stationBoard` promotion tolerance

`src/lib/domain/stationBoard.ts:276-297` previously promoted every
per-stop row whose `tripId` matched a reconciled row to `kind:
'tracked'`. With frequency expansion, that's wrong — the
reconciled row carries ONE specific generated departure's position;
the per-stop set has N rows (one per generated departure). Added a
`tripStartMin` equality check that gates the promotion. Trivial
change; non-frequency trips pass the check trivially because the
anchor's `tripStartMin` is identical to the active-set entry.

### Bootstrap PRAGMA probe

`src/lib/workers/gtfs/bootstrap.ts:385-393` runs a `sqlite_master`
probe for the `frequencies` table after the `stop_times` integrity
check. The result is stashed in `state.currentFeedHasFrequencies`
(`src/lib/workers/gtfs/state.ts:32-36`). `closeCurrent()` resets
the flag to `false`.

### `id` encoding — public contract

`Vehicle.id` for frequency-based rows is `trip:<tripId>@<effectiveStartMin>`.
Anchor rows (where the trip has no frequencies row, or the row
exists but the anchor's stop_times naturally fall in the window
without expansion) keep the legacy `trip:<tripId>` shape. The
per-stop promotion path's `Vehicle.id` propagation is unchanged —
the merged row inherits `v.id` from the per-stop row.

## Stack order

1. **n3ary/gtfs-publisher#252** — DDL addition (merged first).
2. **#347 (this)** — consumer side. Lands after #252.

## Open design questions

1. **Weekly view display.** A frequency-based trip with headway
   15 min / window 05:05-22:40 currently shows as 1 anchor
   departure on the weekly schedule. The data layer makes
   "every 15 min from 05:05 to 22:40" possible; the
   rendering is a separate UX call (the data already includes 67
   synthetic minute slots in the `weekday` set; the existing
   per-minute rendering just needs to handle the dense output).
2. **Per-route schedule display.** Same question for the
   per-route schedule view. 67 individual rows is a lot; one
   summary row with the headway is probably right.
3. **Multi-frequency rows per trip.** GTFS allows multiple
   `frequencies.txt` rows per `trip_id` (e.g. "15 min 05:00-09:00"
   then "30 min 09:00-22:00"). The cluj adapter only emits one
   row per anchor, but the spec permits more. The
   `getFrequenciesForServices` helper already returns N rows per
   trip; the per-time query loops iterate them all and union the
   expansions. Tested conceptually via
   `frequencyExpansion.test.ts` (the `expandFrequenciesToDepartures`
   test covers N rows per trip) but not end-to-end.
4. **`exact_times=1` rows.** GTFS allows `exact_times=1`
   (the frequencies row exists but the trip is still
   schedule-based). The cluj adapter only emits
   `exact_times=0`. The helper treats
   `exact_times=0` (or NULL) as the default expansion target and
   `exact_times=1` as "ignore the frequencies row, use
   `stop_times` directly" — the SQL `WHERE (f.exact_times IS NULL
   OR f.exact_times = 0)` filters these out. Theoretical until a
   feed actually needs it.

## Verification

- `pnpm check` — clean (svelte-check).
- `pnpm test` — 330/330 pass.
- `pnpm build` — vite build emits the production bundle.
- Unit tests cover the load-bearing expansion math
  (`frequencyExpansion.test.ts`, 8 cases).
- Live data path verified at the type level: the per-time queries
  accept `hasFrequencies: boolean`, the worker passes
  `state.currentFeedHasFrequencies`, and the `id` encoding is
  stable across polls. E2E verification (loading a real
  frequencies-bearing blob and inspecting the station board)
  needs the publisher's blob to be published to R2 first — that's
  #252's rollout, out of scope here.

## Out of scope

- A `route_desc` or visual treatment of "headway 15 min" in the
  route badge. That's a separate UX call.
- Per-feed opt-in / opt-out toggles in `feeds.json`. The app is
  feed-agnostic per `docs/standards/feed-agnostic.md`; the
  publisher's `SCHEMA` is the contract, full stop. Old blobs that
  pre-date the DDL addition are handled by the bootstrap PRAGMA
  probe, not by a feed flag.
- Reimplementing the weekly pattern view to summarize
  frequency-based trips. The data layer supports it; the rendering
  is a follow-up.
- GTFS-RT `TripUpdates` and `service_alerts` consumption. Both are
  still reserved per `docs/specs/feeds-json.md:69`.
- The `gtfs-publisher-rt-reconcile` package's `parseFrequencies`
  reader — has no consumer today. Left for a separate cleanup PR.

## Related

- Producer: `gtfs-adapters/adapters/cluj-napoca/src/assemble/derive/frequencies.ts`
- Publisher PR: [n3ary/gtfs-publisher#252](https://github.com/n3ary/gtfs-publisher/pull/252)
- GTFS spec: [frequencies.txt](https://gtfs.org/schedule/reference/#frequenciestxt)
- GTFS-RT contract: [app/docs/specs/gtfs-rt-contract.md](../specs/gtfs-rt-contract.md)
- Reconciler match key: [app/src/lib/domain/reconcile.ts](../../src/lib/domain/reconcile.ts)
- Helper: [app/src/lib/workers/gtfs/queries/frequencyExpansion.ts](../../src/lib/workers/gtfs/queries/frequencyExpansion.ts)
- Helper tests: [app/src/lib/workers/gtfs/queries/frequencyExpansion.test.ts](../../src/lib/workers/gtfs/queries/frequencyExpansion.test.ts)
