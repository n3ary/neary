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
  // Pin "now" to a known LOCAL instant so day arithmetic is deterministic
  // regardless of CI vs dev timezone. Time strings are derived from Date
  // objects (same logic as the formatter) rather than hardcoded so the
  // test passes in any tz.
  const NOW = new Date(2026, 5, 27, 16, 4, 0).getTime(); // local 2026-06-27 16:04

  function hhmm(ms: number): string {
    return new Date(ms).toLocaleString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  }

  function weekday(ms: number): string {
    return new Date(ms).toLocaleString('en-GB', { weekday: 'short' });
  }

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
    const ts = NOW - 5 * 3600_000;
    expect(formatWhen(ts)).toBe(`today, ${hhmm(ts)}`);
  });

  it("returns 'yesterday, HH:MM' for the previous calendar day", () => {
    const yesterday = new Date(NOW);
    yesterday.setDate(yesterday.getDate() - 1);
    const ts = yesterday.getTime();
    expect(formatWhen(ts)).toBe(`yesterday, ${hhmm(ts)}`);
  });

  it("returns 'Wd HH:MM' for entries 2–6 calendar days ago", () => {
    const twoAgo = new Date(NOW);
    twoAgo.setDate(twoAgo.getDate() - 2);
    const ts = twoAgo.getTime();
    expect(formatWhen(ts)).toBe(`${weekday(ts)} ${hhmm(ts)}`);
  });

  it('returns day + short month for ≥ 7 days ago, same year', () => {
    const tenDaysAgo = new Date(NOW);
    tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
    const ts = tenDaysAgo.getTime();
    const expected = new Date(ts).toLocaleString('en-GB', {
      day: 'numeric',
      month: 'short',
    });
    expect(formatWhen(ts)).toBe(expected);
  });

  it('returns day + month + year for entries in an earlier year', () => {
    const lastYear = new Date(NOW);
    lastYear.setFullYear(lastYear.getFullYear() - 1);
    const ts = lastYear.getTime();
    const expected = new Date(ts).toLocaleString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
    expect(formatWhen(ts)).toBe(expected);
  });
});
