// RouteView - Core view component for routes with filtering capability
// Displays filtered route data with loading, error, and success states
// Requirement 7.6, 7.7: Handle first load scenarios with proper user feedback

import { useState } from 'react';
import type { FC } from 'react';
import { 
  Box, 
  Typography, 
  CircularProgress, 
  Alert,
  Button
} from '@mui/material';
import { useRouteStore } from '../../../stores/routeStore';
import { useConfigStore } from '../../../stores/configStore';
import { RouteList } from '../lists/RouteList';
import { RouteFilterBar } from '../filters/RouteFilterBar';
import { useRouteFilter } from '../../../hooks/useRouteFilter';
import { FirstTimeLoadingState } from '../states/FirstTimeLoadingState';
import { DEFAULT_FILTER_STATE } from '../../../types/routeFilter';
import type { RouteFilterState } from '../../../types/routeFilter';

interface RouteViewProps {
  onNavigateToSettings?: () => void;
}

export const RouteView: FC<RouteViewProps> = ({ onNavigateToSettings }) => {
  const { routes, loading, error } = useRouteStore();
  const { agency_id } = useConfigStore();
  
  // Local state for filter management
  const [filterState, setFilterState] = useState<RouteFilterState>(DEFAULT_FILTER_STATE);
  
  // Use the custom hook for route enhancement and filtering
  const { filteredRoutes } = useRouteFilter(routes, filterState);

  // Note: Data loading is handled by automaticRefreshService on app startup
  // No need to trigger loading here - it creates duplicate requests

  /**
   * Handle filter state changes from RouteFilterBar
   */
  const handleFilterChange = (newFilterState: RouteFilterState) => {
    setFilterState(newFilterState);
  };

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
  // Requirement 7.6: Display loading states when cache is empty on first load
  if (loading && routes.length === 0) {
    return (
      <FirstTimeLoadingState 
        message="Loading route information..."
        subMessage="Getting available transit routes"
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
            onClick={() => window.location.reload()}
          >
            Reload App
          </Button>
        }
      >
        {error}
      </Alert>
    );
  }

  return (
    <Box>
      {/* Filter bar - only show when routes are loaded */}
      {routes.length > 0 && (
        <RouteFilterBar
          filterState={filterState}
          onFilterChange={handleFilterChange}
          routeCount={filteredRoutes.length}
        />
      )}
      
      <RouteList routes={filteredRoutes} />
      
      {routes.length > 0 && filteredRoutes.length === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
          No routes match the current filters
        </Typography>
      )}
      
      {routes.length === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
          No routes found
        </Typography>
      )}
    </Box>
  );
};