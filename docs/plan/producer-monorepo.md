# Producer monorepo plan (neary-gtfs)

Future work — architectural sketch for consolidating the GTFS producer
(static + live RT) into a single monorepo. Not yet implemented. Affects
the **producer** repo (`ciotlosm/neary-gtfs`); this consumer repo
(`ciotlosm/neary`) is the read-only beneficiary.

## Why

The current producer (separate repo `neary-gtfs`) handles one job:
build the offline `sqlite3.gz` blob for each feed and publish to R2.
The consumer in `neary` reads those blobs.

For live RT we currently proxy upstream feeds through a Cloudflare Pages
Function with no transformation (just passthrough). That's fine for
GTFS-RT-spec-clean feeds but breaks for feeds whose operators don't
publish canonical fields. The Cluj case (`direction_id=0` always,
`start_time=""` always) is the worked example — it needs per-feed
recovery logic, but the feed-agnostic standard
(`docs/standards/feed-agnostic.md`) forbids that logic from living in
the consumer.

So the work splits naturally into:

| job                       | where it should live                |
|---------------------------|-------------------------------------|
| Build offline GTFS blobs  | producer (neary-gtfs), cron          |
| Clean / merge RT feeds    | producer (neary-gtfs), always-on    |
| Per-feed quirks           | producer (neary-gtfs), one file/feed|
| Consume clean data        | consumer (neary, this repo)          |

The producer becomes the single owner of "what does clean data look like
for this feed"; the consumer stops carrying feed-specific facts.

## Static vs live RT have different shapes

|                       | static pipeline              | live RT adapter                |
|-----------------------|------------------------------|--------------------------------|
| Compute pattern       | burst (build time), dormant  | constant (always-on)           |
| Output                | immutable content-addressed blobs (`<id>-<hash>.sqlite3.gz`) | per-feed clean protobuf (`/rt/<id>/<endpoint>.pb`) |
| Schedule              | daily cron                   | continuous (poll every 15–30 s)|
| Cost driver           | R2 storage + build minutes   | compute uptime + R2 egress     |
| Run-time infra        | GitHub Actions (free cron)   | Hetzner CX22 (€4.50/month, fixed)|
| Failure isolation     | per-feed cached client-side  | schedule-only fallback in UI   |

The shapes differ enough that combining them under a single deploy
target wastes the always-on infra on the static build's idle hours, or
forces the static build to share an always-on VM it doesn't need.
**They get separate deploy targets but share one source tree.**

## Extract `@ciotlosm/neary-gtfs-core` as a published library

Before either pipeline lands, the GTFS **contract** lives in its own
npm package — published from this monorepo's `packages/shared/`,
consumed by both this monorepo's other packages AND by `neary` (the
consumer). Why:

- **Two repos, one contract.** Both `neary-gtfs` and `neary` currently
  duplicate GTFS-shape knowledge (types, feeds.json loader, shape
  projection math). A shared package is the only way to keep them
  honest — drift in either repo becomes a deliberate version bump of
  `@ciotlosm/neary-gtfs-core`.
