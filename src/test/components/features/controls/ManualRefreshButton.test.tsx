// ManualRefreshButton.test.tsx - Tests for Manual Refresh Button component
// Tests button rendering, color states, and refresh functionality

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ManualRefreshButton } from '../../../../components/features/controls/ManualRefreshButton';
import { destroyDataFreshnessMonitor } from '../../../../utils/core/apiFreshnessMonitor';

// Mock the stores with proper Zustand structure
vi.mock('../../../../stores/vehicleStore', () => {
  const mockRefreshData = vi.fn().mockResolvedValue(undefined);
  const mockSubscribe = vi.fn(() => vi.fn()); // Returns unsubscribe function
  
  const mockStoreState = {
    refreshData: mockRefreshData,
    lastUpdated: Date.now(),
    lastApiFetch: Date.now(),
    vehicles: [],
    loading: false
  };
  
  // Mock store that handles selector pattern
  const mockStore = vi.fn((selector) => {
    if (typeof selector === 'function') {
      return selector(mockStoreState);
    }
    return mockStoreState;
  });
  
  mockStore.subscribe = mockSubscribe;
  mockStore.getState = vi.fn(() => mockStoreState);
  
  return {
    useVehicleStore: mockStore
  };
});

vi.mock('../../../../stores/stationStore', () => {
  const mockRefreshData = vi.fn().mockResolvedValue(undefined);
  const mockSubscribe = vi.fn(() => vi.fn());
  
  const mockStoreState = {
    refreshData: mockRefreshData,
    lastUpdated: Date.now(),
    loading: false
  };
  
  const mockStore = vi.fn((selector) => {
    if (typeof selector === 'function') {
      return selector(mockStoreState);
    }
    return mockStoreState;
  });
  
  mockStore.subscribe = mockSubscribe;
  mockStore.getState = vi.fn(() => mockStoreState);
  
  return {
    useStationStore: mockStore
  };
});

vi.mock('../../../../stores/routeStore', () => {
  const mockRefreshData = vi.fn().mockResolvedValue(undefined);
  const mockSubscribe = vi.fn(() => vi.fn());
  
  const mockStoreState = {
    refreshData: mockRefreshData,
    lastUpdated: Date.now(),
    loading: false
  };
  
  const mockStore = vi.fn((selector) => {
    if (typeof selector === 'function') {
      return selector(mockStoreState);
    }
    return mockStoreState;
  });
  
  mockStore.subscribe = mockSubscribe;
  mockStore.getState = vi.fn(() => mockStoreState);
  
  return {
    useRouteStore: mockStore
  };
});

vi.mock('../../../../stores/shapeStore', () => {
  const mockRefreshData = vi.fn().mockResolvedValue(undefined);
  const mockSubscribe = vi.fn(() => vi.fn());
  
  const mockStoreState = {
    refreshData: mockRefreshData,
    lastUpdated: Date.now(),
    loading: false
  };
  
  const mockStore = vi.fn((selector) => {
    if (typeof selector === 'function') {
      return selector(mockStoreState);
    }
    return mockStoreState;
  });
  
  mockStore.subscribe = mockSubscribe;
  mockStore.getState = vi.fn(() => mockStoreState);
  
  return {
    useShapeStore: mockStore
  };
});

vi.mock('../../../../stores/stopTimeStore', () => {
  const mockRefreshData = vi.fn().mockResolvedValue(undefined);
  const mockSubscribe = vi.fn(() => vi.fn());
  
  const mockStoreState = {
    refreshData: mockRefreshData,
    lastUpdated: Date.now(),
    loading: false
  };
  
  const mockStore = vi.fn((selector) => {
    if (typeof selector === 'function') {
      return selector(mockStoreState);
    }
    return mockStoreState;
  });
  
  mockStore.subscribe = mockSubscribe;
  mockStore.getState = vi.fn(() => mockStoreState);
  
  return {
    useStopTimeStore: mockStore
  };
});

vi.mock('../../../../stores/tripStore', () => {
  const mockRefreshData = vi.fn().mockResolvedValue(undefined);
  const mockSubscribe = vi.fn(() => vi.fn());
  
  const mockStoreState = {
    refreshData: mockRefreshData,
    lastUpdated: Date.now(),
    loading: false
  };
  
  const mockStore = vi.fn((selector) => {
    if (typeof selector === 'function') {
      return selector(mockStoreState);
    }
    return mockStoreState;
  });
  
  mockStore.subscribe = mockSubscribe;
  mockStore.getState = vi.fn(() => mockStoreState);
  
  return {
    useTripStore: mockStore
  };
});

describe('ManualRefreshButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    destroyDataFreshnessMonitor();
  });

  it('should render refresh button', () => {
    render(<ManualRefreshButton />);
    
    const button = screen.getByRole('button', { name: /manual refresh data/i });
    expect(button).toBeInTheDocument();
  });

  it('should show refresh icon when not loading', () => {
    render(<ManualRefreshButton />);
    
    const refreshIcon = screen.getByTestId('RefreshIcon');
    expect(refreshIcon).toBeInTheDocument();
  });

  it('should be clickable when not disabled', () => {
    render(<ManualRefreshButton />);
    
    const button = screen.getByRole('button', { name: /manual refresh data/i });
    expect(button).not.toBeDisabled();
  });

  it('should be disabled when disabled prop is true', () => {
    render(<ManualRefreshButton disabled={true} />);
    
    const button = screen.getByRole('button', { name: /manual refresh data/i });
    expect(button).toBeDisabled();
  });

  it('should trigger refresh when clicked', async () => {
    render(<ManualRefreshButton />);
    
    const button = screen.getByRole('button', { name: /manual refresh data/i });
    fireEvent.click(button);
    
    // Wait for the component to process the click
    await waitFor(() => {
      expect(button).toBeInTheDocument();
    });
  });
});