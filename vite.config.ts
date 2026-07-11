import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';
import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));
const VERSION = pkg.version as string;

export default defineConfig({
  plugins: [
    tailwindcss(),
    sveltekit(),
    SvelteKitPWA({
      // injectManifest: we provide the SW source at src/service-worker.ts;
      // the plugin generates a final SW with the precache manifest
      // injected. The default srcDir is 'src' which is where our SW
      // lives, so we don't override it.
      strategies: 'injectManifest',
      // Don't let the plugin auto-register the SW. We register it
      // ourselves in src/routes/+layout.svelte (only on the client)
      // so the dev server doesn't try to register one.
      disable: false,
      // Vite's `define` injects the version at build time. The SW
      // reads it as `__APP_VERSION__`. We can't import package.json
      // from the SW because the SW is built by a separate Vite pass
      // whose module graph doesn't include it.
      injectManifest: {
        globPatterns: [
          // Precache the SvelteKit-emitted shell. The plugin's
          // default glob also picks up `client/**` from
          // .svelte-kit/output, which is what we want.
          'client/**/*.{js,css,html,svg,png,ico,webmanifest}',
        ],
        // version.json is NOT precached. It's emitted to build/_app/
        // by the static adapter after the SW is built, so the glob
        // can't reach it from .svelte-kit/output/. The version
        // polling in $app/state still works online; offline it
        // fails silently and the user keeps running the cached
        // shell, which is what we want anyway.
      },
      // Manifest comes from static/manifest.json. The plugin picks
      // it up by default; we just override a few fields that the
      // spec wants locked.
      manifest: {
        name: 'Neary',
        short_name: 'Neary',
        description: 'Real-time transit companion',
        theme_color: '#4F46E5',
        background_color: '#4F46E5',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'https://branding.n3ary.com/neary-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'https://branding.n3ary.com/neary-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'https://branding.n3ary.com/neary-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  // __APP_VERSION__ is read by src/service-worker.ts to namespace
  // the precache bucket. Without `define` here, the SW would have
  // an undefined VERSION at runtime.
  define: {
    __APP_VERSION__: JSON.stringify(VERSION),
  },
  // OPFS-SAHPool SQLite-WASM doesn't need COOP/COEP (uses sync file APIs
  // worker-side, no SharedArrayBuffer). Keep dev simple — no special headers.
  server: {
    port: 5173,
  },
  // @sqlite.org/sqlite-wasm ships pre-built wasm; Vite's dep pre-bundling
  // breaks it. Excluding tells Vite to leave the package alone and let the
  // worker resolve it natively.
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
});