- **Dependency isolation.** The package's runtime deps are exactly
  three: `csv-parse`, `gtfs-realtime-bindings`, `zod`. No SQLite
  driver, no HTTP framework, no language-specific runtime. Works in
  Node (producer) and the browser (consumer's Web Worker bundle).
- **Versioned independently.** Producer can ship a v0.2.0 of the
  shared package adding CSV readers without forcing the consumer to
  bump anything until the consumer wants to use them.

### What goes in the package

The library covers **strictly GTFS spec** — anything that codifies
the Schedule (CSV) and Realtime (protobuf) specs. Anything that's our
app's convention or per-feed knowledge stays in the apps.

**Architecture invariant**: the library has zero per-feed knowledge.
Per-feed quirks (Cluj direction_id recovery, Swiss auth proxy, etc.)
live in the producer's `packages/gtfs-rt/src/quirks/`, never in the
library. If a future feed needs new quirk logic, the fix is a new
module in the producer — never a PR to the library.

```
packages/shared/                     ← published as @ciotlosm/neary-gtfs-core
├── package.json                     ← exports types + JS, both ESM and CJS
├── tsconfig.json
├── src/
│   ├── schema/                      ← GTFS Schedule column types per file
│   │   ├── stops.ts                 ← stop_id, stop_name, stop_lat, ...
│   │   ├── routes.ts
│   │   ├── trips.ts                 ← route_id, service_id, trip_id, direction_id, ...
│   │   ├── stop-times.ts            ← arrival_time, departure_time, stop_sequence, ...
│   │   ├── shapes.ts
│   │   ├── calendar.ts
│   │   ├── calendar-dates.ts
│   │   └── index.ts
│   ├── csv/                         ← one reader per spec file (csv-parse based)
│   │   ├── stops.ts
│   │   ├── routes.ts
│   │   ├── trips.ts
│   │   ├── stop-times.ts
│   │   ├── shapes.ts
│   │   ├── calendar.ts
│   │   ├── calendar-dates.ts
│   │   └── index.ts
│   ├── shapes/                      ← pure geometry, but used only for GTFS shapes
│   │   │                              ← stays here for now; split into
│   │   │                              ← @neary/shape-utils only if a 2nd
│   │   │                              ← consumer appears
│   │   ├── project-on-polyline.ts
│   │   ├── measure-polyline.ts
│   │   └── index.ts
│   ├── proto/                       ← GTFS-RT protobuf types
│   │   ├── index.ts                 ← re-exports from gtfs-realtime-bindings
│   │   └── rt.ts
│   ├── sql/                         ← canonical GTFS SQLite DDL strings
│   │   └── ddl.ts                   ← CREATE TABLE stops, routes, ... (per spec)
│   └── time.ts                      ← HH:MM:SS ↔ minutes; spec's quirky time
│                                       format (hours can exceed 23 for
│                                       service-day continuation; DST handling)
└── tests/
    ├── csv.test.ts                  ← spec fixtures round-trip through readers
    ├── shapes.test.ts
    ├── proto.test.ts
    └── roundtrip.test.ts            ← CSV → typed → DDL → sqlite: same data
```

**What's NOT in the library** (stays in apps):

| thing | where it lives | why it's not GTFS |
|---|---|---|
| `feeds.json` manifest format | both apps, separately | our convention; the GTFS spec has no concept of "feed registry" |
| Per-feed quirks (Cluj, Swiss, etc.) | producer only (`packages/gtfs-rt/src/quirks/`) | per-feed knowledge is the producer's job |
| OPFS SAH-pool file naming | this consumer | our caching scheme |
| Reconciler, station board, ETAs | this consumer | our runtime logic |
| RT adapter HTTP server | producer only | our deployment shape |
| The cached-clean-RT publishing decision | producer only | our operational policy |

Estimated size: ~1,500 LoC + ~600 LoC tests.

### What stays out (and where it lives instead)

**In the consumer (`neary`):** runtime + reactive + UI
- `Vehicle`, `ReconciledVehicle`, `StationBoardRow` types — runtime
  constructs, not GTFS spec
- Reconciler, station board, live pipeline
- sqlite-wasm specific SQL queries
- `feeds.json` loader — our manifest convention, not GTFS
- All stores, Svelte components, routes

**In the producer (`neary-gtfs`):** pipeline + ops
- `packages/gtfs-static/src/pipeline.ts`, `feed-registry.ts`
- `packages/gtfs-rt/src/adapter.ts`, `poller.ts`, `merge.ts`,
  `quirks/{cluj,swiss,generic,...}.ts`
- `feeds.json` emitter — our manifest convention
- `Dockerfile`, terraform, systemd unit

### Dependency list

```json
{
  "dependencies": {
    "csv-parse": "^5.5.0",
    "gtfs-realtime-bindings": "^1.1.0",
    "zod": "^3.22.0"
  }
}
```

Three runtime deps, that's it. The consumer only pays for what it
imports — `csv-parse` doesn't get pulled into the browser bundle unless
the consumer imports from `@ciotlosm/neary-gtfs-core/csv` (which it
won't, since the consumer reads sqlite not CSVs).

`zod` is used for **GTFS spec validation** (e.g., "stop_times.txt rows
have `arrival_time` in `HH:MM:SS` format, lat/lon are valid floats in
range"), not for our app's manifest.

### Migration order

1. **Stand up `packages/shared/`** in the new monorepo with
   `schema/` (GTFS types) + `shapes/` (math) + `proto/` (RT re-exports)
   + `time.ts` — the consumer can adopt this surface immediately with
   no behaviour change.
2. **Migrate the consumer** to depend on `@ciotlosm/neary-gtfs-core`:
   replace `src/lib/domain/shapeProjection.ts` (the pure-math parts)
   with imports. ~225 lines of consumer code deleted; behaviour
   identical. The consumer's own `feeds.json` loader and `Feed` types
   stay in this repo — they're not GTFS spec.
3. **Add CSV readers** in v0.2.0 of the package; the producer's
   `gtfs-static` consumes them.
4. **Add SQL DDL** in v0.3.0; the producer's writer consumes them;
   the consumer's sqlite-wasm queries can optionally consume them too
   (the consumer's queries are already correct, so this is a "clean
   up the source of truth" not a behaviour change).
5. **Publish story**: monorepo publishes to GitHub Packages on tag;
   `neary` consumes via `.npmrc` pointing at the GitHub registry.

## Monorepo vs multi-repo

Three options, in order of preference:

1. **Monorepo with two deploy targets** — `packages/gtfs-static` and
   `packages/gtfs-rt` under one repo. Shared library lives in
   `packages/shared`. Two CI workflows (one for each). Single repo to
   read when adding a new feed.

2. **Two repos + one shared lib** — `neary-gtfs-shared` (library) +
   `neary-gtfs-static` (cron) + `neary-gtfs-rt` (always-on). Three
   repos to read.

3. **Two repos, copy-pasted shared code** — cheap now, drift surface
   later.

**Recommendation: option 1.** Single source of truth, atomic changes,
one CI. Three repos is overkill for one maintainer; copy-paste is a
debt trap. The split into packages is real but lives at the package
boundary, not the repo boundary.

## Proposed folder structure

```
neary-gtfs/                                # monorepo root
├── .github/
│   ├── workflows/
│   │   ├── static-build.yml              # daily cron — runs packages/gtfs-static
│   │   ├── rt-adapter.yml                # build + deploy adapter to Hetzner
│   │   └── shared-checks.yml             # PR checks (lint, test, schema validate)
│   └── dependabot.yml
├── packages/
│   ├── shared/                           # library — used by both pipelines
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── gtfs/
│   │   │   │   ├── csv-parser.ts         # csv-parse wrapper for GTFS CSVs
│   │   │   │   ├── sqlite-writer.ts      # better-sqlite3 → GTFS-shaped tables
│   │   │   │   └── schema.ts             # GTFS table column types
│   │   │   ├── rt/
│   │   │   │   ├── proto-decode.ts       # gtfs-realtime-bindings wrapper
│   │   │   │   └── proto-encode.ts
│   │   │   ├── feeds-json/
│   │   │   │   ├── schema.ts             # zod schema for the manifest
│   │   │   │   └── emitter.ts            # write feeds.json manifest
│   │   │   └── r2/
│   │   │       └── client.ts             # S3-compatible wrapper for R2
│   │   └── tests/
│   ├── gtfs-static/                      # offline pipeline (cron)
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── pipeline.ts               # main entry: fetch upstream → build → emit
│   │   │   └── feed-registry.ts          # which feeds to build + from where
│   │   └── tests/
│   │       └── test_pipeline.ts
│   └── gtfs-rt/                          # live RT adapter (always-on)
│       ├── package.json
│       ├── src/
│       │   ├── adapter.ts                # Fastify HTTP server: serves /rt/<feed>/<endpoint>
│       │   ├── poller.ts                 # upstream fetch on interval
│       │   ├── merge.ts                  # multi-source merge + dedupe
│       │   ├── quirks/                   # PER-FEED CLEANUP LIVES HERE
│       │   │   ├── index.ts
│       │   │   ├── base.ts                # shared cleanup helpers
│       │   │   ├── cluj.ts               # Cluj: fix direction_id + start_time
│       │   │   ├── swiss.ts              # Swiss SBB (auth proxy / 404 normalisation)
│       │   │   └── generic.ts            # field-by-field patcher from config
│       │   └── cache.ts                  # in-memory + R2 read-through cache
│       ├── Dockerfile
│       └── tests/
│           ├── test_cluj_quirks.ts
│           └── test_adapter.ts
├── config/
│   ├── feeds.example.yaml                # per-feed config (upstream URLs,
│   │                                   # quirk modules to apply, poll cadence)
│   └── feeds.local.yaml.example
├── ops/
│   ├── terraform/                        # optional — Hetzner + R2 + DNS
│   │   └── hcloud/
│   │       ├── main.tf
│   │       └── variables.tf
│   └── systemd/
│       └── neary-gtfs-rt.service         # systemd unit for the adapter
├── docs/
│   ├── README.md                          # monorepo overview
│   ├── architecture.md                    # how static + rt interact (data flow)
│   ├── quirks-guide.md                    # how to add a new feed's quirks
│   └── ops/
│       ├── deployment.md                  # how to deploy to Hetzner + CF
│       └── runbook.md                     # common incidents + fixes
├── .gitignore
├── package.json                          # workspace root (pnpm/npm/yarn workspaces)
├── pnpm-workspace.yaml                   # or package.json "workspaces" field
├── pnpm-lock.yaml
├── README.md
└── LICENSE
```

### Why this shape

- **`packages/shared`** — every per-feed detail (e.g. the `cluj.ts`
  quirks module) sits in `gtfs-rt/quirks/`, not in the consumer. The
  consumer never branches on `feed.id` again. `packages/shared` exists
  so static + rt can share the protobuf decode/encode and the
  `feeds.json` schema/emit logic without duplication.
- **Two CI workflows, one source tree** — `static-build.yml` is a
  GitHub Actions cron that runs `packages/gtfs-static` and pushes
  results to R2. `rt-adapter.yml` builds the Docker image and deploys
  it to Hetzner. Both share `packages/shared`; changes to one workflow
  can ship through the other without coordination.
- **No tests for `gtfs-static` beyond the pipeline glue** — the static
  build is mostly orchestration. Heavy lifting (CSV parse, sqlite
  write) lives in `packages/shared` and gets tested there. The static
  pipeline itself gets one or two smoke tests against a fixture feed.
- **`ops/`** — terraform for Hetzner provisioning lives next to the
  service it provisions; systemd unit file lives with the adapter it
  runs. Keeps ops next to the code that owns it.

### Why Node

- **The cost driver is the live RT adapter** (always-on VM), not the
  static pipeline (daily cron). Node wins on the cost-relevant axes
  for an always-on service: smaller Docker image (~50 MB vs ~80 MB),
  faster cold-start (~50 ms vs ~200-500 ms with pandas), lower idle
  RAM (~30-50 MB vs ~80-120 MB).
- **The static pipeline is fine on GitHub Actions free tier** even
  with Node — a 5-min build for the daily cron is well within the
  2,000 min/month allowance. CSV-parse speed matters; even a slow
  Node parse is under 2 min for the largest feeds, so the 2-3×
  pandas advantage is academic here.
- **Consistency with the consumer repo** — this `neary` app is JS/TS.
  One language, one linter, one test runner, one set of CI conventions
  across both repos. The producer's contract with the consumer is a
  wire format (protobuf + sqlite + feeds.json), not source code, so
  there's no real "code sharing" benefit to a Python producer.
- **GTFS-RT tooling parity** — this repo already uses
  `gtfs-realtime-bindings` (Google's protobuf). Same lib works on the
  producer. For the static side, `csv-parse` + `better-sqlite3` is
  the equivalent of pandas + sqlite3 in ~200 lines of glue — no
  GTFS-specific magic needed since the spec is just a bag of CSVs.

### What about Python

If you ever need it: `pandas` + `gtfs-kit` would be the equivalent
stack. The trade is ~3× faster CSV parsing (which doesn't matter
for a daily cron) for a much larger runtime + slower cold-start
(which does matter for an always-on service). Keep Python in your back
pocket for data-exploration scripts, but the deployable monorepo is
Node.

## Deploy shape

```
                ┌─────────────────────────────────────────┐
                │ Hetzner CX22 (€4.50/mo, fixed)         │
                │                                         │
                │   packages/gtfs-rt                      │
                │   ┌──────────────┐                      │
                │   │ adapter.ts   │                      │
                │   │ (Fastify)    │◀──── polls upstream  │
                │   └──────┬───────┘     every 15–30 s    │
                │          │                              │
                │          ▼                              │
                │   ┌──────────────┐                      │
                │   │ cache.ts     │                      │
                │   │ (R2 cache    │                      │
                │   │  read-through│                      │
                │   └──────────────┘                      │
                └────────────┬────────────────────────────┘
                             │ cache miss only
                             ▼
                ┌─────────────────────────────────────────┐
                │ Cloudflare (free CDN egress)            │
                │                                         │
                │   Worker on edge POP                    │
                │     ├─ cache hit   → serve (~free)       │
                │     └─ cache miss  → fetch from Hetzner │
                │                          (cold path)    │
                └────────────┬────────────────────────────┘
                             │
                             ▼
                       User (every 15 s)
```
neary-gtfs/                                # monorepo root
├── .github/
│   ├── workflows/
│   │   ├── static-build.yml              # daily cron — runs gtfs-static
│   │   ├── rt-adapter.yml                # build + deploy adapter to Hetzner
│   │   └── shared-checks.yml             # PR checks (lint, test, schema validate)
│   └── dependabot.yml
├── packages/
│   ├── shared/                           # library — used by both pipelines
│   │   ├── pyproject.toml
│   │   ├── src/neary_gtfs_shared/
│   │   │   ├── __init__.py
│   │   │   ├── gtfs/
│   │   │   │   ├── csv_parser.py         # GTFS CSV → typed records
│   │   │   │   └── sqlite_writer.py     # typed records → sqlite3 blob
│   │   │   ├── rt/
│   │   │   │   ├── proto_decoder.py     # GTFS-RT protobuf decode
│   │   │   │   └── proto_encoder.py     # clean protobuf encode
│   │   │   ├── feeds_json/
│   │   │   │   ├── schema.py            # feeds.json schema + validation
│   │   │   │   └── emitter.py           # write feeds.json manifest
│   │   │   └── r2/
│   │   │       └── client.py            # R2 put/get wrapper
│   │   └── tests/
│   ├── gtfs-static/                      # offline pipeline (cron)
│   │   ├── pyproject.toml
│   │   ├── src/neary_gtfs_static/
│   │   │   ├── __init__.py
│   │   │   ├── pipeline.py              # main entry: fetch upstream → build → emit
│   │   │   └── feed_registry.py         # which feeds to build + from where
│   │   └── tests/
│   │       └── test_pipeline.py
│   └── gtfs-rt/                          # live RT adapter (always-on)
│       ├── pyproject.toml
│       ├── src/neary_gtfs_rt/
│       │   ├── __init__.py
│       │   ├── adapter.py                # HTTP server: serves /rt/<feed>/<endpoint>
│       │   ├── poller.py                 # upstream fetch on interval
│       │   ├── merge.py                  # multi-source merge + dedupe
│       │   ├── quirks/                   # PER-FEED CLEANUP LIVES HERE
│       │   │   ├── __init__.py
│       │   │   ├── base.py               # shared cleanup helpers
│       │   │   ├── cluj.py               # Cluj: fix direction_id + start_time
│       │   │   ├── swiss.py              # Swiss SBB (auth proxy / 404 normalisation)
│       │   │   └── generic.py            # field-by-field patcher from config
│       │   └── cache.py                  # in-memory + R2 read-through cache
│       ├── Dockerfile
│       └── tests/
│           ├── test_cluj_quirks.py
│           └── test_adapter.py
├── config/
│   ├── feeds.example.yaml                # per-feed config (upstream URLs,
│   │                                   # quirk modules to apply, poll cadence)
│   └── feeds.local.yaml.example
├── ops/
│   ├── terraform/                         # optional — Hetzner + R2 + DNS
│   │   └── hcloud/
│   │       ├── main.tf
│   │       └── variables.tf
│   └── systemd/
│       └── neary-gtfs-rt.service         # systemd unit for the adapter
├── docs/
│   ├── README.md                          # monorepo overview
│   ├── architecture.md                    # how static + rt interact (data flow)
│   ├── quirks-guide.md                    # how to add a new feed's quirks
│   └── ops/
│       ├── deployment.md                  # how to deploy to Hetzner + CF
│       └── runbook.md                     # common incidents + fixes
├── .gitignore
├── .pre-commit-config.yaml
├── pyproject.toml                         # workspace metadata (uv / pdm / poetry)
├── uv.lock                                # or poetry.lock / pdm.lock
├── README.md
└── LICENSE
```

### Why this shape

- **`packages/shared`** — every per-feed detail (e.g. the `cluj.py`
  quirks module) sits in `gtfs-rt/quirks/`, not in the consumer. The
  consumer never branches on `feed.id` again. `packages/shared` exists
  so static + rt can share the protobuf decode/encode and the
  `feeds.json` schema/emit logic without duplication.
- **Two CI workflows, one source tree** — `static-build.yml` is a
  GitHub Actions cron that runs `packages/gtfs-static` and pushes
  results to R2. `rt-adapter.yml` builds the Docker image and deploys
  it to Hetzner. Both share `packages/shared`; changes to one workflow
  can ship through the other without coordination.
- **No tests for `gtfs-static` beyond the pipeline glue** — the static
  build is mostly orchestration. Heavy lifting (CSV parse, sqlite
  write) lives in `packages/shared` and gets tested there. The static
  pipeline itself gets one or two smoke tests against a fixture feed.
- **`ops/`** — terraform for Hetzner provisioning lives next to the
  service it provisions; systemd unit file lives with the adapter it
  runs. Keeps ops next to the code that owns it.

### Why Node

- **The cost driver is the live RT adapter** (always-on VM), not the
  static pipeline (daily cron). Node wins on the cost-relevant axes
  for an always-on service: smaller Docker image (~50 MB vs ~80 MB),
  faster cold-start (~50 ms vs ~200-500 ms with pandas), lower idle
  RAM (~30-50 MB vs ~80-120 MB).
- **The static pipeline is fine on GitHub Actions free tier** even
  with Node — a 5-min build for the daily cron is well within the
  2,000 min/month allowance. CSV-parse speed matters; even a slow
  Node parse is under 2 min for the largest feeds, so the 2-3×
  pandas advantage is academic here.
- **Consistency with the consumer repo** — this `neary` app is JS/TS.
  One language, one linter, one test runner, one set of CI conventions
  across both repos. The producer's contract with the consumer is a
  wire format (protobuf + sqlite + feeds.json), not source code, so
  there's no real "code sharing" benefit to a Python producer.
- **GTFS-RT tooling parity** — this repo already uses
  `gtfs-realtime-bindings` (Google's protobuf). Same lib works on the
  producer. For the static side, `csv-parse` + `better-sqlite3` is
  the equivalent of pandas + sqlite3 in ~200 lines of glue — no
  GTFS-specific magic needed since the spec is just a bag of CSVs.

### What about Python

If you ever need it: `pandas` + `gtfs-kit` would be the equivalent
stack. The trade is ~3× faster CSV parsing (which doesn't matter
for a daily cron) for a much larger runtime + slower cold-start
(which does matter for an always-on service). Keep Python in your back
pocket for data-exploration scripts, but the deployable monorepo is
Node.

## Deploy shape

```
                ┌─────────────────────────────────────────┐
                │ Hetzner CX22 (€4.50/mo, fixed)         │
                │                                         │
                │   packages/gtfs-rt                      │
                │   ┌──────────────┐                      │
                │   │ adapter.py   │                      │
                │   │ (uvicorn)    │◀──── polls upstream  │
                │   └──────┬───────┘     every 15–30 s    │
                │          │                              │
                │          ▼                              │
                │   ┌──────────────┐                      │
                │   │ cache.py     │                      │
                │   │ (R2 cache    │                      │
                │   │  read-through│                      │
                │   └──────────────┘                      │
                └────────────┬────────────────────────────┘
                             │ cache miss only
                             ▼
                ┌─────────────────────────────────────────┐
                │ Cloudflare (free CDN egress)            │
                │                                         │
                │   Worker on edge POP                    │
                │     ├─ cache hit   → serve (~free)       │
                │     └─ cache miss  → fetch from Hetzner │
                │                          (cold path)    │
                └────────────┬────────────────────────────┘
                             │
                             ▼
                       User (every 15 s)
```

- **Hetzner VM** runs the adapter as a systemd-managed Docker
  container. Polls upstream every 30 s, keeps the clean protobuf in
  memory, writes through to R2 on success. Per-feed quirks applied
  before encoding.
- **CF Worker** is a thin cache-and-passthrough. Receives request,
  checks CF edge cache (TTL set by adapter's response header),
  on miss fetches from Hetzner. Logs the cold-path latency.
- **Static blobs** stay on R2 + CF Pages CDN exactly as today; no
  change needed.

## R2 layout (post-monorepo)

```
gtfs.n3ary.com/
├── feeds.json                            # manifest (one entry per feed)
├── <id>-<hash>.sqlite3.gz                # static blob (content-addressed)
└── rt/
    ├── <id>/
    │   ├── vehiclePositions.pb           # cleaned RT, cached
    │   ├── tripUpdates.pb
    │   └── serviceAlerts.pb
    └── ...
```

The consumer (`neary`) doesn't change. `feeds.json` still has the same
schema; the `realtime.*` URLs now point at the adapter's clean feed
(rather than upstream directly).

## Migration plan

Order matters. Each step is independently shippable.

1. **Stand up the monorepo skeleton** on a new repo (`neary-gtfs` →
   reorganised as monorepo, or new repo with the same name and old
   `neary-gtfs-static` content migrated). No behaviour change yet;
   the static pipeline just moves to its new home.
2. **Extract `packages/shared`** — pull the existing CSV-parse and
   sqlite-write code out of the current pipeline into the shared lib.
   Static pipeline imports from it. CI green; static pipeline still
   produces the same blobs.
3. **Stand up `packages/gtfs-rt`** with the Cluj quirk as the pilot.
   Deploy to Hetzner. Configure the CF Pages Function (or Worker)
   that already exists to proxy the request — point it at the
   Hetzner origin. Verify clean feed is published and the consumer
   picks up correct `direction_id` and `start_time` automatically.
4. **Hold PR #159** in the consumer until step 3 ships and the clean
   feed has been live for a week without orphan-regression. Then
   merge; `feedQuirks.ts` deletion becomes the consumer's last
   feed-agnostic action.
5. **Add per-feed quirk files** as new feeds need them. Each quirk
   is its own small module (`< 50 lines`), added under
   `packages/gtfs-rt/src/neary_gtfs_rt/quirks/`. Document the pattern
   in `docs/quirks-guide.md`.
6. **Multi-source merging** — when a feed needs combining two
   upstream sources, extend `merge.py` + add per-source config. The
   consumer stays identical.

## Open questions

- **Language**: Node + TypeScript for the whole monorepo. Rationale
  in "Why Node" above. Kept here as a question only so it's explicit
  that this is the decision; flip back to Python only if you change
  your mind about the cost framing.
- **Hetzner vs alternatives**: this plan assumes Hetzner for the
  always-on VM. Alternatives if Hetzner pricing changes or you want
  more edge presence: Deno Deploy ($/req), Fly.io (similar shape to
  Hetzner + edge), Render (managed VMs). The architecture is the
  same; only the deploy target changes.
- **R2 vs KV for the adapter cache**: R2 is cheaper for binary blobs;
  KV is cheaper for small frequently-read JSON. The adapter writes
  protobuf → R2 wins.
- **Polling cadence**: 30 s is a guess. With the CF cache in front
  the user sees 15 s freshness regardless. Adapter polls upstream at
  30 s for cost / upstream respect.
- **Auth-required upstreams** (e.g. Swiss SBB): the producer's adapter
  needs to hold credentials. Standard secrets-via-env-vars on the
  Hetzner VM. The consumer never sees them.

## What this repo (the consumer) needs to do

Likely **nothing** once the adapter is shipping clean feeds. The
existing reconciler handles correctly-populated `direction_id` /
`start_time` without any quirks module.

The consumer-side refactor that **can** happen independently of the
producer work is the `@ciotlosm/neary-gtfs-core` migration: replace
`src/lib/domain/shapeProjection.ts` (the pure-math parts) with
imports from the library. ~225 lines deleted, behaviour identical.
Safe to do alongside PR #159 or as its own follow-up PR.

The consumer's own `feeds.json` loader and `Feed` types stay in this
repo — they're our manifest convention, not GTFS spec, and don't
belong in the shared library.

The remaining consumer-side change after #159 is documentation: add a
note to `docs/specs/` saying "the RT feed is expected to be
pre-cleaned by the producer; the consumer treats it as
GTFS-RT-spec-compliant and does not branch on `feed.id` for RT
behavior."

## Status

Plan only — no implementation yet. Tracked under issue: TBD.