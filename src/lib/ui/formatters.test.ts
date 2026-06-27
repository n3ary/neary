import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatBytes, formatWhen } from './formatters';

describe('formatBytes', () => {
  it('returns empty string for falsy values', () => {
    expect(formatBytes(null)).toBe('');
    expect(formatBytes(undefined)).toBe('');
    expect(formatBytes(0)).toBe('');
  });

  it('uses KB below 1 MB, MB above', () => {
    expect(formatBytes(500)).toBe('0 KB');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(5_716_840)).toBe('5.5 MB');
  });
});

describe('formatWhen', () => {
  // Pin "now" to a known instant so day/month/year math is deterministic.
  // Using a Saturday so weekday names are predictable.
  const NOW = new Date('2026-06-27T16:04:00+03:00').getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns em-dash for null', () => {
    expect(formatWhen(null)).toBe('—');
  });

  it("returns 'just now' for less than a minute", () => {
    expect(formatWhen(NOW - 30_000)).toBe('just now');
  });

  it('returns minute count for the first hour', () => {
    expect(formatWhen(NOW - 13 * 60_000)).toBe('13 min ago');
    expect(formatWhen(NOW - 59 * 60_000)).toBe('59 min ago');
  });

  it("returns 'today, HH:MM' for same calendar day past one hour", () => {
    // 5 hours earlier same day → 11:04
    expect(formatWhen(NOW - 5 * 3600_000)).toBe('today, 11:04');
  });

  it("returns 'yesterday, HH:MM' for the previous calendar day", () => {
    // Same wall-clock time, day before → yesterday, 16:04
    const yesterday = new Date(NOW);
    yesterday.setDate(yesterday.getDate() - 1);
    expect(formatWhen(yesterday.getTime())).toBe('yesterday, 16:04');
  });

  it("returns 'Wd HH:MM' for entries 2–6 calendar days ago", () => {
    // 2 days ago = Thursday 16:04
    const twoAgo = new Date(NOW);
    twoAgo.setDate(twoAgo.getDate() - 2);
    expect(formatWhen(twoAgo.getTime())).toBe('Thu 16:04');
  });

  it('returns day + short month for ≥ 7 days ago, same year', () => {
    const tenDaysAgo = new Date(NOW);
    tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
    expect(formatWhen(tenDaysAgo.getTime())).toBe('17 Jun');
  });

  it('returns day + month + year for entries in an earlier year', () => {
    const lastYear = new Date(NOW);
    lastYear.setFullYear(lastYear.getFullYear() - 1);
    expect(formatWhen(lastYear.getTime())).toBe('27 Jun 2025');
  });
});
