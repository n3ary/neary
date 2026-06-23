/**
 * Station Filtering Hook
 * Main hook for location-based station filtering with favorites integration and vehicle data
 * Shows all stations within proximity of the closest station
 */

import { useState, useCallback, useEffect } from 'react';
import { useLocationStore } from '../stores/locationStore';
import { useStationStore } from '../stores/stationStore';
import { useStopTimeStore } from '../stores/stopTimeStore';
import { useTripStore } from '../stores/tripStore';
import { useVehicleStore } from '../stores/vehicleStore';
import { useRouteStore } from '../stores/routeStore';
import { useScheduleStore } from '../stores/scheduleStore';
import { useStationCacheStore } from '../stores/stationCacheStore';
import { calculateDistance } from '../utils/location/distanceUtils';
import { LOCATION_CONFIG } from '../utils/core/constants';
import { 
  formatDistance,
  getStationTypeColor,
  getStationTypeLabel
} from '../utils/station/stationDisplayUtils';
import {
  filterStations
} from '../utils/station/stationFilterStrategies';
import { buildTripRouteMap } from '../utils/schedule/scheduleVehicleIntegration';
import { SECONDARY_STATION_THRESHOLD } from '../types/stationFilter';
import type { FilteredStation } from '../types/stationFilter';

interface StationFilterResult {
  filteredStations: FilteredStation[];
  loading: boolean;
  processing: boolean; // NEW: Track when filtering is actively running
  error: string | null;
  retryFiltering: () => void;
  utilities: {
    formatDistance: typeof formatDistance;
    getStationTypeColor: typeof getStationTypeColor;
    getStationTypeLabel: typeof getStationTypeLabel;
  };
}

