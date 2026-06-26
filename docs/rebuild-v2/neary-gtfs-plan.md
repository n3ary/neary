# neary-gtfs — refactor plan (Transitous-aligned)

Status: **draft** — to be opened as a PR / branch on `ciotlosm/neary-gtfs`.
Date: 2026-06-26.
Lives in this repo (neary v2) because it directly informs Phase 4 / 5 of the
[v2 rebuild plan](plan.md) and the app cannot ship without the registry it
describes.

---

## 1. Goal

Reduce `neary-gtfs` to the **minimum unique work**:

1. The **CTP Cluj enhancement** — scrape `ctpcj.ro` official CSV timetables
   daily, produce a spec-compliant GTFS `.zip` that's fresher than the
   `mdb-2121` mirror everyone else uses.
2. A **SQLite conversion** of every feed we want the neary v2 app to load
   (ours-for-Cluj + a curated subset of Transitous's outputs for everything
   else).
3. An **app-facing index** (`feeds.json`) the neary app fetches on launch.

Stop maintaining: a custom registry schema, agency-shaped JSON outputs,
hash-based change-detection bookkeeping, Tranzy-syncing. Transitous already
does all of this better.

## 2. What goes away

| Today in neary-gtfs | Why it goes |
|---|---|
| `src/sync-tranzy.js` (daily Tranzy API mirror) | Tranzy's schedule data is lossy (no arrival/departure times); its live vehicles are now public via `cluj-rt-feed.gtfs.ro` |
| `data/agency.json` (Tranzy-shaped registry) | Transitous's `feeds/<iso>.json` is the standard. We project from it. |
| `data/<id>/{routes,stops,trips,stop_times,shapes}.json` | Redundant once the app consumes standard GTFS .zip + SQLite |
| `agency-2-schedule.json` (custom compact format) | Redundant once we ship `.sqlite3.gz` |
| Bespoke `hashes.json` cache-busting | GitHub raw URLs already serve `Last-Modified`/`ETag`; Transitous handles the same on upstream feeds |
| Per-agency `agencies/<id>/config.json` for non-Cluj agencies | Transitous's `ro.json` already lists those agencies; we curate via the country list, not per-agency |

## 3. What survives

| Today in neary-gtfs | New role |
|---|---|
| `agencies/2/config.json` — CTP URL patterns + service-day mappings | Move to `feeds/ctp-cluj/config.json` |
| `src/build.js` — ctpcj.ro CSV scraper | Move to `feeds/ctp-cluj/build.js`. **Only custom build script we keep.** |
| Daily GitHub Action | Rewritten — see §6 |

## 4. Tranzy.ai — final disposition

**Removed entirely.** Replaced by:

| Tranzy capability | Replacement |
|---|---|
| Live vehicle positions | `https://cluj-rt-feed.gtfs.ro/vehiclePositions` (public, free, standard GTFS-RT protobuf, no API key) |
| Trip updates | `https://cluj-rt-feed.gtfs.ro/tripUpdates` (same) |
| Service alerts | `https://cluj-rt-feed.gtfs.ro/serviceAlerts` (same) |
| Schedule (lossy) | ctpcj.ro CSV → our GTFS |
| Route / stop / trip / shape JSON | Standard GTFS via the SQLite blob |

The v2 app's `userPrefs.apiKey` field is also dropped — there's no
optional API key concept anymore.

## 5. Repo structure (`refactor/feeds-from-transitous` branch)

```
neary-gtfs/
├─ countries.json                         # curated list of country codes from
│                                         # Transitous we expose to the neary app
│                                         # Initial: ["ro"]
├─ transitous-feeds/                      # git submodule -> public-transport/transitous
│                                         # gives us feeds/<iso>.json files as input
├─ feeds/
│  └─ ctp-cluj/                           # ONLY custom-built feed
│     ├─ build.js                         # ported from current src/build.js
│     └─ config.json                      # ctpcj.ro URL patterns & service days
├─ src/
│  └─ pipeline/
│     ├─ build-all.js                     # orchestrator (runs daily)
│     ├─ resolve-feeds.js                 # reads countries.json → walks transitous
│     │                                   # feeds/<iso>.json → flattens to a list
│     │                                   # of { name, gtfs_source, rt_sources, license }
│     ├─ fetch-gtfs.js                    # for each feed, fetch the .zip
│     │                                   # (api.transitous.org/gtfs/<name>.gtfs.zip
│     │                                   # for upstream feeds, OR our local
│     │                                   # build output for ctp-cluj)
│     ├─ make-sqlite.js                   # GTFS .zip → .sqlite3.gz
│     │                                   # (port of apps/web's scripts/build-sqlite)
│     ├─ derive-bbox.js                   # min/max lat,lon from stops.txt
│     │                                   # (replaces hand-curated per-feed bboxes)
│     └─ make-app-registry.js             # builds outputs/feeds.json from results
├─ outputs/                               # built artifacts (published to binaries)
│  ├─ feeds.json                          # THE single index the v2 app fetches
│  └─ feeds/
│     ├─ ctp-cluj.gtfs.zip                # standalone (publishable to Transitous)
│     ├─ ctp-cluj.sqlite3.gz
│     ├─ stb-bucuresti.sqlite3.gz         # derived from Transitous's STB mdb-2098
│     ├─ sctp-iasi.sqlite3.gz             # derived from Transitous's Iași mdb-2116
│     └─ ...                              # one per entry in resolved list
└─ .github/workflows/
   └─ daily.yml                           # cron 00:30 UTC → build-all.js → push binaries
```

