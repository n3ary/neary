// ManualRefreshButton - Color-coded refresh button
// Integrates with Data Freshness Monitor and Manual Refresh System

import type { FC } from 'react';
import { useEffect, useState } from 'react';
import { IconButton, Box, CircularProgress, Snackbar, Alert } from '@mui/material';
import { Refresh as RefreshIcon } from '@mui/icons-material';
import { getDataFreshnessMonitor, type ApiFreshnessStatus } from '../../../utils/core/apiFreshnessMonitor';
import { automaticRefreshService } from '../../../services/automaticRefreshService';
import { manualRefreshService } from '../../../services/manualRefreshService';
import { useConfigStore } from '../../../stores/configStore';
import { useStatusStore } from '../../../stores/statusStore';
import { useVehicleStore } from '../../../stores/vehicleStore';
import { formatCompactRelativeTime } from '../../../utils/time/timestampFormatUtils';
import { API_FETCH_FRESHNESS_THRESHOLDS, MANUAL_REFRESH_DEBOUNCE_MS, GPS_DATA_AGE_THRESHOLDS } from '../../../utils/core/constants';

interface ManualRefreshButtonProps {
  className?: string;
  disabled?: boolean;
}

/**
 * Newest GPS timestamp age across real (GPS-tracked) vehicles, as a compact
 * label like "12s ago", or null when there are no GPS vehicles. Synthetic
 * scheduled/ghost vehicles carry a non-positive id and no live GPS, so they are
 * excluded.
 */
function newestGpsAgeLabel(vehicles: { id: number; timestamp: string }[]): string | null {
  let newest = 0;
  for (const v of vehicles) {
    if (v.id <= 0) continue;
    const ts = Date.parse(v.timestamp);
    if (Number.isFinite(ts) && ts > newest) newest = ts;
  }
  return newest > 0 ? formatCompactRelativeTime(newest) : null;
}

/**
 * Manual Refresh Button Component
 * 
 * Features:
 * - Color-coded status indicator (green for fresh, red for stale)
 * - Loading state during refresh operations
 * - Integrates with Material-UI design system
 * - Prevents concurrent refresh operations
 */
