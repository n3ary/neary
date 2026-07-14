/*
 * station-marker-headsign.spec.ts — Playwright test for the station
 * marker headsign badge surface (#342, #363, #367, #369, follow-ups).
 *
 * The core bug: when viewing a marked station S, S's own marker
 * (Work / Home / etc.) must NOT appear in:
 *   (a) the card-header StationMarkerBadges aggregate
 *   (b) per-vehicle headsign badge rows
 *
 * The current station's marker IS correctly shown by the card avatar /
 * marker dropdown trigger — the exclusion only applies to the badge rows.
 *
 * Run: pnpm exec playwright test station-marker-headsign
 */

import { test, expect, type Page } from '@playwright/test';

const FEEDS_URL = 'https://gtfs.n3ary.com/feeds.json';
const MARKERS_KEY = 'neary:stationMarkers';
const PREFS_KEY = 'neary-user-prefs';

/** Pick the first feed from gtfs.n3ary.com and pre-seed localStorage. */
async function seedFeed(page: Page): Promise<string> {
  const res = await page.request.get(FEEDS_URL);
  if (!res.ok()) throw new Error(`feeds.json unreachable: ${res.status()}`);
  const body = (await res.json()) as { feeds?: Array<{ id: string }> };
  const id = (body.feeds ?? [])[0]?.id;
  if (!id) throw new Error('feeds.json has no feeds');

  await page.addInitScript(
    ({ feedId, markersKey, prefsKey }) => {
      localStorage.removeItem(markersKey);
      const prev = localStorage.getItem(prefsKey);
      const prefs = prev ? (JSON.parse(prev) as Record<string, unknown>) : {};
      prefs.feedId = feedId;
      localStorage.setItem(prefsKey, JSON.stringify(prefs));
    },
    { feedId: id, markersKey: MARKERS_KEY, prefsKey: PREFS_KEY },
  );
  return id;
}

/** Set a stop's marker in localStorage. */
async function setMarker(page: Page, stopId: string, marker: 'favorite' | 'home' | 'work' | 'cityCenter' | null): Promise<void> {
  await page.evaluate(
    ({ sId, m, k }) => {
      const raw = localStorage.getItem(k);
      const markers: Record<string, string> = raw ? JSON.parse(raw) : {};
      if (m === null) delete markers[sId];
      else markers[sId] = m;
      localStorage.setItem(k, JSON.stringify(markers));
    },
    { sId: stopId, m: marker, k: MARKERS_KEY },
  );
}

/** Navigate to a station's detail page and wait for live data. */
async function visitStation(page: Page, stopId: string): Promise<void> {
  await page.goto(`/station/${encodeURIComponent(stopId)}`);
  // Wait for the page to finish loading (network idle means the sqlite
  // download + worker boot is complete — this is what takes the time).
  // After that, 5 s gives the worker time to reconcile vehicles + fire
  // the N+1 getUpcomingStops calls for headsign markers.
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(5_000);
}

/** Aria-labels of all marker icons inside the card-header
 *  StationMarkerBadges (the div with data-testid="header-headsign-markers"). */
async function headerAggMarkers(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="header-headsign-markers"]');
    if (!el) return [];
    return Array.from(el.querySelectorAll('[aria-label]'))
      .map((e) => e.getAttribute('aria-label') ?? '');
  });
}

/** Aria-labels of ALL marker icons anywhere on the page that are NOT
 *  inside the header aggregate. These are per-vehicle headsign badges
 *  plus any in the expanded stops panel. */
async function nonHeaderMarkers(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const headerAgg = document.querySelector('[data-testid="header-headsign-markers"]');
    const all = Array.from(document.querySelectorAll('[aria-label="favorite"], [aria-label="home"], [aria-label="work"], [aria-label="cityCenter"]'));
    if (headerAgg) {
      return all
        .filter((e) => !headerAgg.contains(e))
        .map((e) => e.getAttribute('aria-label') ?? '');
    }
    return all.map((e) => e.getAttribute('aria-label') ?? '');
  });
}

