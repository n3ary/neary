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
    // Dev-only post-transform: SvelteKitPWA's DevPlugin emits a
    // <script> that calls `navigator.serviceWorker.register` against
    // the dev /service-worker.js. The dev SW is the raw
    // src/service-worker.ts (Vite serves it as-is, so the literal
    // `__APP_VERSION__` is un-replaced and the browser throws
    // "Can't find variable: __APP_VERSION__" during evaluation,
    // surfacing as an unhandled promise rejection on every page
    // load). SvelteKitPWA's own options to suppress the script
    // (`disable`, `injectRegister: null`) don't work on the dev
    // injection path -- the only knob that sticks is to strip the
    // <script> out of the dev HTML. In production the plugin
    // registers the SW via the build-time injection (which runs
    // against the properly-built SW with `__APP_VERSION__` replaced)
    // and src/routes/+layout.svelte's prod branch also does its own
    // register() -- so removing the dev script has no production
    // effect.
    {
      name: 'strip-dev-sw-registration',
      apply: 'serve',
      transformIndexHtml: {
        order: 'post',
        handler(html) {
          return html.replace(
            /<script>\s*if\s*\(\s*'serviceWorker'\s*in\s*navigator\s*\)[\s\S]*?<\/script>/,
            '<!-- dev SW registration stripped: see vite.config.ts -->',
          );
        },
      },
    },
    SvelteKitPWA({
      // The DevPlugin's `transformIndexHtml` injects a registration
      // script in dev that calls `navigator.serviceWorker.register`
      // against `/service-worker.js`. In dev that file is the raw
      // `src/service-worker.ts` (Vite serves it as-is), which still
      // contains the literal `__APP_VERSION__` reference -- Vite's
      // `define` only runs at build time, not in the dev SW import
      // pass. The browser then throws "Can't find variable:
      // __APP_VERSION__" inside the SW and the registration promise
      // rejects. SvelteKit surfaces that as an unhandled rejection
      // on every page load in dev.
      //
      // Suppressing the script from inside SvelteKitPWA's options
      // turns out to be unreliable across versions -- `disable` and
      // `injectRegister: null` are both no-ops on the dev-injection
      // code path. Stripping the script out of the dev HTML with a
      // post-transform is the only knob that sticks. The script is
      // only useful in production (where the SW is properly built
      // and the `define` is applied), and src/routes/+layout.svelte
      // registers the SW in production anyway -- so the dev script
      // is pure overhead in dev.
      strategies: 'injectManifest',
      // the plugin generates a final SW with the precache manifest
      // injected. The default srcDir is 'src' which is where our SW
      // lives, so we don't override it.
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
