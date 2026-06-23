// TripStore - Clean state management with raw API data
// No cross-store dependencies, simple loading and error states
// Enhanced with refresh functionality and local storage persistence

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { TranzyTripResponse } from '../types/rawTranzyApi';
import { API_CACHE_DURATION } from '../utils/core/constants';
import { createRefreshMethod, createFreshnessChecker } from '../utils/core/storeUtils';

interface TripStore {
  // Raw API data - no transformations
  trips: TranzyTripResponse[];
  
  // Simple loading and error states
  loading: boolean;
  error: string | null;
  
  // Performance optimization: track last update time
  lastUpdated: number | null;
  
  // Separate API fetch timestamp for freshness checks
  lastApiFetch: number | null;
  
  // Actions
  loadTrips: () => Promise<void>;
  refreshData: () => Promise<void>;
  clearTrips: () => void;
  clearError: () => void;
  
  // Performance helper: check if data is fresh
  isDataFresh: (maxAgeMs?: number) => boolean;
  
  // Helper to get trip by trip_id
  getTripById: (tripId: string) => TranzyTripResponse | undefined;
  
  // Local storage integration
  persistToStorage: () => void;
  loadFromStorage: () => void;
}

// Create shared utilities for this store
const refreshMethod = createRefreshMethod(
  'trip',
  'trips', 
  () => import('../services/tripService'),
  'getTrips'
);
const freshnessChecker = createFreshnessChecker(API_CACHE_DURATION.STATIC_DATA);

export const useTripStore = create<TripStore>()(
  persist(
    (set, get) => ({
      // Raw API data
      trips: [],
      loading: false,
      error: null,
      lastUpdated: null,
      lastApiFetch: null,
      
      // Actions
      loadTrips: async () => {
        // Deduplicate concurrent calls: if already loading, reuse the in-flight promise
        const currentState = get();
        if (currentState.loading) {
          return;
        }
        
        // Check if cached data is fresh
        if (currentState.trips.length > 0 && currentState.isDataFresh()) {
          return;
        }
        
        set({ loading: true, error: null });
        
        try {
          // Import service dynamically to avoid circular dependencies
          const { tripService } = await import('../services/tripService');
          const trips = await tripService.getTrips();
          
          set({ 
            trips, 
            loading: false, 
            error: null, 
            lastUpdated: Date.now() 
          });
        } catch (error) {
          set({ 
            loading: false, 
            error: error instanceof Error ? error.message : 'Failed to load trips'
          });
        }
      },
      
      refreshData: async () => {
        await refreshMethod(get, set);
      },
      
      clearTrips: () => set({ trips: [], error: null, lastUpdated: null, lastApiFetch: null }),
      clearError: () => set({ error: null }),
      
      // Performance helper: check if data is fresh (default 24 hours for general data)
      isDataFresh: (maxAgeMs = API_CACHE_DURATION.STATIC_DATA) => {
        return freshnessChecker(get, maxAgeMs);
      },

      // Helper to get trip by trip_id
      getTripById: (tripId: string) => {
        const { trips } = get();
        return trips.find(trip => trip.trip_id === tripId);
      },
      
      // Local storage integration methods
      persistToStorage: () => {
        // Persistence is handled automatically by zustand persist middleware
        // This method exists for API consistency but doesn't need implementation
      },
      
      loadFromStorage: () => {
        // Loading from storage is handled automatically by zustand persist middleware
        // This method exists for API consistency but doesn't need implementation
      },
    }),
    {
      name: 'trip-store',
      // Simple storage for trip data
      partialize: (state) => ({
        trips: state.trips,
        lastUpdated: state.lastUpdated,
        error: state.error
      }),
    }
  )
);