export function useStationFilter(): StationFilterResult {
  // Use selectors to prevent re-renders when unrelated store properties change
  const currentPosition = useLocationStore(state => state.currentPosition);
  const locationLoading = useLocationStore(state => state.loading);
  const locationError = useLocationStore(state => state.error);
  
  const stops = useStationStore(state => state.stops);
  const stationLoading = useStationStore(state => state.loading);
  const stationError = useStationStore(state => state.error);
  
  const stopTimes = useStopTimeStore(state => state.stopTimes);
  const stopTimeLoading = useStopTimeStore(state => state.loading);
  const stopTimeError = useStopTimeStore(state => state.error);
  const loadStopTimes = useStopTimeStore(state => state.loadStopTimes);
  
  const trips = useTripStore(state => state.trips);
  const tripLoading = useTripStore(state => state.loading);
  const tripError = useTripStore(state => state.error);
  const loadTrips = useTripStore(state => state.loadTrips);
  
  const vehicles = useVehicleStore(state => state.vehicles);
  const vehicleLoading = useVehicleStore(state => state.loading);
  const vehicleError = useVehicleStore(state => state.error);
  const loadVehicles = useVehicleStore(state => state.loadVehicles);
  
  const allRoutes = useRouteStore(state => state.routes);
  const routeLoading = useRouteStore(state => state.loading);
  const routeError = useRouteStore(state => state.error);
  const loadRoutes = useRouteStore(state => state.loadRoutes);

  // Schedule data for synthesized scheduled departures (Req 6, 12). Optional —
  // when absent the filter runs in pure GPS-only mode.
  const scheduleData = useScheduleStore(state => state.scheduleData);
  const activeServiceIds = useScheduleStore(state => state.activeServiceIds);
  const loadSchedule = useScheduleStore(state => state.loadSchedule);
  const ensureActiveServicesForToday = useScheduleStore(state => state.ensureActiveServicesForToday);
  
  // Auto-load stop times, vehicles, and routes when hook is used
  useEffect(() => {
    const loadData = async () => {
      // Get API credentials from app context for stores that haven't been updated yet
      const { isContextReady, getApiConfig } = await import('../context/appContext');
      
      if (!isContextReady()) {
        // Context not ready yet, skip loading
        return;
      }
      
      const { apiKey, agencyId } = getApiConfig();
      
      // Load stop times if not already loaded (stop time store updated to use context)
      if (stopTimes.length === 0 && !stopTimeLoading && !stopTimeError) {
        loadStopTimes();
      }
      
      // Load trips if not already loaded (for headsign data)
      if (trips.length === 0 && !tripLoading && !tripError) {
        loadTrips();
      }
      
      // Load vehicles if not already loaded (consistent with other stores)
      if (vehicles.length === 0 && !vehicleLoading && !vehicleError) {
        loadVehicles();
      }
      
      // Load routes if not already loaded (route store updated to use context)
      if (allRoutes.length === 0 && !routeLoading && !routeError) {
        loadRoutes();
      }

      // Load schedule data (additive; safe no-op when already fresh/cached).
      loadSchedule();
    };
    
    loadData();
  }, [stopTimes.length, trips.length, stopTimeLoading, tripLoading, stopTimeError, tripError, loadStopTimes, loadTrips, vehicles.length, vehicleLoading, vehicleError, loadVehicles, allRoutes.length, routeLoading, routeError, loadRoutes, loadSchedule]);
  
  // Use Zustand store for cache (persists across unmounts)
  const { get: getCachedStations, set: setCachedStations } = useStationCacheStore();
  
  // Generate cache key from location (rounded to 3 decimals = ~100m precision)
  const getCacheKey = useCallback((position: GeolocationPosition | null): string | null => {
    if (!position) return null;
    const lat = position.coords.latitude.toFixed(3);
    const lon = position.coords.longitude.toFixed(3);
    return `${lat},${lon}`;
  }, []);
  
  // Initialize filtered stations from cache if available
  const initialFilteredStations = useCallback(() => {
    const cacheKey = getCacheKey(currentPosition);
    if (cacheKey) {
      const cached = getCachedStations(cacheKey);
      if (cached) {
        return cached;
      }
    }
    return [];
  }, [currentPosition, getCacheKey, getCachedStations]);
  
  const [filteredStations, setFilteredStations] = useState<FilteredStation[]>(initialFilteredStations);
  const [lastFilterPosition, setLastFilterPosition] = useState<GeolocationPosition | null>(null);
  const [processing, setProcessing] = useState(false);
  
  // Extract coordinates to use as dependencies (prevents re-runs when position object reference changes but coords are same)
  const currentLat = currentPosition?.coords.latitude;
  const currentLon = currentPosition?.coords.longitude;
  
  // Helper function to check if location change is significant enough to re-filter
  const shouldRefilter = useCallback((newPosition: GeolocationPosition | null, lastPosition: GeolocationPosition | null): boolean => {
    if (!newPosition) return false;
    if (!lastPosition) return true;
    
    // Use existing distance utility instead of duplicating calculation
    const distance = calculateDistance(
      { lat: lastPosition.coords.latitude, lon: lastPosition.coords.longitude },
      { lat: newPosition.coords.latitude, lon: newPosition.coords.longitude }
    );
    
    // Use constant from configuration
    return distance > LOCATION_CONFIG.REFILTER_DISTANCE_THRESHOLD;
  }, []);
  
  // Async filtering effect with 100ms debounce - batch rapid updates
  useEffect(() => {
    const filterAsync = async () => {
      // Early return if no stations available
      if (stops.length === 0) {
        setFilteredStations([]);
        setProcessing(false);
        return;
      }

      // Wait for trips to be loaded before filtering to avoid fallback calculations.
      // BUT: if we have stops (from persistence), proceed anyway — trips are nice-to-have
      // for headsign data, not a hard gate. This prevents blocking the first paint while
      // the trip API call takes 5-7 seconds.
      if (stops.length === 0) {
        setFilteredStations([]);
        setProcessing(false);
        return;
      }

      // Check if we should re-filter based on location change OR if we have no filtered stations yet
      // Always re-filter when vehicles/stops/trips data changes (dependencies trigger this effect)
      const hasLocationChanged = shouldRefilter(currentPosition, lastFilterPosition);
      const hasNoResults = filteredStations.length === 0;
      
      // Check cache for this location
      const cacheKey = getCacheKey(currentPosition);
      const cachedStations = cacheKey ? getCachedStations(cacheKey) : null;
      
      if (cachedStations && !hasLocationChanged && lastFilterPosition !== null) {
        // Location hasn't changed — use cached station list for instant display
        // but still run the full filter to recalculate arrival times with
        // updated vehicle positions (predictions update every 15s)
        setFilteredStations(cachedStations);
      }

      setProcessing(true);
      try {
        let result: FilteredStation[];
        
        // Always use proximity filtering - need location
        if (!currentPosition) {
          result = []; // No location available for proximity filtering
        } else {
          // Ensure active services reflect the current day before synthesizing
          // scheduled departures (handles midnight crossings).
          ensureActiveServicesForToday();
          // Show all stations within proximity of the closest station (unlimited results)
          result = await filterStations(
            stops,
            currentPosition,
            stopTimes,
            vehicles,
            allRoutes,
            1, // Enable proximity filtering
            SECONDARY_STATION_THRESHOLD,
            trips,
            {
              scheduleData,
              tripRouteMap: buildTripRouteMap(trips),
              activeServiceIds,
              tranzyTrips: trips,
            }
          );
        }
        
        setFilteredStations(result);
        setLastFilterPosition(currentPosition); // Update last filter position
        
        // Update cache
        if (cacheKey && result.length > 0) {
          setCachedStations(cacheKey, result);
        }
      } catch (error) {
        console.error('Error filtering stations:', error);
        setFilteredStations([]);
      } finally {
        setProcessing(false);
      }
    };

    // Debounce filter execution by 100ms to batch rapid updates
    const timeoutId = setTimeout(() => {
      filterAsync();
    }, 100);

    return () => clearTimeout(timeoutId);
  }, [stops, stopTimes, trips, vehicles, allRoutes, scheduleData, activeServiceIds, ensureActiveServicesForToday, currentLat, currentLon, shouldRefilter, lastFilterPosition, filteredStations.length, tripError]);
  
  const retryFiltering = useCallback(() => {
    // Force re-filtering by clearing last position
    setLastFilterPosition(null);
  }, []);
  
  const loadingState = (
    (locationLoading && filteredStations.length === 0) || 
    (stationLoading && stops.length === 0) || 
    (tripLoading && trips.length === 0) || 
    (stopTimeLoading && stopTimes.length === 0) ||
    (routeLoading && allRoutes.length === 0)
  );

  return {
    filteredStations,
    // Only show loading for initial data loads when we have no data
    // Don't show loading during background refreshes when we already have cached data
    loading: loadingState,
    processing, // NEW: Track when filtering is actively running
    error: locationError || stationError || tripError || vehicleError || routeError,
    retryFiltering,
    // Utility functions for UI formatting
    utilities: {
      formatDistance,
      getStationTypeColor,
      getStationTypeLabel
    }
  };
}