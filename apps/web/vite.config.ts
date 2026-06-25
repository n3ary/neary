import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
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
