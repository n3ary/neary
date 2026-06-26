# Neary v2 — Rebuild Plan

Status: **approved** — see commit history of this branch (`rebuild/v2-svelte-sqlite`) for execution.
Owner: @ciotlosm. Date: 2026-06-26.

This document is the spec for the v2 rebuild and the only long-form doc we
intentionally keep in-repo. Day-to-day changes go in commit messages and PR
descriptions, not here. Update this file only when the plan itself changes.

---

## 1. Goals

| Goal | Target |
|---|---|
| Cold start to interactive (iOS Safari, mid-range iPhone) | < 1.0 s |
| Time-to-first-station-card after launch | < 250 ms (offline, schedule cached) |
| JS shipped on first paint | < 50 KB gzipped |
| Real GTFS, no dedup hack | First-class, full spec |
| Offline | All views fully usable without network |
| Live GPS | Optional enhancement, never required |
| Skinnable | One CSS file changes the entire app |
| Modular UI | Every primitive runs standalone in a sandbox |

Non-goals: Android-first, desktop-first, multi-agency simultaneously.

---

## 2. Stack — decided

| Layer | Pick | Rationale |
|---|---|---|
| Framework | **Svelte 5 + SvelteKit** | ~3 KB runtime, fine-grained reactivity, single-file components are the sandbox-testable primitive, scoped CSS native, best iOS PWA story. |
| Build | Vite (rolldown-vite when SvelteKit supports it; vanilla Vite otherwise) | |
| Styling | **Tailwind v4** + CSS custom properties for tokens | Skinning = swap one `theme.css`. |
| Headless behaviors | **Melt UI** | Svelte's Radix equivalent — accessible, unstyled, tiny. |
| Icons | **lucide-svelte** | Per-icon tree-shaking. |
| Local DB | **SQLite-WASM (`@sqlite.org/sqlite-wasm`) + OPFS** | Real GTFS as real tables, unlimited storage on iOS 16.4+, worker-isolated. |
| DB transport | Comlink-wrapped Web Worker | Clean RPC; UI never blocks. |
| Network | Native `fetch` | Drop axios (smaller, no vulns). |
| Map | Leaflet 1.9 (kept) | 40 KB. Fix layer-order issues with proper Leaflet panes. |
| Lint+format | **Biome** | One tool replaces ESLint + Prettier. |
| Tests | Vitest + `@testing-library/svelte` + Playwright | |
| Sandbox | **Histoire** | Svelte-native. |
| PWA | `@vite-pwa/sveltekit` + Workbox | |
| TypeScript | 6.0 | |

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────┐
│ UI  (Svelte 5 + Tailwind, main thread)                  │
│   - 4 top-level views + drill-downs                     │
│   - Primitives sandboxed in Histoire                    │
│   - Subscribes to stores via $state/$derived            │
└──────────────────────▲──────────────────────────────────┘
                       │ typed events / signals
┌──────────────────────┴──────────────────────────────────┐
│ Domain  (pure TS, framework-free, unit-tested)          │
│   - Stations, Routes, Trips, Vehicles, Predictions      │
│   - Reconciler: matches live vehicles ↔ scheduled trips │
│   - Prediction engine (ported from v1)                  │
│   - Time/speed estimators (ported from v1)              │
└──────────▲────────────────────────────▲─────────────────┘
           │ repository API             │ live data API
