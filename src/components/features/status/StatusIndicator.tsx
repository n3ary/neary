import type { FC } from 'react';
import { useEffect, useState } from 'react';
import { Box, Snackbar, Alert } from '@mui/material';
import { GpsStatusIcon } from './GpsStatusIcon';
import { ApiStatusIcon } from './ApiStatusIcon';
import { useLocationStore } from '../../../stores/locationStore';
import { useStatusStore } from '../../../stores/statusStore';
import { getGpsToastMessage, getApiToastMessage } from '../../../utils/status/statusToastHelpers';

interface StatusIndicatorProps {
  className?: string;
  showGpsDetails?: boolean; // Only control whether to show detailed popup
}

export const StatusIndicator: FC<StatusIndicatorProps> = ({
  className,
  showGpsDetails = false // Default to false - only show details in settings
}) => {
  // Toast state
  const [toastOpen, setToastOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  const [toastSeverity, setToastSeverity] = useState<'success' | 'warning' | 'error' | 'info'>('info');

  // Connect to LocationStore for GPS status
  const {
    currentPosition,
    permissionState,
    locationAccuracy,
    lastUpdated,
    requestLocation
  } = useLocationStore();

  // Connect to StatusStore for API status
  const {
    apiStatus,
    networkOnline,
    lastApiCheck,
    responseTime,
    setNetworkStatus
  } = useStatusStore();

  // Handle GPS icon click - always request location AND show feedback toast.
  // The toast is shown regardless of `showGpsDetails` so users get immediate
  // confirmation that the button did something (status, accuracy, or why it
  // can't acquire — e.g. permission denied) on every page where the icon is
  // visible (#21 follow-up).
  const handleGpsClick = () => {
    requestLocation();

    const { message, severity } = getGpsToastMessage(
      currentPosition ? 'available' : 'unavailable',
      locationAccuracy,
      permissionState
    );
    setToastMessage(message);
    setToastSeverity(severity);
    setToastOpen(true);
  };

  // Handle API icon click - show toast with connection info
  const handleApiClick = () => {
    const { message, severity } = getApiToastMessage(
      apiStatus,
      networkOnline,
      responseTime
    );
    setToastMessage(message);
    setToastSeverity(severity);
    setToastOpen(true);
  };

  // Listen to browser online/offline events for immediate network status updates
  useEffect(() => {
    const handleOnline = () => setNetworkStatus(true);
    const handleOffline = () => setNetworkStatus(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [setNetworkStatus]);

  return (
    <>
      <Box 
        className={className}
        data-testid="status-indicator"
        sx={{ 
          display: 'flex', 
          alignItems: 'center',
          gap: 0.5, // Small gap between icons
          // Smooth transition animations between states
          transition: 'all 0.3s ease-in-out',
          '& > *': {
            transition: 'all 0.3s ease-in-out'
          }
        }}
      >
        <GpsStatusIcon
          status={currentPosition ? 'available' : 'unavailable'}
          accuracy={locationAccuracy}
          permissionState={permissionState}
          lastUpdated={lastUpdated}
          onClick={handleGpsClick}
        />
        <ApiStatusIcon
          status={apiStatus}
          networkOnline={networkOnline}
          lastCheck={lastApiCheck}
          responseTime={responseTime}
          onClick={handleApiClick}
        />
      </Box>

      <Snackbar
        open={toastOpen}
        autoHideDuration={4000}
        onClose={() => setToastOpen(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert 
          onClose={() => setToastOpen(false)} 
          severity={toastSeverity}
          variant="filled"
          sx={{ width: '100%' }}
        >
          {toastMessage}
        </Alert>
      </Snackbar>
    </>
  );
};