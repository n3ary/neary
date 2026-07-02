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
    alias: {
      $lib: 'src/lib',
    },
    // Lets clients detect new deploys. The client polls
    // `_app/version.json` every `pollInterval` ms; when the string
    // doesn't match the one it booted with, `updated.current` from
    // `$app/state` flips to true, and the root layout reloads.
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
