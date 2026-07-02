# feeds.json

The app-facing catalog published by the [neary-gtfs](https://github.com/ciotlosm/neary-gtfs) repo.

**Live URL**: `https://gtfs.n3ary.com/feeds.json` (Cloudflare R2 via custom domain)

**Schema** (authoritative, Ajv-validated at build time):
`https://github.com/ciotlosm/neary-gtfs/blob/main/schemas/feeds.schema.json`

This doc captures the contract from the app's perspective.

## Top-level shape

```jsonc
{
  "version": "2026-06-26T06:44:33.068Z",
  "generated_at": "2026-06-26T06:44:33.068Z",
  "feeds": [ /* Feed[] */ ]
}
```

## Per-feed fields the app relies on

```jsonc
{
  "id": "cluj-napoca",                          // stable, what userPrefs.feedId stores
  "name": "Cluj-Napoca",
  "country": "RO",
  "timezone": "Europe/Bucharest",               // used by tz math, see live-data-pipeline.md
  "bbox": { "minLat": …, "minLon": …,
            "maxLat": …, "maxLon": … },         // GPS auto-pick
  "center": { "lat": …, "lon": … },
  "agencies": [
    { "agency_id": "2", "agency_name": "CTP Cluj", "agency_url": "…" }
  ],
  "files": {
    "sqlite_gz": "cluj-napoca-6fa8a70c3f0b.sqlite3.gz"   // filename embeds first 12 hex of hash
  },
  "size_bytes": { "sqlite_gz": 5716840 },
  "hash": "sha256-…",                           // used for freshness check
  "realtime": {
    "vehicle_positions": "https://cluj-rt-feed.gtfs.ro/vehiclePositions",
    "trip_updates":      "https://cluj-rt-feed.gtfs.ro/tripUpdates",
    "service_alerts":    "https://cluj-rt-feed.gtfs.ro/serviceAlerts"
  },
  "license": { /* SPDX + attribution */ }
}
```

## How the app uses each field

| Field | Used by |
|---|---|
| `id` | `userPrefs.feedId`, OPFS filename, favorites key, worker `setFeed` |
| `name`, `country`, `region` | Settings picker display |
| `timezone` | All wall-clock math; `nowMin` derivation; bucket boundaries |
| `bbox`, `center` | GPS auto-pick (`locationStore.pickFeed`) |
| `agencies` | Worker-side live matching; future per-agency badging |
| `files.sqlite_gz` | GTFS worker download URL (cold switch) |
| `hash` | Freshness check — mismatch ⇒ mark stale |
| `realtime.vehicle_positions` | Worker GTFS-RT poll target |
| `realtime.trip_updates`, `service_alerts` | Reserved (not consumed yet) |
| `license` | Settings "About" attribution panel |

## Cache headers

R2 serves `feeds.json` with `cache-control: public, max-age=300` and an
ETag. The app fetches with `cache: 'no-cache'` (forces `If-None-Match`
revalidation) so unchanged loads return 304 with no body. Sqlite files
are served with `cache-control: public, max-age=31536000, immutable` —
safe because URLs are content-addressed (`<id>-<hash12>.sqlite3.gz`),
so a content change produces a new URL that no client has cached.
See [multi-feed-data-lifecycle.md](multi-feed-data-lifecycle.md#freshness-check).

## When this contract changes

If `feeds.json` needs a breaking schema change:

1. Open a PR on the neary-gtfs repo first.
2. Land app-side reader changes that handle both shapes (back-compat window).
3. Cut neary-gtfs pipeline to publish the new schema to R2.
4. Remove the back-compat code from the app.

Versioning: no `/v1/feeds.json` style; one file at a stable URL.
Schema is intentionally additive — new optional fields only, breaks coordinated.
