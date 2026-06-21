/**
 * AppVersionPanel — surfaces the running app version in Settings so users can
 * confirm whether their client picked up a new deploy.
 *
 * Two complementary values are shown:
 *   - **Release**: the package.json semver (e.g. `1.4.1`), injected at build
 *     time as `__APP_VERSION__` via Vite's `define`. This is the human-readable
 *     marker for what shipped.
 *   - **Build**: the cache-bust timestamp from the `<meta name="app-version">`
 *     tag in `index.html`, stamped by `scripts/update-version.js` on each
 *     production build. This is what tells the user whether their cached app
 *     has refreshed to the latest deploy (the service worker keys on the same
 *     value).
 */

import type { FC } from 'react';
import { Box, Stack, Typography } from '@mui/material';

/** Read the cache-bust timestamp from the <meta name="app-version"> tag. */
function readBuildStamp(): string {
  if (typeof document === 'undefined') return 'unknown';
  const meta = document.querySelector('meta[name="app-version"]');
  return meta?.getAttribute('content') ?? 'unknown';
}

/**
 * Format `YYYY-MM-DD-HHmm` (the `update-version.js` shape) as a readable
 * datetime; falls back to the raw value when the shape doesn't match.
 */
function formatBuildStamp(stamp: string): string {
  const m = stamp.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})$/);
  if (!m) return stamp;
  const [, y, mo, d, h, mi] = m;
  return `${y}-${mo}-${d} ${h}:${mi}`;
}

interface VersionRowProps {
  label: string;
  value: string;
}

const VersionRow: FC<VersionRowProps> = ({ label, value }) => (
  <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
    <Typography variant="body2" color="text.secondary">{label}</Typography>
    <Typography
      variant="body2"
      sx={{ fontVariantNumeric: 'tabular-nums', fontFamily: 'monospace' }}
    >
      {value}
    </Typography>
  </Box>
);

interface AppVersionPanelProps {
  className?: string;
}

export const AppVersionPanel: FC<AppVersionPanelProps> = ({ className }) => {
  const release = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'unknown';
  const build = readBuildStamp();

  return (
    <Box className={className} data-testid="app-version-panel">
      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        Version
      </Typography>
      <Stack spacing={0.75}>
        <VersionRow label="Release" value={release} />
        <VersionRow label="Build" value={formatBuildStamp(build)} />
      </Stack>
    </Box>
  );
};
