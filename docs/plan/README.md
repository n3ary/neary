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

## Where the app is

The SvelteKit rebuild has reached feature parity with v1 on the core surfaces:
station board, schedule, map, favorites, settings, multi-feed switching, and
GTFS-RT reconciliation are all in production. The remaining substantive work
is prediction (see [prediction-v2.md](prediction-v2.md)), with Tranzy as an
optional accuracy booster ([tranzy-integration.md](tranzy-integration.md)).
Everything else is iterative polish driven by usage — no dedicated plan doc.

## Cross-repo work

The [neary-gtfs](https://github.com/ciotlosm/neary-gtfs) data pipeline lives in
its own repo with its own roadmap. Some stages of
[prediction-v2.md](prediction-v2.md) (Stage A — build-time interpolation
upgrade) ship there, not here.
