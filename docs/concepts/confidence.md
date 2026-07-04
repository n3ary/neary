# Confidence

A single bit-of-information per vehicle that drives UI dimming and badges.

Source: [src/lib/domain/types.ts](../../src/lib/domain/types.ts) is authoritative.

## Tiers

| Tier | Meaning | UI |
|---|---|---|
| `high` | Two live sources agree (`verified`), OR the next scheduled departure at the trip's origin (`scheduled` + `tripPhase === 'next'`) | Full opacity. A check-circle pip on `verified` is planned but not yet rendered — currently unreachable because only one live source is wired (see [specs/multi-source-live-data.md](../specs/multi-source-live-data.md)). |
| `medium` | One live source matched to schedule (`tracked`), live without schedule match (`gps-only`), or a non-`next` origin row (`scheduled` + `tripPhase ∈ {last, on-route, later}`) | Full opacity |
| `low` | Schedule-only at an intermediate stop (no live match, no origin authority) | `opacity-60` (dimmed) |

`next` at the origin earns `high` because the schedule IS the source
of truth for an imminent departure: the bus is parked, no GPS-based
ETA can improve on the timetable, and the rider is about to act on
that information. Other origin rows (`later`, `last`, `on-route`)
stay at `medium` — they're crisp and full opacity, but they're not
the row the rider is most likely to be checking.

## Why one field instead of UI-side derivation

The UI used to compute `dim = kind === 'scheduled' && !isFirstStop`. Two
problems: it duplicated information the domain already had, and it would
drift the moment a new kind needed a different rule. Consolidated into
`confidence` set by `scheduleScanner` and `reconcile`. The card reads
one bit: `vehicle.confidence === 'low'`.

## Setting confidence

- `scheduleScanner` sets the initial value: `medium` at the trip
  origin (`isFirstStop === true`), `low` at intermediate stops.
  Then `assignTripPhases` upgrades `tripPhase === 'next'` rows to
  `high`.
- `reconcile` upgrades matched rows to `medium` (becoming `tracked`).
- Two-source agreement sets `high` (becoming `verified`) —
  unreachable in production today since only GTFS-RT is wired; see
  [specs/multi-source-live-data.md](../specs/multi-source-live-data.md).
