# Plan

Future work, in-flight design, and open questions. Short-lived per doc;
distilled into [../specs/](../specs/) or [../concepts/](../concepts/)
once shipped.

## Active priority

[prediction-v2.md](prediction-v2.md) is the primary near-term focus. It
fixes two real pain points in the current app:

1. **Schedule-spine prediction** — regression vs v1; live GPS is only used
   for reconciliation, not as the spine for position rendering.
2. **Opaque UI update cycles** — three loops (live poll, UI tick, refresh)
   are decoupled in ways that aren't obvious; refresh can take up to ~30 s
   to flip ETA labels. Section 6.5 of the plan spells out the contract.

## All plan docs

| Document | Scope |
|---|---|
| [prediction-v2.md](prediction-v2.md) | Prediction overhaul — active priority |
| [tranzy-integration.md](tranzy-integration.md) | Opt-in second live source for higher-confidence reconciliation |
| [polish-and-perf.md](polish-and-perf.md) | Phase 9 — Histoire, Biome, perf budgets, store install |
| [open-questions.md](open-questions.md) | Deferred decisions awaiting more signal |

## Phase status (high level)

| Phase | What | Status |
|---|---|---|
| 0 | Foundations (monorepo, SvelteKit shell) | shipped |
| 1 | UI primitive library | shipped |
| 2 | GTFS DB worker (SQLite-WASM + OPFS) | shipped |
| 3 | App shell (Header / StatusBar / BottomNav, 4 routes) | shipped |
| 4 | Domain + Stations (schedule-only) | shipped |
| 5 | Live data (GTFS-RT, reconciler, shape projection) | shipped |
| 6 | Favorites, Schedule, Map drill-downs | shipped |
| 7 | Settings + Advanced | partial |
| 8 | Planner (with transfers) | TBD |
| 9 | Polish, perf budgets, store install | TBD |

## Cross-repo work

The [neary-gtfs](https://github.com/ciotlosm/neary-gtfs) data pipeline has
its own roadmap — see [neary-gtfs-evolution.md](neary-gtfs-evolution.md).
Stages of [prediction-v2.md](prediction-v2.md) span both repos.