┌──────────┴─────────────┐  ┌───────────┴─────────────────┐
│ GTFS Worker            │  │ Live Worker (optional)      │
│   - SQLite-WASM + OPFS │  │   - Tranzy / GTFS-RT poller │
│   - Schema = real GTFS │  │   - debounce, retry, ETag   │
│   - Async repo queries │  │   - emits to domain         │
└────────────────────────┘  └─────────────────────────────┘
```

### Three root-cause fixes

1. **Real GTFS in SQLite.** `neary-gtfs` already produces `agency-<id>-gtfs.zip`
   (CTP) and Tranzy-API JSON for other agencies. A new pipeline step there
   converts both paths to `agency-<id>.sqlite3` gzipped. The app downloads once
   to OPFS, opens in a worker, runs real SQL — no dedup, no in-memory Maps, no
   5 MB localStorage gymnastics.

2. **All heavy work in workers.** GTFS queries in the DB worker; live polling +
   enhancement + prediction in the live worker. UI thread does layout and
   events only.

3. **Vehicle taxonomy is data.** Discriminated union: `scheduled | predicted
   | live | reconciled | corroborated`. One component per kind, used
   identically in list / schedule / map. Schedule-only-trip detection lives
   in the reconciler, not in JSX.

   Each entry also carries a **multi-source confidence annotation** so the
   reconciler can encode "which live feeds confirm this":

   ```ts
   type LiveSource = 'gtfs-rt' | 'tranzy';
   type Confidence = 'high' | 'medium' | 'low';

   type Vehicle =
     | { kind: 'scheduled';    id; route; schedule }
     | { kind: 'predicted';    id; route; schedule;
                               checkedSources: LiveSource[]; // sources we polled
                               lastSeenGps?: GpsFix }
     | { kind: 'live';         id; route; gps; eta?;
                               liveSources: LiveSource[];     // ≥1
                               confidence: Confidence }
     | { kind: 'reconciled';   id; route; gps; schedule; eta?;
                               liveSources: LiveSource[];     // exactly 1
                               confidence: 'medium' }
     | { kind: 'corroborated'; id; route; gps; schedule; eta?;
                               liveSources: LiveSource[];     // ≥2
                               confidence: 'high' };
   ```

   - `corroborated` = both live sources agree on this trip.
   - `reconciled` = one live source matched to a scheduled trip.
   - `live` = live GPS with no schedule match.
   - `predicted` = scheduled trip should be running now but no live source
     reports it; `checkedSources` records which sources were polled and
     found nothing. `['gtfs-rt','tranzy']` is a confirmed schedule-only
     vehicle; `['gtfs-rt']` (no Tranzy key) is probable.
   - `scheduled` = trip in schedule but not yet active.

   The UI kind drives the visual; `confidence` and `liveSources` drive small
   badges. Full model, station-view buckets, map-view rendering, prediction
   engine and reconciler in [vehicles-and-views.md](vehicles-and-views.md).
   See also [live-data analysis](live-data-analysis.md) for the empirical
   basis of the multi-source design.

---

## 4. UI design system

### Primitives (`apps/web/src/lib/ui/`)

`Box`, `Stack`, `Card`, `Chip`, `Avatar`, `Button`, `IconButton`, `Switch`,
`TextField`, `BottomNav`, `Dialog`, `Tooltip`, `Collapsible`, `Toast`,
`StatusBar`, `Spinner`, `ProgressBar`, `Tabs`, `ToggleGroup`, `List`,
`ListItem`, `RouteBadge`, `StationCard`, `VehicleCard`.

Each is a single `.svelte` file. Each gets a Histoire story.

Skinning = `apps/web/src/lib/styles/theme.css` (CSS vars). One file. Light /
dark / high-contrast are sibling files swapped via `[data-theme]`.

### Header (kept from v1)

Title (left), 4 status dots (GPS, Connection, Schedule, Live), Refresh button
(right). Each dot is a primitive with its own tooltip.

### Status bar

Single fixed line **below the header**. Severity hierarchy:
`error > loading/progress > warning > info > success`. Concurrent loads
collapse into one line ("Loading schedule, vehicles"). Idle → 0 height. Replaces
all toasts AND all per-view loading spinners (header `CircularProgress`,
manual-refresh button state, "refreshing…" footers).

### Bottom navigation

`[Stations] [Favorites] [Planner] [Settings]`

Schedule and Map are drill-downs (`/schedule/[routeId]`, `/map/vehicle/[id]`),
not top-level — keeps URLs shareable and the back button working on iOS PWA.
Planner reserved now, implemented in a later phase.

### Card unification

Station, Route, Vehicle cards share one shell with `variant` accent and
content slots. Fixes the visual inconsistency complaint at the design-system
level, not per-screen.

### Vehicle visual taxonomy (consistent in list + schedule + map)

| Kind            | Color                 | Border          | Badge                  |
| --------------- | --------------------- | --------------- | ---------------------- |
| `corroborated`  | route color           | 2 px + white outline | check-circle pip  |
| `reconciled`    | route color           | 2 px            | calendar pip           |
| `live`          | route color           | 1 px            | —                      |
| `predicted`     | route color           | **dashed**      | dashed-clock           |
| `scheduled`     | route color, 50 % opacity | **dotted**  | calendar               |

Detail and bucket-vs-kind interaction in
[vehicles-and-views.md §2-§4](vehicles-and-views.md).

### Map layer order (Leaflet panes, top→bottom)

`selected-overlay > corroborated > reconciled > live > predicted > user-location > stations > route-shapes > tiles`

(Refined from "selected-vehicle > vehicles > …" — see
[vehicles-and-views.md §4](vehicles-and-views.md).)

---

## 5. Kept from v1

These move to `apps/web/src/lib/domain/` as pure TS, unit-tested:

- Prediction engine (segment-based speed + distance + ETA)
- Debounce strategy for live polling
- GPS-staleness-aware refresh trigger
- Schedule-by-route-direction logic
- Speed estimate alternatives (avg / instant / shape-based)
- Time estimate composition

---

## 6. Settings split

**User Preferences (default Settings tab):** theme, distance unit, language,
drop-off indicators toggle, schedule-only vehicles toggle, default landing
view, home
/ work addresses (later — fuels Planner), manage favorites.

**Advanced (separate route):** agency selector, optional API key, storage
usage breakdown (per OPFS file), force schedule reload, last update
timestamps, app version + build hash, force-update button, debug toggles.

---

## 7. Onboarding (no wizard)

First launch lands directly on **Stations** with an empty state: "Select your
transit agency." Inline dropdown sourced from `neary-gtfs`' `data/agency.json`.
Pick agency → SQLite download starts in background, app already usable. API
key is **never required**, mentioned once in the Live indicator's empty state
as "Add API key for real-time tracking → Advanced settings."

---

## 8. Repository layout

```
apps/web/                  # v2 SvelteKit app
apps/legacy/               # current React/MUI app, frozen at v1.5.x
docs/rebuild-v2/           # this plan and any future spec docs
scripts/                   # local maintenance
.github/workflows/         # CI for both apps
```

`neary-gtfs` (separate repo) owns the data pipeline. It already publishes the
JSON outputs `apps/legacy` consumes. A new step there will add the SQLite
output `apps/web` consumes.

---

## 9. Phases — sequenced, each independently demoable

Every phase ends in a working, testable build.

**Status legend**: `✓ done` · `🟡 in progress` · `⏸ blocked` · `TBD`. Each
done phase lists the commits that delivered it (run `git show <sha>` for the
detailed message). Update this section on every phase boundary so
`docs/rebuild-v2/plan.md` is enough to resume from after a context switch.

_Last updated: 2026-06-26 after `d4aa4f9`._

### Phase 0 — Foundations · ✓ done
Commits: `6ed1b66`
- Branch `rebuild/v2-svelte-sqlite`
- npm workspaces monorepo
- Legacy moved to `apps/legacy/`, builds + tests green
- `apps/web/` bootstrapped (SvelteKit + Tailwind v4 + Vitest + PWA plugin
  groundwork). Biome and Histoire intentionally deferred — Biome wasn't
  needed yet, Histoire's Svelte 5 support was shaky, the `/showcase` route
  serves the same sandbox purpose for now.
- Both apps build under one `npm run build` at root
- Netlify config updated to build from `apps/legacy`

### Phase 1 — UI primitive library · ✓ done
Commits: `523db31` · `6eec22c` · `0023a3e` · `0a6d1b1`
- Primitives in `apps/web/src/lib/ui/`: Box, Stack, Typography, Card +
  CardContent, Chip, Avatar, Button, IconButton, Spinner, Tooltip,
  Dialog/Title/Content, Switch, Collapsible (pure CSS), TextField,
  ProgressBar, Tabs, ToggleGroup, List/ListItem/ListItemText, plus the
  composites RouteBadge, VehicleCard, StationCard.
- StatusBar primitive + reactive `statusBus.svelte.ts` store.
- All exercised on `/showcase`.
- Histoire / Playwright screenshot regression deferred (manual review via
  `/showcase`); revisit in Phase 9 polish.

### Phase 2 — GTFS pipeline + DB worker · ✓ done locally · ⏸ pipeline-side TBD
Commits: `60d167e` · `7f0a610`
- `scripts/build-sqlite/`: Node converter that downloads the CTP Cluj GTFS
  zip from neary-gtfs releases, builds a real GTFS-shape SQLite (with
  indexes), and gzips it.
- `apps/web/src/lib/workers/gtfs.worker.ts`: SQLite-WASM in a Web Worker,
  OPFS-backed via SAH pool, Comlink-exposed typed repo
  (`ready` / `getManifest` / `getRoutes` / `getStopsNear` /
  `getDeparturesFromStop`).
- `/data-test` route exercises the full pipeline end-to-end.
- **Outstanding (blocked on neary-gtfs work)**: pipeline refactor described
  in [neary-gtfs-plan.md](neary-gtfs-plan.md). v2 app keeps using the
  dev-only `agency-2.sqlite3.gz` until that branch's `binaries`
  publishes the new `feeds.json` + SQLite blobs.

### Phase 3 — App shell + status system · ✓ done
Commits: `4078a3f` · `d4aa4f9`
- AppLayout = Header (title + 4 status dots + optional refresh) +
  StatusBar + scrollable main + BottomNavigation.
- 4 routes wired: `/` Stations, `/favorites`, `/planner`, `/settings`.
- `userPrefs.svelte.ts` singleton: theme, agencyId, display toggles,
  apiKey; persisted to localStorage.
- Theme picker (light / auto / dark) in Settings; SSR-safe.
- GPS dot driven by `locationStore.svelte.ts` (watchPosition + 15s
  freshness ticker). Permission prompt only fires on `/`.
- Connection dot driven by `connectionStore.svelte.ts` (online/offline
  events).
- Schedule dot driven by `userPrefs.agencyId` + worker binding.
- Live dot stays idle until Phase 5.
- Real agency picker: pulls neary-gtfs `data/agency.json`, gates rows on
  the local `AGENCIES_WITH_SQLITE` set, on select fires
  `repo.setAgency(id)` with progress through the StatusBar.

### Phase 4 — Domain + Stations (schedule-only) · TBD (next)
- Port prediction / reconciler / estimators from `apps/legacy/src/utils/`
  to `apps/web/src/lib/domain/` as pure TS, unit-tested with Vitest. Algorithm
  validation and changes from v1 in
  [vehicles-and-views.md §5-§6](vehicles-and-views.md).
- New repo method: `getStationArrivals(stopId, now, windowMinutes)` — joins
  stops + active services + upcoming trip starts and returns
  `Vehicle[]` per [vehicles-and-views.md §3](vehicles-and-views.md).
- Real Stations view subscribed to `locationStore.position`, rendering
  `StationCard`s.
- Rename `userPrefs.showGhostVehicles` → `showScheduleOnlyVehicles`
  (one-time read migration).

### Phase 5 — Live data · TBD
- Live worker polls GTFS-RT (no key) and Tranzy (if key set); responses
  tagged with `source: LiveSource`.
- Reconciler produces `live` / `reconciled` / `corroborated`; also promotes
  active scheduled trips with no live match to `predicted`.
- Live status dot reflects health.
- API key toggle in Advanced settings.

### Phase 6 — Favorites, Schedule, Map · TBD
- Favorites view: saved routes AND saved stations (route-context card shell).
- Schedule drill-down: `/schedule/route/[routeId]` and
  `/schedule/route/[routeId]?stop=[stopId]` (same `<ArrivalsBoard>` filtered
  differently — station view IS the schedule view).
- Map drill-down: `/map/route/[routeId]?selected=[vehicleId]` renders the
  shape + every `Vehicle` on the route + the selected ring. Marker variant
  per `vehicle.kind`. Leaflet panes per §4.
- `/map/vehicle/[vehicleId]` redirects to the route map with `selected` set.

### Phase 7 — Settings + Advanced · TBD
- User Preferences view (mostly already shipped in Phase 3)
- Advanced view (storage, freshness, force reload, version)
- Polished agency-picker empty state

### Phase 8 — Planner (with transfers) · TBD
- From/to (current location / address / station)
- Itinerary using SQLite + stop_times + transfer matching
- Reuses Schedule view as the result renderer

### Phase 9 — Polish, perf budgets, store install · TBD
- Histoire / Playwright screenshot regression (Phase 1 follow-up).
- Biome adoption.
- Per-route perf budgets enforced in CI.
- Apple PWA install polish + screenshots.

---

## 10. Open items intentionally deferred

- Whether to share `lib/domain/` as an npm package between `apps/web` and any
  future native wrapper. Decide once Phase 4 is done and the domain shape is
  stable.
- Whether to swap Leaflet for MapLibre GL. Revisit if Phase 6 hits a real
  bottleneck on iOS Safari.
- Server-side rendering vs static prerender for SvelteKit. Default to
  prerender (cheaper hosting, faster TTI). Revisit if route-based data
  fetching ever needs it.
