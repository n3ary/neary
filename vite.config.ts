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
      // TEMPORARY WORKAROUND: switch to generateSW because
      // @vite-pwa/sveltekit@1.1.0's injectManifest strategy has a bug
      // where its closeBundle runs BEFORE SvelteKit's closeBundle (which
      // builds the SW), so client/service-worker.js doesn't exist yet.
      // generateSW calls api.generateSW() directly without needing a
      // pre-built SW file. Revert to 'injectManifest' once the plugin
      // is fixed upstream.
      strategies: 'generateSW',
      workbox: {
        // globDirectory defaults to .svelte-kit/output. The SSR build
        // populates server/ with prerendered pages + JS chunks; the
        // secondary non-SSR builds (run by SvelteKit in writeBundle)
        // populate client/ with JS chunks + CSS.
        globPatterns: ['client/**/*.{js,css,html,svg,png,ico,webmanifest,wasm}'],
        globIgnores: ['server/**', 'server/sw.js', 'server/workbox-*.js'],
        // skipWaiting + clients.claim: new SW takes over immediately on
        // install. We lose the custom CHECK_VERSION protocol from our
        // src/service-worker.ts but gain a working build.
        skipWaiting: true,
        clientsClaim: true,
        runtimeCaching: [
          // OSM tiles: CacheFirst, survives SW updates (not versioned by
          // app version — tile imagery is data, not shell code).
          {
            urlPattern: /^https:\/\/.*\.tile\.openstreetmap\.org\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'osm-tiles-v1',
              expiration: { maxEntries: 1200, maxAgeSeconds: 30 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          // gtfs.n3ary.com/feeds.json: NetworkFirst with offline fallback.
          {
            urlPattern: /^https:\/\/gtfs\.n3ary\.com\/feeds\.json/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'feeds-json-v1',
              networkTimeoutSeconds: 5,
              expiration: { maxAgeSeconds: 5 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
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
    // <script> out of the dev HTML after the DevPlugin has injected
    // it. This plugin is registered AFTER SvelteKitPWA so its
    // `transformIndexHtml` runs after the DevPlugin's. In
    // production the plugin registers the SW via the build-time
    // injection (which runs against the properly-built SW with
    // `__APP_VERSION__` replaced) and src/routes/+layout.svelte's
    // prod branch also does its own register() -- so removing the
    // dev script has no production effect.
    {
      name: 'neutralize-dev-sw',
      apply: 'serve',
      configureServer(server) {
        // Intercept requests for /service-worker.js in dev and
        // return a no-op SW. The SvelteKitPWA plugin serves the
        // raw src/service-worker.ts at that path in dev, which
        // still references the literal `__APP_VERSION__` (Vite's
        // `define` only runs at build time). The browser evaluates
        // it, throws "Can't find variable: __APP_VERSION__", and
        // the registration promise rejects -- SvelteKit surfaces
        // that as an unhandled rejection on every page load.
        // Returning a no-op SW silences the error without affecting
        // production (this plugin has `apply: 'serve'`).
        server.middlewares.use((req, res, next) => {
          if (req.url === '/service-worker.js' || req.url === '/service-worker.js?') {
            res.setHeader('Content-Type', 'application/javascript');
            res.statusCode = 200;
            res.end('// dev SW neutralized: see vite.config.ts\nself.addEventListener("install", () => self.skipWaiting());\nself.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));\n');
            return;
          }
          next();
        });
      },
    },
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
