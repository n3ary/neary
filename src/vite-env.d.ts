/// <reference types="vite/client" />

/**
 * Build-time constants injected by Vite (`define` in vite.config.ts).
 *
 * `__APP_VERSION__` is the semver from `package.json` (e.g. "1.4.1"),
 * surfaced in Settings alongside the cache-bust build stamp.
 */
declare const __APP_VERSION__: string;
