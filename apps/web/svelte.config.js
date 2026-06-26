import { execSync } from 'node:child_process';
import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** Best-effort unique build identifier. Falls back to a timestamp
 *  when the build runs outside a git checkout (CI sandbox, Netlify
 *  without git history fetched, etc.). The runtime client polls
 *  `_app/version.json` carrying this string — a change triggers
 *  the auto-reload in +layout.svelte. */
function buildVersion() {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return `t${Date.now()}`;
  }
}

/**
 * SvelteKit config — static adapter because v2 is a pure PWA with no server
 * runtime. All routes prerendered; data lives in OPFS / IndexedDB. Hosting
 * is just a static bucket (Netlify, GitHub Pages, etc.).
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
      name: buildVersion(),
      pollInterval: 60 * 1000,
    },
  },
};

export default config;
