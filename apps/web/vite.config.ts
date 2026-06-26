import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  // OPFS-SAHPool SQLite-WASM doesn't need COOP/COEP (uses sync file APIs
  // worker-side, no SharedArrayBuffer). Keep dev simple — no special headers.
  server: {
    port: 5173,
    // CORS-busting proxies for GTFS-RT endpoints in dev. Mirrors the
    // Netlify production redirects in /netlify.toml so the same client
    // code (`fetch('/api/rt/<feed>/<endpoint>')`) works in both
    // environments.
    proxy: {
      '/api/rt/cluj-napoca': {
        target: 'https://cluj-rt-feed.gtfs.ro',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/rt\/cluj-napoca/, ''),
      },
      '/api/rt/bucuresti-ilfov': {
        target: 'https://gtfs.tpbi.ro/api/gtfs-rt',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/rt\/bucuresti-ilfov/, ''),
      },
    },
  },
  // @sqlite.org/sqlite-wasm ships pre-built wasm; Vite's dep pre-bundling
  // breaks it. Excluding tells Vite to leave the package alone and let the
  // worker resolve it natively.
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
});
