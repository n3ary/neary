// `/favorites` reads `?tab=` from the URL on first render to decide
// which surface (Routes / Stations) to show. The static adapter
// prerenders routes by default; this page is meant to hydrate on the
// client with browser-only state (URL params, localStorage, GPS),
// so opt out of prerender the same way `/station/[id]` does — the
// `fallback: 'index.html'` SPA mode serves it.
export const prerender = false;