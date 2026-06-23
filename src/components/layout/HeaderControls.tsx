// HeaderControls - Reusable header controls component
// Contains StatusIndicator, ManualRefreshButton, and Settings/Close toggle

import type { FC } from 'react';
import { Box, IconButton } from '@mui/material';
import { Settings as SettingsIcon, Close as CloseIcon } from '@mui/icons-material';
import { StatusIndicator } from '../features/status/StatusIndicator';
import { ManualRefreshButton } from '../features/controls/ManualRefreshButton';

interface HeaderControlsProps {
  onSettingsClick?: () => void;
  /** When true, the settings icon becomes a close (X) icon. */
  isSettingsOpen?: boolean;
  showGpsDetails?: boolean;
}

export const HeaderControls: FC<HeaderControlsProps> = ({ 
  onSettingsClick,
  isSettingsOpen = false,
  showGpsDetails = false
}) => {
  return (
    <Box sx={{ 
      display: 'flex', 
      alignItems: 'center',
      gap: 1,
      mr: onSettingsClick ? 1 : 0
    }}>
      <StatusIndicator showGpsDetails={showGpsDetails} />
      <ManualRefreshButton />
      
      {onSettingsClick && (
        <IconButton
          color="inherit"
          onClick={onSettingsClick}
          aria-label={isSettingsOpen ? 'close settings' : 'settings'}
        >
          {isSettingsOpen ? <CloseIcon /> : <SettingsIcon />}
        </IconButton>
      )}
    </Box>
  );
};