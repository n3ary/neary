/**
 * Shape Store - Centralized state management for route shape data
 * Uses shared utilities for consistency while maintaining compression for 5MB+ data
 * Simplified initialization with standardized retry logic
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { RouteShape } from '../types/arrivalTime.ts';
import { API_CACHE_DURATION } from '../utils/core/constants.ts';
import { createCompressedStorage } from '../utils/core/compressedStorage.ts';
import { 
  createRefreshMethod, 
  createFreshnessChecker 
} from '../utils/core/storeUtils.ts';

interface ShapeStore {
  // Core state - Map for O(1) shape lookups by shape_id
  shapes: Map<string, RouteShape>;
  
  // Simple loading and error states
  loading: boolean;
  error: string | null;
  
  // Performance optimization: track last update time
  lastUpdated: number | null;
  
  // Separate API fetch timestamp for freshness checks
  lastApiFetch: number | null;
  
  // Actions
  loadShapes: () => Promise<void>;
  getShape: (shapeId: string) => RouteShape | undefined;
  refreshData: () => Promise<void>;
  clearShapes: () => void;
  
  // Utilities
  isDataFresh: (maxAgeMs?: number) => boolean;
  hasShape: (shapeId: string) => boolean;
  isDataExpired: () => boolean;
  
  // Local storage integration
  persistToStorage: () => void;
  loadFromStorage: () => void;
}

// Create shared utilities for this store
// Note: Storage methods need custom compression handling for 5MB+ data
const refreshMethod = createRefreshMethod(
  'shapes',
  'shapes',
  () => import('../services/shapesService.ts'),
  'getAllShapes',
  {
    // Shapes are a large payload (~14 MB uncompressed). Reduce retries to avoid
    // hammering the API on slow connections, and use a longer delay between
    // attempts so the network has time to recover.
    useRetry: true,
    retryConfig: { maxAttempts: 2, baseDelay: 3000, maxDelay: 10000, backoffMultiplier: 2 },
    processData: async (rawShapes: any) => {
      try {
        const { processAllShapes, validateShapeData } = await import('../utils/shapes/shapeProcessingUtils.ts');
        const validatedShapes = validateShapeData(rawShapes);
        const processedShapes = processAllShapes(validatedShapes);
        console.log(`[ShapeStore] Processed ${processedShapes.size} shapes`);
        return processedShapes;
      } catch (error) {
        console.error('[ShapeStore] Error processing shapes:', error);
        throw error;
      }
    }
  }
);

const freshnessChecker = createFreshnessChecker(API_CACHE_DURATION.STATIC_DATA);

export const useShapeStore = create<ShapeStore>()(
  persist(
    (set, get) => ({
  // Core state
  shapes: new Map<string, RouteShape>(),
  loading: false,
  error: null,
  lastUpdated: null,
  lastApiFetch: null,
  
  // Actions
  loadShapes: async () => {
    const currentState = get();
    
    // Performance optimization: avoid duplicate requests if already loading
    if (currentState.loading) {
      return;
    }
    
    // Check if cached data is fresh
    if (currentState.shapes.size > 0 && currentState.isDataFresh()) {
      return; // Use cached data
    }
    
    // Need to fetch fresh data
    await get().refreshData();
  },
  
  getShape: (shapeId: string) => {
    const { shapes } = get();
    return shapes.get(shapeId);
  },
  
  refreshData: async () => {
    // Use standardized refresh method (retry and cached data handling enabled by default)
    await refreshMethod(get, set);
  },
  
  clearShapes: () => {
    set({
      shapes: new Map<string, RouteShape>(),
      error: null,
      lastUpdated: null,
      lastApiFetch: null
    });
  },
  
  // Utilities
  isDataFresh: (maxAgeMs = API_CACHE_DURATION.STATIC_DATA) => {
    return freshnessChecker(get, maxAgeMs);
  },
  
  hasShape: (shapeId: string) => {
    const { shapes } = get();
    return shapes.has(shapeId);
  },
  
  isDataExpired: () => {
    const { lastUpdated } = get();
    if (!lastUpdated) return true;
    return (Date.now() - lastUpdated) >= API_CACHE_DURATION.STATIC_DATA;
  },
  
  // Local storage integration methods (handled by persist middleware)
  persistToStorage: () => {
    // Persistence with compression is handled automatically by zustand persist middleware
  },
  
  loadFromStorage: () => {
    // Loading with decompression is handled automatically by zustand persist middleware
  },
}),
{
  name: 'shape-store',
  
  // Persist to localStorage with gzip compression via the shared adapter
  // (issue #29). The shapes Map is serialized to entries in `partialize` and
  // reconstructed in `merge`; the adapter transparently (de)compresses and
  // reads legacy uncompressed/`gzip:`-prefixed values.
  storage: createJSONStorage(() => createCompressedStorage('[ShapeStore]')),

  partialize: (state) => ({
    shapes: Array.from(state.shapes.entries()),
    lastUpdated: state.lastUpdated,
    lastApiFetch: state.lastApiFetch,
  }),

  merge: (persistedState, currentState) => {
    const persisted = persistedState as
      | Partial<{
          shapes: Array<[string, RouteShape]>;
          lastUpdated: number | null;
          lastApiFetch: number | null;
        }>
      | undefined;
    return {
      ...currentState,
      shapes: persisted?.shapes ? new Map(persisted.shapes) : currentState.shapes,
      lastUpdated: persisted?.lastUpdated ?? null,
      lastApiFetch: persisted?.lastApiFetch ?? null,
    };
  },
}
));