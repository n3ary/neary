// Manual Refresh Service Tests
// Tests for coordinated refresh across all stores with network connectivity checks

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { manualRefreshService } from '../../services/manualRefreshService';
import { useStatusStore } from '../../stores/statusStore';
import { useVehicleStore } from '../../stores/vehicleStore';
import { useStationStore } from '../../stores/stationStore';
import { useRouteStore } from '../../stores/routeStore';
import { useShapeStore } from '../../stores/shapeStore';
import { useStopTimeStore } from '../../stores/stopTimeStore';
import { useTripStore } from '../../stores/tripStore';

// Mock all stores
vi.mock('../../stores/statusStore');
vi.mock('../../stores/vehicleStore');
vi.mock('../../stores/stationStore');
vi.mock('../../stores/routeStore');
vi.mock('../../stores/shapeStore');
vi.mock('../../stores/stopTimeStore');
vi.mock('../../stores/tripStore');
vi.mock('../../stores/configStore', () => ({
  useConfigStore: { getState: () => ({ apiKey: 'test-key', agency_id: 2 }) }
}));

describe('ManualRefreshService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    // Reset service state
    (manualRefreshService as any).isRefreshing = false;
    (manualRefreshService as any).refreshPromise = null;
    (manualRefreshService as any).lastRefreshStartedAt = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Network Connectivity Checks', () => {
    it('should check network availability before refresh', async () => {
      // Mock network offline
      const mockStatusStore = {
        networkOnline: false,
        apiStatus: 'offline'
      };
      vi.mocked(useStatusStore.getState).mockReturnValue(mockStatusStore as any);

      const result = await manualRefreshService.refreshData();

      expect(result.success).toBe(false);
      expect(result.errors).toContain('Network unavailable');
      expect(result.refreshedStores).toHaveLength(0);
    });

    it('should refresh all stores when network is available', async () => {
      // Mock network online
      const mockStatusStore = {
        networkOnline: true,
        apiStatus: 'online'
      };
      vi.mocked(useStatusStore.getState).mockReturnValue(mockStatusStore as any);

      // Mock all stores with successful refresh
      const mockStoreState = {
        refreshData: vi.fn().mockResolvedValue(undefined)
      };

      vi.mocked(useVehicleStore.getState).mockReturnValue(mockStoreState as any);
      vi.mocked(useStationStore.getState).mockReturnValue(mockStoreState as any);
      vi.mocked(useRouteStore.getState).mockReturnValue(mockStoreState as any);
      vi.mocked(useShapeStore.getState).mockReturnValue(mockStoreState as any);
      vi.mocked(useStopTimeStore.getState).mockReturnValue(mockStoreState as any);
      vi.mocked(useTripStore.getState).mockReturnValue(mockStoreState as any);

      const result = await manualRefreshService.refreshData();

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.refreshedStores).toEqual(['vehicles', 'stations', 'routes', 'shapes', 'stopTimes', 'trips']);
    });
  });

  describe('Concurrency Control', () => {
    it('should prevent concurrent refresh operations', async () => {
      // Mock network online
      const mockStatusStore = {
        networkOnline: true,
        apiStatus: 'online'
      };
      vi.mocked(useStatusStore.getState).mockReturnValue(mockStatusStore as any);

      // Mock stores with delayed refresh
      const mockStoreState = {
        refreshData: vi.fn().mockImplementation(() => new Promise(resolve => setTimeout(resolve, 100)))
      };

      vi.mocked(useVehicleStore.getState).mockReturnValue(mockStoreState as any);
      vi.mocked(useStationStore.getState).mockReturnValue(mockStoreState as any);
      vi.mocked(useRouteStore.getState).mockReturnValue(mockStoreState as any);
      vi.mocked(useShapeStore.getState).mockReturnValue(mockStoreState as any);
      vi.mocked(useStopTimeStore.getState).mockReturnValue(mockStoreState as any);
      vi.mocked(useTripStore.getState).mockReturnValue(mockStoreState as any);

      // Start first refresh
      const firstRefresh = manualRefreshService.refreshData();
      
      // Start second refresh immediately
      const secondRefresh = manualRefreshService.refreshData();

      // Both should resolve to the same promise
      const [firstResult, secondResult] = await Promise.all([firstRefresh, secondRefresh]);
      
      expect(firstResult).toBe(secondResult);
      expect(firstResult.success).toBe(true);
    });

    it('should track refresh progress correctly', async () => {
      // Mock network online
      const mockStatusStore = {
        networkOnline: true,
        apiStatus: 'online'
      };
      vi.mocked(useStatusStore.getState).mockReturnValue(mockStatusStore as any);

      // Mock stores
      const mockStoreState = {
        refreshData: vi.fn().mockResolvedValue(undefined)
      };

      vi.mocked(useVehicleStore.getState).mockReturnValue(mockStoreState as any);
      vi.mocked(useStationStore.getState).mockReturnValue(mockStoreState as any);
      vi.mocked(useRouteStore.getState).mockReturnValue(mockStoreState as any);
      vi.mocked(useShapeStore.getState).mockReturnValue(mockStoreState as any);
      vi.mocked(useStopTimeStore.getState).mockReturnValue(mockStoreState as any);
      vi.mocked(useTripStore.getState).mockReturnValue(mockStoreState as any);

      const refreshPromise = manualRefreshService.refreshData();
      
      // Should be in progress during refresh
      expect(manualRefreshService.isRefreshInProgress()).toBe(true);
      
      await refreshPromise;
      
      // Should not be in progress after completion
      expect(manualRefreshService.isRefreshInProgress()).toBe(false);
    });
  });

  describe('Error Handling', () => {
    it('should handle individual store errors gracefully', async () => {
      // Mock network online
      const mockStatusStore = {
        networkOnline: true,
        apiStatus: 'online'
      };
      vi.mocked(useStatusStore.getState).mockReturnValue(mockStatusStore as any);

      // Mock some stores to succeed, others to fail
      const mockSuccessState = {
        refreshData: vi.fn().mockResolvedValue(undefined)
      };
      const mockFailState = {
        refreshData: vi.fn().mockRejectedValue(new Error('Refresh failed'))
      };

      vi.mocked(useVehicleStore.getState).mockReturnValue(mockSuccessState as any);
      vi.mocked(useStationStore.getState).mockReturnValue(mockFailState as any);
      vi.mocked(useRouteStore.getState).mockReturnValue(mockSuccessState as any);
      vi.mocked(useShapeStore.getState).mockReturnValue(mockSuccessState as any);
      vi.mocked(useStopTimeStore.getState).mockReturnValue(mockSuccessState as any);
      vi.mocked(useTripStore.getState).mockReturnValue(mockSuccessState as any);

      const result = await manualRefreshService.refreshData();

      expect(result.success).toBe(false);
      expect(result.errors).toContain('stations: Refresh failed');
      expect(result.refreshedStores).toContain('vehicles');
      expect(result.refreshedStores).not.toContain('stations');
    });
  });
});