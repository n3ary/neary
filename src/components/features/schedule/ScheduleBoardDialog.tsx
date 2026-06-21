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
  ToggleButtonGroup, ToggleButton, Button,
} from '@mui/material';
import { Close as CloseIcon, ExpandMore as ExpandMoreIcon } from '@mui/icons-material';
import { useScheduleStore } from '../../../stores/scheduleStore';
import { useTripStore } from '../../../stores/tripStore';
import { useRouteStore } from '../../../stores/routeStore';
import { buildTripRouteMap } from '../../../utils/schedule/scheduleVehicleIntegration';
import { buildStationDepartureBoard, formatBoardTime } from '../../../utils/schedule/stationScheduleBoard';
import { minutesSinceMidnight } from '../../../utils/schedule/activeServiceUtils';
import { generateStatusMessage } from '../../../utils/arrival/statusUtils';

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
  /**
   * Optional GTFS trip id to pin as the "past departure" entry on Today, so
   * the run that the source ghost card represents is always shown — even if
   * its scheduled departure is older than the regular 10-min past window.
   */
  pinnedPastTripId?: string | null;
  onClose: () => void;
}

export const ScheduleBoardDialog: FC<ScheduleBoardDialogProps> = ({
  open, initialMode, station, routeId, routeShortName, headsign, directionId, pinnedPastTripId, onClose,
}) => {
  const [mode, setMode] = useState<BoardMode>(initialMode);
  // Tomorrow defaults to the morning (until noon) with a "See more" expander.
  const [tomorrowExpanded, setTomorrowExpanded] = useState(false);
  const { scheduleData } = useScheduleStore();
  const { trips } = useTripStore();
  const { routes } = useRouteStore();

  useEffect(() => {
    if (open) setMode(initialMode);
  }, [open, initialMode]);

  // Collapse the tomorrow expander whenever the dialog opens or the tab changes.
  useEffect(() => {
    setTomorrowExpanded(false);
  }, [open, mode]);

  const board = useMemo(() => {
    if (!open || !station) return [];
    const now = new Date();
    const tripRouteMap = buildTripRouteMap(trips);
    const common = { scheduleData, tripRouteMap, stopId: station.stop_id, routes, routeId, directionId };
    if (mode === 'today') {
      // Include the soonest past departure within the last 10 minutes (matches
      // the ghost "Departed" window cap), so a recently-passed run is visible
      // alongside the upcoming list — useful when the dialog is opened from a
      // ghost "Departed" chip. When the source is a ghost we ALSO pin that
      // ghost's own trip as the past entry so it shows even when older than
      // the regular 10-min window (e.g. a long route still en route).
      return buildStationDepartureBoard({
        ...common,
        date: now,
        fromMinutes: minutesSinceMidnight(now),
        pastWindowMinutes: 10,
        pinnedPastTripId: pinnedPastTripId ?? null,
      });
    }
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 12, 0, 0);
    return buildStationDepartureBoard({ ...common, date: tomorrow, fromMinutes: null });
  }, [open, station, mode, scheduleData, trips, routes, routeId, directionId, pinnedPastTripId]);

  // Tomorrow defaults to morning (before noon); "See more" reveals the rest.
  const NOON_MINUTES = 12 * 60;
  const visibleBoard =
    mode === 'tomorrow' && !tomorrowExpanded
      ? board.filter((d) => d.departureMinutes < NOON_MINUTES)
      : board;
  const hasMore = mode === 'tomorrow' && !tomorrowExpanded && board.length > visibleBoard.length;

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
          <>
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: 'repeat(3, 1fr)' },
                gap: 1,
              }}
            >
              {(() => {
                const nowMin = minutesSinceMidnight(new Date());
                // Index of the first non-past row — gets the "soonest upcoming"
                // highlight in Today mode.
                const firstUpcomingIdx = visibleBoard.findIndex((d) => !d.past);
                return visibleBoard.map((d, i) => {
                  const isPast = d.past === true;
                  const minutesUntil = d.departureMinutes - nowMin;
                  const showSoonest = mode === 'today' && i === firstUpcomingIdx && minutesUntil >= 0;
                  const upcomingLabel =
                    minutesUntil < 1 ? 'Departing now' : generateStatusMessage('in_minutes', minutesUntil);
                  // "Departed Xm ago" caption for the recently-passed row.
                  const minutesAgo = Math.max(0, Math.round(-minutesUntil));
                  const pastLabel = minutesAgo === 0 ? 'just now' : `${minutesAgo} min ago`;

                  // Three visual states: past (muted, italic), soonest
                  // (info-filled), and the rest (subtle action.hover).
                  const bg = isPast ? 'transparent' : showSoonest ? 'info.main' : 'action.hover';
                  const fg = isPast ? 'text.secondary' : showSoonest ? 'info.contrastText' : 'text.primary';
                  return (
                    <Box
                      key={`${d.tripId}-${i}`}
                      sx={{
                        py: 1,
                        px: 0.5,
                        textAlign: 'center',
                        borderRadius: 1,
                        bgcolor: bg,
                        color: fg,
                        border: isPast ? '1px dashed' : 'none',
                        borderColor: isPast ? 'divider' : 'transparent',
                        fontVariantNumeric: 'tabular-nums',
                        fontWeight: 600,
                        opacity: isPast ? 0.75 : 1,
                      }}
                    >
                      {formatBoardTime(d.departureMinutes)}
                      {(isPast || showSoonest) && (
                        <Typography
                          variant="caption"
                          component="div"
                          sx={{ fontWeight: 400, fontStyle: isPast ? 'italic' : 'normal' }}
                        >
                          ({isPast ? pastLabel : upcomingLabel})
                        </Typography>
                      )}
                    </Box>
                  );
                });
              })()}
            </Box>
            {hasMore && (
              <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
                <Button
                  size="small"
                  variant="outlined"
                  color="primary"
                  startIcon={<ExpandMoreIcon />}
                  onClick={() => setTomorrowExpanded(true)}
                >
                  See more
                </Button>
              </Box>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};
