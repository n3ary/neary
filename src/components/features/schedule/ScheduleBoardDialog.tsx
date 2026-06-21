/**
 * ScheduleBoardDialog - full-screen Today / Tomorrow scheduled departure board
 * for a single route + direction at a station, opened from the "Today schedule"
 * / "Tomorrow schedule" buttons on a scheduled departure card.
 *
 *  - Today    : upcoming scheduled departures from this station (>= now).
 *  - Tomorrow : all of tomorrow's scheduled departures.
 *
 * The route is shown as a badge in the title and the destination as a subtitle,
 * so the rows are just a compact two-column grid of departure times.
 * Schedule-only (GTFS); no live GPS. Degrades gracefully when no schedule data.
 */

import type { FC } from 'react';
import { useMemo, useState, useEffect } from 'react';
import {
  Dialog, DialogTitle, DialogContent, IconButton, Typography, Box, Avatar,
  ToggleButtonGroup, ToggleButton,
} from '@mui/material';
import { Close as CloseIcon } from '@mui/icons-material';
import { useScheduleStore } from '../../../stores/scheduleStore';
import { useTripStore } from '../../../stores/tripStore';
import { useRouteStore } from '../../../stores/routeStore';
import { buildTripRouteMap } from '../../../utils/schedule/scheduleVehicleIntegration';
import { buildStationDepartureBoard, formatBoardTime } from '../../../utils/schedule/stationScheduleBoard';
import { minutesSinceMidnight } from '../../../utils/schedule/activeServiceUtils';

type BoardMode = 'today' | 'tomorrow';

interface ScheduleBoardDialogProps {
  open: boolean;
  initialMode: BoardMode;
  station: { stop_id: number; stop_name: string } | null;
  /** Route + direction this board is scoped to (from the scheduled card). */
  routeId: number | null;
  routeShortName: string;
  headsign: string;
  directionId: number | null;
  onClose: () => void;
}

export const ScheduleBoardDialog: FC<ScheduleBoardDialogProps> = ({
  open, initialMode, station, routeId, routeShortName, headsign, directionId, onClose,
}) => {
  const [mode, setMode] = useState<BoardMode>(initialMode);
  const { scheduleData } = useScheduleStore();
  const { trips } = useTripStore();
  const { routes } = useRouteStore();

  useEffect(() => {
    if (open) setMode(initialMode);
  }, [open, initialMode]);

  const board = useMemo(() => {
    if (!open || !station) return [];
    const now = new Date();
    const tripRouteMap = buildTripRouteMap(trips);
    const common = { scheduleData, tripRouteMap, stopId: station.stop_id, routes, routeId, directionId };
    if (mode === 'today') {
      return buildStationDepartureBoard({ ...common, date: now, fromMinutes: minutesSinceMidnight(now) });
    }
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 12, 0, 0);
    return buildStationDepartureBoard({ ...common, date: tomorrow, fromMinutes: null });
  }, [open, station, mode, scheduleData, trips, routes, routeId, directionId]);

  return (
    <Dialog open={open} onClose={onClose} fullScreen>
      <DialogTitle sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', py: 1, px: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, minWidth: 0 }}>
          <Avatar sx={{ bgcolor: 'primary.main', width: 40, height: 40, fontSize: '1rem', fontWeight: 'bold', flexShrink: 0 }}>
            {routeShortName}
          </Avatar>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="h6" component="div" noWrap>{station?.stop_name ?? 'Schedule'}</Typography>
            <Typography variant="caption" color="text.secondary" noWrap component="div">
              {headsign ? `→ ${headsign}` : 'Scheduled departures'}
            </Typography>
          </Box>
        </Box>
        <IconButton edge="end" color="inherit" onClick={onClose} aria-label="close">
          <CloseIcon />
        </IconButton>
      </DialogTitle>

      <DialogContent sx={{ p: 2 }}>
        <ToggleButtonGroup
          exclusive
          size="small"
          color="primary"
          value={mode}
          onChange={(_, v) => v && setMode(v)}
          sx={{ mb: 2 }}
        >
          <ToggleButton value="today">Today</ToggleButton>
          <ToggleButton value="tomorrow">Tomorrow</ToggleButton>
        </ToggleButtonGroup>

        {board.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic', mt: 2 }}>
            {scheduleData
              ? mode === 'today'
                ? 'No more scheduled departures today.'
                : 'No scheduled departures tomorrow.'
              : 'Schedule data is not available.'}
          </Typography>
        ) : (
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: 'repeat(3, 1fr)' },
              gap: 1,
            }}
          >
            {board.map((d, i) => (
              <Box
                key={`${d.tripId}-${i}`}
                sx={{
                  py: 1,
                  textAlign: 'center',
                  borderRadius: 1,
                  bgcolor: 'action.hover',
                  fontVariantNumeric: 'tabular-nums',
                  fontWeight: 600,
                }}
              >
                {formatBoardTime(d.departureMinutes)}
              </Box>
            ))}
          </Box>
        )}
      </DialogContent>
    </Dialog>
  );
};
