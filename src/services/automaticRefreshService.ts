// Automatic Refresh Service - Handles automatic refresh timers and app lifecycle
// Requirements: 7.1, 7.2, 7.3, 7.4, 7.5

import { useStatusStore } from '../stores/statusStore';
import { useStationCacheStore } from '../stores/stationCacheStore';
import { manualRefreshService } from './manualRefreshService';
import { AUTO_REFRESH_CYCLE, PREDICTION_UPDATE_CYCLE } from '../utils/core/constants';

interface AutoRefreshConfig {
  vehicleRefreshInterval: number;
  predictionUpdateInterval: number;
  enableBackgroundRefresh: boolean;
}

class AutomaticRefreshService {
  private vehicleRefreshTimer: NodeJS.Timeout | null = null;
  private predictionUpdateTimer: NodeJS.Timeout | null = null;
  private networkStatusUnsubscribe: (() => void) | null = null;
  private vehicleLoadUnsubscribe: (() => void) | null = null;
  private isAppInForeground = true;
  private hasInitializedStartup = false;
  private isPredicting = false;
  private config: AutoRefreshConfig;
  private cleanupVisibilityHandlers: (() => void) | null = null;

  constructor(config: Partial<AutoRefreshConfig> = {}) {
    this.config = {
      vehicleRefreshInterval: AUTO_REFRESH_CYCLE,
      predictionUpdateInterval: PREDICTION_UPDATE_CYCLE,
      enableBackgroundRefresh: false,
      ...config
    };

    this.setupVisibilityHandling();
    this.setupNetworkStatusMonitoring();
  }

  /**
   * Initialize the automatic refresh system
   * Requirement 7.1: Cache-first startup strategy
   */
  async initialize(): Promise<void> {
    if (this.hasInitializedStartup) {
      return;
    }

    this.hasInitializedStartup = true;

    // Check if API configuration is ready before starting refresh
    const { isContextReady } = await import('../context/appContext');
    if (!isContextReady()) {
      console.log('[AutoRefresh] Skipping initialization - API key and agency ID not configured');
      return;
    }

    // Start background refresh immediately (components handle their own cache loading)
    this.startBackgroundRefresh();

    // Start timers if in foreground
    if (this.isAppInForeground) {
      // Only start vehicle timer if API key is configured
      const { useConfigStore } = await import('../stores/configStore');
      if (useConfigStore.getState().apiKey) {
        this.startVehicleRefreshTimer();
      }
      this.startPredictionUpdateTimer();
    }

    // Setup immediate prediction trigger after vehicle loads
    this.setupImmediatePredictionTrigger();
  }

  /**
   * Start background refresh with network connectivity check
   * Requirements 7.3, 7.4: Fetch fresh data when network is available
   */
  private async startBackgroundRefresh(): Promise<void> {
    if (!manualRefreshService.isNetworkAvailable()) {
      // Network not available, wait for connectivity
      return;
    }

    // Check if API configuration is ready
    const { isContextReady } = await import('../context/appContext');
    if (!isContextReady()) {
      return;
    }

    try {
      // Single refresh call - no duplicate calls needed
      await manualRefreshService.refreshData();
    } catch (error) {
      console.warn('Background refresh failed:', error);
    }
  }

  /**
   * Start automatic vehicle refresh timer
   * Requirement 7.2: 1-minute automatic refresh for vehicle data when in foreground
   */
  private startVehicleRefreshTimer(): void {
    if (this.vehicleRefreshTimer) {
      return; // Timer already running
    }

    this.vehicleRefreshTimer = setInterval(async () => {
      // Only refresh if app is in foreground and network is available
      if (!this.isAppInForeground) {
        return;
      }

      // Skip vehicle refresh if no API key (schedule-only mode)
      const { useConfigStore } = await import('../stores/configStore');
      if (!useConfigStore.getState().apiKey) {
        return;
      }

      const statusStore = useStatusStore.getState();
      if (!statusStore.networkOnline) {
        return;
      }

      // Check if API configuration is ready
      const { isContextReady } = await import('../context/appContext');
      if (!isContextReady()) {
        return;
      }

      console.log('[Auto Refresh Timer] Automatic refresh triggered');

      try {
        // Use the same unified refresh mechanism for consistency
        // This ensures proper button state management and timer coordination
        await this.triggerManualRefresh();
      } catch (error) {
        console.warn('Automatic vehicle refresh failed:', error);
      }
    }, this.config.vehicleRefreshInterval);
  }

