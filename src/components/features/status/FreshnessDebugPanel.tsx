/**
 * FreshnessDebugPanel — data-age diagnostics.
 *
 * Two-tier display:
 * 1. Live data: Vehicle fetch age + GPS timestamp age
 * 2. Static data: Per-endpoint last-updated / last-checked
 */

import type { FC } from 'react';
import { useEffect, useState } from 'react';
import { Box, Stack, Typography, Divider } from '@mui/material';
import { useVehicleStore } from '../../../stores/vehicleStore';
import { useScheduleStore } from '../../../stores/scheduleStore';
import { useConfigStore } from '../../../stores/configStore';
import { staticDataService } from '../../../services/staticDataService';
import { formatCompactRelativeTime } from '../../../utils/time/timestampFormatUtils';
import {
  API_FETCH_FRESHNESS_THRESHOLDS,
  GPS_DATA_AGE_THRESHOLDS,
  API_CACHE_DURATION,
} from '../../../utils/core/constants';
import type { StaticEndpoint } from '../../../utils/schedule/agencyFeeds';

type AgeStatus = 'fresh' | 'aging' | 'stale' | 'none';

const STATUS_COLOR: Record<AgeStatus, string> = {
  fresh: 'success.main',
  aging: 'warning.main',
  stale: 'error.main',
  none: 'text.disabled',
};

function gradeAge(ageMs: number | null, freshMs: number, agingMs: number): AgeStatus {
  if (ageMs === null) return 'none';
  if (ageMs < freshMs) return 'fresh';
  if (ageMs < agingMs) return 'aging';
  return 'stale';
}

function newestGpsTimestamp(vehicles: { id: number; timestamp: string }[]): number | null {
  let newest = 0;
  for (const v of vehicles) {
    if (v.id <= 0) continue;
    const ts = Date.parse(v.timestamp);
    if (Number.isFinite(ts) && ts > newest) newest = ts;
  }
  return newest > 0 ? newest : null;
}

const STATIC_ENDPOINTS: { key: StaticEndpoint; label: string }[] = [
  { key: 'routes', label: 'Routes' },
  { key: 'stops', label: 'Stops' },
  { key: 'trips', label: 'Trips' },
  { key: 'stop_times', label: 'Stop times' },
  { key: 'shapes', label: 'Shapes' },
];

interface FreshnessDebugPanelProps {
  className?: string;
}

export const FreshnessDebugPanel: FC<FreshnessDebugPanelProps> = ({ className }) => {
  // Tick every second to keep relative times current
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const vehicleFetch = useVehicleStore((s) => s.lastApiFetch);
  const vehicles = useVehicleStore((s) => s.vehicles);
  const scheduleFetched = useScheduleStore((s) => s.lastUpdated);
  const scheduleVersion = useScheduleStore((s) => s.dataVersion);
  const agencyId = useConfigStore((s) => s.agency_id);

  const gpsTs = newestGpsTimestamp(vehicles);
  const vehicleAge = vehicleFetch ? now - vehicleFetch : null;
  const gpsAge = gpsTs ? now - gpsTs : null;

  const timestamps = staticDataService.getTimestamps();
  const scheduleVersionTs = scheduleVersion ? Date.parse(scheduleVersion) : null;

  return (
    <Box className={className} data-testid="freshness-debug-panel">
      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        Data freshness
      </Typography>

      {/* Live data */}
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
        Live
      </Typography>
      <Stack spacing={0.5} sx={{ mb: 1.5 }}>
        <LiveRow
          label="Vehicles"
          ageMs={vehicleAge}
          status={gradeAge(vehicleAge, API_FETCH_FRESHNESS_THRESHOLDS.FRESH, API_FETCH_FRESHNESS_THRESHOLDS.WARNING)}
        />
        <LiveRow
          label="GPS (newest)"
          ageMs={gpsAge}
          status={gradeAge(gpsAge, GPS_DATA_AGE_THRESHOLDS.HEALTHY, GPS_DATA_AGE_THRESHOLDS.STALE)}
        />
      </Stack>

      <Divider sx={{ my: 1 }} />

      {/* Static data */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
        <Typography variant="caption" color="text.secondary">
          Static
        </Typography>
        <Box sx={{ display: 'flex', gap: 1.5 }}>
          <Typography variant="caption" color="text.disabled">updated</Typography>
          <Typography variant="caption" color="text.disabled">checked</Typography>
        </Box>
      </Box>
      <Stack spacing={0.5}>
        {STATIC_ENDPOINTS.map(({ key, label }) => {
          const hashKey = `${agencyId}/${key}`;
          const ts = timestamps[hashKey];
          return (
            <StaticRow
              key={key}
              label={label}
              lastChanged={ts?.lastChanged ?? null}
              lastChecked={ts?.lastChecked ?? null}
              now={now}
            />
          );
        })}
        <StaticRow
          label="Schedule"
          lastChanged={scheduleVersionTs && Number.isFinite(scheduleVersionTs) ? scheduleVersionTs : null}
          lastChecked={scheduleFetched}
          now={now}
        />
      </Stack>
    </Box>
  );
};

function LiveRow({ label, ageMs, status }: { label: string; ageMs: number | null; status: AgeStatus }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Dot color={STATUS_COLOR[status]} />
        <Typography variant="body2" color="text.secondary">{label}</Typography>
      </Box>
      <Typography
        variant="body2"
        sx={{ fontVariantNumeric: 'tabular-nums', color: status === 'stale' ? 'error.main' : 'text.primary', fontWeight: status === 'stale' ? 600 : 400 }}
      >
        {ageMs === null ? 'no data' : formatAge(ageMs)}
      </Typography>
    </Box>
  );
}

function StaticRow({ label, lastChanged, lastChecked, now }: {
  label: string; lastChanged: number | null; lastChecked: number | null; now: number;
}) {
  const FRESH = API_CACHE_DURATION.STATIC_DATA / 2;
  const AGING = API_CACHE_DURATION.STATIC_DATA;
  const age = lastChanged ? now - lastChanged : null;
  const status = gradeAge(age, FRESH, AGING);

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Dot color={STATUS_COLOR[status]} />
        <Typography variant="body2" color="text.secondary">{label}</Typography>
      </Box>
      <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'baseline' }}>
        <Typography variant="caption" sx={{ fontVariantNumeric: 'tabular-nums', color: 'text.secondary', minWidth: 40, textAlign: 'right' }}>
          {lastChanged ? formatCompactRelativeTime(lastChanged) : '—'}
        </Typography>
        <Typography variant="caption" sx={{ fontVariantNumeric: 'tabular-nums', color: 'text.disabled', minWidth: 40, textAlign: 'right' }}>
          {lastChecked ? formatCompactRelativeTime(lastChecked) : '—'}
        </Typography>
      </Box>
    </Box>
  );
}

function Dot({ color }: { color: string }) {
  return <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: color, flexShrink: 0 }} />;
}

function formatAge(ageMs: number): string {
  const s = Math.floor(ageMs / 1000);
  if (s < 30) return 'now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
