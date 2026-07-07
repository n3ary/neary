// Visible-viewport height for the iOS PWA standalone shell.
//
// On the first paint after the PWA is launched, the CSS engine resolves
// `100dvh` before the standalone viewport has settled (#184 fixed the
// post-navigation case but not the first-paint case; #227 tracks that).
// The fix is to source the shell height from JS, where `window.innerHeight`
// is correct on the first frame, and expose it as a `--app-height` CSS
// custom property. The Svelte shell reads `var(--app-height, 100dvh)`
// (100dvh is the SSR / pre-hydration fallback), and an inline <head>
// script in app.html sets the same custom property before the CSS parses
// so the first paint uses the correct value too.

/** CSS custom property name. Single source of truth for the shell height. */
export const APP_HEIGHT_VAR = '--app-height';

/**
 * Read the current visible-viewport height. Prefers `visualViewport.height`
 * when available (excludes the iOS home indicator area in standalone PWA),
 * falls back to `window.innerHeight`.
 */
export function readViewportHeight(): number {
  if (typeof window === 'undefined') return 0;
  return window.visualViewport?.height ?? window.innerHeight;
}

/**
 * Write the current visible-viewport height to the `--app-height` custom
 * property on the document root. Idempotent — calling twice with the same
 * viewport is a no-op for layout.
 */
export function setAppHeight(height: number = readViewportHeight()): void {
  if (typeof document === 'undefined') return;
  document.documentElement.style.setProperty(APP_HEIGHT_VAR, `${height}px`);
}

/**
 * Subscribe to viewport changes (window resize, visualViewport resize) and
 * re-write `--app-height` on each one. Returns a cleanup that removes both
 * listeners — call it from the component's onMount return.
 *
 * Both events are listened to because they cover different cases: window
 * resize fires on orientation change and PWA standalone↔browser mode
 * transitions; visualViewport.resize fires on the same plus on-screen
 * keyboard show/hide and pinch zoom.
 */
export function subscribeAppHeight(
  onChange: (height: number) => void = setAppHeight,
): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = () => onChange(readViewportHeight());
  window.addEventListener('resize', handler);
  window.visualViewport?.addEventListener('resize', handler);
  return () => {
    window.removeEventListener('resize', handler);
    window.visualViewport?.removeEventListener('resize', handler);
  };
}
