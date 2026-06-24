// ShapesService — shapes from static neary-gtfs source

import type { TranzyShapeResponse } from '../types/rawTranzyApi.ts';
import { getApiConfig } from '../context/appContext';
import { staticDataService } from './staticDataService';

export const shapesService = {
  /**
   * Get all shapes from static source.
   */
  async getAllShapes(): Promise<TranzyShapeResponse[]> {
    const { agencyId } = getApiConfig();
    const data = await staticDataService.fetchEndpoint<TranzyShapeResponse[]>(agencyId, 'shapes');
    if (data) return data;
    return [];
  }
};