## 6. Daily pipeline

```
00:30 UTC (chosen to be after Transitous's own ~00:00 UTC import finishes)
  └─ resolve-feeds.js
       ├─ reads countries.json → ["ro"]
       └─ for each iso, reads transitous-feeds/feeds/<iso>.json
            └─ flattens to list:
                 [{
                   id: "Cluj-Napoca",
                   gtfs_source: { type: "mobility-database", mdb-id: "mdb-2121" },
                   rt_sources: [ "vehicle_positions": "...", "trip_updates": "...", "service_alerts": "..." ],
                   license: "CC-BY-SA-4.0"
                 }, ...]
       
  └─ build-cluj.js                       # our unique pipeline
       ├─ scrape ctpcj.ro CSV files (per route, per service day)
       ├─ assemble standard GTFS .zip
       │     - agency.txt (single row, CTP Cluj)
       │     - routes/trips/stops/stop_times/calendar/calendar_dates/shapes
       │     - feed_info.txt with feed_publisher_name="neary-gtfs",
       │       feed_version=<date>, valid_from/until
       ├─ run canonical GTFS validator (MobilityData) → log warnings, fail on errors
       └─ output: outputs/feeds/ctp-cluj.gtfs.zip

  └─ for each resolved feed entry:
       ├─ if ctp-cluj: source = outputs/feeds/ctp-cluj.gtfs.zip (local)
       └─ else:         source = api.transitous.org/gtfs/<name>.gtfs.zip (cached upstream)
            └─ make-sqlite.js: GTFS .zip → <name>.sqlite3.gz
            └─ derive-bbox.js: read stops.txt → { minLat, minLon, maxLat, maxLon }

  └─ make-app-registry.js
       └─ outputs/feeds.json (see §7)

  └─ git commit + force-push to binaries branch (only if any output changed)
```

Output is published to the **`binaries`** branch — separate from
`releases` so the v1 neary app keeps working unchanged.

## 7. `outputs/feeds.json` schema (the app-facing index)

```jsonc
{
  "version": "2026-06-26T00:30:00Z",
  "generated_at": "2026-06-26T00:30:00Z",
  "feeds": [
    {
      "id": "ctp-cluj",                            // stable; what the app picks
      "name": "Cluj-Napoca",                       // human-facing
      "country": "RO",
      "region": "Cluj",
      "timezone": "Europe/Bucharest",
      "languages": ["ro"],
      "bbox": { "minLat": 46.71, "minLon": 23.50,  // derived from stops.txt
                "maxLat": 46.84, "maxLon": 23.74 },
      "center": { "lat": 46.770, "lon": 23.595 },  // bbox midpoint
      "agencies": [                                // pre-parsed from agency.txt
        { "agency_id": "2",
          "agency_name": "Compania de Transport Public Cluj-Napoca",
          "agency_url": "https://www.ctpcluj.ro/" }
      ],
      "source": {                                  // where the GTFS came from
        "type": "build",                           // "build" | "transitous" | "mobility-database"
        "publisher": "neary-gtfs",
        "upstream_url": null
      },
      "files": {
        "gtfs_zip":  "feeds/ctp-cluj.gtfs.zip",    // relative to binaries root
        "sqlite_gz": "feeds/ctp-cluj.sqlite3.gz"
      },
      "size_bytes": { "gtfs_zip": 1395000, "sqlite_gz": 4406857 },
      "hash": "sha256-abc…",                       // for cheap freshness checks
      "generated_at": "2026-06-26T00:30:00Z",
      "valid_from": "2025-11-01",                  // from feed_info.txt
      "valid_until": "2026-06-30",
      "realtime": {                                // copied straight from Transitous
        "vehicle_positions": "https://cluj-rt-feed.gtfs.ro/vehiclePositions",
        "trip_updates":      "https://cluj-rt-feed.gtfs.ro/tripUpdates",
        "service_alerts":    "https://cluj-rt-feed.gtfs.ro/serviceAlerts"
      },
      "license": {
        "spdx_identifier": "CC-BY-SA-4.0",
        "attribution_text": "© Compania de Transport Public Cluj-Napoca",
        "attribution_url": "https://www.ctpcluj.ro/"
      }
    },
    {
      "id": "stb-bucuresti",
      "name": "Bucharest",
      ...
      "source": {
        "type": "transitous",
        "publisher": "Transitous (mdb-2098)",
        "upstream_url": "https://api.transitous.org/gtfs/Bucuresti-Ilfov.gtfs.zip"
      },
      ...
    }
  ]
}
```

