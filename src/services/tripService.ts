// TripService — trips and stop_times from static neary-gtfs source

import type { TranzyStopTimeResponse, TranzyTripResponse } from '../types/rawTranzyApi.ts';
import { getApiConfig } from '../context/appContext';
import { staticDataService } from './staticDataService';

export const tripService = {
  /**
   * Get stop times from static source.
   */
  async getStopTimes(): Promise<TranzyStopTimeResponse[]> {
    const { agencyId } = getApiConfig();
    const data = await staticDataService.fetchEndpoint<TranzyStopTimeResponse[]>(agencyId, 'stop_times');
    if (data) return data;
    return [];
  },

  /**
   * Get trips from static source.
   */
  async getTrips(): Promise<TranzyTripResponse[]> {
    const { agencyId } = getApiConfig();
    const data = await staticDataService.fetchEndpoint<TranzyTripResponse[]>(agencyId, 'trips');
    if (data) return data;
    return [];
  }
};
