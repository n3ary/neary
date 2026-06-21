// SettingsView - Core view component for settings
// Simplified to focus on theme and reconfiguration

import type { FC } from 'react';
import { 
  Box, 
  Typography, 
  Button, 
  Card,
  CardContent,
  Link
} from '@mui/material';
import { ThemeToggle } from '../../theme/ThemeToggle';
import { useConfigStore } from '../../../stores/configStore';
import { FreshnessDebugPanel } from '../status/FreshnessDebugPanel';
import { AppVersionPanel } from '../status/AppVersionPanel';

interface SettingsViewProps {
  onNavigateToSetup?: () => void;
}

export const SettingsView: FC<SettingsViewProps> = ({ onNavigateToSetup }) => {
  const { theme } = useConfigStore();
  
  const handleReconfigure = () => {
    if (onNavigateToSetup) {
      onNavigateToSetup();
    }
  };

  return (
    <Box sx={{ p: 2 }}>
      <Card variant="outlined" sx={{ mb: 2 }}>
        <CardContent>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Box>
              <Typography variant="h6" gutterBottom>
                Theme
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {theme === 'dark' ? 'Dark Mode' : theme === 'light' ? 'Light Mode' : 'System Default'}
              </Typography>
            </Box>
            <ThemeToggle size="large" />
          </Box>
        </CardContent>
      </Card>

      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Configuration
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Change your API key or transit agency
          </Typography>
          <Button 
            variant="outlined" 
            onClick={handleReconfigure}
            fullWidth
          >
            Reconfigure
          </Button>
        </CardContent>
      </Card>

      <Card variant="outlined" sx={{ mt: 2 }}>
        <CardContent>
          <FreshnessDebugPanel />
        </CardContent>
      </Card>

      <Card variant="outlined" sx={{ mt: 2 }}>
        <CardContent>
          <AppVersionPanel />
        </CardContent>
      </Card>

      <Card variant="outlined" sx={{ mt: 2 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Data Attribution
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Schedule data is derived from the Cluj public transit GTFS feed
            (external.gtfs.ro), licensed under{' '}
            <Link
              href="https://creativecommons.org/licenses/by-sa/4.0/"
              target="_blank"
              rel="noopener noreferrer"
            >
              CC-BY-SA-4.0
            </Link>
            . Real-time vehicle, route, and station data is provided by the
            Tranzy API.
          </Typography>
        </CardContent>
      </Card>
    </Box>
  );
};