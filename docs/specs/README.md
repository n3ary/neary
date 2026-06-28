# Specs

Contracts where the reasoning isn't in the code. Per
[standards/documentation.md](../standards/documentation.md): if the answer
is in the code, there's no spec doc here.

| Document | Why it exists (not just code) |
|---|---|
| [vehicles-and-views.md](vehicles-and-views.md) | Cross-cutting design: Vehicle union + UI taxonomy + per-bucket interaction. Long-lived design reasoning |
| [multi-feed-data-lifecycle.md](multi-feed-data-lifecycle.md) | OPFS storage model, switch flow, eviction policy, pin-for-offline. Cross-layer contract (worker ↔ UI) |
| [feeds-json.md](feeds-json.md) | feeds.json schema published by the separate `neary-gtfs` repo. Cross-repo contract |
| [live-data-pipeline.md](live-data-pipeline.md) | Reconciler rationale, Cluj direction-id workaround, source-of-truth for tz handling |
| [multi-source-live-data.md](multi-source-live-data.md) | Multi-URL `realtime.vehicle_positions`, per-tick merge, no provider-specific clients, no client-side keys |
| [ci-and-versioning.md](ci-and-versioning.md) | Auto-bump policy, release trigger, version sequencing — easy to misread from workflow YAML |
| [pwa.md](pwa.md) | SvelteKit version polling, Netlify cache headers, iOS safe-area |

What is NOT a spec here (read the code instead):

- Station view assembly → [src/routes/+page.svelte](../../src/routes/+page.svelte) + [src/lib/domain/buckets.ts](../../src/lib/domain/buckets.ts) + [src/lib/domain/stationSelection.ts](../../src/lib/domain/stationSelection.ts)
- Schedule view → [src/routes/schedule/route/[id]/[[view]]/+page.svelte](../../src/routes/schedule/route/[id]/[[view]]/+page.svelte)
- Map view → [src/routes/map/route/[id]/[[selected]]/+page.svelte](../../src/routes/map/route/[id]/[[selected]]/+page.svelte)
- Favorites → [src/lib/stores/favoritesStore.svelte.ts](../../src/lib/stores/favoritesStore.svelte.ts)
