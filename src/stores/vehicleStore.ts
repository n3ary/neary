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
        
        // Skip if no API key configured (schedule-only mode)
        const { useConfigStore } = await import('./configStore');
        if (!useConfigStore.getState().apiKey) {
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
          // Get cached data from stores
          const { useTripStore } = await import('./tripStore');
          const { useStationStore } = await import('./stationStore');
          const { useShapeStore } = await import('./shapeStore');
          const { useStopTimeStore } = await import('./stopTimeStore');
          
          const tripStore = useTripStore.getState();
          const stationStore = useStationStore.getState();
          const shapeStore = useShapeStore.getState();
          const stopTimeStore = useStopTimeStore.getState();
          
          if (tripStore.trips.length === 0 || stationStore.stops.length === 0) {
            return;
          }
          
          // Build lookup structures ONCE (reuse across vehicles)
          const stopTimesByTrip = new Map<string, any[]>();
          for (const st of stopTimeStore.stopTimes) {
            if (!stopTimesByTrip.has(st.trip_id)) stopTimesByTrip.set(st.trip_id, []);
            stopTimesByTrip.get(st.trip_id)!.push(st);
          }
          
          const tripByTripId = new Map(tripStore.trips.map(t => [t.trip_id, t]));
          
          // Build route shapes only for vehicles that have a matching trip+shape
          let routeShapes: Map<string, any> | undefined;
          if (shapeStore.shapes.size > 0) {
            routeShapes = new Map();
            for (const vehicle of currentState.vehicles) {
              if (vehicle.trip_id && !routeShapes.has(vehicle.trip_id)) {
                const trip = tripByTripId.get(vehicle.trip_id);
                if (trip?.shape_id) {
                  const shape = shapeStore.shapes.get(trip.shape_id);
                  if (shape) routeShapes.set(vehicle.trip_id, shape);
                }
              }
            }
          }

          const stops = stationStore.stops;
          
          // Re-enhance with current timestamp
          const { enhanceVehicles } = await import('../utils/vehicle/vehicleEnhancementUtils');
          const originalVehicles = currentState.vehicles.map(v => ({
            ...v,
            latitude: v.apiLatitude,
            longitude: v.apiLongitude,
          }));
          
          const updatedVehicles = enhanceVehicles(originalVehicles, {
            routeShapes,
            stopTimesByTrip,
            stops
          });
          
          set({ 
            vehicles: updatedVehicles,
            error: null,
            lastUpdated: Date.now()
          });
          
          console.log(`[VehicleStore] Updated predictions for ${updatedVehicles.length} vehicles using cached data at ${new Date().toLocaleTimeString()}`);
        } catch (error) {
          console.warn('Failed to update predictions:', error);
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