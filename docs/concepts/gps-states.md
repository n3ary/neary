# GPS states

How Neary represents the user's GPS context across the home page,
settings, and the header GPS dot. Every consumer reads the same
derived flags so the three surfaces stay consistent.

## Source of truth

| Source | What it holds | Persisted? |
|---|---|---|
| `userPrefs.gpsOptedIn` | Has the user explicitly turned GPS on? | yes (`neary-user-prefs`) |
| `userPrefs.hasEverEnabledGPS` | Has the user ever called `locationStore.enable()`? Stays true even after they disable. | yes (`neary-user-prefs`) |
| `locationStore.permission` | Browser-reported permission: `unknown` / `prompt` / `granted` / `denied`. | no |
| `locationStore.position` | Most recent fix, or null. | no (resets on reload) |
| `locationStore.error` | Most recent watch error, or null. | no |
| `locationStore.isSupported` | Does `navigator.geolocation` exist in this browser? | no (browser-derived) |
| `noLocationCardDismissedStore.dismissed` | Has the user X-ed the No-location card? Auto-resets on fresh opt-in. | yes (`neary:noLocationCardDismissed`) |
| `enableLocationPromptDismissedStore.dismissed` | Has the user X-ed the first-time Enable-location prompt? Never auto-resets. | yes (`neary:enableLocationPromptDismissed`) |

Both dismissed-flag stores are instances of `createDismissedFlag()` from
`src/lib/stores/dismissedFlag.svelte.ts` — the factory centralises the
SSR-safe load / persist / auto-reset logic. The GPS-cluster stores
(`locationStore`, `noLocationCardDismissedStore`, `enableLocationPromptDismissedStore`)
live under `src/lib/stores/gps/`; the factory stays at the top level
because it's a generic pattern reusable for non-GPS dismissed flags.

## Derived flags (script-level)

The home page derives four named flags once and reads them in the markup:

```ts
// src/routes/+page.svelte
const denied = $derived(
  gpsState === 'unavailable' && locationStore.permission === 'denied',
);
const gpsUnsupported = $derived(
  !locationStore.isSupported && gpsState === 'unavailable' && !denied,
);
const showEnablePrompt = $derived(
  gpsState === 'not-opted-in'
  && !userPrefs.hasEverEnabledGPS
  && !enableLocationPromptDismissedStore.dismissed,
);
const showSearchAndFavorites = $derived(
  gpsState === 'not-opted-in' || denied,
);
const showNoLocationCard = $derived(denied);
const showLocationUnsupported = $derived(gpsUnsupported);
```

Settings derives:

```ts
// src/routes/settings/+page.svelte
const denied = $derived(locationStore.permission === 'denied');
// isSupported via locationStore.isSupported
```

Header dot uses `locationStore.freshness` (a getter, not a $derived).

## `gpsState` machine

Derived in the home page from the underlying sources:

```
gpsState = $derived.by<GpsState>(() => {
  if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return 'unavailable';
  if (locationStore.position) return 'available';
  if (locationStore.permission === 'denied') return 'unavailable';
  if (locationStore.error && !locationStore.position) return 'unavailable';
  if (!userPrefs.gpsOptedIn) return 'not-opted-in';
  return 'pending';
});
```

Order matters: the `permission === 'denied'` check sits above the
`gpsOptedIn` check so a denied user stays in `unavailable` (and thus
`denied`) regardless of opt-in state. `not-opted-in` is only reached
when nothing has gone wrong yet — the user just hasn't engaged, or
engaged then cleanly disabled.

| `gpsState` | Trigger |
|---|---|
| `not-opted-in` | Browser has geolocation, user hasn't opted in (or cleanly disabled). |
| `pending` | User opted in, watch started, no first fix yet. |
| `available` | User opted in, position available. |
| `unavailable` | No API support, permission denied, or watch error with no position. |

`unavailable` is split semantically by the additional derived flags:

- `denied`: permission is `'denied'` (recoverable via browser settings)
- `gpsUnsupported`: browser has no geolocation API at all (unrecoverable)
- transient error: watch errored but API exists (next attempt may succeed; no UI banner — header dot only)

## Home page banner-stack matrix

| gpsState | Enable prompt | Search + Favorites | No-location card |
|---|---|---|---|
| `not-opted-in` + first-time (no `hasEverEnabledGPS`, not dismissed) | shown | shown | hidden |
| `not-opted-in` + dismissed via X | hidden | shown | hidden |
| `not-opted-in` + ever-enabled (enabled then disabled in Settings) | hidden | shown | hidden |
| `pending` | hidden | hidden | hidden |
| `available` | hidden | hidden | hidden |
| `denied` | hidden | shown | shown (dismissible, global state) |
| `gpsUnsupported` (no API) | hidden | hidden | hidden |
| transient error (`unavailable` && `!denied` && supported) | hidden | hidden | hidden |

The home page also adds:

- `SelectFeedCard` when no feed is bound.
- `wrongFeedFor` banner when GPS is on but the user is outside the active feed's bbox.
- The Position-me FAB when `gpsState === 'available'`.
- The StationCard list (with the proximity query) when feed is bound + GPS available + position inside feed bbox.

## Settings privacy-section matrix

| Condition | Rendered |
|---|---|
| `!locationStore.isSupported` | `InfoCard "Location not supported"` — explains the toggle wouldn't work. |
| `denied` | `<NoLocationCard />` (non-dismissible in settings; dismissal is sticky across home + settings). |
| otherwise | Switch + Use-location copy + helper text. |

The header GPS dot (always shown) is the third path: state `'off'` is
tappable to enable.

## Header dot (freshness)

| State | Color | Tooltip |
|---|---|---|
| `off` (gpsOptedIn false) | grey | "GPS off — tap to enable." |
| `error` (denied, or error without position) | red | "Location permission denied" / "GPS error: …" |
| `idle` (opted in, no fix yet) | grey | "Waiting for first GPS fix…" |
| `ok` (fix < 60s old) | green | "GPS fresh (Ns ago)" |
| `stale` (60s–5min) | amber | "GPS last fix N min ago" |
| `error` (fix > 5min) | red | "GPS last fix N min ago" |

The `lastUpdated` field is normalized via `normalizePositionTimestamp` in
`src/lib/stores/gps/locationStore.svelte.ts` because some iOS Safari
WebKit builds report `GeolocationPosition.timestamp` in **seconds**
rather than milliseconds. Without the normalize, a fresh fix would
land `lastUpdated` at ~1.78e9 (current time as seconds), and
`this.now - lastUpdated` becomes ~31 years, rendering as "GPS last fix
16305118 min ago" on the header dot with the red `error` state.

## Reset behaviour for the dismissed flags

| Flag | Resets on… |
|---|---|
| `noLocationCardDismissedStore` | Fresh opt-in (`userPrefs.gpsOptedIn` false → true). Surfacing the recovery card again if the user actively re-tries GPS. |
| `enableLocationPromptDismissedStore` | Never. Once dismissed, the first-time Enable CTA is gone for good — `hasEverEnabledGPS` handles the "user engaged then disabled" path. |

Both flags can be cleared programmatically via `.reset()` if needed
(used in tests or a future "Reset all prompts" settings entry).