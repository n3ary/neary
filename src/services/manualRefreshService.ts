// Manual Refresh Service - Single entry point for all refresh operations
// Handles network connectivity checks and prevents concurrent executions

import { useVehicleStore } from '../stores/vehicleStore';
import { useStationStore } from '../stores/stationStore';
import { useRouteStore } from '../stores/routeStore';
import { useShapeStore } from '../stores/shapeStore';
import { useStopTimeStore } from '../stores/stopTimeStore';
import { useTripStore } from '../stores/tripStore';
import { useStationRoleStore } from '../stores/stationRoleStore';
import { useStatusStore } from '../stores/statusStore';
import { API_CACHE_DURATION, PERFORMANCE } from '../utils/core/constants';

export interface RefreshResult {
  success: boolean;
  errors: string[];
  refreshedStores: string[];
  skippedStores: string[];
}

/** Options for a refresh pass. */
export interface RefreshOptions {
  /**
   * Force a vehicle fetch even within the freshness/debounce window (used by an
   * explicit user tap, see MANUAL_REFRESH_DEBOUNCE_MS). Forcing does NOT refetch
   * 24h static data — only the dynamic vehicle data is forced. Forced calls also
   * bypass the automatic-trigger coalescing guard.
   */
  force?: boolean;
}

class ManualRefreshService {
  private isRefreshing = false;
  private refreshPromise: Promise<RefreshResult> | null = null;
  /** Start time of the most recent refresh, for coalescing automatic triggers. */
  private lastRefreshStartedAt = 0;

  async refreshData(options: RefreshOptions = {}): Promise<RefreshResult> {
    if (this.isRefreshing && this.refreshPromise) {
      return this.refreshPromise;
    }

    // Network gate first, so an offline attempt never updates the coalescing
    // timestamp (otherwise a real refresh on network-restore could be skipped).
    if (!this.isNetworkAvailable()) {
      return {
        success: false,
        errors: ['Network unavailable'],
        refreshedStores: [],
        skippedStores: [],
      };
    }

    // Coalesce rapid AUTOMATIC triggers (e.g. foreground + network-available
    // firing together on resume). An explicit user tap (force) always proceeds.
    if (!options.force) {
      const sinceLast = Date.now() - this.lastRefreshStartedAt;
      if (sinceLast < PERFORMANCE.MIN_REFRESH_INTERVAL) {
        return {
          success: true,
          errors: [],
          refreshedStores: [],
          skippedStores: ['coalesced'],
        };
      }
    }

    this.isRefreshing = true;
    this.lastRefreshStartedAt = Date.now();
    this.refreshPromise = this.performRefresh(options);
    
    try {
      const result = await this.refreshPromise;
      return result;
    } finally {
      this.isRefreshing = false;
      this.refreshPromise = null;
    }
  }

  private async performRefresh(options: RefreshOptions = {}): Promise<RefreshResult> {
    const result: RefreshResult = {
      success: true,
      errors: [],
      refreshedStores: [],
      skippedStores: []
    };

    if (!this.isNetworkAvailable()) {
      result.success = false;
      result.errors.push('Network unavailable');
      return result;
    }

    // Check freshness before refreshing each store
    const stores = [
      { name: 'vehicles', store: useVehicleStore, maxAge: API_CACHE_DURATION.VEHICLES },
      { name: 'stations', store: useStationStore, maxAge: API_CACHE_DURATION.STATIC_DATA },
      { name: 'routes', store: useRouteStore, maxAge: API_CACHE_DURATION.STATIC_DATA },
      { name: 'shapes', store: useShapeStore, maxAge: API_CACHE_DURATION.STATIC_DATA },
      { name: 'stopTimes', store: useStopTimeStore, maxAge: API_CACHE_DURATION.STATIC_DATA },
      { name: 'trips', store: useTripStore, maxAge: API_CACHE_DURATION.STATIC_DATA }
    ];

    for (const { name, store, maxAge } of stores) {
      try {
        const storeState = store.getState();
        
        // Skip vehicle refresh if no API key configured (schedule-only mode)
        if (name === 'vehicles') {
          const { useConfigStore } = await import('../stores/configStore');
          const apiKey = useConfigStore.getState().apiKey;
          if (!apiKey) {
            result.skippedStores.push(name);
            continue;
          }
        }

        // Check if data is fresh - skip refresh if so. A forced tap bypasses the
        // debounce for VEHICLE data only (static 24h data is never worth forcing).
        const forceThisStore = options.force === true && name === 'vehicles';
        if (!forceThisStore && storeState.isDataFresh && storeState.isDataFresh(maxAge)) {
          result.skippedStores.push(name);
          console.log(`[Refresh] ${name}: Using cached data (fetched at ${new Date(storeState.lastApiFetch || 0).toLocaleTimeString()})`);
          continue;
        }
        
        // Call refreshData() method - store will log the API fetch
        await storeState.refreshData();
        result.refreshedStores.push(name);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        result.errors.push(`${name}: ${errorMessage}`);
        result.success = false;
      }
    }
    
    // Calculate station roles after trips and stopTimes are loaded
    const tripsLoaded = result.refreshedStores.includes('trips') || result.skippedStores.includes('trips');
    const stopTimesLoaded = result.refreshedStores.includes('stopTimes') || result.skippedStores.includes('stopTimes');
    
    if (tripsLoaded && stopTimesLoaded) {
      try {
        const stationRoleStore = useStationRoleStore.getState();
        
        // Only calculate if data is stale or missing
        if (!stationRoleStore.isDataFresh(API_CACHE_DURATION.STATIC_DATA)) {
          console.log('[Refresh] stationRoles: Calculating station roles...');
          await stationRoleStore.calculateStationRoles();
          console.log('[Refresh] stationRoles: Calculation completed');
        }
      } catch (error) {
        console.warn('Failed to calculate station roles:', error);
      }
    }
    
    return result;
  }

  isRefreshInProgress(): boolean {
    return this.isRefreshing;
  }

  isNetworkAvailable(): boolean {
    const statusStore = useStatusStore.getState();
    return statusStore.networkOnline && statusStore.apiStatus !== 'offline';
  }
}

const refreshService = new ManualRefreshService();
export { refreshService as manualRefreshService };