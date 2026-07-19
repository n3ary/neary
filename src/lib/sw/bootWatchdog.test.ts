import { describe, expect, it } from 'vitest';
import {
  BOOT_MAX_AUTO_RELOADS,
  BOOT_RELOAD_WINDOW_MS,
  decideBootAction,
} from './bootWatchdog';

const NOW = 1_700_000_000_000;

describe('decideBootAction', () => {
  it('reloads when there is no reload history', () => {
    expect(decideBootAction([], NOW)).toBe('reload');
  });

  it('reloads while under the budget', () => {
    const history = Array.from({ length: BOOT_MAX_AUTO_RELOADS - 1 }, (_, i) => NOW - (i + 1) * 1000);
    expect(decideBootAction(history, NOW)).toBe('reload');
  });

  it('shows the overlay once the budget is exhausted', () => {
    const history = Array.from({ length: BOOT_MAX_AUTO_RELOADS }, (_, i) => NOW - (i + 1) * 1000);
    expect(decideBootAction(history, NOW)).toBe('overlay');
  });

  it('reloads again after old reloads age out of the window', () => {
    const history = Array.from(
      { length: BOOT_MAX_AUTO_RELOADS },
      (_, i) => NOW - BOOT_RELOAD_WINDOW_MS - (i + 1) * 1000,
    );
    expect(decideBootAction(history, NOW)).toBe('reload');
  });

  it('counts only reloads inside the window', () => {
    const history = [
      NOW - 1000, // inside
      NOW - BOOT_RELOAD_WINDOW_MS - 60_000, // aged out
      NOW - BOOT_RELOAD_WINDOW_MS - 120_000, // aged out
    ];
    expect(decideBootAction(history, NOW)).toBe('reload');
  });
});
