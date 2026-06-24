// StationVehicleList - Display vehicles serving routes that pass through a specific station
// Receives vehicle data as props for better performance and simpler architecture
// Includes performance optimizations with memoization to prevent unnecessary re-renders

import type { FC } from 'react';
import { memo, useState, useMemo } from 'react';
import { 
  Card, CardContent, Typography, Chip, Stack, Box, Avatar, IconButton,
  Collapse, List, ListItem, ListItemText, Tooltip, CircularProgress, ClickAwayListener,
  Snackbar, Alert, Button
} from '@mui/material';
import { 
  AccessibleForward as WheelchairIcon,
  DirectionsBike as BikeIcon,
  AccessTime as ArrivalIcon, ExpandMore as ExpandMoreIcon, Map as MapIcon,
  LocationOn as TargetStationIcon, Favorite as FavoriteIcon,
  AccessTime as AccessTimeIcon, Warning as WarningIcon, Error as ErrorIcon,
  ArrowRightAlt as HeadsignArrowIcon,
  CalendarToday as ScheduleIcon
} from '@mui/icons-material';
import { formatTimestamp, getAccessibilityFeatures, formatArrivalTime } from '../../../utils/vehicle/vehicleFormatUtils';
import { formatAbsoluteTime, formatRelativeTime, formatDetailedRelativeTime } from '../../../utils/time/timestampFormatUtils';
import { sortStationVehiclesByArrival } from '../../../utils/station/stationVehicleUtils';
import { calculateDataAge } from '../../../utils/vehicle/dataAgeUtils';
import { groupVehiclesForDisplay } from '../../../utils/station/vehicleGroupingUtils';
import {
  buildDropOffOnlyVehicleIdSet,
  isVehicleDropOffOnlyAtStation,
} from '../../../utils/station/dropOffOnlyUtils';
import { getNextTomorrowDeparture } from '../../../utils/schedule/stationScheduleBoard';
import { VEHICLE_DISPLAY } from '../../../utils/core/constants';
import { getTripStopSequence, computeTripStopStatuses } from '../../../utils/arrival/tripUtils';
import { useTripStore } from '../../../stores/tripStore';
import { useStopTimeStore } from '../../../stores/stopTimeStore';
import { useStationStore } from '../../../stores/stationStore';
import { useVehicleStore } from '../../../stores/vehicleStore';
import { useRouteStore } from '../../../stores/routeStore';
import { useScheduleStore } from '../../../stores/scheduleStore';
import { useConfigStore } from '../../../stores/configStore';
import { VehicleMapDialog } from '../maps/VehicleMapDialog';
import { VehicleDropOffChip } from '../controls/VehicleDropOffChip';
import { ScheduledDepartureChip } from '../controls/ScheduledDepartureChip';
import { ScheduleBoardDialog } from '../schedule/ScheduleBoardDialog';
import { buildTripRouteMap } from '../../../utils/schedule/scheduleVehicleIntegration';
import type { StationVehicle } from '../../../types/stationFilter';
import { useFavoritesStore } from '../../../stores/favoritesStore';

// VehicleDisplayState interface removed as it's not used in the current implementation
// The component uses direct state variables instead

interface StationVehicleListProps {
  vehicles: StationVehicle[];
  expanded: boolean;
  station: any; // The station these vehicles are being displayed for
  stationRouteCount?: number; // Number of routes serving this station
  selectedRouteId?: number | null; // NEW: route filter
  vehicleRefreshTimestamp?: number | null; // Timestamp when vehicle data was last refreshed
  vehicleLoading?: boolean; // NEW: vehicle loading state for showing loading indicator
  routeIds?: number[]; // NEW: route ids serving this station (for scheduled departures)
}

/**
 * Fallback row shown when a station has no displayable vehicles. If the GTFS
 * schedule knows about a departure tomorrow, it shows "Next: tomorrow HH:MM"
 * with a button that opens the Tomorrow schedule dialog. Otherwise just shows
 * the provided empty-state message.
 */
