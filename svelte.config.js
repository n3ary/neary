import { readFileSync } from 'node:fs';
import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** Single source of truth for the app version. Bumped on every PR by the
 *  auto-version GitHub Action — see docs/specs/ci-and-versioning.md. The
 *  runtime client polls `_app/version.json` carrying this string; UI code
 *  reads the same value via `import { version } from '$app/environment'`. */
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));

/**
 * SvelteKit config — static adapter because v2 is a pure PWA with no server
 * runtime. All routes prerendered; data lives in OPFS / IndexedDB. Hosting
 * is just a static bucket (Cloudflare Pages).
 */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      pages: 'build',
      assets: 'build',
      fallback: 'index.html',
      precompress: false,
      strict: true,
    }),
    // Without this, SvelteKit auto-generates an inline
    // `navigator.serviceWorker.register()` call in app.html that has NO
    // updateViaCache option -- the browser caches the SW for up to 24 h
    // and never checks for a fresh copy on revisit. The layout's own
    // register() (with updateViaCache:'none') fires later from the JS
    // bundle, but the browser may have already stored the first
    // registration and ignore the second. Setting it here once means
    // every render of app.html gets the correct option baked in.
    serviceWorker: {
      options: { updateViaCache: 'none' },
    },
    alias: {
      $lib: 'src/lib',
    },
    // Lets clients detect new deploys. The client polls
    // `_app/version.json` every `pollInterval` ms; when the string
    // doesn't match the one it booted with, `updated.current` from
    // `$app/state` flips to true, and the root layout's hidden-first
    // update flow kicks in (src/lib/sw/appUpdate.ts — reload only
    // when hidden, banner otherwise).
    // Bound to 60 s — enough to catch a fresh deploy within a few
    // minutes for a PWA the user comes back to, infrequent enough
    // to not show up in network panels or burn battery.
    version: {
      name: pkg.version,
      pollInterval: 60 * 1000,
    },
  },
};

export default config;
