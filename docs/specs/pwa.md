# PWA

Reasoning behind the PWA setup. Implementation:
[svelte.config.js](../../svelte.config.js), [vite.config.ts](../../vite.config.ts),
[static/_headers](../../static/_headers), [src/routes/+layout.svelte](../../src/routes/+layout.svelte).

## Goals

- Installable on iOS Safari and Android Chrome.
- Updates propagate without forcing the user to clear caches.
- Safe-area aware on iPhone X+ (notch, home indicator).

## Single version source

`package.json#version` is the single source of truth for "what build is
this". It's:

- Bumped on every PR by the auto-version GitHub Action — see
  [ci-and-versioning.md](ci-and-versioning.md).
- Read at build time in [svelte.config.js](../../svelte.config.js) and passed
  to SvelteKit as `kit.version.name`.
- Emitted into `build/_app/version.json` (e.g. `{"version":"1.5.20"}`).
- Available to UI code via `import { version } from '$app/environment'` —
  use it anywhere a version string needs to be displayed.

> [!IMPORTANT]
> One version everywhere. Don't introduce a separate git-SHA, build
> timestamp, or PWA-only version string. The auto-bump action guarantees
> uniqueness per shipped bundle.

## Update propagation

SvelteKit's client polls `_app/version.json` on a fixed interval (60 s).
When the returned string differs from the one the client booted with,
`updated.current` from `$app/state` flips to `true`. The root layout
([src/routes/+layout.svelte](../../src/routes/+layout.svelte)) subscribes
and reloads the page.

```js
// svelte.config.js
kit: {
  version: {
    name: pkg.version,         // package.json version
    pollInterval: 60 * 1000,   // 60 s
  },
}
```

Why 60 s: long enough to be invisible in network panels and battery use,
short enough that a returning user catches a fresh deploy within a few
minutes.

## Cache headers

[static/_headers](../../static/_headers) explicitly excludes `version.json`,
the service worker, and `index.html` from CDN caching. Without these
overrides the version poll would lag the CDN TTL and the update story
silently breaks.

## iOS safe-area

`AppLayout` applies `env(safe-area-inset-*)` so the header and bottom
navigation don't get cut by the notch / home indicator when launched
from the home screen.

## Standalone viewport height

The shell's `min-height` is sourced from a `--app-height` CSS custom
property rather than `100dvh` directly. On the first paint of an iOS
PWA standalone launch, the CSS engine resolves `100dvh` before the
viewport has stabilized, so the flex container is shorter than the
visible viewport and the fixed `BottomNavigation` floats up with a
strip of background below it (#184, #227).

`--app-height` is set from `window.innerHeight` in two places:

- an inline `<head>` script in [src/app.html](../../src/app.html) that
  runs before the CSS parses, so the very first paint uses the correct
  value;
- an `onMount` subscription in [src/lib/ui/AppLayout.svelte](../../src/lib/ui/AppLayout.svelte)
  that updates it on `window.resize` and `visualViewport.resize`.

The shared helper lives in [src/lib/ui/appHeight.ts](../../src/lib/ui/appHeight.ts).
`100dvh` is kept as the SSR / pre-hydration fallback.

## What we deliberately don't do

- No custom install prompt UI — rely on the browser's native install affordance.
- No background sync — re-fetch on focus instead.
- No push notifications — out of scope.

## Manifest

[static/manifest.json](../../static/manifest.json) is the source. Update
icons + name there; the PWA plugin picks it up at build time.
