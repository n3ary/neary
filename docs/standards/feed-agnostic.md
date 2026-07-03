# Feed-agnostic app

Neary is a generic GTFS / GTFS-RT consumer. It MUST work for any feed
that follows the GTFS spec, and it MUST NOT carry per-feed exceptions.
Feeds that ship non-conformant data fix themselves upstream.

## Rules

- **MUST** treat every input column, table, file, and field per the
  [GTFS Schedule reference](https://gtfs.org/documentation/schedule/reference/)
  and the [GTFS Realtime reference](https://gtfs.org/documentation/realtime/reference/).
- **MUST** branch on capability or shape (column present, value
  non-empty, optional field set), never on `feed.id`, agency name,
  city, or any feed-specific token.
- **MUST NOT** add `if (feedId === 'cluj-napoca')`, `if (agency ===
  'CTP')`, or equivalent. The grep `feed\.id\s*===|feedId\s*===\s*['"]`
  in any code under `src/` is a CI-grade smell.
- **MUST NOT** import feed-specific palettes, name maps, schedule
  patches, route-type overrides, or vehicle-type fallbacks. If a feed
  needs them, they live in the producer (neary-gtfs and/or its source
  adapters like cluj-napoca-gtfs-adapter), not here.
- **MUST** fail loudly on missing required GTFS fields rather than
  silently substituting a feed-aware default. Optional fields degrade
  gracefully, not specifically.
- **SHOULD** add a column / capability probe (e.g. `PRAGMA table_info`)
  when the SQLite schema is evolving, so older blobs degrade gracefully
  for ALL feeds.

## Where bugs go

| Symptom | Fix lives in |
|---|---|
| One feed renders wrong colors, names, routes | The feed's producer (neary-gtfs or its source adapter) |
| GTFS spec violation (e.g. `route_desc` duplicates `route_long_name`) | The feed's producer, not here |
| Real-time payload deviates from GTFS-RT proto | The feed's RT gateway, not here |
| Every feed renders wrong | This repo — it's a bug in neary |

When you find a per-feed problem, open an issue against the producer
repo, not against neary. Link the producer issue from your PR if the
neary change needs to land in lockstep.

## Why

Per-feed branches metastasise: one `if (city === 'X')` becomes ten,
then the data layer can't be reasoned about without knowing every
feed's history. Keeping the producer as the only place that knows
feed-specific facts means neary stays a clean GTFS reference consumer
and any new feed works without code changes.