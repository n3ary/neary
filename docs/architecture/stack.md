# Stack

Current v2 stack as of 2026-06-27. Authoritative dependency list is [package.json](../../package.json).

## Runtime

| Layer | Pick | Why |
|---|---|---|
| Framework | Svelte 5 + SvelteKit | Tiny runtime, fine-grained reactivity, single-file components, best iOS PWA story |
| Styling | Tailwind v4 + CSS custom properties | Skinning = swap one `theme.css` |
| Headless behaviors | bits-ui | Accessible primitives, Svelte 5 native |
| Icons | lucide-svelte | Per-icon tree-shake |
| Local DB | SQLite-WASM (`@sqlite.org/sqlite-wasm`) + OPFS | Real GTFS as real tables, worker-isolated |
| DB transport | Comlink-wrapped Web Worker | UI never blocks |
| Map | Leaflet 1.9 | Small, panes solve layering |
| Network | Native `fetch` | No axios |
| PWA | `@vite-pwa/sveltekit` + Workbox | Service worker + version polling |
| GTFS-RT | `gtfs-realtime-bindings` | Protobuf decode |
| TypeScript | 6.x | strict mode on |

## Build / test

| Layer | Pick |
|---|---|
| Build | Vite (rolldown-vite) |
| Tests | Vitest + `@testing-library/svelte` |
| Lint | (deferred — Biome adoption planned in polish phase) |

## Deployment

- Netlify static deploy of `build/` after `vite build --config vite.config.ts`.
- GitHub Actions: PR validation, auto-bump version on merge, deploy to production on push to `main`.
- See [../specs/ci-and-versioning.md](../specs/ci-and-versioning.md).

## What's deliberately not here

- Server-side rendering — static prerender only. Revisit only if route-based data fetching needs it.
- MapLibre GL — kept on Leaflet until a real iOS-Safari bottleneck appears.
