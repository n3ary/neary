// VehicleStore - Clean state management for enhanced vehicles
// Always stores enhanced vehicles with position predictions
// Enhancement happens at service layer, store handles data management

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { EnhancedVehicleData } from '../utils/vehicle/vehicleEnhancementUtils';
import { API_CACHE_DURATION, API_DATA_STALENESS_THRESHOLDS } from '../utils/core/constants';
import { createCompressedStorage } from '../utils/core/compressedStorage';
import { createRefreshMethod, createFreshnessChecker } from '../utils/core/storeUtils';

interface VehicleStore {
  // Always stores enhanced vehicles (service handles enhancement)
  vehicles: EnhancedVehicleData[];
  
  // Simple loading and error states
  loading: boolean;
  error: string | null;
  
  // Performance optimization: track last update time
  lastUpdated: number | null;
  
  // Separate API fetch timestamp for debugging (when lastUpdated gets overridden by predictions)
  lastApiFetch: number | null;
  
  // Actions
  loadVehicles: () => Promise<void>;
  refreshData: () => Promise<void>;
  updatePredictions: () => Promise<void>;
  clearVehicles: () => void;
  clearError: () => void;
  
  // Performance helper: check if data is fresh
  isDataFresh: (maxAgeMs?: number) => boolean;
}

// Create shared utilities for this store
const refreshMethod = createRefreshMethod(
  'vehicle',
  'vehicles', 
  () => import('../services/vehicleService'),
  'getVehicles'
);
const freshnessChecker = createFreshnessChecker(API_CACHE_DURATION.VEHICLES);

export const useVehicleStore = create<VehicleStore>()(
  persist(
    (set, get) => ({
      // Always stores enhanced vehicles (service provides enhancement)
      vehicles: [],
      
      // Simple states
      loading: false,
      error: null,
      lastUpdated: null,
      lastApiFetch: null,
      
      // Actions
      loadVehicles: async () => {
        // Performance optimization: avoid duplicate requests if already loading
        const currentState = get();
        if (currentState.loading) {
          return;
        }
        
        // Check if cached data is fresh using API fetch timestamp
        if (currentState.vehicles.length > 0 && currentState.isDataFresh()) {
          return; // Use cached data
        }
        
        set({ loading: true, error: null });
        
        try {
          // Service handles enhancement, store just manages the data
          const { vehicleService } = await import('../services/vehicleService');
          const vehicles = await vehicleService.getVehicles(); // Service returns enhanced vehicles
          
          const now = Date.now();
          set({ 
            vehicles, 
            loading: false, 
            error: null, 
            lastUpdated: now,      // For component subscriptions
            lastApiFetch: now      // For API freshness checks
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to load vehicles';
          set({ loading: false, error: errorMessage });
          console.error('Error loading vehicles:', error);
        }
      },
      
      refreshData: async () => {
        await refreshMethod(get, set);
      },
      
      updatePredictions: async () => {
        const currentState = get();
        
        // Only update if we have vehicles and they're not too old
        if (currentState.vehicles.length === 0) {
          return;
        }
        
        // Don't update predictions if data is too stale (over 5 minutes)
        const maxStaleTime = API_DATA_STALENESS_THRESHOLDS.VEHICLES;
        if (currentState.lastUpdated && (Date.now() - currentState.lastUpdated) > maxStaleTime) {
          return;
        }
        
        try {
          // Get the original API data from enhanced vehicles
          const originalVehicles = currentState.vehicles.map(vehicle => ({
            ...vehicle,
            // Restore original API coordinates for re-enhancement
            latitude: vehicle.apiLatitude,
            longitude: vehicle.apiLongitude
          }));
          
          // Get cached data from stores instead of making API calls
          const { useTripStore } = await import('./tripStore');
          const { useStationStore } = await import('./stationStore');
          const { useShapeStore } = await import('./shapeStore');
          const { useStopTimeStore } = await import('./stopTimeStore');
          
          const tripStore = useTripStore.getState();
          const stationStore = useStationStore.getState();
          const shapeStore = useShapeStore.getState();
          const stopTimeStore = useStopTimeStore.getState();
          
          // Use cached data if available, otherwise skip prediction update
          if (tripStore.trips.length === 0 || stationStore.stops.length === 0) {
            console.log('[VehicleStore] Skipping prediction update - missing cached trip/station data');
            return;
          }
          
          // Build route shapes from cached data
          let routeShapes: Map<string, any> | undefined;
          if (shapeStore.shapes.size > 0) {
            routeShapes = new Map();
            
            // Create mapping from trip_id to route shape
            for (const vehicle of originalVehicles) {
              if (vehicle.trip_id) {
                const trip = tripStore.trips.find(t => t.trip_id === vehicle.trip_id);
                if (trip && trip.shape_id) {
                  const shape = shapeStore.shapes.get(trip.shape_id);
                  if (shape) {
                    // Use the existing RouteShape directly
                    routeShapes.set(vehicle.trip_id, shape);
                  }
                }
              }
            }
          }
          
          // Build stop times by trip from cached data
          const stopTimesByTrip = new Map();
          if (stopTimeStore.stopTimes.length > 0) {
            for (const stopTime of stopTimeStore.stopTimes) {
              if (!stopTimesByTrip.has(stopTime.trip_id)) {
                stopTimesByTrip.set(stopTime.trip_id, []);
              }
              stopTimesByTrip.get(stopTime.trip_id).push(stopTime);
            }
          }
          
          // Use cached stops
          const stops = stationStore.stops;
          
          // Re-enhance with current timestamp using cached data
          const { enhanceVehicles } = await import('../utils/vehicle/vehicleEnhancementUtils');
          const updatedVehicles = enhanceVehicles(originalVehicles, {
            routeShapes,
            stopTimesByTrip,
            stops
          });
          
          // Update store with new predictions and update lastUpdated for component subscriptions
          set({ 
            vehicles: updatedVehicles,
            error: null,
            lastUpdated: Date.now() // Components subscribe to this for prediction updates
            // NOTE: lastApiFetch is NOT updated - this is not an API call
          });
          
          console.log(`[VehicleStore] Updated predictions for ${updatedVehicles.length} vehicles using cached data at ${new Date().toLocaleTimeString()}`);
        } catch (error) {
          console.warn('Failed to update predictions:', error);
          // Don't set error state for prediction updates - they're non-critical
        }
      },
      
      clearVehicles: () => set({ 
        vehicles: [], 
        error: null, 
        lastUpdated: null,
        lastApiFetch: null
      }),
      clearError: () => set({ error: null }),
      
      // Performance helper: check if data is fresh
      isDataFresh: (maxAgeMs = API_CACHE_DURATION.VEHICLES) => {
        return freshnessChecker(get, maxAgeMs);
      },
    }),
    {
      name: 'vehicle-store',
      storage: createJSONStorage(() => createCompressedStorage('[VehicleStore]')),
      partialize: (state) => ({
        vehicles: state.vehicles,
        lastUpdated: state.lastUpdated,
        lastApiFetch: state.lastApiFetch,
        error: state.error
      }),
    }
  )
);