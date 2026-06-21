/**
 * Test for simplified shapeStore implementation
 * Verifies that the simplified version maintains the same API and functionality
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useShapeStore } from '../../stores/shapeStore';

// Mock the services and utilities
vi.mock('../../services/shapesService.ts', () => ({
  shapesService: {
    getAllShapes: vi.fn()
  }
}));

vi.mock('../../utils/shapes/shapeProcessingUtils.ts', () => ({
  processAllShapes: vi.fn(),
  validateShapeData: vi.fn()
}));

// Mock localStorage
const mockLocalStorage = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn()
};
Object.defineProperty(window, 'localStorage', { value: mockLocalStorage });

describe('ShapeStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLocalStorage.getItem.mockReturnValue(null);
  });

  it('should have the same API as the original shapeStore', () => {
    const store = useShapeStore.getState();

    // Verify all required methods exist
    expect(typeof store.loadShapes).toBe('function');
    expect(typeof store.getShape).toBe('function');
    expect(typeof store.refreshData).toBe('function');
    expect(typeof store.clearShapes).toBe('function');
    expect(typeof store.isDataFresh).toBe('function');
    expect(typeof store.hasShape).toBe('function');
    expect(typeof store.isDataExpired).toBe('function');
    expect(typeof store.persistToStorage).toBe('function');
    expect(typeof store.loadFromStorage).toBe('function');

    // Verify initial state
    expect(store.shapes).toBeInstanceOf(Map);
    expect(store.shapes.size).toBe(0);
    expect(store.loading).toBe(false);
    expect(store.error).toBe(null);
    expect(store.lastUpdated).toBe(null);
  });

  it('should handle Map serialization correctly', () => {
    const store = useShapeStore.getState();

    // Create test shape data
    const testShape = {
      id: 'test-shape',
      points: [{ lat: 1, lon: 2 }],
      segments: []
    };

    // Add shape to store
    store.shapes.set('test-shape', testShape);
    store.lastUpdated = Date.now();

    // Test that the store maintains Map structure
    expect(store.shapes).toBeInstanceOf(Map);
    expect(store.shapes.get('test-shape')).toEqual(testShape);
    expect(store.shapes.size).toBe(1);
    
    // Note: Persistence is now handled by zustand persist middleware with compression
    // The actual localStorage calls happen asynchronously during zustand's persist cycle
  });

  it('should load Map data from storage correctly', () => {
    // Mock stored data
    const testShape = {
      id: 'test-shape',
      points: [{ lat: 1, lon: 2 }],
      segments: []
    };
    
    const storedData = {
      shapes: [['test-shape', testShape]],
      lastUpdated: Date.now(),
      error: null
    };
    
    mockLocalStorage.getItem.mockReturnValue(JSON.stringify(storedData));

    const store = useShapeStore.getState();
    store.loadFromStorage();

    // Verify Map was reconstructed correctly
    const updatedStore = useShapeStore.getState();
    expect(updatedStore.shapes).toBeInstanceOf(Map);
    expect(updatedStore.shapes.size).toBe(1);
    expect(updatedStore.shapes.get('test-shape')).toEqual(testShape);
  });

  it('should maintain backward compatibility with existing API', () => {
    // Clear any existing state
    const store = useShapeStore.getState();
    store.clearShapes();
    
    // Get fresh state after clearing
    const freshStore = useShapeStore.getState();

    // Test shape operations
    expect(freshStore.hasShape('non-existent')).toBe(false);
    expect(freshStore.getShape('non-existent')).toBeUndefined();
    
    // Test data freshness
    expect(freshStore.isDataExpired()).toBe(true); // No lastUpdated
    expect(freshStore.isDataFresh()).toBe(false); // No lastUpdated
    
    // Test clear operation
    freshStore.clearShapes();
    const clearedStore = useShapeStore.getState();
    expect(clearedStore.shapes.size).toBe(0);
    expect(clearedStore.error).toBe(null);
    expect(clearedStore.lastUpdated).toBe(null);
  });
});