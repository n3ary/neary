// AgencyService - Domain-focused service for agency operations
// Primary source for agency list: static JSON from neary-gtfs releases branch
// Fallback: Tranzy API (requires API key)

import axios from 'axios';
import type { TranzyAgencyResponse } from '../types/rawTranzyApi.ts';
import { handleApiError, apiStatusTracker } from './error';
import { getApiConfig } from '../context/appContext';
import { API_CONFIG } from '../utils/core/constants';

const STATIC_AGENCY_URL = 'https://raw.githubusercontent.com/ciotlosm/neary-gtfs/releases/data/agency.json';

export const agencyService = {
  /**
   * Get all available agencies from the static source (no API key needed).
   * Falls back to Tranzy API if static source is unavailable.
   */
  async getAgencies(): Promise<TranzyAgencyResponse[]> {
    // Try static source first (no API key required)
    try {
      const agencies = await agencyService.getAgenciesFromStatic();
      if (agencies.length > 0) return agencies;
    } catch (err) {
      console.warn('[AgencyService] Static source failed, trying API:', err);
    }

    // Fallback: Tranzy API
    const startTime = Date.now();
    try {
      const { apiKey } = getApiConfig();

      const response = await axios.get(`${API_CONFIG.BASE_URL}/agency`, {
        headers: {
          'X-API-Key': apiKey
        }
      });
      
      const responseTime = Date.now() - startTime;
      apiStatusTracker.recordSuccess('fetch agencies', responseTime);
      
      if (typeof window !== 'undefined') {
        const { useStatusStore } = await import('../stores/statusStore');
        useStatusStore.getState().updateFromApiCall(true, responseTime, 'fetch agencies');
      }
      
      return response.data;
    } catch (error) {
      handleApiError(error, 'fetch agencies');
    }
  },

  /**
   * Fetch agencies from the static GitHub source.
   * No API key required — available to all users.
   */
  async getAgenciesFromStatic(): Promise<TranzyAgencyResponse[]> {
    const res = await fetch(STATIC_AGENCY_URL, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Static agencies: HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('Invalid agency data format');
    return data;
  },

  /**
   * Validate API key by calling the agency endpoint
   * @param apiKey - API key to validate
   * @returns Agency list on success
   * @throws Error on validation failure
   */
  async validateApiKey(apiKey: string): Promise<TranzyAgencyResponse[]> {
    try {
      const response = await axios.get(`${API_CONFIG.BASE_URL}/agency`, {
        headers: {
          'X-API-Key': apiKey
        }
      });
      
      return response.data;
    } catch (error) {
      handleApiError(error, 'validate API key');
    }
  }
};