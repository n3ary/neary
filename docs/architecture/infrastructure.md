# Infrastructure

Every cloud / external / browser piece the app touches, in one diagram + one table. Cross-references the relevant specs/concepts for detail; this doc is the **index** for "what runs where and what breaks if it dies".

Cross-refs:
- Tech stack table — [stack.md](stack.md)
- Data flow (R2 → app → reconciler) — [data-pipeline.md](data-pipeline.md)
- CI / versioning / deploy — [specs/ci-and-versioning.md](../specs/ci-and-versioning.md)
- PWA specifics (version polling, cache headers, safe-area) — [specs/pwa.md](../specs/pwa.md)
- Storage lifecycle (OPFS eviction, pinning, offline) — [specs/multi-feed-data-lifecycle.md](../specs/multi-feed-data-lifecycle.md)

## Diagram

```mermaid
flowchart TB
  subgraph External["External (operator infrastructure)"]
    direction TB
    rt["Per-feed RT endpoints<br/>(e.g. cluj-rt-feed.gtfs.ro)"]:::external
  end

  subgraph Cloudflare["Cloudflare (account: n3ary)"]
    direction TB
    dns["DNS<br/>n3ary.com → Pages<br/>gtfs.n3ary.com → R2"]:::dns
    r2[("R2 bucket<br/>feeds.json + *.sqlite3.gz")]:::r2
    pages["Pages<br/>(n3ary.com → PWA hosting)"]:::pages
    pages_fn["Pages Function<br/>/api/rt/[feed]/[[endpoint]].js<br/>RT passthrough proxy"]:::pagesfn
  end

  subgraph GitHub["GitHub (this repo)"]
    direction TB
    gh_pr["Actions: PR validation<br/>npm run check + test + build<br/>(triggered on PR open)"]:::gh
    gh_deploy["Actions: deploy-production<br/>wrangler pages deploy<br/>(triggered on push to main)"]:::gh
  end

  subgraph Browser["Browser (user device)"]
    direction TB
    pwa["PWA<br/>SvelteKit static bundle"]:::browser
    sw["Service Worker<br/>(Workbox)"]:::browser
    opfs[("OPFS<br/>*.sqlite3 + feeds-meta.json")]:::browser
    localstorage[("localStorage<br/>userPrefs, favorites")]:::browser
  end

  rt -->|"real-time protobuf"| pages_fn
  pages_fn -->|"passthrough (CF edge cache)"| pwa

  r2 -->|"feeds.json<br/>id-hash.sqlite3.gz"| pwa

  gh_deploy -->|"wrangler pages deploy"| pages

  pwa --> sw
  pwa --> opfs
  pwa --> localstorage

  classDef external fill:#f5f5f4,stroke:#a8a29e,color:#1c1917
  classDef r2 fill:#fef3c7,stroke:#f59e0b,color:#92400e
  classDef dns fill:#e0e7ff,stroke:#6366f1,color:#3730a3
  classDef pages fill:#dbeafe,stroke:#3b82f6,color:#1e40af
  classDef pagesfn fill:#fce7f3,stroke:#ec4899,color:#9f1239
  classDef gh fill:#f3f4f6,stroke:#6b7280,color:#1f2937
  classDef browser fill:#dcfce7,stroke:#22c55e,color:#15803d
```

## Component table

| Component | Role | Owner | Cost driver | Failure impact |
|---|---|---|---|---|
| **GitHub Actions — PR validation** | `npm run check` + `npm test` + `npm run build` on every PR (also auto-bumps `package.json#version` on the PR branch) | GitHub | Free tier (2 000 min/month) | PR can't merge |
| **GitHub Actions — deploy-production** | `wrangler pages deploy build --project-name=neary --branch=main` on push to `main` | GitHub + Cloudflare | Free tier + Wrangler invocation | Latest commits not live in production |
| **Cloudflare Pages** | Static hosting for the PWA (`build/`) | Cloudflare | Free tier (unlimited requests) | PWA down |
| **Cloudflare Pages Function** — `/functions/api/rt/[feed]/[[endpoint]].js` | RT passthrough proxy: fetch `feeds.json`, look up upstream RT URL, fetch + return protobuf | Cloudflare | Workers Paid $5/mo + $0.30/M requests after 10 M | Live RT offline (UI shows schedule-only data) |
| **Cloudflare R2** — `gtfs` bucket | Stores `feeds.json` + `<id>-<hash12>.sqlite3.gz`. Populated by the sister `gtfs` repo's daily pipeline; consumed via `gtfs.n3ary.com` | Cloudflare | $0.015/GB/month + $0.36/M Class A operations | App can't bootstrap (no manifest, no blobs) |
| **Cloudflare DNS** — `n3ary.com` → Pages, `gtfs.n3ary.com` → R2 | Custom-domain routing for both the app and the data | Cloudflare | Free with Pages + R2 | App URL down (`n3ary.com`) and/or data URL down (`gtfs.n3ary.com`) |
| **Per-feed RT endpoints** (e.g. `cluj-rt-feed.gtfs.ro`) | Live protobuf per operator; consumed via the Pages Function | Operators | Free | Live view falls back to schedule-only for that feed |
| **Browser — PWA bundle** | The actual app | User device | Free | — |
| **Browser — Service Worker** (Workbox) | Asset caching + `_app/version.json` polling | User device | Free | PWA may serve stale assets after a deploy |
| **Browser — OPFS** | `feeds-meta.json` + per-feed `*.sqlite3` blobs | User device | Free | App can't load feeds (forces re-download on next launch) |
| **Browser — localStorage** | `userPrefs` (theme, feedId, toggles) + `favorites` per-feed | User device | Free | App may not remember settings between sessions |

## Planned: Hetzner RT adapter (tracking [gtfs#34](https://github.com/n3ary/gtfs/issues/34))

When the producer monorepo ships, the per-feed RT adapter moves to a Hetzner CX22 (€4.50/month fixed), with the existing Pages Function becoming a thin cache-and-passthrough layer in front. Spec: [gtfs-rt-contract.md](../specs/gtfs-rt-contract.md). Until then, the existing Pages Function does the passthrough and the producer-side quirks live inline in [neary](https://github.com/ciotlosm/neary) via the TEMP `recoverClujTripFields` block in `src/lib/domain/enrichObservations.ts` (tracked by [#161](https://github.com/ciotlosm/neary/issues/161)).