const NextTomorrowFallback: FC<{ station: any; message: string }> = ({ station, message }) => {
  const { scheduleData } = useScheduleStore();
  const { routes } = useRouteStore();
  const trips = useTripStore((s) => s.trips) || [];
  const [tomorrowDialogOpen, setTomorrowDialogOpen] = useState(false);

  const nextTomorrow = useMemo(() => {
    if (!station?.stop_id || !scheduleData) return null;
    return getNextTomorrowDeparture({
      scheduleData,
      tripRouteMap: buildTripRouteMap(trips),
      stopId: station.stop_id,
      routes,
    });
  }, [station?.stop_id, scheduleData, trips, routes]);

  return (
    <Stack spacing={1.5} sx={{ pt: 2, px: 2 }}>
      <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic' }}>
        {message}
      </Typography>
      {nextTomorrow && (
        <Box display="flex" alignItems="center" gap={1}>
          <Typography variant="body2" color="text.secondary">
            Next: tomorrow {nextTomorrow.time}
          </Typography>
          <Button
            size="small"
            variant="outlined"
            color="info"
            onClick={() => setTomorrowDialogOpen(true)}
            sx={{ fontSize: '0.7rem', textTransform: 'none', py: 0.25 }}
          >
            Tomorrow schedule
          </Button>
        </Box>
      )}
      <ScheduleBoardDialog
        open={tomorrowDialogOpen}
        initialMode="tomorrow"
        station={station}
        routeId={null}
        routeShortName=""
        headsign=""
        directionId={null}
        onClose={() => setTomorrowDialogOpen(false)}
      />
    </Stack>
  );
};

