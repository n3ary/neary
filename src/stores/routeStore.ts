// RouteStore - Clean state management with raw API data
// Standardized with Zustand persist middleware for consistency

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { TranzyRouteResponse } from '../types/rawTranzyApi';
import { API_CACHE_DURATION } from '../utils/core/constants';
import { createRefreshMethod, createFreshnessChecker } from '../utils/core/storeUtils';

interface RouteStore {
  // Raw API data - no transformations
  routes: TranzyRouteResponse[];
  
  // Simple loading and error states
  loading: boolean;
  error: string | null;
  
  // Performance optimization: track last update time
  lastUpdated: number | null;
  
  // Separate API fetch timestamp for freshness checks
  lastApiFetch: number | null;
  
  // Actions
  loadRoutes: () => Promise<void>;
  refreshData: () => Promise<void>;
  clearRoutes: () => void;
  clearError: () => void;
  
  // Performance helper: check if data is fresh
  isDataFresh: (maxAgeMs?: number) => boolean;
}

// Create shared utilities for this store
const refreshMethod = createRefreshMethod(
  'route',
  'routes', 
  () => import('../services/routeService'),
  'getRoutes'
);
const freshnessChecker = createFreshnessChecker(API_CACHE_DURATION.STATIC_DATA);

export const useRouteStore = create<RouteStore>()(
  persist(
    (set, get) => ({
      // Raw API data
      routes: [],
      loading: false,
      error: null,
      lastUpdated: null,
      lastApiFetch: null,
      
      // Actions
      loadRoutes: async () => {
        // Performance optimization: avoid duplicate requests if already loading
        const currentState = get();
        if (currentState.loading) {
          return;
        }
        
        // Check if cached data is fresh
        if (currentState.routes.length > 0 && currentState.isDataFresh()) {
          return; // Use cached data
        }
        
        set({ loading: true, error: null });
        
        try {
          // Import service dynamically to avoid circular dependencies
          const { routeService } = await import('../services/routeService');
          const routes = await routeService.getRoutes();
          
          // Don't overwrite existing data with empty result (hash-match signal)
          if (routes.length === 0 && currentState.routes.length > 0) {
            set({ loading: false, error: null, lastUpdated: Date.now(), lastApiFetch: Date.now() });
          } else {
            set({ routes, loading: false, error: null, lastUpdated: Date.now() });
          }
        } catch (error) {
          set({ 
            loading: false, 
            error: error instanceof Error ? error.message : 'Failed to load routes'
          });
        }
      },
      
      refreshData: async () => {
        await refreshMethod(get, set);
      },
      
      clearRoutes: () => set({ routes: [], error: null, lastUpdated: null, lastApiFetch: null }),
      clearError: () => set({ error: null }),
      
      // Performance helper: check if data is fresh (default from constants)
      isDataFresh: (maxAgeMs = API_CACHE_DURATION.STATIC_DATA) => {
        return freshnessChecker(get, maxAgeMs);
      },
    }),
    {
      name: 'route-store',
      partialize: (state) => ({
        routes: state.routes,
        lastUpdated: state.lastUpdated,
        error: state.error
      }),
    }
  )
);