export const ManualRefreshButton: FC<ManualRefreshButtonProps> = ({
  className,
  disabled = false
}) => {
  const [freshnessStatus, setFreshnessStatus] = useState<ApiFreshnessStatus>({
    status: 'stale',
    vehicleApiAge: Infinity,
    staticApiAge: Infinity,
    isRefreshing: false,
    nextAutoRefreshIn: 0,
    lastApiFetchTime: null
  });

  const [isRefreshing, setIsRefreshing] = useState(false);
  // Local busy state for the in-debounce "predict only" tap (no API call, so it
  // does not show up in manualRefreshService.isRefreshInProgress()).
  const [isPredicting, setIsPredicting] = useState(false);

  // Outcome toast (#21): an explicit tap always tells the user what happened.
  const [toast, setToast] = useState<{
    open: boolean;
    message: string;
    severity: 'success' | 'info' | 'warning' | 'error';
  }>({ open: false, message: '', severity: 'info' });

  const showToast = (message: string, severity: 'success' | 'info' | 'warning' | 'error') =>
    setToast({ open: true, message, severity });

  // Subscribe to freshness monitor for fresh/stale status
  useEffect(() => {
    const monitor = getDataFreshnessMonitor();
    
    // Get initial status
    const initialStatus = monitor.calculateApiFreshness();
    setFreshnessStatus(initialStatus);
    
    // Subscribe to changes
    const unsubscribe = monitor.subscribeToChanges((status) => {
      setFreshnessStatus(status);
    });

    return unsubscribe;
  }, []);

  // Poll refresh status from manualRefreshService
  useEffect(() => {
    const checkRefreshStatus = () => {
      const refreshing = manualRefreshService.isRefreshInProgress();
      setIsRefreshing(refreshing);
    };

    // Check immediately
    checkRefreshStatus();

    // Poll every 100ms
    const interval = setInterval(checkRefreshStatus, 100);

    return () => clearInterval(interval);
  }, []);

  /**
   * Manual refresh: an explicit tap should always do something useful.
   *   - OUTSIDE the debounce window (vehicle data is older) -> force a real
   *     fetch and reset the auto-refresh cadence.
   *   - INSIDE the window (a fetch would just be skipped) -> recompute
   *     predictions so the tap still moves vehicles, without spending an API
   *     call (quota-friendly).
   */
  const handleManualRefresh = async () => {
    // Prevent concurrent operations
    if (isRefreshing || isPredicting || disabled) {
      return;
    }

    // Offline: nothing to do, but the tap still gets feedback (#21).
    if (!manualRefreshService.isNetworkAvailable()) {
      showToast('Offline — can’t refresh right now', 'warning');
      return;
    }

    const before = useVehicleStore.getState();
    const beforeFetch = before.lastApiFetch ?? 0;
    const beforeCount = before.vehicles.length;
    const vehicleAge = beforeFetch ? Date.now() - beforeFetch : Infinity;
    const outsideDebounce = vehicleAge >= MANUAL_REFRESH_DEBOUNCE_MS;

    // Also force fetch when GPS data is stale (newest timestamp > 3 min old)
    // even if within debounce — the user is explicitly asking for fresh data.
    let gpsStale = false;
    if (!outsideDebounce && before.vehicles.length > 0) {
      let newestGps = 0;
      for (const v of before.vehicles) {
        if (v.id <= 0) continue;
        const ts = Date.parse(v.timestamp);
        if (Number.isFinite(ts) && ts > newestGps) newestGps = ts;
      }
      gpsStale = newestGps > 0 && (Date.now() - newestGps) > GPS_DATA_AGE_THRESHOLDS.HEALTHY;
    }

    // Also force if stores are empty (e.g. after Clear Storage)
    const storesEmpty = before.vehicles.length === 0 && beforeFetch === 0;

    if (outsideDebounce || gpsStale || storesEmpty) {
      console.log(`[Manual Refresh] User tap -> force fetch (${outsideDebounce ? 'debounce expired' : gpsStale ? 'GPS stale' : 'stores empty'})`);
      try {
        await automaticRefreshService.triggerManualRefresh(true);

        const after = useVehicleStore.getState();
        const afterFetch = after.lastApiFetch ?? 0;
        const afterCount = after.vehicles.length;
        const gps = newestGpsAgeLabel(after.vehicles);

        if (afterFetch > beforeFetch) {
          // A real fetch happened. Report the new vehicle count and how it
          // changed, plus how fresh the GPS is.
          const delta = afterCount - beforeCount;
          const deltaLabel = delta !== 0 ? ` (${delta > 0 ? '+' : ''}${delta})` : '';
          const gpsLabel = gps ? ` · GPS ${gps}` : '';
          showToast(`Refreshed · ${afterCount} vehicles${deltaLabel}${gpsLabel}`, 'success');
        } else {
          // Force bypasses the debounce, so this is rare (e.g. the fetch
          // returned no fresh snapshot). Report honestly rather than implying
          // an update.
          showToast('No new data — showing the latest available', 'info');
        }
      } catch (error) {
        console.warn('Manual refresh encountered errors:', error);
        showToast('Refresh failed — check your connection', 'error');
      }
    } else {
      console.log('[Manual Refresh] User tap within debounce -> prediction update');
      setIsPredicting(true);
      try {
        await automaticRefreshService.triggerPredictionUpdate();
        const lastLabel = beforeFetch ? formatCompactRelativeTime(beforeFetch) : 'recently';
        showToast(`Data is recent (${lastLabel}) · positions updated`, 'info');
      } catch (error) {
        console.warn('Manual prediction update failed:', error);
        showToast('Could not update positions', 'error');
      } finally {
        setIsPredicting(false);
      }
    }
  };

  // Determine button color based on API fetch time and disabled conditions
  const getButtonColor = (): 'success' | 'warning' | 'error' | 'default' => {
    // Get store states for disabled state checks
    const configState = useConfigStore.getState();
    const statusState = useStatusStore.getState();
    
    // Check disabled conditions first
    const isDisabled = 
      !configState.apiKey || 
      !configState.agency_id || 
      !statusState.networkOnline || 
      statusState.apiStatus !== 'online';
    
    if (isDisabled) {
      return 'default'; // Grey for disabled states
    }
    
    // If no API fetch has occurred yet
    if (freshnessStatus.lastApiFetchTime === null) {
      return 'default'; // Grey for initial state
    }
    
    // Calculate API fetch age in milliseconds
    const apiFetchAge = Date.now() - freshnessStatus.lastApiFetchTime;
    
    // Apply three-color thresholds
    if (apiFetchAge < API_FETCH_FRESHNESS_THRESHOLDS.FRESH) {
      return 'success'; // Green: < 1 minute
    } else if (apiFetchAge < API_FETCH_FRESHNESS_THRESHOLDS.WARNING) {
      return 'warning'; // Yellow: 1-3 minutes
    } else {
      return 'error'; // Red: > 3 minutes
    }
  };

  const buttonColor = getButtonColor();
  const busy = isRefreshing || isPredicting;

  return (
    <Box sx={{ position: 'relative', display: 'inline-flex' }}>
      <IconButton
        className={className}
        color={buttonColor}
        onClick={handleManualRefresh}
        disabled={disabled || busy}
        aria-label="Manual refresh data"
        size="small"
        sx={{
          transition: 'color 0.2s ease-in-out',
        }}
      >
        {busy ? (
          <CircularProgress
            size={24}
            color={buttonColor === 'default' ? 'inherit' : buttonColor}
            sx={{
              width: '24px !important',
              height: '24px !important',
            }}
          />
        ) : (
          <RefreshIcon />
        )}
      </IconButton>

      <Snackbar
        open={toast.open}
        autoHideDuration={4000}
        onClose={() => setToast((t) => ({ ...t, open: false }))}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          onClose={() => setToast((t) => ({ ...t, open: false }))}
          severity={toast.severity}
          variant="filled"
          sx={{ width: '100%' }}
        >
          {toast.message}
        </Alert>
      </Snackbar>
    </Box>
  );
};