export const StationVehicleList: FC<StationVehicleListProps> = memo(({ vehicles, expanded, station, stationRouteCount, selectedRouteId, vehicleRefreshTimestamp, vehicleLoading, routeIds }) => {
  // State for expansion functionality
  const [showingAll, setShowingAll] = useState(false);

  // Inputs needed to detect "drop-off only" rows (the trip terminates at this
  // station, so the user can't board). Live vehicles need the Tranzy
  // stop_times store; scheduled/ghost vehicles use the GTFS schedule payload.
  const stopTimesForDropOff = useStopTimeStore((s) => s.stopTimes);
  const scheduleDataForDropOff = useScheduleStore((s) => s.scheduleData);
  // Whether the user has opted INTO seeing drop-off-only rows (off by default).
  const showDropOffOnly = useConfigStore((s) => s.showDropOffOnly);

  // Static data subscribed ONCE here, passed to all VehicleCards as props.
  // This eliminates 5+ duplicate store subscriptions per card.
  const allTrips = useTripStore((s) => Array.isArray(s.trips) ? s.trips : []);
  const allStops = useStationStore((s) => Array.isArray(s.stops) ? s.stops : []);
  const allVehicles = useVehicleStore((s) => Array.isArray(s.vehicles) ? s.vehicles : []);
  const allRoutes = useRouteStore((s) => Array.isArray(s.routes) ? s.routes : []);
  const { isFavorite } = useFavoritesStore();

  // Apply route filtering with departed vehicle limiting (must be before any returns)
  const filteredVehicles = useMemo(() => {
    if (!selectedRouteId) {
      return vehicles;
    }

    // Filter vehicles by selected route
    const routeVehicles = vehicles.filter(({ route }) => route?.route_id === selectedRouteId);
    
    // Group vehicles by trip_id and status
    const vehiclesByTrip = new Map<string, StationVehicle[]>();
    const nonDepartedVehicles: StationVehicle[] = [];
    
    for (const vehicle of routeVehicles) {
      const isDeparted = vehicle.arrivalTime?.statusMessage?.includes('Departed') || false;
      
      if (!isDeparted) {
        // Non-departed vehicles: include all
        nonDepartedVehicles.push(vehicle);
      } else if (vehicle.trip && vehicle.trip.trip_id) {
        // Departed vehicles: group by trip_id
        const tripId = vehicle.trip.trip_id;
        if (!vehiclesByTrip.has(tripId)) {
          vehiclesByTrip.set(tripId, []);
        }
        vehiclesByTrip.get(tripId)!.push(vehicle);
      }
    }
    
    // For departed vehicles, take only 1 per trip (the first one after sorting by arrival time)
    const departedVehicles: StationVehicle[] = [];
    for (const tripVehicles of vehiclesByTrip.values()) {
      // Sort by arrival time and take the first (most relevant) one
      const sortedTripVehicles = sortStationVehiclesByArrival(tripVehicles);
      if (sortedTripVehicles.length > 0) {
        departedVehicles.push(sortedTripVehicles[0]);
      }
    }
    
    // Combine non-departed and limited departed vehicles
    return [...nonDepartedVehicles, ...departedVehicles];
  }, [vehicles, selectedRouteId]);

  // Drop-off-only ids — vehicles that terminate at this station (passengers
  // can't board). Computed once and used to deprioritise these rows in the
  // sort and the "More N vehicles" grouping. Must sit ABOVE every early
  // return below so the hook order stays stable across renders.
  const dropOffOnlyIds = useMemo(
    () => buildDropOffOnlyVehicleIdSet(filteredVehicles, station?.stop_id, stopTimesForDropOff, scheduleDataForDropOff),
    [filteredVehicles, station?.stop_id, stopTimesForDropOff, scheduleDataForDropOff],
  );

  // Apply the user's "show drop-off only" preference. When OFF (default),
  // those rows are removed entirely — riders waiting at the station can't
  // board them so they're noise. When ON they remain in the list but the
  // sort/grouping below still pushes them behind every pickup row.
  const visibleVehicles = useMemo(
    () =>
      showDropOffOnly
        ? filteredVehicles
        : filteredVehicles.filter((v) => !dropOffOnlyIds.has(v.vehicle.id)),
    [filteredVehicles, dropOffOnlyIds, showDropOffOnly],
  );

  // Show loading indicator when vehicles are being loaded
  if (vehicleLoading && vehicles.length === 0) {
    return (
      <Box display="flex" alignItems="center" gap={1} sx={{ p: 2 }}>
        <CircularProgress size={16} />
        <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic' }}>
          Loading vehicles...
        </Typography>
      </Box>
    );
  }

  // Empty state - no vehicles found
  if (vehicles.length === 0) {
    return <NextTomorrowFallback station={station} message="No active vehicles serving this station" />;
  }

  // The station has vehicles but they're all drop-off-only and the user has
  // hidden them. Tell them why the list is empty (and how to opt back in)
  // rather than silently showing nothing.
  if (!selectedRouteId && filteredVehicles.length > 0 && visibleVehicles.length === 0) {
    return (
      <NextTomorrowFallback
        station={station}
        message="Only drop-off vehicles serve this station at the moment. Enable Show drop-off only in Settings to view them."
      />
    );
  }

  // Handle empty state when route filter is active but no vehicles match
  if (selectedRouteId && visibleVehicles.length === 0) {
    return <NextTomorrowFallback station={station} message="No active vehicles for this route" />;
  }
  // Sort vehicles by arrival time using existing utility, with drop-off-only
  // pushed to the end of the list (lowest priority). When `showDropOffOnly`
  // is false, those rows have already been filtered out above.
  const sortedVehicles = sortStationVehiclesByArrival(visibleVehicles, dropOffOnlyIds);

  // Skip grouping when route filter is active
  const shouldApplyGrouping = !selectedRouteId && 
                             (stationRouteCount || 1) > 1 && 
                             sortedVehicles.length > VEHICLE_DISPLAY.VEHICLE_DISPLAY_THRESHOLD;

  // Apply grouping logic if needed
  const groupingResult = shouldApplyGrouping 
    ? groupVehiclesForDisplay(sortedVehicles, {
        maxVehicles: VEHICLE_DISPLAY.VEHICLE_DISPLAY_THRESHOLD,
        routeCount: stationRouteCount || 1,
        dropOffOnlyIds,
      })
    : {
        displayed: sortedVehicles,
        hidden: [],
        groupingApplied: false
      };

  // Determine which vehicles to display based on expansion state
  const vehiclesToDisplay = showingAll 
    ? sortedVehicles 
    : groupingResult.displayed;

  const hiddenVehicleCount = showingAll ? 0 : groupingResult.hidden.length;

  return (
    <Stack spacing={2} sx={{ pt: 2
     }}>
      {vehiclesToDisplay.map(({ vehicle, route, trip, arrivalTime }) => (
        <VehicleCard 
          key={vehicle.id}
          vehicle={vehicle}
          route={route}
          trip={trip}
          arrivalTime={arrivalTime}
          station={station}
          vehicleRefreshTimestamp={vehicleRefreshTimestamp}
          allStationVehicles={vehicles}
          stopTimes={stopTimesForDropOff}
          trips={allTrips}
          stops={allStops}
          scheduleData={scheduleDataForDropOff}
          allVehicles={allVehicles}
          routes={allRoutes}
          isFavorite={isFavorite}
        />
      ))}
      
      {/* Show more/less button when grouping is applied */}
      {groupingResult.groupingApplied && (
        <Box sx={{ display: 'flex', justifyContent: 'center', pt: 1, pb: 4 }}>
          <Chip
            label={showingAll 
              ? "Show less" 
              : `More ${hiddenVehicleCount} vehicle${hiddenVehicleCount !== 1 ? 's' : ''}`
            }
            onClick={() => setShowingAll(!showingAll)}
            variant="outlined"
            color="primary"
            sx={{ cursor: 'pointer' }}
          />
        </Box>
      )}
    </Stack>
  );
});

