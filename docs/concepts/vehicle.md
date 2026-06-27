# Vehicle

Every row in a station/schedule/map view is one `Vehicle`. The `kind`
field is a discriminated union encoding **how we know where it is**.

Source: [src/lib/domain/types.ts](../../src/lib/domain/types.ts) is authoritative.

## Kinds

| Kind | Meaning |
|---|---|
| `scheduled` | In the schedule; not yet active or no live match |
| `predicted` | Schedule says it should be running, no live source reports it (older design — see notes) |
| `live` | Live GPS, no schedule match |
| `reconciled` | One live source matched to a scheduled trip |
| `corroborated` | Two live sources agree on this trip (only when Tranzy key is set) |

The visual taxonomy and bucket interaction live in [specs/vehicles-and-views.md](../specs/vehicles-and-views.md).

## Why a discriminated union

- One component per kind, used identically in list / schedule / map.
- Schedule-only detection lives in the reconciler, not in JSX.
- The UI never has to guess what data is present — the type system enforces it.

## Per-row metadata

Each entry also carries:

- `confidence: 'high' | 'medium' | 'low'` → see [confidence.md](confidence.md).
- `liveSources: LiveSource[]` (when the kind has live data) → records which feeds confirm it.
- `schedule.isAtTripStart` → the bus is at its trip origin, so schedule is authoritative even without GPS.
