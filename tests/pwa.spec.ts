/*
 * pwa.spec.ts — Playwright smoke test for the service worker.
 *
 * Verifies the things we shipped the SW for:
 *   1. The SW is generated and served at /service-worker.js.
 *   2. Its source contains the versioned precache bucket name
 *      (so an outdated shell from a previous deploy gets
 *      evicted on activate).
 *   3. The SW registers in a real browser.
 *
 * Driving a full offline reload through the browser is fragile —
 * chromium's headless mode handles `page.goto` + `setOffline` in
 * surprising ways, and the deeper precache-population test
 * doesn't catch anything the SW-source check doesn't already.
 * The "does the app work offline" question is an end-to-end UX
 * concern that's better tested by hand than in CI.
 *
 * Run: `pnpm exec playwright test` (after `pnpm run build`). The
 * preview server runs the static build; the test asserts against
 * the build output, not the dev server.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const pkg = JSON.parse(
  readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8'),
) as { version: string };

const EXPECTED_PRECACHE_PREFIX = 'precache-v';
const EXPECTED_VERSION = pkg.version;

test('service worker is generated with the versioned precache bucket', async ({
  request,
}) => {
  // 1. SW file is served at /service-worker.js with JS content
  //    AND the versioned bucket name is in the source. If the
  //    `__APP_VERSION__` `define` in vite.config.ts is missing,
  //    the bucket name is `precache-vundefined` and the test
  //    fails — a real regression, not a flake.
  const swResponse = await request.get('/service-worker.js');
  expect(swResponse.status()).toBe(200);
  const swBody = await swResponse.text();
  expect(swBody).toMatch(/precache-v/);
  expect(swBody).toContain(`precache-v${EXPECTED_VERSION}`);
});

test('service worker registers and creates a cache', async ({ page }) => {
  // Clear any prior SW registration so the waitForFunction
  // below can't short-circuit on a stale active SW from a
  // previous test run.
  await page.context().addInitScript(() => {
    void navigator.serviceWorker?.getRegistrations().then((regs) => {
      for (const reg of regs) void reg.unregister();
    });
  });

  await page.goto('/');

  // Wait for the SW to actually activate. If install failed
  // (e.g. `addAll` threw), the SW goes to 'redundant' and
  // `reg.active` stays null — the wait times out and the test
  // fails.
  await page.waitForFunction(
    async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return reg?.active !== null && reg?.active !== undefined;
    },
    null,
    { timeout: 15_000 },
  );

  // 2. The versioned precache bucket exists. (Catches the case
  //    where the SW installs but `caches.open` is bypassed — e.g.
  //    a refactor that drops the precache entirely.)
  await page.waitForFunction(
    async ({ cachePrefix, version }) => {
      const names = await caches.keys();
      return names.some(
        (n) => n.startsWith(cachePrefix) && n.includes(version),
      );
    },
    { cachePrefix: EXPECTED_PRECACHE_PREFIX, version: EXPECTED_VERSION },
    { timeout: 5_000 },
  );
});
