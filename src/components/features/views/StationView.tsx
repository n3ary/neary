// StationView - Clean view component always showing nearby stations
// Orchestrates header, list, and empty state components
// Requirement 7.6, 7.7: Handle first load scenarios with proper user feedback

import type { FC } from 'react';
import { 
  Box, 
  CircularProgress, 
  Alert, 
  Button
} from '@mui/material';
import { useStationStore } from '../../../stores/stationStore';
import { useVehicleStore } from '../../../stores/vehicleStore';
import { useConfigStore } from '../../../stores/configStore';
import { useStationFilter } from '../../../hooks/useStationFilter';
import { StationList } from '../lists/StationList';
import { StationEmptyState } from '../states/StationEmptyState';
import { FirstTimeLoadingState } from '../states/FirstTimeLoadingState';

interface StationViewProps {
  onNavigateToSettings?: () => void;
}

export const StationView: FC<StationViewProps> = ({ onNavigateToSettings }) => {
  // Use selectors to prevent unnecessary re-renders
  const stops = useStationStore(state => state.stops);
  const stationLoading = useStationStore(state => state.loading);
  const vehicles = useVehicleStore(state => state.vehicles);
  const vehicleLoading = useVehicleStore(state => state.loading);
  const vehicleLastUpdated = useVehicleStore(state => state.lastApiFetch);
  const agency_id = useConfigStore(state => state.agency_id);
  
  const { 
    filteredStations, 
    loading, 
    processing,
    error, 
    retryFiltering,
    utilities
  } = useStationFilter();

  // Note: Data loading is handled by automaticRefreshService on app startup
  // No need to trigger loading here - it creates duplicate requests

  if (!agency_id) {
    return (
      <Alert 
        severity="info" 
        sx={{ m: 2 }}
        action={
          onNavigateToSettings && (
            <Button 
              color="inherit" 
              size="small" 
              onClick={onNavigateToSettings}
            >
              Settings
            </Button>
          )
        }
      >
        Please select a transit agency in settings
      </Alert>
    );
  }

  // Show first-time loading state when cache is empty and data is loading
  // In schedule-only mode (no API key), don't wait for vehicles
  const apiKey = useConfigStore(state => state.apiKey);
  const needsVehicles = !!apiKey;
  const isWaitingForData = stops.length === 0 || (needsVehicles && vehicles.length === 0);
  
  if (isWaitingForData) {
    return (
      <FirstTimeLoadingState 
        message="Loading nearby stations..."
        subMessage="Getting transit data for your area"
      />
    );
  }

  // Show regular loading state for subsequent loads
  if (loading) {
    return (
      <Box display="flex" justifyContent="center" p={3}>
        <CircularProgress />
      </Box>
    );
  }

  if (error) {
    return (
      <Alert 
        severity="error" 
        sx={{ m: 2 }}
        action={
          <Button 
            color="inherit" 
            size="small" 
            onClick={() => retryFiltering()}
          >
            Retry
          </Button>
        }
      >
        {error}
      </Alert>
    );
  }

  return (
    <Box sx={{ position: 'relative' }}>
      {/* Small processing spinner - non-blocking */}
      {processing && (
        <Box sx={{ 
          position: 'absolute', 
          top: 8, 
          right: 8, 
          zIndex: 1 
        }}>
          <CircularProgress size={16} />
        </Box>
      )}
      
      <StationList 
        stations={filteredStations} 
        utilities={utilities}
        vehicleRefreshTimestamp={vehicleLastUpdated}
        vehicleLoading={vehicleLoading}
      />
      
      <StationEmptyState
        filteredCount={filteredStations.length}
        processing={processing}
        hasStops={stops.length > 0}
      />
    </Box>
  );
};