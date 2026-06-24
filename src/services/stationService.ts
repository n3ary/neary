// StationService — stops from static neary-gtfs source + arrival calculations

import type { TranzyStopResponse } from '../types/rawTranzyApi.ts';
import type { ArrivalTimeResult } from '../types/arrivalTime.ts';
import { getApiConfig } from '../context/appContext';
import { staticDataService } from './staticDataService';
import { handleApiError } from './error';

export const stationService = {
  /**
   * Get stops from static source.
   */
  async getStops(): Promise<TranzyStopResponse[]> {
    const { agencyId } = getApiConfig();
    const data = await staticDataService.fetchEndpoint<TranzyStopResponse[]>(agencyId, 'stops');
    if (data) return data;
    return [];
  },

  /**
   * Get arrival times for vehicles approaching a specific stop.
   */
  async getStopArrivals(stopId: string): Promise<ArrivalTimeResult[]> {
    try {
      const { arrivalService } = await import('./arrivalService');
      return arrivalService.calculateArrivalsForStop(stopId);
    } catch (error) {
      handleApiError(error, 'fetch stop arrivals');
    }
  }
};
