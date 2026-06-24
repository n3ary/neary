// VehicleService - Domain-focused service for vehicle tracking
// Returns raw vehicle data immediately; position predictions are applied
// asynchronously by the vehicle store's updatePredictions(routeIds) cycle.

import axios from 'axios';
import type { TranzyVehicleResponse } from '../types/rawTranzyApi.ts';
import type { EnhancedVehicleData } from '../utils/vehicle/vehicleEnhancementUtils.ts';
import { handleApiError, apiStatusTracker } from './error';
import { getApiConfig } from '../context/appContext';
import { API_CONFIG } from '../utils/core/constants';

export const vehicleService = {
  /**
   * Get vehicles with raw GPS data (no position prediction).
   * Returns immediately after API fetch — enhancement is deferred to
   * the prediction cycle in the vehicle store.
   */
  async getVehicles(): Promise<EnhancedVehicleData[]> {
    const rawVehicles = await this.getRawVehicles();

    // Map to EnhancedVehicleData shape without predictions
    return rawVehicles.map(vehicle => ({
      ...vehicle,
      apiLatitude: vehicle.latitude,
      apiLongitude: vehicle.longitude,
      apiSpeed: vehicle.speed,
      // No predictionMetadata — signals "not yet enhanced"
    })) as EnhancedVehicleData[];
  },

  /**
   * Get raw vehicles from API (internal method)
   * Use this only for debugging or when you specifically need original API data
   */
  async getRawVehicles(): Promise<TranzyVehicleResponse[]> {
    const startTime = Date.now();
    try {
      // Get API credentials from app context
      const { apiKey, agencyId } = getApiConfig();

      const response = await axios.get(`${API_CONFIG.BASE_URL}/vehicles`, {
        headers: {
          'X-API-Key': apiKey,
          'X-Agency-Id': agencyId.toString()
        },
        params: { _t: Date.now() } // Cache-bust Netlify edge CDN
      });
      
      // Validate response is JSON array, not HTML error page
      if (!Array.isArray(response.data)) {
        console.error('API returned non-array response:', typeof response.data, response.data);
        throw new Error('API returned invalid data format (expected array, got ' + typeof response.data + ')');
      }
      
      // Record successful API call
      const responseTime = Date.now() - startTime;
      apiStatusTracker.recordSuccess('fetch vehicles', responseTime);
      
      // Update status store if available
      if (typeof window !== 'undefined') {
        const { useStatusStore } = await import('../stores/statusStore');
        useStatusStore.getState().updateFromApiCall(true, responseTime, 'fetch vehicles');
      }
      
      return response.data;
    } catch (error) {
      handleApiError(error, 'fetch vehicles');
    }
  },

};