  /**
   * Stop automatic vehicle refresh timer
   */
  private stopVehicleRefreshTimer(): void {
    if (this.vehicleRefreshTimer) {
      clearInterval(this.vehicleRefreshTimer);
      this.vehicleRefreshTimer = null;
    }
  }

  /**
   * Start automatic prediction update timer.
   * Uses setInterval but guards against overlapping runs.
   */
  private startPredictionUpdateTimer(): void {
    if (this.predictionUpdateTimer) {
      return; // Timer already running
    }

    this.predictionUpdateTimer = setInterval(async () => {
      if (!this.isAppInForeground) return;
      if (this.isPredicting) return; // Skip if previous run hasn't finished
      
      this.isPredicting = true;
      try {
        await this.updatePredictionsOnly();
      } catch (error) {
        console.warn('Automatic prediction update failed:', error);
      } finally {
        this.isPredicting = false;
      }
    }, this.config.predictionUpdateInterval);
  }

  /**
   * Stop automatic prediction update timer
   */
  private stopPredictionUpdateTimer(): void {
    if (this.predictionUpdateTimer) {
      console.log('[Prediction Timer] Stopping prediction timer');
      clearInterval(this.predictionUpdateTimer);
      this.predictionUpdateTimer = null;
    }
  }

  /**
   * Get route IDs from the station cache for scoping predictions.
   * Returns all unique route IDs from the most recent valid cache entry.
   */
  private getRouteIdsFromCache(): number[] {
    const cache = useStationCacheStore.getState().cache;
    
    for (const [, entry] of cache) {
      if (Date.now() - entry.timestamp < 5 * 60 * 1000) {
        const routeIds = entry.stations.flatMap(s => s.routeIds);
        const unique = [...new Set(routeIds)];
        if (unique.length > 0) {
          console.log(`[AutoRefresh] Route scope from cache: ${unique.length} routes`);
        }
        return unique;
      }
    }
    return [];
  }

  /**
   * Update vehicle predictions using existing cached data.
   * Scopes enhancement to only vehicles matching the user's station routes.
   */
  private async updatePredictionsOnly(): Promise<void> {
    try {
      const { useVehicleStore } = await import('../stores/vehicleStore');
      const vehicleStore = useVehicleStore.getState();
      
      // Only update if we have cached vehicles
      if (vehicleStore.vehicles.length === 0) {
        return;
      }

      const routeIds = this.getRouteIdsFromCache();
      await vehicleStore.updatePredictions(routeIds);
      
    } catch (error) {
      console.warn('Failed to update predictions:', error);
    }
  }

  /**
   * Setup subscription to vehicle store to trigger immediate prediction
   * after vehicle fetch completes.
   */
  private setupImmediatePredictionTrigger(): void {
    import('../stores/vehicleStore').then(({ useVehicleStore }) => {
      this.vehicleLoadUnsubscribe = useVehicleStore.subscribe(
        (state, prevState) => {
          // Detect: was loading, now loaded with vehicles
          if (prevState.loading && !state.loading && state.vehicles.length > 0) {
            this.triggerImmediatePrediction();
          }
        }
      );
    });
  }

