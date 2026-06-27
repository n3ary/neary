# Tranzy integration

Opt-in second live source. Polled in parallel with GTFS-RT when the user
provides an API key and the active feed has a `tranzy.agency_id` mapping
in [feeds.json](../specs/feeds-json.md).

The empirical case for keeping Tranzy optional (rather than primary) is in
[../investigation/tranzy-vs-gtfsrt.md](../investigation/tranzy-vs-gtfsrt.md).

## What it buys

- **Corroboration.** Vehicles confirmed by both sources are stamped
  `kind: 'corroborated'` with `confidence: 'high'` — see
  [../concepts/vehicle.md](../concepts/vehicle.md). UI shows a small "2/2"
  pip.
- **Fresher position.** Tranzy timestamps run ~60 s ahead of GTFS-RT on
  Cluj. The reconciler trusts the fresher source for the displayed
  position when both agree on the trip.
- **Confirmed-predicted classification.** A scheduled trip missing from
  RT *might* be RT lag. If Tranzy also doesn't see it, the row becomes a
  confirmed `predicted` (vs probable) — UI can render with stronger styling.

## Out of scope

- Tranzy as a primary or required source. The default zero-config
  experience does not change.
- Per-vehicle field exposure beyond what the reconciler already needs.
- Storing the key anywhere except `userPrefs` (localStorage). Tranzy
  responses are in-memory only.

## Phasing

### T1 — Worker channel

- Add `tranzyIngester` stage to the live pipeline next to `rtIngester`.
- Poll cadence 30 s (gentler than RT's 15 s; Tranzy is fresher per sample).
- Gated on: `userPrefs.apiKey != null` AND active feed has
  `tranzy.agency_id`. If either is missing, the stage is dropped from the
  composition.
- CORS: Tranzy sends `Access-Control-Allow-Origin: *`, so the worker fetches
  directly. No proxy needed (unlike GTFS-RT — see
  [../specs/live-data-pipeline.md](../specs/live-data-pipeline.md)).

Acceptance: with a key set and Cluj active, the live worker reports
Tranzy poll success in the StatusBar live dot tooltip; without a key or
on a non-Tranzy feed, the stage is absent from `composePipeline` output.

### T2 — Reconciler corroboration

- New `multiSourceCorroborator` stage runs after `rtScheduleReconciler`.
- Match key across channels: **license plate** (Tranzy `label` ≡
  GTFS-RT `entity.id`).
- Two sources point at the same trip → `kind: 'corroborated'`, `confidence: 'high'`, `liveSources` is the union.
- Existing single-source matches stay as `reconciled`.

Acceptance: in dev with both feeds running, at least some Cluj vehicles
land as `corroborated`; UI shows the high-confidence pip.

### T3 — Settings UI

- Tranzy API key field in **Settings → Advanced** (not the main Settings page).
- Copy frames it as opt-in: "Add a Tranzy key for higher-confidence live tracking. Optional."
- New toggle "Show out-of-service fleet (debug)" gates the fleet-completeness
  overlay (the ~251 yard buses Tranzy reports but RT filters).

Acceptance: a user can paste a key, see the live dot tooltip update, and
clear the key without disrupting the rest of the app.

## Non-obvious gotchas

- **Per-vehicle freshness comparison.** When both sources report the same
  vehicle, pick the fresher timestamp for the displayed position. Don't
  average — averaging two slightly stale positions is worse than picking
  the freshest one.
- **The fleet-completeness overlay is debug-only.** It surfaces vehicles
  Tranzy reports but RT filters (yard buses, deadheading). Default off;
  never appears in the default station / route board views.
- **Tranzy's `trip_id` format is non-canonical** (`route_dir`, no
  service/block/start-time suffix). Don't try to JOIN it against the
  SQLite `trips` table — only use it as a heuristic for cohort matching
  in the Tranzy-only path.

## What this does NOT change

- The default zero-config experience.
- `vehicle.kind` set for vehicles when only RT is available (still
  `reconciled` / `live` / `predicted`).
- `feeds.json` schema — `tranzy.agency_id` is already an optional field
  per [../specs/feeds-json.md](../specs/feeds-json.md).
