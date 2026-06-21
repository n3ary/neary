/**
 * FreshnessDebugPanel — data-age diagnostics (issue #20).
 *
 * Surfaces how old each layer of data is, with a clear red state when a layer
 * is stale, so users (and we, when debugging) can tell at a glance whether the
 * app is showing current information:
 *
 *   - Vehicle data: when this client last pulled the vehicle snapshot.
 *   - GPS: age of the newest vehicle GPS timestamp.
 *   - Schedule (client): when this client last fetched the schedule payload.
 *   - Schedule (server): when the backend pipeline last processed the feed
 *     (the payload `version`) — the closest available "server fetch age" until
 *     the server-side Tranzy cache (#19) lands.
 *
 * Reuses the shared freshness thresholds (`API_FETCH_FRESHNESS_THRESHOLDS`,
 * `GPS_DATA_AGE_THRESHOLDS`, `API_CACHE_DURATION.STATIC_DATA`) and the compact
 * relative-time formatter rather than introducing new ones.
 */

import type { FC } from 'react';
import { useEffect, useState } from 'react';
import { Box, Stack, Typography } from '@mui/material';
import { useVehicleStore } from '../../../stores/vehicleStore';
import { useScheduleStore } from '../../../stores/scheduleStore';
import { formatCompactRelativeTime } from '../../../utils/time/timestampFormatUtils';
import {
  API_FETCH_FRESHNESS_THRESHOLDS,
  GPS_DATA_AGE_THRESHOLDS,
  API_CACHE_DURATION,
} from '../../../utils/core/constants';

type AgeStatus = 'fresh' | 'aging' | 'stale' | 'none';

const STATUS_COLOR: Record<AgeStatus, string> = {
  fresh: 'success.main',
  aging: 'warning.main',
  stale: 'error.main',
  none: 'text.disabled',
};

/** Grade an age (ms) against fresh/aging thresholds; `null` age -> 'none'. */
function gradeAge(ageMs: number | null, freshMs: number, agingMs: number): AgeStatus {
  if (ageMs === null) return 'none';
  if (ageMs < freshMs) return 'fresh';
  if (ageMs < agingMs) return 'aging';
  return 'stale';
}

interface FreshnessRow {
  label: string;
  ageMs: number | null;
  status: AgeStatus;
}

/** Newest GPS timestamp (ms) across real (positive-id) vehicles, or null. */
function newestGpsTimestamp(vehicles: { id: number; timestamp: string }[]): number | null {
  let newest = 0;
  for (const v of vehicles) {
    if (v.id <= 0) continue;
    const ts = Date.parse(v.timestamp);
    if (Number.isFinite(ts) && ts > newest) newest = ts;
  }
  return newest > 0 ? newest : null;
}

interface FreshnessDebugPanelProps {
  className?: string;
}

/**
 * Compact diagnostics panel showing the age of each data layer with a
 * green/yellow/red dot. Recomputes every second so ages stay current.
 */
export const FreshnessDebugPanel: FC<FreshnessDebugPanelProps> = ({ className }) => {
  // Tick to recompute relative ages without depending on store updates.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const vehicleFetch = useVehicleStore((s) => s.lastApiFetch);
  const vehicles = useVehicleStore((s) => s.vehicles);
  const scheduleFetched = useScheduleStore((s) => s.lastUpdated);
  const scheduleVersion = useScheduleStore((s) => s.dataVersion);

  const gpsTs = newestGpsTimestamp(vehicles);
  const scheduleVersionTs = scheduleVersion ? Date.parse(scheduleVersion) : NaN;

  const vehicleAge = vehicleFetch ? now - vehicleFetch : null;
  const gpsAge = gpsTs ? now - gpsTs : null;
  const scheduleFetchAge = scheduleFetched ? now - scheduleFetched : null;
  const scheduleServerAge = Number.isFinite(scheduleVersionTs) ? now - scheduleVersionTs : null;

  // Schedule is a daily pipeline with a 24h client TTL. Treat <12h as fresh,
  // <24h as aging, and >=24h (a missed cycle) as stale.
  const SCHEDULE_FRESH = API_CACHE_DURATION.STATIC_DATA / 2;
  const SCHEDULE_AGING = API_CACHE_DURATION.STATIC_DATA;
  // The server pipeline runs daily; flag the backend as stale past ~26h.
  const SCHEDULE_SERVER_STALE = API_CACHE_DURATION.STATIC_DATA + 2 * 60 * 60 * 1000;

  const rows: FreshnessRow[] = [
    {
      label: 'Vehicle data',
      ageMs: vehicleAge,
      status: gradeAge(
        vehicleAge,
        API_FETCH_FRESHNESS_THRESHOLDS.FRESH,
        API_FETCH_FRESHNESS_THRESHOLDS.WARNING,
      ),
    },
    {
      label: 'GPS (newest)',
      ageMs: gpsAge,
      status: gradeAge(gpsAge, GPS_DATA_AGE_THRESHOLDS.HEALTHY, GPS_DATA_AGE_THRESHOLDS.STALE),
    },
    {
      label: 'Schedule (client)',
      ageMs: scheduleFetchAge,
      status: gradeAge(scheduleFetchAge, SCHEDULE_FRESH, SCHEDULE_AGING),
    },
    {
      label: 'Schedule (server)',
      ageMs: scheduleServerAge,
      status: gradeAge(scheduleServerAge, SCHEDULE_AGING, SCHEDULE_SERVER_STALE),
    },
  ];

  return (
    <Box className={className} data-testid="freshness-debug-panel">
      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        Data freshness
      </Typography>
      <Stack spacing={0.75}>
        {rows.map((row) => (
          <Box
            key={row.label}
            sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Box
                sx={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  bgcolor: STATUS_COLOR[row.status],
                  flexShrink: 0,
                }}
              />
              <Typography variant="body2" color="text.secondary">
                {row.label}
              </Typography>
            </Box>
            <Typography
              variant="body2"
              sx={{
                fontVariantNumeric: 'tabular-nums',
                color: row.status === 'stale' ? 'error.main' : 'text.primary',
                fontWeight: row.status === 'stale' ? 600 : 400,
              }}
            >
              {row.ageMs === null
                ? 'no data'
                : formatCompactRelativeTime(now - row.ageMs)}
            </Typography>
          </Box>
        ))}
      </Stack>
    </Box>
  );
};
