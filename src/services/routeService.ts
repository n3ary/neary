// RouteService — routes from static neary-gtfs source + API key validation

import type { TranzyRouteResponse } from '../types/rawTranzyApi.ts';
import { getApiConfig } from '../context/appContext';
import { staticDataService } from './staticDataService';
import { API_CONFIG } from '../utils/core/constants';

export const routeService = {
  /**
   * Get routes from static source. Returns data if hash changed,
   * null if unchanged (store keeps its localStorage cache).
   */
  async getRoutes(): Promise<TranzyRouteResponse[]> {
    const { agencyId } = getApiConfig();
    const data = await staticDataService.fetchEndpoint<TranzyRouteResponse[]>(agencyId, 'routes');
    if (data) return data;
    // Hash matched — no new data. Return empty array; the store's
    // loadRoutes() will see length=0 but its localStorage cache is still valid
    // (the store only overwrites when it gets actual data).
    return [];
  },

  /**
   * Validate API key + agency (used during setup for live vehicle key check).
   */
  async validateAgency(apiKey: string, agencyId: number): Promise<boolean> {
    const { default: axios } = await import('axios');
    try {
      await axios.get(`${API_CONFIG.BASE_URL}/routes`, {
        headers: { 'X-API-Key': apiKey, 'X-Agency-Id': agencyId.toString() }
      });
      return true;
    } catch {
      return false;
    }
  }
};
