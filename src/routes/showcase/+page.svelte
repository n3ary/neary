<!-- Visual sandbox for every primitive in src/lib/ui/. Global AppLayout provides the chrome (header, status bar, bottom nav), so this page only renders the primitive demos. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import {
    Avatar, BackButton, Box, Button, Card, CardContent, Chip,
    Collapsible, Dialog, DialogContent, DialogTitle, FavoriteStationRow,
    IconButton, InfoCard, List, ListItem, ListItemText, SelectFeedCard,
    ProgressBar, RouteBadge, RouteChipsRow, Spinner, Stack,
    StationCard, StatusDot, Switch, Tabs, TextField,
    ToggleGroup, Tooltip, TripStopList, Typography, TypeBadge, VehicleCard,
  } from '$lib/ui';
  import type { Route, Station, Vehicle, VehicleType } from '$lib/domain/types';
  import type { ScheduleTripStop, StopWithDistance } from '$lib/data/gtfs/types';
  import type { BoardRow } from '$lib/domain/stationBoard';
  import { statusBus } from '$lib/stores/statusBus.svelte';
  import { userPrefs, type Theme } from '$lib/stores/userPrefs.svelte';
  import {
    Bus, Locate, MapPin, RefreshCw, Search, Sun, Moon,
  } from 'lucide-svelte';

  // Interactive state
  let switchOn = $state(true);
  let collapsibleOpen = $state(false);
  let dialogOpen = $state(false);
  let textValue = $state('');
  let progressValue = $state(35);
  let tabsValue = $state<'today' | 'tomorrow' | 'week'>('today');

  // Composite-primitives demo data
  const route24: Route = { id: '24',  shortName: '24', color: '#1e88e5' };
  const route35: Route = { id: '35',  shortName: '35', color: '#43a047' };
  const route9: Route  = { id: '9',   shortName: '9',  color: '#fdd835' };
  const routeM: Route  = { id: '100', shortName: 'M5', color: '#e53935' };

  // Sample catalog used by the TypeBadge demo below. Mirrors the
  // real /favorites page: each chip's color is taken straight from a
  // route of that type in the catalog. The data layer is responsible
  // for whatever color it ships (including its own neutral fallback);
  // this page does no color logic.
  const showcaseModeRoutes: Route[] = [
    { id: 's-bus-1',    shortName: '24', color: '#1e88e5', type: 'bus' },
    { id: 's-tram-1',   shortName: '101', color: '#43a047', type: 'tram' },
    { id: 's-trolly-1', shortName: '8',  color: '#fdd835', type: 'trolleybus' },
    { id: 's-metro-1',  shortName: 'M5', color: '#e53935', type: 'metro' },
  ];
  const showcaseModeColors = new Map<VehicleType, string>();
  for (const r of showcaseModeRoutes) {
    const t = r.type ?? 'unknown';
    if (!showcaseModeColors.has(t)) showcaseModeColors.set(t, r.color);
  }

  const demoStation: Station = {
    id: '4012', name: 'Piața Mihai Viteazul',
    distance: 120, lat: 46.7712, lon: 23.6236,
  };

  const demoVehicles: Vehicle[] = [
    { kind: 'gps-only', id: 'v-gps-only-1', route: route24, type: 'bus',
      position: { lat: 46.7700, lon: 23.6240, source: 'gps', asOf: Date.now() - 8_000 },
      eta: { distanceMeters: 220, minutes: 3, confidence: 'medium' },
      confidence: 'medium',
      liveSources: ['gtfs-rt'],
      headsign: 'Mănăștur' },
    { kind: 'tracked', id: 'v-tracked-1', route: route35, type: 'bus',
      position: { lat: 46.7693, lon: 23.6219, source: 'gps', asOf: Date.now() - 12_000 },
      schedule: { tripId: 't-35-103', scheduledDeparture: 14 * 60 + 27, headsign: 'Aeroport' },
      eta: { distanceMeters: 540, minutes: 8, confidence: 'high' },
      confidence: 'medium',
      liveSources: ['gtfs-rt'] },
    { kind: 'verified', id: 'v-verified-1', route: route24, type: 'tram',
      position: { lat: 46.7705, lon: 23.6230, source: 'gps', asOf: Date.now() - 4_000 },
      schedule: { tripId: 't-24-201', scheduledDeparture: 14 * 60 + 30, headsign: 'Gara' },
      eta: { distanceMeters: 120, minutes: 1, confidence: 'high' },
      confidence: 'high',
      liveSources: ['gtfs-rt'] },
    { kind: 'scheduled', id: 'v-interpolated-1', route: route9, type: 'trolleybus',
      schedule: { tripId: 't-9-44', scheduledDeparture: 14 * 60 + 32, headsign: 'Gara Cluj' },
      position: { lat: 46.7710, lon: 23.6225, source: 'predicted-from-schedule', asOf: Date.now() },
      confidence: 'low' },
    { kind: 'scheduled', id: 'v-sched-1', route: routeM, type: 'metro',
      schedule: { tripId: 't-M5-72', scheduledDeparture: 14 * 60 + 45, headsign: 'Centru' },
      confidence: 'low' },
  ];

  let stationExpanded = $state(true);
  let selectedRouteId = $state<string | null>(null);
  let activeTypeFilter = $state<VehicleType | null>(null);
  const favorites = new Set<string>(['35']);
  // All routes serving the demo station (pre-filter), so the badge row
  // stays stable when a single route is selected.
  const demoAllRoutes = Array.from(
    new Map(demoVehicles.map((v) => [v.route.id, v.route])).values(),
  );

  // TripStopList demo — a short arm of a fabricated route with times
  // roughly 2 min apart. Matches the shape returned by the worker's
  // getStopsAlongTrip.
  const demoTripStops: ScheduleTripStop[] = [
    { stopId: '4012', stopName: 'Piața Mihai Viteazul', lat: 46.7712, lon: 23.6236,
      arrivalTime: '08:15:00', arrivalMin: 8 * 60 + 15, stopSequence: 1 },
    { stopId: '4020', stopName: 'Regina Maria', lat: 46.7695, lon: 23.6212,
      arrivalTime: '08:17:00', arrivalMin: 8 * 60 + 17, stopSequence: 2 },
    { stopId: '4034', stopName: 'Cipariu', lat: 46.7681, lon: 23.6188,
      arrivalTime: '08:19:00', arrivalMin: 8 * 60 + 19, stopSequence: 3 },
    { stopId: '4041', stopName: 'Sigma Center', lat: 46.7670, lon: 23.6154,
      arrivalTime: '08:22:00', arrivalMin: 8 * 60 + 22, stopSequence: 4 },
    { stopId: '4055', stopName: 'Gara CFR', lat: 46.7654, lon: 23.6117,
      arrivalTime: '08:26:00', arrivalMin: 8 * 60 + 26, stopSequence: 5 },
  ];

  // Search-overlay station row demo — a plausible station with several
  // routes so the fit calculator has something to overflow into a +N
  // chip on narrow viewports.
  const demoSearchStop: StopWithDistance = {
    id: '4012', name: 'Piața Mihai Viteazul',
    distance: 180, lat: 46.7712, lon: 23.6236,
  };
  const demoSearchRoutes: Route[] = [
    { id: '9',    shortName: '9',    color: '#fdd835', hasSchedule: true },
    { id: '24',   shortName: '24',   color: '#1e88e5', hasSchedule: true },
    { id: '35',   shortName: '35',   color: '#43a047', hasSchedule: true },
    { id: '43B',  shortName: '43B',  color: '#8e24aa', hasSchedule: true },
    { id: '102L', shortName: '102L', color: '#00838f', hasSchedule: true },
    { id: 'M26',  shortName: 'M26',  color: '#e53935', hasSchedule: true },
    { id: '25N',  shortName: '25N',  color: '#3949ab', hasSchedule: true },
    { id: '5N',   shortName: '5N',   color: '#5e35b1', hasSchedule: true },
  ];
  // Same data, padded to 20 routes so the +N overflow chip is visible
  // regardless of the card width the showcase renders at.
  const demoManyRoutes: Route[] = [
    ...demoSearchRoutes,
    { id: '1',    shortName: '1',    color: '#e91e63', hasSchedule: true },
    { id: '6',    shortName: '6',    color: '#3f51b5', hasSchedule: true },
    { id: '7',    shortName: '7',    color: '#009688', hasSchedule: true },
    { id: '14',   shortName: '14',   color: '#ff5722', hasSchedule: true },
    { id: '19',   shortName: '19',   color: '#795548', hasSchedule: true },
    { id: '22',   shortName: '22',   color: '#607d8b', hasSchedule: true },
    { id: '24B',  shortName: '24B',  color: '#9c27b0', hasSchedule: true },
    { id: '29',   shortName: '29',   color: '#673ab7', hasSchedule: true },
    { id: '30',   shortName: '30',   color: '#4caf50', hasSchedule: true },
    { id: '42',   shortName: '42',   color: '#ff9800', hasSchedule: true },
    { id: '52',   shortName: '52',   color: '#03a9f4', hasSchedule: true },
    { id: '54N',  shortName: '54N',  color: '#e91e63', hasSchedule: true },
  ];

  onMount(() => {
    statusBus.push({
      id: 'demo-info', kind: 'info',
      message: 'StatusBar lives in the global layout. Push more from the buttons below.',
      ttlMs: 0,
    });
  });

  function demo(kind: 'error' | 'warning' | 'success' | 'info' | 'loading' | 'progress') {
    if (kind === 'loading') {
      statusBus.push({ id: `demo-${kind}`, kind, message: 'Loading schedule…' });
      setTimeout(() => statusBus.dismiss(`demo-${kind}`), 2500);
      return;
    }
    if (kind === 'progress') {
      const id = `demo-${kind}`;
      statusBus.push({ id, kind, message: 'Downloading agency database', progress: 0 });
      let pct = 0;
      const t = setInterval(() => {
        pct += 13;
        if (pct >= 100) { clearInterval(t); statusBus.dismiss(id); }
        else statusBus.progress(id, pct);
      }, 200);
      return;
    }
    statusBus.push({
      id: `demo-${kind}-${Date.now()}`, kind,
      message: ({
        error: 'Something went wrong loading vehicles.',
        warning: 'Schedule is more than 24h old.',
        success: 'Schedule refreshed.',
        info: 'Tap a route to see its schedule.',
      })[kind],
    });
  }
