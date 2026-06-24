// SetupView - Agency-first setup flow
// Step 1: Select transit agency (no API key needed — agencies loaded from static source)
// Step 2: Optionally add API key for live vehicle tracking
//
// Without an API key the app works in schedule-only mode (routes, stops, shapes,
// schedule all come from the static neary-gtfs releases branch). Adding a key
// enables live GPS vehicle tracking via the Tranzy API.

import { useState, useEffect } from 'react';
import type { FC } from 'react';
import {
  Box,
  Typography,
  TextField,
  Button,
  Alert,
  CircularProgress,
  Card,
  CardContent,
  MenuItem,
  Collapse,
} from '@mui/material';
import { useConfigStore } from '../../../stores/configStore';
import { useAgencyStore } from '../../../stores/agencyStore';

interface SetupViewProps {
  initialApiKey?: string;
  initialAgencyId?: number;
  onComplete: () => void;
}

export const SetupView: FC<SetupViewProps> = ({
  initialApiKey,
  initialAgencyId,
  onComplete,
}) => {
  const { agencies, loadAgencies, loading: agenciesLoading } = useAgencyStore();

  // Agency selection state
  const [selectedAgencyId, setSelectedAgencyId] = useState<number | ''>(
    initialAgencyId || ''
  );

  // API key state (optional)
  const [showApiKey, setShowApiKey] = useState(!!initialApiKey);
  const [apiKey, setApiKey] = useState(initialApiKey || '');
  const [keyLoading, setKeyLoading] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keyValid, setKeyValid] = useState(!!initialApiKey);

  // Load agencies on mount from static source (no API key needed)
  useEffect(() => {
    if (agencies.length === 0) {
      loadAgencies();
    }
  }, [agencies.length, loadAgencies]);

  const handleAgencyChange = (value: number | '') => {
    setSelectedAgencyId(value);
  };

  const handleValidateKey = async () => {
    const trimmed = apiKey.trim();
    if (!trimmed) return;

    setKeyLoading(true);
    setKeyError(null);

    try {
      const { agencyService } = await import('../../../services/agencyService');
      await agencyService.validateApiKey(trimmed);
      setKeyValid(true);
      setKeyLoading(false);
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : 'Invalid API key');
      setKeyValid(false);
      setKeyLoading(false);
    }
  };

  const handleContinue = async () => {
    if (selectedAgencyId === '') return;

    const trimmedKey = apiKey.trim();
    const { setAgency, setApiKey: saveApiKey } = useConfigStore.getState();

    // If user provided an API key, validate key+agency combo
    if (trimmedKey && keyValid) {
      try {
        const { validateAndSave } = useConfigStore.getState();
        await validateAndSave(trimmedKey, selectedAgencyId as number);
      } catch {
        // validateAndSave handles its own error state
        return;
      }
    } else {
      // No API key — schedule-only mode. Just set the agency.
      if (trimmedKey && !keyValid) {
        // Key entered but not validated — skip it
        saveApiKey('');
      }
      setAgency(selectedAgencyId as number);
    }

    onComplete();
  };

  const isAgencySelected = selectedAgencyId !== '';
  const canContinue = isAgencySelected && (!apiKey.trim() || keyValid);

  return (
    <Box
      sx={{
        p: 2,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
      }}
    >
      <Card sx={{ maxWidth: 500, width: '100%' }}>
        <CardContent sx={{ p: 3 }}>
          <Typography variant="h5" gutterBottom>
            {initialAgencyId ? 'Reconfigure' : 'Welcome to Neary'}
          </Typography>

          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Select your transit agency to see schedules, routes, and stations.
          </Typography>

          {/* Step 1: Agency selection */}
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Transit agency
          </Typography>

          {agenciesLoading ? (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
              <CircularProgress size={16} />
              <Typography variant="body2" color="text.secondary">
                Loading agencies...
              </Typography>
            </Box>
          ) : (
            <TextField
              select
              label="Select your city"
              value={selectedAgencyId}
              onChange={(e) =>
                handleAgencyChange(e.target.value === '' ? '' : Number(e.target.value))
              }
              fullWidth
              sx={{ mb: 2 }}
            >
              <MenuItem value="">
                <em>Choose an agency</em>
              </MenuItem>
              {agencies.map((agency) => (
                <MenuItem key={agency.agency_id} value={agency.agency_id}>
                  {agency.agency_name}
                </MenuItem>
              ))}
            </TextField>
          )}

          {/* Step 2: Optional API key */}
          {!showApiKey && isAgencySelected && (
            <Button
              variant="text"
              size="small"
              onClick={() => setShowApiKey(true)}
              sx={{ mb: 2, textTransform: 'none' }}
            >
              + Add API key for live vehicle tracking
            </Button>
          )}

          <Collapse in={showApiKey}>
            <Box sx={{ mb: 2 }}>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                Tranzy API key (optional)
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                Enables live GPS vehicle positions. Without it, the app shows
                schedules and routes only.
              </Typography>

              {keyError && (
                <Alert severity="error" sx={{ mb: 1 }} onClose={() => setKeyError(null)}>
                  {keyError}
                </Alert>
              )}

              <Box sx={{ display: 'flex', gap: 1 }}>
                <TextField
                  label="API Key"
                  type="password"
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value);
                    setKeyValid(false);
                    setKeyError(null);
                  }}
                  fullWidth
                  size="small"
                  disabled={keyLoading}
                  color={keyValid ? 'success' : undefined}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleValidateKey();
                  }}
                />
                <Button
                  variant="outlined"
                  onClick={handleValidateKey}
                  disabled={!apiKey.trim() || keyLoading || keyValid}
                  sx={{ minWidth: 90 }}
                >
                  {keyLoading ? <CircularProgress size={16} /> : keyValid ? '✓' : 'Validate'}
                </Button>
              </Box>
            </Box>
          </Collapse>

          {/* Continue button */}
          <Button
            variant="contained"
            fullWidth
            size="large"
            onClick={handleContinue}
            disabled={!canContinue}
            sx={{ mt: 1 }}
          >
            {apiKey.trim() && keyValid ? 'Continue' : 'Continue (schedule only)'}
          </Button>

          {isAgencySelected && !apiKey.trim() && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1, textAlign: 'center' }}>
              You can add an API key later in Settings
            </Typography>
          )}
        </CardContent>
      </Card>
    </Box>
  );
};