  /**
   * Trigger one immediate prediction cycle and restart the regular timer.
   * Retries briefly if station cache isn't populated yet (React hook lag).
   */
  private async triggerImmediatePrediction(): Promise<void> {
    // Reset the prediction timer so the next tick is 15s from now
    this.stopPredictionUpdateTimer();

    if (!this.isPredicting) {
      this.isPredicting = true;
      try {
        // Station cache may not be populated yet (React renders after store update).
        // Retry up to 3 times with 500ms delay to let the station filter hook run.
        let routeIds = this.getRouteIdsFromCache();
        let retries = 0;
        while (routeIds.length === 0 && retries < 3) {
          await new Promise(r => setTimeout(r, 500));
          routeIds = this.getRouteIdsFromCache();
          retries++;
        }

        if (routeIds.length > 0) {
          const { useVehicleStore } = await import('../stores/vehicleStore');
          await useVehicleStore.getState().updatePredictions(routeIds);
        }
      } catch (error) {
        console.warn('Immediate prediction cycle failed:', error);
      } finally {
        this.isPredicting = false;
      }
    }

    // Restart the regular 15s timer from this point
    if (this.isAppInForeground) {
      this.startPredictionUpdateTimer();
    }
  }

  /**
   * Setup app visibility change handling
   * Requirement 7.4: Handle app visibility changes for timer management
   */
  private setupVisibilityHandling(): void {
    // Handle page visibility changes
    const handleVisibilityChange = () => {
      const isVisible = !document.hidden;
      this.handleAppVisibilityChange(isVisible);
    };

    // Handle window focus/blur events
    const handleFocus = () => this.handleAppVisibilityChange(true);
    const handleBlur = () => this.handleAppVisibilityChange(false);

    // Add event listeners
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);
    window.addEventListener('blur', handleBlur);

