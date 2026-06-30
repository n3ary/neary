<!--
  /showcase — visual sandbox for every primitive in src/lib/ui/. The global
  AppLayout (in +layout.svelte) provides the header, status bar, and bottom
  nav, so this page only renders the primitive demos.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import {
    Avatar, Box, Button, Card, CardContent, Chip,
    Collapsible, Dialog, DialogContent, DialogTitle,
    IconButton, List, ListItem, ListItemText,
    ProgressBar, RouteBadge, Spinner, Stack, StationCard,
    Switch, Tabs, TextField, ToggleGroup, Tooltip, Typography, TypeBadge, VehicleCard,
  } from '$lib/ui';
  import type { Route, Station, Vehicle, VehicleType } from '$lib/domain/types';
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
    id: 4012, name: 'Piața Mihai Viteazul',
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
      liveSources: ['gtfs-rt', 'tranzy'] },
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
        aria-label="Toggle ghost vehicles"
      />
      <Typography variant="body2">Show ghost vehicles</Typography>
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
