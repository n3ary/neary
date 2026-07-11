/*
 * playwright.config.ts — smoke-test config.
 *
 * The PWA smoke test (tests/pwa.spec.ts) runs against the production
 * build, served by `vite preview`. The dev server isn't suitable:
 * service workers don't behave the same way against a Vite dev server
 * (HMR, module URLs, no precache).
 *
 * Run:
 *   pnpm run build
 *   pnpm exec playwright test
 *
 * `pnpm test` (vitest) is separate — it doesn't start the preview
 * server and only runs the unit tests.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  webServer: {
    // Use the same port vite preview defaults to (4173). --strictPort
    // fails fast if the port is taken, instead of silently picking
    // another one and the test hitting a stale build.
    command: 'pnpm exec vite preview --port 4173 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