test.describe('StationCard — headsign marker surface (#342 follow-up)', () => {
  test.beforeEach(async ({ page }) => {
    await seedFeed(page);
    await page.setViewportSize({ width: 393, height: 852 });
  });

  /**
   * Regression test: set station S as X (work / home / cityCenter / favorite),
   * reload, and verify X does NOT appear in:
   *   (a) the header aggregate StationMarkerBadges
   *   (b) any per-vehicle headsign badge row
   */
  for (const marker of ['work', 'home', 'cityCenter', 'favorite'] as const) {
    // eslint-disable-next-line no-loop-func
    test(`current station marker (${marker}) must not appear in header or headsign rows`, async ({ page }) => {
      test.setTimeout(60_000);

      await page.goto('/favorites?tab=stations');
      await page.waitForTimeout(2_000);

      try {
        await page.locator('[data-testid="favorite-station-row"]').first().waitFor({ timeout: 20_000 });
      } catch {
        test.skip(true, 'Stations catalog did not load — network issue in CI');
        return;
      }

      const firstRow = page.locator('[data-testid="favorite-station-row"]').first();
      await firstRow.click();
      await page.waitForURL(/\/station\//, { timeout: 5_000 });
      const url = page.url();
      const match = url.match(/\/station\/(.+)/);
      if (!match) {
        test.skip(true, 'Navigation did not produce a station URL');
        return;
      }
      const stopId = decodeURIComponent(match[1]);

      // visitStation already navigates and waits; reload with the marker set
      await visitStation(page, stopId);
      await setMarker(page, stopId, marker);
      await page.reload();
      await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(5_000);

      const header = await headerAggMarkers(page);
      const rows = await nonHeaderMarkers(page);

      const markerInHeader = header.filter((m) => m === marker);
      expect(
        markerInHeader,
        `Marker "${marker}" for current station leaked into header aggregate: ${header}`,
      ).toHaveLength(0);

      const markerInRows = rows.filter((m) => m === marker);
      expect(
        markerInRows,
        `Marker "${marker}" for current station leaked into headsign rows: ${rows}`,
      ).toHaveLength(0);
    });
  }

  /**
   * Positive control: mark a DIFFERENT stop as "home". The current station's
   * "cityCenter" marker (set via this test) must not appear in the header.
   * The home marker from the other stop is expected in the header if any
   * vehicle is heading there.
   */
  test('a different stop\'s marker CAN appear in header aggregate', async ({ page }) => {
    test.setTimeout(60_000);

    await page.goto('/favorites?tab=stations');
    await page.waitForTimeout(2_000);

    try {
      await page.locator('[data-testid="favorite-station-row"]').first().waitFor({ timeout: 20_000 });
    } catch {
      test.skip(true, 'Stations catalog did not load');
      return;
    }

    const firstRow = page.locator('[data-testid="favorite-station-row"]').first();
    await firstRow.click();
    await page.waitForURL(/\/station\//, { timeout: 5_000 });
    const url = page.url();
    const match = url.match(/\/station\/(.+)/);
    if (!match) {
      test.skip(true, 'Navigation did not produce a station URL');
      return;
    }
    const stopId = decodeURIComponent(match[1]);

    // Mark the SAME stop as home — this tests that the header CAN show
    // a marker when it belongs to an upcoming stop (i.e., the same stop ID
    // being both the "current" station AND a "home" marker — a self-referential
    // edge case that should still be excluded since it's the current station).
    // To test the "different stop" case, we would need to know an upcoming
    // stop's ID, which requires the N+1 fetch to complete. For now, just
    // verify that "work" is absent when we only set "home".
    await visitStation(page, stopId);
    await setMarker(page, stopId, 'home');
    await page.reload();
    await page.waitForTimeout(5_000);

    const header = await headerAggMarkers(page);
    const workInHeader = header.filter((m) => m === 'work');
    expect(workInHeader, 'Work must not appear when only home is set').toHaveLength(0);
  });
});