// Individual Vehicle Card Component
interface VehicleCardProps {
  vehicle: any;
  route: any;
  trip: any;
  arrivalTime?: any;
  station: any;
  vehicleRefreshTimestamp?: number | null;
  allStationVehicles: StationVehicle[];
  // Static data passed from parent (single subscription, shared across all cards)
  stopTimes: any[];
  trips: any[];
  stops: any[];
  scheduleData: any;
  allVehicles: any[];
  routes: any[];
  isFavorite: (routeId: string) => boolean;
}

// Data Age Icon Component - displays GPS freshness indicator
interface DataAgeIconProps {
  status: 'healthy' | 'stale' | 'very-stale';
}

const DataAgeIcon: FC<DataAgeIconProps> = ({ status }) => {
  if (status === 'healthy') {
    return <AccessTimeIcon fontSize="small" sx={{ color: 'success.main' }} />;
  } else if (status === 'stale') {
    return <WarningIcon fontSize="small" sx={{ color: 'warning.main' }} />;
  } else {
    return <ErrorIcon fontSize="small" sx={{ color: 'error.main' }} />;
  }
};

const VehicleCard: FC<VehicleCardProps> = memo(({ vehicle, route, trip, arrivalTime, station, vehicleRefreshTimestamp, allStationVehicles, stopTimes, trips, stops, scheduleData, allVehicles, routes, isFavorite }) => {
  const [stopsExpanded, setStopsExpanded] = useState(false);
  const [mapDialogOpen, setMapDialogOpen] = useState(false);
  const [dataToastOpen, setDataToastOpen] = useState(false);
  const [arrivalToastOpen, setArrivalToastOpen] = useState(false);
  // Placeholder for the upcoming today/tomorrow schedule views.
  const [scheduleView, setScheduleView] = useState<null | 'today' | 'tomorrow'>(null);
  
  // Calculate data age for freshness indicator
  const dataAgeResult = vehicleRefreshTimestamp 
    ? calculateDataAge(vehicle.timestamp, vehicleRefreshTimestamp)
    : null;
  
  // Check if this vehicle's route is a favorite
  const isRouteFavorite = route && isFavorite(String(route.route_id));

  // Scheduled (synthetic) vehicle: no live GPS, positioned at its start station
  // (future) or interpolated along the route (ghost). Rendered through this same
  // card so it looks/behaves like a normal vehicle (Req 6, 12).
  const isScheduled = vehicle.isScheduled === true;
  // A future scheduled departure waits at its start station; a ghost has
  // departed and is moving. Future ones swap the GPS detail row (speed/id/
  // accessibility) for schedule-view buttons.
  const isFutureScheduled = isScheduled && vehicle.isGhost !== true;

  // A "tomorrow" scheduled vehicle: its status message starts with "Tomorrow"
  // (synthesized when no more today departures exist for that route at a start
  // station). These should open the schedule in "tomorrow" mode, not "today".
  const isTomorrowVehicle = isFutureScheduled && arrivalTime?.statusMessage?.startsWith('Tomorrow');

  // Whether the current station is the trip's terminus — passengers can't
  // board, so the row is shown demoted with a "Drop off only" chip and is
  // also pushed to the bottom of the list by the sort/grouping. Same util
  // the list component uses to build its drop-off set.
  const isDropOffOnly = isVehicleDropOffOnlyAtStation(
    { vehicle, route, trip, arrivalTime } as StationVehicle,
    station?.stop_id,
    stopTimes,
    scheduleData,
  );
  
  // Get actual stops for this vehicle's trip. Live vehicles use the Tranzy
  // stop-time store; scheduled vehicles use the GTFS schedule payload (their
  // trip is not in the partial Tranzy set).
  //
  // Stop count: always computed (cheap — just array length).
  // Stop statuses (passed/current/upcoming): deferred until user expands.
  const tripStopCount = isScheduled
    ? (scheduleData?.stopTimes?.[vehicle.trip_id ?? ''] ?? []).length
    : getTripStopSequence(vehicle, stopTimes).length;

  // Full stop list with statuses — only computed when stops section is expanded
  const tripStops = useMemo(() => {
    if (!stopsExpanded) return [];

    if (isScheduled) {
      return (scheduleData?.stopTimes?.[vehicle.trip_id ?? ''] ?? [])
        .slice()
        .sort((a, b) => a.q - b.q)
        .map((st) => ({
          name: stops.find((s) => s.stop_id === st.s)?.stop_name || `Stop ${st.s}`,
          stopId: st.s,
          sequence: st.q,
          status: 'upcoming' as const,
        }));
    }

    // Live vehicle: single-pass O(N) computation
    return computeTripStopStatuses(vehicle, stopTimes, stops);
  }, [stopsExpanded, isScheduled, vehicle, stopTimes, stops, scheduleData]);

  const routeShortName = route?.route_short_name || vehicle.route_id?.toString() || '?';
  const headsign = trip?.trip_headsign || 'Unknown Destination';

  // Stop times to feed the map dialog. Scheduled trips are not in the Tranzy
  // stop-time store, so the map's station filter would fall back to showing
  // EVERY station. Synthesize Tranzy-shaped rows for this trip from the schedule
  // so the map shows only THIS trip's stations.
  const mapStopTimes = isScheduled && vehicle.trip_id
    ? [
        ...stopTimes,
        ...(scheduleData?.stopTimes?.[vehicle.trip_id] ?? []).map((st) => ({
          trip_id: vehicle.trip_id as string,
          stop_id: st.s,
          stop_sequence: st.q,
        })),
      ]
    : stopTimes;

  return (
    <Card 
      variant="vehicle"
      sx={{ 
        borderRadius: 2,
        boxShadow: 1,
        position: 'relative'
      }}
    >
      {/* Pending enhancement indicator — pulsing dot until first prediction cycle */}
      {!vehicle.predictionMetadata && !isScheduled && (
        <Box
          sx={{
            position: 'absolute',
            top: 8,
            right: 8,
            width: 8,
            height: 8,
            borderRadius: '50%',
            bgcolor: 'info.main',
            opacity: 0.6,
            zIndex: 1,
            animation: 'pulse-enhancement 1.5s ease-in-out infinite',
            '@keyframes pulse-enhancement': {
              '0%, 100%': { opacity: 0.6, transform: 'scale(1)' },
              '50%': { opacity: 0.3, transform: 'scale(1.2)' },
            },
          }}
        />
      )}
      <CardContent sx={{ 
        p: { xs: 1.5, sm: 2 }, 
        '&:last-child': { pb: { xs: 1.5, sm: 2 } } 
      }}>
        {/* Header with route badge, headsign, and vehicle ID */}
        <Stack direction="row" alignItems="center" spacing={{ xs: 1.5, sm: 2 }} sx={{ mb: 1.5 }}>
          {/* Circular route badge - smaller on mobile */}
          <Avatar sx={{ 
            bgcolor: 'primary.main', 
            width: { xs: 40, sm: 48 }, 
            height: { xs: 40, sm: 48 },
            fontSize: { xs: '1rem', sm: '1.1rem' },
            fontWeight: 'bold',
            flexShrink: 0
          }}>
            {routeShortName}
          </Avatar>
          
          {/* Route name and vehicle info */}
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Box display="flex" alignItems="center" gap={0.5} sx={{ mb: 0.5 }}>
              {/*
                A subtle "→" arrow before the headsign to convey
                "this bus is travelling toward <destination>". Sized to the
                line height of the headsign and tinted secondary so it
                reinforces direction without competing with the destination
                name itself. `ArrowRightAlt` reads as a clean horizontal arrow
                (line + head), more graphical than a literal `>` glyph and
                more compact than `ArrowForward`.
              */}
              <HeadsignArrowIcon
                aria-hidden
                sx={{
                  flexShrink: 0,
                  color: 'text.secondary',
                  fontSize: { xs: '1.1rem', sm: '1.25rem' },
                }}
              />
              <Typography 
                variant="subtitle1" 
                sx={{ 
                  fontWeight: 600,
                  fontSize: { xs: '0.95rem', sm: '1.1rem' },
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flex: 1
                }}
              >
                {headsign}
              </Typography>
              
              {/* Vehicle ID chip - inline with headsign */}
            </Box>
          </Box>
          
          {/* GPS data age indicator - icon only */}
          <Box 
            display="flex" 
            alignItems="center" 
            sx={{ 
              flexShrink: 0,
              cursor: 'pointer',
              minWidth: '44px',
              minHeight: '44px',
              justifyContent: 'center'
            }}
            onClick={() => setDataToastOpen(true)}
          >
            {isScheduled
              ? <AccessTimeIcon
                  fontSize="small"
                  sx={{
                    // Ghost (en-route schedule estimate, no live GPS) is RED
                    // to signal "this is estimated, treat with caution".
                    // Future (waiting at start) stays the existing blue, which
                    // matches the "Scheduled" pill on those rows.
                    color: vehicle.isGhost === true ? 'error.main' : 'info.main',
                  }}
                />
              : (dataAgeResult && <DataAgeIcon status={dataAgeResult.status} />)}
          </Box>
        </Stack>

        {/* Vehicle details row - compact horizontal layout */}
        <Stack 
          direction="row" 
          alignItems="center" 
          spacing={{ xs: 1.5, sm: 2 }} 
          sx={{ mb: 1.5, flexWrap: 'wrap' }}
        >
          {isFutureScheduled ? (
            <>
              <Button
                size="small"
                variant="outlined"
                color="info"
                startIcon={
                  <ScheduleIcon
                    sx={{
                      fontSize: '0.9rem !important',
                      color: 'success.main',
                    }}
                  />
                }
                onClick={() => setScheduleView(isTomorrowVehicle ? 'tomorrow' : 'today')}
                sx={{ fontSize: { xs: '0.7rem', sm: '0.75rem' }, textTransform: 'none', py: 0.25 }}
              >
                {isTomorrowVehicle ? 'Tomorrow' : 'Today'}
              </Button>
            </>
          ) : (
            <>
              {vehicle.label ? (
                <Chip
                  label={`${vehicle.label}`}
                  size="small"
                  variant="outlined"
                  sx={{
                    fontSize: '0.7rem',
                    height: { xs: 20, sm: 24 },
                    flexShrink: 0
                  }}
                />
              ) : null}

              {/* Accessibility information */}
              {getAccessibilityFeatures(vehicle.wheelchair_accessible, vehicle.bike_accessible).map(feature => (
                <Box key={feature.type} display="flex" alignItems="center" gap={0.25} sx={{ flexShrink: 0 }}>
                  {feature.type === 'wheelchair' ? (
                    <WheelchairIcon fontSize="small" color="primary" />
                  ) : (
                    <BikeIcon fontSize="small" color="primary" />
                  )}
                  <Typography
                    variant="caption"
                    color="primary"
                    sx={{
                      fontSize: { xs: '0.7rem', sm: '0.75rem' },
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {feature.label}
                  </Typography>
                </Box>
              ))}
            </>
          )}
          
          {/* Favorite route indicator */}
          {isRouteFavorite && (
            <Box display="flex" alignItems="center" sx={{ flexShrink: 0 }}>
              <FavoriteIcon 
                fontSize="small" 
                sx={{ 
                  color: 'error.main',
                  fontSize: { xs: '0.8rem', sm: '0.9rem' }
                }} 
              />
            </Box>
          )}
        </Stack>

        {/* Arrival time information */}
        {arrivalTime && isScheduled && (
          <Box display="flex" alignItems="center" gap={1} sx={{ mb: 1.5 }}>
            <Chip
              icon={<ArrivalIcon />}
              label={arrivalTime.statusMessage}
              color="info"
              variant="filled"
              size="small"
              onClick={() => setScheduleView(isTomorrowVehicle ? 'tomorrow' : 'today')}
              sx={{
                fontWeight: 'medium',
                fontSize: { xs: '0.7rem', sm: '0.75rem' },
                '& .MuiChip-icon': { color: 'inherit' },
                cursor: 'pointer',
              }}
            />
            {/*
              The "Scheduled" pill marks a row that has not yet started — it's
              waiting at its start station. A GHOST (already departed, shown as
              an estimated moving vehicle) is meant to look like a real bus
              (just without live GPS), so the pill would only add noise. Tapping
              the ETA chip above already opens the schedule for that
              route+headsign with the recent past departure annotated.
            */}
            {vehicle.isGhost !== true && <ScheduledDepartureChip />}
            <VehicleDropOffChip isDropOffOnly={isDropOffOnly} />
          </Box>
        )}

        {/* Arrival time information */}
        {arrivalTime && !isScheduled && (
          <Box display="flex" alignItems="center" gap={1} sx={{ mb: 1.5 }}>
            {(() => {
              // Format time difference without "ago" suffix
              const totalSeconds = Math.abs(arrivalTime.estimatedMinutes * 60);
              const minutes = Math.floor(totalSeconds / 60);
              const seconds = Math.floor(totalSeconds % 60);
              const timeFormat = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
              
              // Check statusMessage since status field is not included in StationVehicle.arrivalTime
              const isDeparted = arrivalTime.statusMessage.toLowerCase().includes('departed');
              const isAtStop = arrivalTime.statusMessage.toLowerCase().includes('at stop');
              
              return (
                <>
                  <Chip
                    icon={<ArrivalIcon />}
                    label={formatArrivalTime(arrivalTime)}
                    color={isDeparted ? 'default' : 'success'}
                    variant="filled"
                    size="small"
                    onClick={() => setArrivalToastOpen(true)}
                    sx={{ 
                      fontWeight: 'medium',
                      fontSize: { xs: '0.7rem', sm: '0.75rem' },
                      '& .MuiChip-icon': { color: 'inherit' },
                      cursor: 'pointer'
                    }}
                  />
                  
                  {/* Drop off only chip */}
                  <VehicleDropOffChip isDropOffOnly={isDropOffOnly} />
                </>
              );
            })()}
          </Box>
        )}



       

        {/* Stops section */}
        <Box>
          <Stack direction="row" alignItems="center" justifyContent="space-between">
            <Box 
              display="flex" 
              alignItems="center" 
              gap={1}
              sx={{ cursor: 'pointer' }}
              onClick={() => setStopsExpanded(!stopsExpanded)}
            >
              <IconButton 
                size="small"
                sx={{ 
                  transform: stopsExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                  transition: 'transform 0.2s'
                }}
              >
                <ExpandMoreIcon />
              </IconButton>
              <Typography variant="body2" sx={{ fontWeight: 500 }}>
                Stops ({tripStopCount})
              </Typography>
            </Box>
            
            <IconButton 
              size="small" 
              color="primary"
              onClick={() => setMapDialogOpen(true)}
            >
              <MapIcon />
            </IconButton>
          </Stack>

          <Collapse in={stopsExpanded} timeout="auto" unmountOnExit>
            <List dense sx={{ mt: 1 }}>
              {tripStops.length > 0 ? (
                tripStops.map((stop) => (
                  <ListItem key={stop.stopId} sx={{ py: 0.5, px: 0 }}>
                    <Box 
                      sx={{ 
                        width: 8, 
                        height: 8, 
                        borderRadius: '50%', 
                        bgcolor: stop.status === 'current' ? 'primary.main' : 
                                 stop.status === 'passed' ? 'success.main' : 'grey.400',
                        mr: 2,
                        mt: 0.5
                      }} 
                    />
                    <ListItemText 
                      primary={
                        <Stack direction="row" alignItems="center" spacing={1}>
                          <Typography 
                            variant="body2"
                            color={stop.status === 'current' ? 'primary.main' : 'text.primary'}
                          >
                            {stop.name}
                          </Typography>
                          {stop.stopId === station?.stop_id && (
                            <TargetStationIcon 
                              fontSize="small" 
                              color="primary" 
                              sx={{ opacity: 0.7 }}
                            />
                          )}
                        </Stack>
                      }
                    />
                  </ListItem>
                ))
              ) : (
                  <ListItem sx={{ py: 0.5, px: 0 }}>
                    <ListItemText 
                      primary="No stop data available"
                      slotProps={{ 
                        primary: { 
                          variant: 'body2',
                          color: 'text.secondary',
                          fontStyle: 'italic'
                        }
                      }}
                    />
                  </ListItem>
              )}
            </List>
          </Collapse>
        </Box>
      </CardContent>
      
      {/* Vehicle Map Dialog */}
      {mapDialogOpen && (
        <VehicleMapDialog
          open={mapDialogOpen}
          onClose={() => setMapDialogOpen(false)}
          vehicleId={vehicle.id}
          targetStationId={station?.stop_id || null}
          vehicles={allStationVehicles}
          routes={routes}
          stations={stops}
          trips={isScheduled && trip ? [...trips, trip] : trips}
          stopTimes={mapStopTimes}
        />
      )}

      {/* Today / Tomorrow scheduled departure board.
        *
        * For a GHOST card (synthesized scheduled vehicle whose run is en route
        * with no live GPS), the user wants to see the schedule for that run's
        * START station — the place this bus departed from — not the station
        * they're currently at (which may be mid-route or a terminus). For all
        * other cards we keep the current behaviour (schedule for the station
        * the card belongs to). The ghost's trip is also PINNED as the past
        * entry so its scheduled departure shows as "Departed X min ago" in
        * the first cell, even when it's older than the regular 10-min window.
        */}
      {(() => {
        let dialogStation = station;
        let pinnedPastTripId: string | null = null;
        if (
          vehicle.isGhost === true &&
          vehicle.trip_id &&
          scheduleData?.stopTimes?.[vehicle.trip_id]
        ) {
          const sts = scheduleData.stopTimes[vehicle.trip_id];
          let firstSt = sts[0];
          for (const st of sts) if (st.q < firstSt.q) firstSt = st;
          const originStop = stops.find((s) => s.stop_id === firstSt.s);
          if (originStop) {
            dialogStation = { stop_id: originStop.stop_id, stop_name: originStop.stop_name };
            pinnedPastTripId = vehicle.trip_id;
          }
        }
        return (
          <ScheduleBoardDialog
            open={scheduleView !== null}
            initialMode={scheduleView ?? 'today'}
            station={dialogStation}
            routeId={route?.route_id ?? vehicle.route_id ?? null}
            routeShortName={routeShortName}
            headsign={trip?.trip_headsign ?? headsign}
            directionId={trip?.direction_id ?? null}
            pinnedPastTripId={pinnedPastTripId}
            onClose={() => setScheduleView(null)}
          />
        );
      })()}
      
      {/* Data Age Toast */}
      <Snackbar
        open={dataToastOpen}
        onClose={() => setDataToastOpen(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert 
          onClose={() => setDataToastOpen(false)} 
          severity="info" 
          variant="filled"
          sx={{ width: '100%' }}
        >
          {isScheduled ? (
            <>
              <Typography variant="body2" sx={{ fontWeight: 'bold', mb: 0.5 }}>
                Scheduled vehicle (no live GPS)
              </Typography>
              {vehicle.isGhost ? (
                <Typography variant="body2" sx={{ fontSize: '0.875rem' }}>
                  Position is estimated from the timetable, based on the last scheduled
                  stop {formatAbsoluteTime(new Date(vehicle.timestamp).getTime())}.
                </Typography>
              ) : (
                <Typography variant="body2" sx={{ fontSize: '0.875rem' }}>
                  Shown at its start station until its scheduled departure. Once a real
                  GPS vehicle appears for this run, it replaces this entry.
                </Typography>
              )}
            </>
          ) : dataAgeResult ? (
            <>
              <Typography variant="body2" sx={{ fontWeight: 'bold', mb: 0.5 }}>
                Data Freshness
              </Typography>
              <Typography variant="body2" sx={{ fontSize: '0.875rem' }}>
                Vehicle GPS: {formatAbsoluteTime(new Date(vehicle.timestamp).getTime())} ({formatDetailedRelativeTime(dataAgeResult.gpsAge)})
              </Typography>
              <Typography variant="body2" sx={{ fontSize: '0.875rem' }}>
                Last API fetch: {formatAbsoluteTime(vehicleRefreshTimestamp || Date.now())} ({formatDetailedRelativeTime(dataAgeResult.fetchAge)})
              </Typography>
              <Typography variant="body2" sx={{ fontSize: '0.875rem', mt: 0.5, fontStyle: 'italic' }}>
                {dataAgeResult.tip}
              </Typography>
            </>
          ) : (
            vehicleRefreshTimestamp ? `Fetched ${formatRelativeTime(vehicleRefreshTimestamp)}` : 'No data available'
          )}
        </Alert>
      </Snackbar>
      
      {/* Arrival Time Toast */}
      {arrivalTime && (() => {
        const totalSeconds = Math.abs(arrivalTime.estimatedMinutes * 60);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = Math.floor(totalSeconds % 60);
        const timeFormat = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
        
        const isDeparted = arrivalTime.statusMessage.toLowerCase().includes('departed');
        const isAtStop = arrivalTime.statusMessage.toLowerCase().includes('at stop');
        
        let mainMessage = '';
        if (isDeparted) {
          mainMessage = `Departed ${timeFormat} ago`;
        } else if (isAtStop) {
          mainMessage = 'At stop now';
        } else {
          mainMessage = `Arrival in ${timeFormat}`;
        }
        
        return (
          <Snackbar
            open={arrivalToastOpen}
            onClose={() => setArrivalToastOpen(false)}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
          >
            <Alert 
              onClose={() => setArrivalToastOpen(false)} 
              severity="info" 
              variant="filled"
              sx={{ width: '100%' }}
            >
              <Typography variant="body2" sx={{ fontWeight: 'bold', mb: 0.5 }}>
                ⏰ {mainMessage}
              </Typography>
              {vehicle.predictionMetadata?.positionMethod && vehicle.predictionMetadata?.positionApplied && (
                <Typography variant="body2" sx={{ fontSize: '0.875rem' }}>
                  📍 Position: {vehicle.predictionMetadata.positionMethod} ({
                    vehicle.predictionMetadata.timestampAge < 60000 ? 'high' : 
                    vehicle.predictionMetadata.timestampAge < 120000 ? 'medium' : 'low'
                  } confidence)
                </Typography>
              )}
              {vehicle.predictionMetadata?.speedMethod && (
                <Typography variant="body2" sx={{ fontSize: '0.875rem' }}>
                  🏃 Speed: {vehicle.predictionMetadata.speedMethod} ({vehicle.predictionMetadata.speedConfidence} confidence)
                </Typography>
              )}
            </Alert>
          </Snackbar>
        );
      })()}
    </Card>
  );
});

// Display name for debugging
StationVehicleList.displayName = 'StationVehicleList';