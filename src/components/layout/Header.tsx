// Header - Simple header component with dynamic title and integrated status indicator
// Uses Material-UI directly without wrappers

import type { FC } from 'react';
import { AppBar, Toolbar, Typography, Box } from '@mui/material';
import { HeaderControls } from './HeaderControls';

interface HeaderProps {
  title?: string;
  onSettingsClick?: () => void;
  isSettingsOpen?: boolean;
}

export const Header: FC<HeaderProps> = ({ 
  title = 'Bus Tracker',
  onSettingsClick,
  isSettingsOpen = false,
}) => {
  return (
    <AppBar position="static">
      <Toolbar>
        {/* App Icon */}
        <Box sx={{ 
          display: 'flex', 
          alignItems: 'center',
          mr: 2
        }}>
          <img 
            src="/neary.svg" 
            alt="Neary" 
            style={{ 
              width: 32, 
              height: 32
            }} 
          />
        </Box>
        
        <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
          {title}
        </Typography>
        
        {/* Reusable header controls */}
        <HeaderControls onSettingsClick={onSettingsClick} isSettingsOpen={isSettingsOpen} />
      </Toolbar>
    </AppBar>
  );
};