## 8. Publishing the Cluj feed for upstream Transitous consumption

Once `outputs/feeds/ctp-cluj.gtfs.zip` is being produced reliably, **open a
PR against `public-transport/transitous`** adding a new source to `ro.json`:

```jsonc
{
  "name": "Cluj-Napoca-CTP",
  "type": "http",
  "url": "https://raw.githubusercontent.com/ciotlosm/neary-gtfs/binaries/feeds/ctp-cluj.gtfs.zip",
  "license": {
    "spdx-identifier": "CC-BY-SA-4.0",
    "attribution-text": "© Compania de Transport Public Cluj-Napoca",
    "publisher": "neary-gtfs"
  },
  "fix": true
}
```

URL hosting choice: **GitHub raw on the `binaries` branch**. Reasoning:
- Free, public, HTTPS, CORS-open.
- Honors `Last-Modified` / `ETag` (Transitous's fetcher uses both).
- Same hosting pattern your current `data/<id>/*.json` already uses.
- Stable URL — branch refs don't change.

Once accepted upstream:
- Every Transitous downstream (KDE Itinerary, GNOME Maps, Bimba, Cartes,
  Railway, plus 100+ more contributors' apps) gets fresher Cluj data.
- Optionally we can either *keep* mdb-2121 as a fallback or have the
  Transitous maintainers drop it (their `skip` field) — that's a discussion
  on the PR.

## 9. Required v2 app changes (in this repo)

Tracked here because they need to land *with* the new `feeds.json` going
live, not before / after. All changes are on the v2 app (`apps/web/`),
nothing in `apps/legacy/`.

### 9.1 `apps/web/src/lib/data/`

| Today | Replacement |
|---|---|
| `agencies.ts` (fetches `data/agency.json`) | `feeds.ts` (fetches `feeds.json` from `binaries`); exposes `Feed[]` with `bbox`, `realtime` URLs, `files.sqlite_gz` |
| `AGENCIES_WITH_SQLITE = new Set([2])` hardcode | Removed — `hasSqlite` is now `feed.files.sqlite_gz != null` directly (always true; entries without SQLite simply aren't in `feeds.json`) |
| `gtfs/repo.ts` `setAgency(agencyId: number)` | `setFeed(feedId: string)` |
| `gtfs/types.ts` `Agency` | `Feed` (broader shape — see §7) |

### 9.2 `apps/web/src/lib/workers/gtfs.worker.ts`

- `seedUrlFor(agencyId)` / `manifestUrlFor(agencyId)` / `opfsFileFor(agencyId)`
  become `seedUrlFor(feed: Feed)` etc., reading
  `feed.files.sqlite_gz` directly.
- The hardcoded special-case for `agencyId === 2` (the dev `/dev-data/` path)
  is dropped — `feeds.json`'s `binaries` URL becomes the single source for
  every feed including Cluj (no more `apps/web/static/dev-data/`).
- Stays agency-parameterized — switching feeds = close current db, seed new
  OPFS file `/<feed-id>.sqlite3`, open.

### 9.3 `apps/web/src/lib/stores/userPrefs.svelte.ts`

| Today | Change |
|---|---|
| `agencyId: number \| null` | `feedId: string \| null` (e.g. `"ctp-cluj"`) |
| `apiKey: string \| null` | **Removed** — no API key needed (Tranzy dropped) |
| `showDropOffOnly`, `showGhostVehicles`, `theme` | Unchanged |

### 9.4 `apps/web/src/routes/settings/+page.svelte`

- Agency picker → **feed picker**, sorted by GPS proximity (auto-pick the
  bbox-containing feed by default; pick from list when no GPS).
- The API key TextField is removed entirely.
- The "Live tracking (optional)" card becomes "Live tracking" (always on
  when the feed has `realtime` URLs).

### 9.5 `apps/web/src/lib/stores/locationStore.svelte.ts` (extension)

Add `pickFeed(feeds: Feed[]): Feed | null` helper that returns the first
feed whose `bbox` contains the current position. Called on first launch
when `userPrefs.feedId == null` and we have a GPS fix.

### 9.6 New worker for live data (Phase 5 starts here)

- `apps/web/src/lib/workers/live.worker.ts` — polls `feed.realtime.*` URLs,
  decodes GTFS-RT via `gtfs-realtime-bindings` (already installed), pushes
  vehicle / alert updates through Comlink.
- **Recommended poll cadence: every 15–30 s.** Validated empirically
  against `cluj-rt-feed.gtfs.ro/vehiclePositions` (2026-06-26):
  - Server regenerates the feed exactly every **10 s** (header
    `timestamp` advances 10 s per sample).
  - Per-vehicle AVL pings arrive every **~1–2 min** upstream (27% of
    vehicles got a newer timestamp within a 60 s window).
  - Polling faster than 10 s gets you the same bytes; slower than 30 s
    makes ghost UI lag behind reality.
  - Vehicle freshness: median 60–110 s, p90 200–260 s. ~10% long-tail
    (parked / transponder issues) — must be handled by the reconciler
    (move into `ghost` after > 5 min of staleness).
- **CORS workaround**: a Netlify Edge Function at `/rt/[feed]/[endpoint]`
  proxies the upstream RT URL with a 5–10 s cache (matching server
  regen). Lives in `apps/web/` edge config; same-origin to the app,
  ~10 lines.

### 9.7 Header status dots

- Schedule dot already wired (Phase 3) — works unchanged with `feedId`.
- Live dot starts reflecting real state in Phase 5 (driven by the live
  worker's last-success timestamp).
- API key dot mention is removed from the Settings copy.

## 10. Sequencing

| Step | Where | Done in |
|---|---|---|
| 1. Refactor `neary-gtfs` to this layout, drop Tranzy | `ciotlosm/neary-gtfs` branch `refactor/feeds-from-transitous` | Out-of-band |
| 2. First `binaries` publish with just `ctp-cluj` + `Bucuresti-Ilfov` (proof of multi-feed) | `ciotlosm/neary-gtfs` | Out-of-band |
| 3. Open Transitous PR adding `Cluj-Napoca-CTP` to `ro.json` | `public-transport/transitous` | Out-of-band, after #2 stable |
| 4. v2 app: swap `agencies.ts` → `feeds.ts`, `agencyId` → `feedId`, drop `apiKey` | This repo, `rebuild/v2-svelte-sqlite` (or a child branch) | Phase 3.5 — small commit |
| 5. v2 app: GPS-based feed auto-pick | Same | Same commit |
| 6. v2 app: real Stations view (Phase 4) | Same | After #4 |
| 7. v2 app: live worker + edge proxy (Phase 5) | Same | After #6 |

Until step 1+2 are live, the v2 app keeps using the dev-only
`apps/web/static/dev-data/agency-2.sqlite3.gz` we generate from
`scripts/build-sqlite`. The migration to `feeds.json` is one well-scoped
commit when the new `binaries` branch is publishing.

## 11. Open items

- **Bbox derivation**: `derive-bbox.js` reads `stops.txt` and takes min/max
  of `stop_lat`/`stop_lon`. Edge case: feeds containing trips that leave
  the urban area (e.g. an intercity route) inflate the bbox. Acceptable
  trade — auto-pick is opinion-free, user can always pick manually.
- **Auto-pick when GPS is inside multiple bboxes** (e.g. rail feed +
  city feed overlap): pick the smallest bbox (= more specific). Document
  in the app picker as "Most-specific feed for this area".
- **Initial countries scope**: `["ro"]`. Adding `["hu", "de", ...]` later
  is one-line edits to `countries.json` plus disk space for more SQLite
  blobs. We grow this once neary v2 has Romanian users actually trying
  to use it abroad.
- **Force-push vs append** to `binaries`: I'd start with appending
  commits (clean diff history per build); switch to force-push later if
  the branch gets too large.

---

## Appendix: example flow for the v2 app's first user

1. User installs the PWA, lands on `/`.
2. App fetches `https://raw.githubusercontent.com/ciotlosm/neary-gtfs/binaries/outputs/feeds.json`.
3. App requests GPS (the location dot turns yellow then green).
4. App's `pickFeed()` finds `ctp-cluj`'s bbox contains the user → sets
   `userPrefs.feedId = "ctp-cluj"` automatically.
5. Worker downloads `feeds/ctp-cluj.sqlite3.gz` (~4 MB) into OPFS.
   StatusBar shows progress.
6. Stations view renders proximity-based station list using the SQLite.
7. Live worker spins up against `cluj-rt-feed.gtfs.ro` via the edge
   proxy. Vehicle dots turn green; ghosts appear for trips that don't
   yet have a live vehicle.

No setup wizard. No API key. No agency dropdown. The user just opens the
app.