    // Store cleanup functions
    this.cleanupVisibilityHandlers = () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('blur', handleBlur);
    };
  }

  /**
   * Handle app visibility changes
   */
  private handleAppVisibilityChange(isVisible: boolean): void {
    const wasInForeground = this.isAppInForeground;
    this.isAppInForeground = isVisible;

    if (isVisible && !wasInForeground) {
      // App came to foreground
      this.onAppForeground();
    } else if (!isVisible && wasInForeground) {
      // App went to background
      this.onAppBackground();
    }
  }

  /**
   * Handle app coming to foreground
   */
  private async onAppForeground(): Promise<void> {
    // Start timers
    this.startVehicleRefreshTimer();
    this.startPredictionUpdateTimer();

    // Check if any data is stale and refresh if needed
    await this.refreshStaleDataOnForeground();
  }

  /**
   * Handle app going to background
   */
  private onAppBackground(): void {
    // Stop timers to save battery
    if (!this.config.enableBackgroundRefresh) {
      this.stopVehicleRefreshTimer();
      this.stopPredictionUpdateTimer();
    }
  }

  /**
   * Refresh stale data when app comes to foreground
   * Requirement 7.5: Automatic refresh for stale data when network becomes available
   */
  private async refreshStaleDataOnForeground(): Promise<void> {
    if (!manualRefreshService.isNetworkAvailable()) {
      return;
    }

    // Check if API configuration is ready
    const { isContextReady } = await import('../context/appContext');
    if (!isContextReady()) {
      return;
    }

    try {
      // Use the same unified refresh mechanism for consistency
      await this.triggerManualRefresh();
    } catch (error) {
      console.warn('Failed to refresh stale data on foreground:', error);
    }
  }

  /**
   * Setup network status monitoring
   * Requirement 7.4: Automatic refresh when network becomes available
   */
  private setupNetworkStatusMonitoring(): void {
    // Subscribe to network status changes
    this.networkStatusUnsubscribe = useStatusStore.subscribe((state, prevState) => {
      // Network became available
      if (state.networkOnline && !prevState.networkOnline) {
        this.onNetworkAvailable();
      }
    });
  }

  /**
   * Handle network becoming available
   */
  private async onNetworkAvailable(): Promise<void> {
    if (!this.hasInitializedStartup) {
      return;
    }

    // Check if API configuration is ready
    const { isContextReady } = await import('../context/appContext');
    if (!isContextReady()) {
      return;
    }

    try {
      // Use the same unified refresh mechanism for consistency
      await this.triggerManualRefresh();
    } catch (error) {
      console.warn('Failed to refresh data when network became available:', error);
    }
  }

  /**
   * Manually trigger a refresh and reset the automatic timers
   * This should be called by the manual refresh button to keep both systems in sync.
   * Pass `force` for an explicit user tap so the vehicle fetch bypasses the
   * freshness debounce and the automatic-trigger coalescing guard.
   */
  async triggerManualRefresh(force = false): Promise<void> {
    try {
      // Stop current timers
      this.stopVehicleRefreshTimer();
      this.stopPredictionUpdateTimer();
      
      // Trigger the same refresh logic used by automatic refresh
      await manualRefreshService.refreshData({ force });
      
      // Restart timers (resets the countdown)
      if (this.isAppInForeground) {
        this.startVehicleRefreshTimer();
        this.startPredictionUpdateTimer();
      }
    } catch (error) {
      // Restart timers even if refresh failed
      if (this.isAppInForeground) {
        this.startVehicleRefreshTimer();
        this.startPredictionUpdateTimer();
      }
      throw error; // Re-throw for button to handle
    }
  }

  /**
   * Recompute vehicle predictions without an API call. Used by an explicit tap
   * that lands INSIDE the manual-refresh debounce window: a fetch would be a
   * no-op, so we recompute positions/ETAs instead to keep the tap rewarding.
   */
  async triggerPredictionUpdate(): Promise<void> {
    if (!this.isPredicting) {
      this.isPredicting = true;
      try {
        await this.updatePredictionsOnly();
      } finally {
        this.isPredicting = false;
      }
    }
  }

  /**
   * Check if automatic refresh is currently active
   */
  isActive(): boolean {
    return this.vehicleRefreshTimer !== null || this.predictionUpdateTimer !== null;
  }

  /**
   * Get current configuration
   */
  getConfig(): AutoRefreshConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<AutoRefreshConfig>): void {
    const oldConfig = this.config;
    this.config = { ...this.config, ...newConfig };

    // Restart timers if intervals changed
    if (oldConfig.vehicleRefreshInterval !== this.config.vehicleRefreshInterval) {
      if (this.vehicleRefreshTimer) {
        this.stopVehicleRefreshTimer();
        if (this.isAppInForeground) {
          this.startVehicleRefreshTimer();
        }
      }
    }
    
    if (oldConfig.predictionUpdateInterval !== this.config.predictionUpdateInterval) {
      if (this.predictionUpdateTimer) {
        this.stopPredictionUpdateTimer();
        if (this.isAppInForeground) {
          this.startPredictionUpdateTimer();
        }
      }
    }
  }

  /**
   * Cleanup all timers and event listeners
   */
  destroy(): void {
    // Stop timers
    this.stopVehicleRefreshTimer();
    this.stopPredictionUpdateTimer();

    // Cleanup network status subscription
    if (this.networkStatusUnsubscribe) {
      this.networkStatusUnsubscribe();
      this.networkStatusUnsubscribe = null;
    }

    // Cleanup vehicle load subscription
    if (this.vehicleLoadUnsubscribe) {
      this.vehicleLoadUnsubscribe();
      this.vehicleLoadUnsubscribe = null;
    }

    // Cleanup visibility handlers
    if (this.cleanupVisibilityHandlers) {
      this.cleanupVisibilityHandlers();
      this.cleanupVisibilityHandlers = null;
    }

    this.hasInitializedStartup = false;
  }
}

// Export singleton instance
export const automaticRefreshService = new AutomaticRefreshService();

// Export types for use in components
export type { AutoRefreshConfig };