</script>

<svelte:head>
  <title>Showcase — neary v2</title>
</svelte:head>

<main class="mx-auto max-w-3xl px-4 py-6 space-y-10">
  <header>
    <Typography variant="h2">UI primitives</Typography>
    <Typography variant="body2" class="text-[color:var(--color-fg-muted)]">
      Every primitive in <code>$lib/ui</code>, exercised. Header / status bar / bottom nav now
      live in the global layout; theme switching is in
      <a href="/settings" class="underline">Settings</a>.
    </Typography>
  </header>

  <section class="space-y-3">
    <Typography variant="h4">StatusBar</Typography>
    <Stack direction="row" spacing={1} wrap>
      <Button size="small" color="primary" onclick={() => demo('loading')}>loading</Button>
      <Button size="small" color="primary" onclick={() => demo('progress')}>progress</Button>
      <Button size="small" variant="outlined" onclick={() => demo('info')}>info</Button>
      <Button size="small" variant="outlined" onclick={() => demo('success')}>success</Button>
      <Button size="small" variant="outlined" color="danger" onclick={() => demo('warning')}>warning</Button>
      <Button size="small" color="danger" onclick={() => demo('error')}>error</Button>
      <Button size="small" variant="text" onclick={() => statusBus.clear()}>clear</Button>
    </Stack>
  </section>

  <section class="space-y-3">
    <Typography variant="h4">Buttons</Typography>
    <Stack direction="row" spacing={1} wrap align="center">
      <Button>Contained</Button>
      <Button variant="outlined">Outlined</Button>
      <Button variant="text">Text</Button>
      <Button color="danger">Danger</Button>
      <Button variant="outlined" color="danger">Outlined danger</Button>
      <Button disabled>Disabled</Button>
    </Stack>
    <Stack direction="row" spacing={1} wrap align="center">
      <Button size="small">Small</Button>
      <Button size="medium">Medium</Button>
      <Button size="large">Large</Button>
    </Stack>
    {#snippet refreshIcon()}<RefreshCw size={16} />{/snippet}
    <Stack direction="row" spacing={1} wrap align="center">
      <Button startIcon={refreshIcon}>Refresh</Button>
      <IconButton aria-label="Search"><Search size={20} /></IconButton>
      <IconButton color="primary" aria-label="Locate"><Locate size={20} /></IconButton>
      <BackButton fallback="/" />
    </Stack>
  </section>

  <section class="space-y-3">
    <Typography variant="h4">Chips</Typography>
    <Stack direction="row" spacing={1} wrap align="center">
      <Chip>Default</Chip>
      <Chip color="primary">Primary</Chip>
      <Chip color="success">Success</Chip>
      <Chip color="warning">Warning</Chip>
      <Chip color="danger">Danger</Chip>
    </Stack>
    <Stack direction="row" spacing={1} wrap align="center">
      <Chip variant="outlined">Outlined</Chip>
      <Chip variant="outlined" color="primary">Primary</Chip>
      <Chip variant="outlined" color="danger">Drop off only</Chip>
    </Stack>
    <Stack direction="row" spacing={1} wrap align="center">
      <Chip size="small">small</Chip>
      <Chip size="medium">medium</Chip>
      <Chip onclick={() => demo('info')}>clickable</Chip>
      <Chip>
        {#snippet icon()}<MapPin size={12} />{/snippet}
        120 m
      </Chip>
    </Stack>
  </section>

  <section class="space-y-3">
    <Typography variant="h4">Avatars & Spinner</Typography>
    <Stack direction="row" spacing={1.5} align="center">
      <Avatar size={32}><Bus size={16} /></Avatar>
      <Avatar size={40}><Bus size={20} /></Avatar>
      <Avatar size={48}><Bus size={24} /></Avatar>
      <Avatar variant="square" class="w-10 h-10 sm:w-12 sm:h-12"><Bus size={20} /></Avatar>
      <Spinner size={20} />
      <Spinner size={28} />
    </Stack>
  </section>

  <section class="space-y-3">
    <Typography variant="h4">StatusDot — health indicator</Typography>
    <Typography variant="caption" class="text-[color:var(--color-fg-muted)]">
      Used by the global Header to surface GPS / Connection / Schedule / Live health.
      'off' state is muted with a faint ring — used for GPS when the user hasn't opted in.
    </Typography>
    <Stack direction="row" spacing={2} align="center">
      <Stack spacing={0.5} align="center">
        <StatusDot state="ok" label="Live" tooltip="Fresh data" pulse />
        <Typography variant="caption">ok</Typography>
      </Stack>
      <Stack spacing={0.5} align="center">
        <StatusDot state="stale" label="Live" tooltip="Slow updates" />
        <Typography variant="caption">stale</Typography>
      </Stack>
      <Stack spacing={0.5} align="center">
        <StatusDot state="error" label="Live" tooltip="No data" />
        <Typography variant="caption">error</Typography>
      </Stack>
      <Stack spacing={0.5} align="center">
        <StatusDot state="idle" label="GPS" tooltip="Waiting for fix" />
        <Typography variant="caption">idle</Typography>
      </Stack>
      <Stack spacing={0.5} align="center">
        <StatusDot state="off" label="GPS" tooltip="GPS off — tap to enable"
          onclick={() => demo('info')} />
        <Typography variant="caption">off (tappable)</Typography>
      </Stack>
    </Stack>
  </section>

  <section class="space-y-1">
    <Typography variant="h4">Typography</Typography>
    <Typography variant="h1">Heading 1</Typography>
    <Typography variant="h2">Heading 2</Typography>
    <Typography variant="h3">Heading 3</Typography>
    <Typography variant="h4">Heading 4</Typography>
    <Typography variant="h5">Heading 5</Typography>
    <Typography variant="h6">Heading 6</Typography>
    <Typography variant="body">Body text — used for most regular content.</Typography>
    <Typography variant="body2">Body 2 — secondary text.</Typography>
    <Typography variant="caption">Caption — small muted text.</Typography>
    <Typography variant="overline">Overline label</Typography>
  </section>

  <section class="space-y-4">
    <Typography variant="h4">Form controls</Typography>

    <Stack spacing={2}>
      <TextField
        label="API key"
        placeholder="Optional — for live tracking"
        helperText="Add in Settings to enable real-time data."
        bind:value={textValue}
      />
      <TextField
        label="With error"
        value="bad-input"
        error
        helperText="This value is not valid."
      />
    </Stack>

    <Stack direction="row" spacing={2} align="center">
      <Switch
        checked={switchOn}
        onchange={(v) => (switchOn = v)}
        aria-label="Toggle scheduled-only vehicles"
      />
      <Typography variant="body2">Show scheduled-only vehicles</Typography>
    </Stack>

    <Stack spacing={1}>
      <Typography variant="body2">ProgressBar</Typography>
      <ProgressBar value={progressValue} />
      <Stack direction="row" spacing={1} align="center">
        <Button size="small" variant="outlined" onclick={() => (progressValue = Math.max(0, progressValue - 10))}>−10%</Button>
        <Button size="small" variant="outlined" onclick={() => (progressValue = Math.min(100, progressValue + 10))}>+10%</Button>
        <Typography variant="caption">{progressValue}%</Typography>
      </Stack>
    </Stack>
  </section>

  <section class="space-y-4">
    <Typography variant="h4">Overlays & motion</Typography>

    <Stack direction="row" spacing={1.5} align="center" wrap>
      <Tooltip title="Hover or focus to see me" placement="top">
        <Button variant="outlined" size="small">Hover for tooltip</Button>
      </Tooltip>
      <Tooltip title="Tooltip on a chip works too" placement="right">
        <Chip color="primary">Hover me</Chip>
      </Tooltip>
      <Tooltip title="Bottom tooltip" placement="bottom">
        <IconButton aria-label="Info"><Search size={18} /></IconButton>
      </Tooltip>
    </Stack>

    <Stack spacing={1}>
      <Button variant="outlined" size="small" onclick={() => (collapsibleOpen = !collapsibleOpen)}>
        {collapsibleOpen ? 'Hide' : 'Show'} collapsible
      </Button>
      <Collapsible in={collapsibleOpen}>
        <Card>
          <CardContent>
            <Typography variant="body2">
              Pure CSS grid-template-rows 1fr↔0fr — no JS height measurement,
              interruptible, respects reduced motion.
            </Typography>
          </CardContent>
        </Card>
      </Collapsible>
    </Stack>

    <div>
      <Button onclick={() => (dialogOpen = true)}>Open dialog</Button>
    </div>
  </section>

  <section class="space-y-4">
    <Typography variant="h4">Selection & lists</Typography>

    <Stack spacing={1}>
      <Typography variant="body2">Tabs</Typography>
      <Tabs
        value={tabsValue}
        onchange={(v: typeof tabsValue) => (tabsValue = v)}
        items={[
          { value: 'today', label: 'Today' },
          { value: 'tomorrow', label: 'Tomorrow' },
          { value: 'week', label: 'This week' },
        ]}
      />
      <Typography variant="caption">Active: {tabsValue}</Typography>
    </Stack>

    {#snippet sunIcon()}<Sun size={16} />{/snippet}
    {#snippet autoIcon()}<Locate size={16} />{/snippet}
    {#snippet moonIcon()}<Moon size={16} />{/snippet}
    <Stack spacing={1}>
      <Typography variant="body2">ToggleGroup — bound to userPrefs.theme</Typography>
      <Stack direction="row" spacing={1} align="center" wrap>
        <ToggleGroup
          value={userPrefs.theme}
          onchange={(v: Theme) => (userPrefs.theme = v)}
          items={[
            { value: 'light', label: 'Light', icon: sunIcon },
            { value: 'auto', label: 'Auto', icon: autoIcon },
            { value: 'dark', label: 'Dark', icon: moonIcon },
          ]}
        />
        <ToggleGroup
          size="small"
          value={userPrefs.theme}
          onchange={(v: Theme) => (userPrefs.theme = v)}
          items={[
            { value: 'light', 'aria-label': 'Light', icon: sunIcon },
            { value: 'auto', 'aria-label': 'Auto', icon: autoIcon },
            { value: 'dark', 'aria-label': 'Dark', icon: moonIcon },
          ]}
        />
      </Stack>
    </Stack>

    <Stack spacing={1}>
      <Typography variant="body2">List</Typography>
      <Card>
        <List>
          <ListItem button onclick={() => statusBus.push({ id: 'list-1', kind: 'info', message: 'Station 1 tapped' })}>
            <Avatar variant="square" size={36}><Bus size={18} /></Avatar>
            <ListItemText primary="Piața Mihai Viteazul" secondary="120 m · 6 routes" />
            <Chip size="small" color="success">Live</Chip>
          </ListItem>
          <ListItem button onclick={() => statusBus.push({ id: 'list-2', kind: 'info', message: 'Station 2 tapped' })}>
            <Avatar variant="square" size={36}><Bus size={18} /></Avatar>
            <ListItemText primary="Cluj Arena" secondary="340 m · 4 routes" />
            <Chip size="small" color="warning" variant="outlined">Schedule</Chip>
          </ListItem>
          <ListItem>
            <Avatar variant="square" size={36}><Bus size={18} /></Avatar>
            <ListItemText primary="Gara Cluj" secondary="1.2 km · 8 routes (read-only row)" />
          </ListItem>
        </List>
      </Card>
    </Stack>
  </section>

  <section class="space-y-4">
    <Typography variant="h4">Composite primitives</Typography>

    <Stack spacing={1}>
      <Typography variant="body2">RouteBadge</Typography>
      <Stack direction="row" spacing={1} align="center" wrap>
        <RouteBadge route={route24} size="small" />
        <RouteBadge route={route24} size="medium" />
        <RouteBadge route={route24} size="large" />
      </Stack>
      <Stack direction="row" spacing={1} align="center" wrap>
        <RouteBadge route={route24} isStart />
        <RouteBadge route={route24} isEnd />
        <RouteBadge route={route24} isStart isEnd aria-label="Turnaround route 24" />
        <RouteBadge route={route9} />
        <RouteBadge route={route35} selected onclick={() => statusBus.push({ id: 'rb-click', kind: 'info', message: 'Route 35 clicked' })} />
        <RouteBadge route={routeM} />
      </Stack>
    </Stack>

    <Stack spacing={1}>
      <Typography variant="body2">TypeBadge — single-select filter pattern</Typography>
      <Stack direction="row" spacing={1} align="center" wrap>
        {#each (['bus', 'tram', 'trolleybus', 'metro'] as VehicleType[]) as t (t)}
          <TypeBadge
            type={t}
            color={showcaseModeColors.get(t)}
            active={activeTypeFilter === t}
            onclick={() => { activeTypeFilter = activeTypeFilter === t ? null : t; }}
          />
        {/each}
      </Stack>
      <Typography variant="caption" class="text-[color:var(--color-fg-muted)]">
        Active: {activeTypeFilter ?? 'none'}
      </Typography>
    </Stack>

    <Stack spacing={1}>
      <Typography variant="body2">VehicleCard — one of each kind, with schedule + map links</Typography>
      <Stack spacing={0.5}>
        {#each demoVehicles as v (v.id)}
          <VehicleCard
            vehicle={v}
            scheduleHref={`/schedule/route/${v.route.id}_0`}
            mapHref={v.schedule?.tripId ? `/map/route/${v.route.id}_0/${encodeURIComponent(v.schedule.tripId)}` : `/map/route/${v.route.id}_0`}
          />
        {/each}
      </Stack>
    </Stack>

    <Stack spacing={1}>
      <Typography variant="body2">StationCard — with route colors + isStart ▶</Typography>
      <StationCard
        station={demoStation}
        rows={(demoVehicles
          .map((v, i) => ({
            vehicle: v,
            bucket: (['arriving', 'at-station', 'incoming', 'incoming', 'incoming'] as const)[i] ?? 'incoming',
            etaMinutes: v.eta?.minutes ?? 0,
          })) as BoardRow[])
          .filter((r) => selectedRouteId == null || r.vehicle.route.id === selectedRouteId)}
        allRoutes={demoAllRoutes}
        expanded={stationExpanded}
        ontoggle={() => (stationExpanded = !stationExpanded)}
        dropOffOnly={false}
        selectedRouteId={selectedRouteId}
        onRouteClick={(id: string) => (selectedRouteId = selectedRouteId === id ? null : id)}
        favoriteRouteIds={favorites}
        originRouteIds={new Set(['24'])}
      />
    </Stack>

    <Stack spacing={1}>
      <Typography variant="body2">TripStopList — ordered stops of a single trip</Typography>
      <Typography variant="caption" class="text-[color:var(--color-fg-muted)]">
        Same component the station card renders under an expanded vehicle and the schedule
        view renders under an expanded trip. Each row links to /station/[id].
      </Typography>
      <TripStopList stops={demoTripStops} showDepartureMarker />
    </Stack>

    <Stack spacing={1}>
      <Typography variant="body2">FavoriteStationRow — search-overlay row with route chips</Typography>
      <Typography variant="caption" class="text-[color:var(--color-fg-muted)]">
        Same row the favorites surfaces use. With hasGps=true the
        distance chip renders next to the station name. Chip row
        uses bind:clientWidth to fit as many badges as the card
        width allows, then collapses the rest into a +N chip.
        Resize the browser to see the count change.
      </Typography>
      <FavoriteStationRow
        stop={demoSearchStop}
        routes={demoSearchRoutes}
        hasGps
        isFav={false}
        onToggleFavorite={() => statusBus.push({ id: 'fsr-fav', kind: 'info', message: 'Toggled favorite (demo)' })}
        onbodyclick={() => statusBus.push({ id: 'fsr-click', kind: 'info', message: 'Would open /station/<id>' })}
      />
    </Stack>

    <Stack spacing={1}>
      <Typography variant="body2">RouteChipsRow — fit-driven, fills the available space</Typography>
      <Typography variant="caption" class="text-[color:var(--color-fg-muted)]">
        Same chip row FavoriteStationRow uses. The visible count is the
        natural fit: the largest N such that N badges + a "+M" chip fits
        the measured rowWidth, with `+N` appearing only when the
        catalogue genuinely overflows. The row fills the available space
        before collapsing via +N. Pass maxVisible to force a hard upper
        bound. Resize the browser to watch the count and the +N move.
      </Typography>
      <Stack spacing={1}>
        <Stack spacing={0.5}>
          <Typography variant="caption" class="text-[color:var(--color-fg-muted)]">
            3 routes (fits; no +N)
          </Typography>
          <RouteChipsRow routes={demoSearchRoutes.slice(0, 3)} />
        </Stack>
        <Stack spacing={0.5}>
          <Typography variant="caption" class="text-[color:var(--color-fg-muted)]">
            8 routes (fits on wide; +N on narrow)
          </Typography>
          <RouteChipsRow routes={demoSearchRoutes} />
        </Stack>
        <Stack spacing={0.5}>
          <Typography variant="caption" class="text-[color:var(--color-fg-muted)]">
            20 routes (overflows; +N chip)
          </Typography>
          <RouteChipsRow routes={demoManyRoutes} />
        </Stack>
        <Stack spacing={0.5}>
          <Typography variant="caption" class="text-[color:var(--color-fg-muted)]">
            20 routes, maxVisible=8 (caller override; tight cap)
          </Typography>
          <RouteChipsRow routes={demoManyRoutes} maxVisible={8} />
        </Stack>
      </Stack>
    </Stack>

    <Stack spacing={1}>
      <Typography variant="body2">InfoCard — reusable empty / info-state banner</Typography>
      <Typography variant="caption" class="text-[color:var(--color-fg-muted)]">
        Used across the Stations view for feed / location / wrong-feed prompts. Icon variant
        tints only the icon so the card stays neutral.
      </Typography>
      <Stack spacing={1}>
        <InfoCard variant="primary" title="Location needed">
          {#snippet icon()}<MapPin size={16} />{/snippet}
          {#snippet body()}
            Enable location and we'll surface stops near you automatically.
          {/snippet}
          {#snippet actions()}
            <Button variant="contained" size="small" onclick={() => demo('info')}>
              Enable location
            </Button>
            <Button variant="text" size="small" onclick={() => demo('info')}>
              Search
            </Button>
          {/snippet}
        </InfoCard>
        <InfoCard variant="warning" title="Wrong feed for your location">
          {#snippet icon()}<MapPin size={16} />{/snippet}
          {#snippet body()}
            Your selected feed <strong>Cluj-Napoca</strong> is about 320 km away, so nearby
            stops won't be available. <strong>Bucuresti-Ilfov</strong> covers your current
            location — switch with one tap.
          {/snippet}
          {#snippet actions()}
            <Button variant="contained" size="small" onclick={() => demo('info')}>
              Switch to Bucuresti-Ilfov
            </Button>
          {/snippet}
        </InfoCard>
        <InfoCard variant="danger" title="Failed to load nearby stations">
          {#snippet body()}Worker connection lost.{/snippet}
        </InfoCard>
      </Stack>
    </Stack>

    <Stack spacing={1}>
      <Typography variant="body2">SelectFeedCard — the "no feed bound" banner used across the app</Typography>
      <Typography variant="caption" class="text-[color:var(--color-fg-muted)]">
        Rendered by the home Stations view, /favorites, /station/[id], /schedule/route,
        and /map/route. Self-contained: reads location + feed catalogue directly and picks
        one of three body/action variants (covering / no-coverage / GPS-off).
      </Typography>
      <SelectFeedCard fallbackBody="Pick a feed in Settings to browse routes and schedules." />
    </Stack>
  </section>
</main>

<Dialog open={dialogOpen} onclose={() => (dialogOpen = false)} maxWidth="sm">
  <DialogTitle onclose={() => (dialogOpen = false)}>Dialog title</DialogTitle>
  <DialogContent>
    <Stack spacing={2}>
      <Typography variant="body2">
        bits-ui handles the focus trap, the Escape key, the overlay click, and scroll
        locking on the body. Styling and copy are ours.
      </Typography>
      <Stack direction="row" spacing={1} justify="end">
        <Button variant="text" onclick={() => (dialogOpen = false)}>Cancel</Button>
        <Button onclick={() => (dialogOpen = false)}>Confirm</Button>
      </Stack>
    </Stack>
  </DialogContent>
</Dialog>
