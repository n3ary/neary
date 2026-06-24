// SettingsView - Core view component for settings

import type { FC } from 'react';
import { useState, useEffect } from 'react';
import { 
  Box, 
  Typography, 
  Button, 
  Card,
  CardContent,
  Link,
  FormControlLabel,
  Switch,
} from '@mui/material';
import { ThemeToggle } from '../../theme/ThemeToggle';
import { useConfigStore } from '../../../stores/configStore';
import { FreshnessDebugPanel } from '../status/FreshnessDebugPanel';
import { AppVersionPanel } from '../status/AppVersionPanel';

interface SettingsViewProps {
  onNavigateToSetup?: () => void;
  onClose?: () => void;
}

/** Calculate total localStorage usage in bytes (UTF-16: 2 bytes per char). */
function getLocalStorageUsage(): { totalBytes: number; label: string } {
  let total = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i) ?? '';
    const val = localStorage.getItem(key) ?? '';
    total += (key.length + val.length) * 2; // UTF-16
  }
  if (total < 1024) return { totalBytes: total, label: `${total} B` };
  if (total < 1024 * 1024) return { totalBytes: total, label: `${(total / 1024).toFixed(1)} KB` };
  return { totalBytes: total, label: `${(total / 1024 / 1024).toFixed(2)} MB` };
}

export const SettingsView: FC<SettingsViewProps> = ({ onNavigateToSetup, onClose }) => {
  const { theme } = useConfigStore();
  const showDropOffOnly = useConfigStore((s) => s.showDropOffOnly);
  const setShowDropOffOnly = useConfigStore((s) => s.setShowDropOffOnly);
  const [storageCleared, setStorageCleared] = useState(false);
  
  // Recompute storage usage periodically (stores write back asynchronously after clear)
  const [storageUsage, setStorageUsage] = useState(() => getLocalStorageUsage());
  useEffect(() => {
    setStorageUsage(getLocalStorageUsage());
    const id = setInterval(() => setStorageUsage(getLocalStorageUsage()), 2000);
    return () => clearInterval(id);
  }, [storageCleared]);

  const handleClearStorage = async () => {
    const apiKey = useConfigStore.getState().apiKey;
    const agencyId = useConfigStore.getState().agency_id;
    const themeVal = useConfigStore.getState().theme;
    localStorage.clear();
    // Restore essential config so the user doesn't have to re-authenticate
    useConfigStore.setState({ apiKey, agency_id: agencyId, theme: themeVal });
    // Invalidate static data manifest cache so next refresh re-downloads
    const { staticDataService } = await import('../../../services/staticDataService');
    staticDataService.invalidateCache();
    // Clear in-memory store state so refresh doesn't skip (stale lastApiFetch)
    const { useConfigStore: config } = await import('../../../stores/configStore');
    await config.getState().clearAgencyData();
    setStorageCleared((v) => !v); // trigger re-render
  };

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
          <Typography variant="h6" gutterBottom>
            Display
          </Typography>
          <FormControlLabel
            control={
              <Switch
                checked={showDropOffOnly}
                onChange={(_, v) => setShowDropOffOnly(v)}
              />
            }
            label="Show drop-off-only vehicles"
          />
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            Vehicles whose trip ends at the current station — you can't board
            them. Hidden by default; toggle on for terminus / debugging
            visibility.
          </Typography>
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
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Storage
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', mb: 1.5 }}>
            <Typography variant="body2" color="text.secondary">
              localStorage used
            </Typography>
            <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums', fontFamily: 'monospace' }}>
              {storageUsage.label}
            </Typography>
          </Box>
          <Button
            variant="outlined"
            color="error"
            size="small"
            fullWidth
            onClick={handleClearStorage}
          >
            Clear storage
          </Button>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            Clears cached data (shapes, vehicles, schedule). API key and agency are preserved. App will refetch on next load.
          </Typography>
        </CardContent>
      </Card>

      <Card variant="outlined" sx={{ mt: 2 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Data Attribution
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Schedule data is derived from the official CTP Cluj-Napoca website
            (ctpcj.ro) and generated by the{' '}
            <Link
              href="https://github.com/ciotlosm/neary-gtfs"
              target="_blank"
              rel="noopener noreferrer"
            >
              neary-gtfs
            </Link>{' '}
            pipeline. Real-time vehicle, route, and station data is provided by the
            Tranzy API.
          </Typography>
        </CardContent>
      </Card>
    </Box>
  );
};