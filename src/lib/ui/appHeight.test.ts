// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_HEIGHT_VAR, readViewportHeight, setAppHeight, subscribeAppHeight } from './appHeight';

describe('appHeight', () => {
  const originalVisualViewport = window.visualViewport;

  beforeEach(() => {
    document.documentElement.style.removeProperty(APP_HEIGHT_VAR);
    // jsdom doesn't implement visualViewport by default. installAppHeight
    // gates on `window.visualViewport?.addEventListener`, so leaving it
    // undefined exercises the innerHeight fallback path; the per-test
    // override below adds it back for the visualViewport path.
  });

  afterEach(() => {
    document.documentElement.style.removeProperty(APP_HEIGHT_VAR);
    Object.defineProperty(window, 'visualViewport', { value: originalVisualViewport, configurable: true });
  });

  it('exports the CSS custom property name as a single source of truth', () => {
    expect(APP_HEIGHT_VAR).toBe('--app-height');
  });

  describe('readViewportHeight', () => {
    it('prefers visualViewport.height when present', () => {
      Object.defineProperty(window, 'visualViewport', {
        value: { height: 700 },
        configurable: true,
      });
      // Cast through unknown — jsdom doesn't type the override.
      expect(readViewportHeight()).toBe(700);
    });

    it('falls back to window.innerHeight when visualViewport is absent', () => {
      Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true });
      // jsdom's default innerHeight is 768; assert the read came from there.
      expect(readViewportHeight()).toBe(window.innerHeight);
    });
  });

  describe('setAppHeight', () => {
    it('writes the given height to the document root as px', () => {
      setAppHeight(812);
      expect(document.documentElement.style.getPropertyValue(APP_HEIGHT_VAR)).toBe('812px');
    });

    it('defaults to the current viewport height when no argument is passed', () => {
      Object.defineProperty(window, 'visualViewport', { value: { height: 900 }, configurable: true });
      setAppHeight();
      expect(document.documentElement.style.getPropertyValue(APP_HEIGHT_VAR)).toBe('900px');
    });

    it('is a no-op outside the browser (SSR safety)', () => {
      const originalDocument = globalThis.document;
      (globalThis as { document?: Document }).document = undefined;
      expect(() => setAppHeight(100)).not.toThrow();
      (globalThis as { document?: Document }).document = originalDocument;
    });
  });

  describe('subscribeAppHeight', () => {
    it('writes the current height to --app-height on resize', () => {
      Object.defineProperty(window, 'visualViewport', {
        value: { height: 600, addEventListener: vi.fn(), removeEventListener: vi.fn() },
        configurable: true,
      });
      const unsubscribe = subscribeAppHeight();
      window.dispatchEvent(new Event('resize'));
      expect(document.documentElement.style.getPropertyValue(APP_HEIGHT_VAR)).toBe('600px');
      unsubscribe();
    });

    it('returns a no-op cleanup when window is unavailable', () => {
      const originalWindow = globalThis.window;
      (globalThis as { window?: Window }).window = undefined;
      const cb = vi.fn();
      const unsubscribe = subscribeAppHeight(cb);
      expect(cb).not.toHaveBeenCalled();
      expect(() => unsubscribe()).not.toThrow();
      (globalThis as { window?: Window }).window = originalWindow;
    });

    it('re-runs the callback on window resize and stops after cleanup', () => {
      const cb = vi.fn();
      const unsubscribe = subscribeAppHeight(cb);
      cb.mockClear();

      window.dispatchEvent(new Event('resize'));
      expect(cb).toHaveBeenCalledTimes(1);

      unsubscribe();
      window.dispatchEvent(new Event('resize'));
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('also listens to visualViewport.resize when present', () => {
      const vv = { height: 500, addEventListener: vi.fn(), removeEventListener: vi.fn() };
      Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });

      const cb = vi.fn();
      const unsubscribe = subscribeAppHeight(cb);

      expect(vv.addEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
      unsubscribe();
      expect(vv.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
    });
  });
});
