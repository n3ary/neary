<!--
  /showcase — visual sandbox for every primitive in src/lib/ui/.
  Renders each in its main variants and adds interactive controls for the
  primitives whose value is the whole point (StatusBar severities,
  BottomNavigation active state, theme toggle). Until Histoire / Storybook
  is wired up, this is the single page to eyeball during development.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import {
    Avatar, Box, Button, BottomNavigation, Card, CardContent, Chip,
    Collapsible, Dialog, DialogContent, DialogTitle,
    IconButton, List, ListItem, ListItemText,
    ProgressBar, RouteBadge, Spinner, Stack, StationCard, StatusBar,
    Switch, Tabs, TextField, ToggleGroup, Tooltip, Typography, VehicleCard,
  } from '$lib/ui';
  import type { Route, Station, Vehicle } from '$lib/domain/types';
  import { statusBus } from '$lib/stores/statusBus.svelte';
  import {
    Bus, Calendar, ChevronDown, EyeOff, Heart, Home, Locate, MapPin,
    RefreshCw, Search, Settings, Sun, Moon,
  } from 'lucide-svelte';

  // Bottom-nav active tab
  type Tab = 'stations' | 'favorites' | 'planner' | 'settings';
  let tab = $state<Tab>('stations');

  // Theme toggle so the showcase doubles as a dark-mode check
  let theme = $state<'auto' | 'light' | 'dark'>('auto');
  $effect(() => {
    document.documentElement.dataset.theme = theme;
  });

  // Interactive state for the controls section
  let switchOn = $state(true);
  let collapsibleOpen = $state(false);
  let dialogOpen = $state(false);
  let textValue = $state('');
  let progressValue = $state(35);

  // Tabs + ToggleGroup demo state
  let tabsValue = $state<'today' | 'tomorrow' | 'week'>('today');
  let mode = $state<'auto' | 'light' | 'dark'>('auto');
  $effect(() => {
    // Mirror the theme picker (top-right) so they stay in sync
    theme = mode;
  });

  // --- Composite-primitives demo data ----------------------------------------
  // A handful of routes with realistic CTP Cluj palette so the badges look like
  // they would in the real app.
  const route24: Route = { id: 24, shortName: '24', color: '#1e88e5' };
  const route35: Route = { id: 35, shortName: '35', color: '#43a047' };
  const route9:  Route = { id: 9,  shortName: '9',  color: '#fdd835' }; // yellow → black text
  const routeM:  Route = { id: 100, shortName: 'M5', color: '#e53935' };

  const demoStation: Station = {
    id: 4012,
    name: 'Piața Mihai Viteazul',
    distance: 120,
    lat: 46.7712,
    lon: 23.6236,
  };

  // One of each vehicle kind to show the full visual taxonomy.
  const demoVehicles: Vehicle[] = [
    {
      kind: 'live',
      id: 'v-live-1',
      route: route24,
      gps: { lat: 46.7700, lon: 23.6240, observedAt: Date.now() - 8_000 },
      eta: 3,
      headsign: 'Mănăștur',
    },
    {
      kind: 'live-matched',
      id: 'v-matched-1',
      route: route35,
      gps: { lat: 46.7693, lon: 23.6219, observedAt: Date.now() - 12_000 },
      schedule: { tripId: 't-35-103', scheduledDeparture: 14 * 60 + 27, headsign: 'Aeroport' },
      eta: 8,
    },
    {
      kind: 'ghost',
      id: 'v-ghost-1',
      route: route9,
      schedule: { tripId: 't-9-44', scheduledDeparture: 14 * 60 + 32, headsign: 'Gara Cluj' },
    },
    {
      kind: 'scheduled',
      id: 'v-sched-1',
      route: routeM,
      schedule: { tripId: 't-M5-72', scheduledDeparture: 14 * 60 + 45, headsign: 'Centru' },
    },
  ];

  let stationExpanded = $state(true);
  let selectedRouteId = $state<number | null>(null);
  const favorites = new Set<number>([35]);

  // Push one demo entry on mount so the StatusBar is non-empty on first paint
  onMount(() => {
    statusBus.push({
      id: 'demo-info',
      kind: 'info',
      message: 'StatusBar lives below the header and replaces toasts + per-view spinners.',
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
        if (pct >= 100) {
          clearInterval(t);
          statusBus.dismiss(id);
        } else statusBus.progress(id, pct);
      }, 200);
      return;
    }
    statusBus.push({
      id: `demo-${kind}-${Date.now()}`,
      kind,
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

<!-- The StatusBar normally sits inside the layout; here we mount it inline
     so the rest of the showcase content flows below it (same UX). -->
<StatusBar />

<main class="mx-auto max-w-3xl px-4 py-6 pb-32 space-y-10">
  <!-- ============================== Header ============================== -->
  <header class="flex items-center justify-between gap-3">
    <Typography variant="h2">UI primitives</Typography>
    <Stack direction="row" spacing={0.5} align="center">
      <IconButton onclick={() => (theme = 'light')} aria-label="Light"><Sun size={20} /></IconButton>
      <IconButton onclick={() => (theme = 'auto')} aria-label="Auto"><Locate size={20} /></IconButton>
      <IconButton onclick={() => (theme = 'dark')} aria-label="Dark"><Moon size={20} /></IconButton>
    </Stack>
  </header>

  <!-- ============================== Status bar demo ============================== -->
  <section class="space-y-3">
    <Typography variant="h4">StatusBar</Typography>
    <Typography variant="body2" class="text-[color:var(--color-fg-muted)]">
      Click to push messages of each severity. Loading/progress entries auto-resolve.
    </Typography>
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

  <!-- ============================== Buttons ============================== -->
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
    <Stack direction="row" spacing={1} wrap align="center">
      {#snippet refreshIcon()}<RefreshCw size={16} />{/snippet}
      <Button startIcon={refreshIcon}>Refresh</Button>
      <IconButton aria-label="Search"><Search size={20} /></IconButton>
      <IconButton color="primary" aria-label="Settings"><Settings size={20} /></IconButton>
      <IconButton color="danger" aria-label="Remove"><Heart size={20} /></IconButton>
    </Stack>
  </section>

  <!-- ============================== Chips ============================== -->
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

  <!-- ============================== Avatars & icons ============================== -->
  <section class="space-y-3">
    <Typography variant="h4">Avatars</Typography>
    <Stack direction="row" spacing={1.5} align="center">
      <Avatar size={32}><Bus size={16} /></Avatar>
      <Avatar size={40}><Bus size={20} /></Avatar>
      <Avatar size={48}><Bus size={24} /></Avatar>
      <Avatar variant="square" class="w-10 h-10 sm:w-12 sm:h-12"><Bus size={20} /></Avatar>
    </Stack>
  </section>

  <!-- ============================== Spinners ============================== -->
  <section class="space-y-3">
    <Typography variant="h4">Spinner</Typography>
    <Stack direction="row" spacing={1.5} align="center">
      <Spinner size={16} />
      <Spinner size={20} />
      <Spinner size={28} />
      <Spinner size={40} />
    </Stack>
  </section>

  <!-- ============================== Cards ============================== -->
  <section class="space-y-3">
    <Typography variant="h4">Cards</Typography>
    <Stack spacing={1.5}>
      <Card variant="station">
        <CardContent>
          <Stack direction="row" spacing={1.5} align="center">
            <Avatar variant="square" size={44}><Bus size={22} /></Avatar>
            <Box class="flex-1 min-w-0">
              <Stack spacing={0.5}>
                <Typography variant="h6" class="truncate">Piața Mihai Viteazul</Typography>
                <Stack direction="row" spacing={1} align="center" wrap>
                  <Chip size="small">{#snippet icon()}<MapPin size={12} />{/snippet}120 m</Chip>
                  <Chip size="small" variant="outlined" color="danger">Drop off only</Chip>
                </Stack>
              </Stack>
            </Box>
            <IconButton aria-label="Expand"><ChevronDown size={20} /></IconButton>
          </Stack>
        </CardContent>
      </Card>

      <Card variant="route">
        <CardContent>
          <Stack direction="row" spacing={1.5} align="center">
            <Avatar variant="square" size={44}>24</Avatar>
            <Box class="flex-1 min-w-0">
              <Stack spacing={0.5}>
                <Typography variant="h6">Cluj-Napoca → Mănăștur</Typography>
                <Typography variant="caption">Route 24 · Trolleybus · 12 stops</Typography>
              </Stack>
            </Box>
            <Chip color="success" size="small">Live</Chip>
          </Stack>
        </CardContent>
      </Card>

      <Card variant="vehicle">
        <CardContent>
          <Stack direction="row" spacing={1.5} align="center">
            <Avatar variant="square" size={44}>3D</Avatar>
            <Box class="flex-1 min-w-0">
              <Stack spacing={0.5}>
                <Typography variant="h6">Ghost vehicle</Typography>
                <Stack direction="row" spacing={1} align="center" wrap>
                  <Chip size="small" variant="outlined" color="warning">
                    {#snippet icon()}<EyeOff size={12} />{/snippet}
                    GPS missing
                  </Chip>
                  <Chip size="small">
                    {#snippet icon()}<Calendar size={12} />{/snippet}
                    Scheduled 14:32
                  </Chip>
                </Stack>
              </Stack>
            </Box>
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  </section>

  <!-- ============================== Typography ============================== -->
  <section class="space-y-1">
    <Typography variant="h4">Typography</Typography>
    <Typography variant="h1">Heading 1</Typography>
    <Typography variant="h2">Heading 2</Typography>
    <Typography variant="h3">Heading 3</Typography>
    <Typography variant="h4">Heading 4</Typography>
    <Typography variant="h5">Heading 5</Typography>
    <Typography variant="h6">Heading 6</Typography>
    <Typography variant="body">Body text — used for most regular content.</Typography>
    <Typography variant="body2">Body 2 — secondary text, slightly smaller.</Typography>
    <Typography variant="caption">Caption — small muted text.</Typography>
    <Typography variant="overline">Overline label</Typography>
  </section>

  <!-- ============================== Form controls ============================== -->
  <section class="space-y-4">
    <Typography variant="h4">Form controls</Typography>

    <Stack spacing={2}>
      <TextField
        label="API key"
        placeholder="Optional — for live tracking"
        helperText="Add later in Advanced settings to enable real-time data."
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
      <Switch bind:checked={switchOn} onchange={(v) => (switchOn = v)} aria-label="Toggle ghost vehicles" />
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

  <!-- ============================== Tooltip + Collapsible + Dialog ============================== -->
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
              Pure CSS expand/collapse via grid-template-rows: 1fr↔0fr — no JS height
              measurement, interruptible, respects reduced motion when the parent passes it.
              This is what every station card body will use.
            </Typography>
          </CardContent>
        </Card>
      </Collapsible>
    </Stack>

    <div>
      <Button onclick={() => (dialogOpen = true)}>Open dialog</Button>
    </div>
  </section>

  <!-- ============================== Tabs / Toggle / List ============================== -->
  <section class="space-y-4">
    <Typography variant="h4">Selection & lists</Typography>

    <Stack spacing={1}>
      <Typography variant="body2">Tabs (Today / Tomorrow / This week)</Typography>
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

  <!-- ============================== Composite primitives ============================== -->
  <section class="space-y-4">
    <Typography variant="h4">Composite primitives</Typography>

    <Stack spacing={1}>
      <Typography variant="body2">RouteBadge — sizes, markers, favorite, selected</Typography>
      <Stack direction="row" spacing={1} align="center" wrap>
        <RouteBadge route={route24} size="small" />
        <RouteBadge route={route24} size="medium" />
        <RouteBadge route={route24} size="large" />
      </Stack>
      <Stack direction="row" spacing={1} align="center" wrap>
        <RouteBadge route={route24} isStart />
        <RouteBadge route={route24} isEnd />
        <RouteBadge route={route24} isStart isEnd aria-label="Turnaround route 24" />
        <RouteBadge route={route9} isFavorite />
        <RouteBadge route={route35} selected onclick={() => statusBus.push({ id: 'rb-click', kind: 'info', message: 'Route 35 clicked' })} />
        <RouteBadge route={routeM} />
      </Stack>
    </Stack>

    <Stack spacing={1}>
      <Typography variant="body2">VehicleCard — one of each kind</Typography>
      <Stack spacing={0.5}>
        {#each demoVehicles as v (v.id)}
          <VehicleCard vehicle={v} />
        {/each}
      </Stack>
      <Typography variant="caption">
        Solid border = live or live-matched. Dashed = ghost (GPS missing).
        Dotted + 60% opacity = scheduled-only. Right-side badge encodes the kind.
      </Typography>
    </Stack>

    <Stack spacing={1}>
      <Typography variant="body2">StationCard — full unified shell</Typography>
      <StationCard
        station={demoStation}
        routes={[route24, route35, route9, routeM]}
        vehicles={demoVehicles}
        expanded={stationExpanded}
        ontoggle={() => (stationExpanded = !stationExpanded)}
        dropOffOnly={false}
        selectedRouteId={selectedRouteId}
        onRouteClick={(id: number) => (selectedRouteId = selectedRouteId === id ? null : id)}
        favoriteRouteIds={favorites}
      />
      <Typography variant="caption">
        Click a route badge to filter the expand region; click again to clear.
        Heart pip marks favorites (route 35 here). Expand toggle rotates 180°.
      </Typography>
    </Stack>
  </section>
    </Stack>

    <Stack spacing={1}>
      <Typography variant="body2">ToggleGroup (theme picker)</Typography>
      <Stack direction="row" spacing={1} align="center" wrap>
        {#snippet sunIcon()}<Sun size={16} />{/snippet}
        {#snippet locateIcon()}<Locate size={16} />{/snippet}
        {#snippet moonIcon()}<Moon size={16} />{/snippet}
        <ToggleGroup
          value={mode}
          onchange={(v: typeof mode) => (mode = v)}
          items={[
            { value: 'light', label: 'Light', icon: sunIcon },
            { value: 'auto', label: 'Auto', icon: locateIcon },
            { value: 'dark', label: 'Dark', icon: moonIcon },
          ]}
        />
        <ToggleGroup
          size="small"
          value={mode}
          onchange={(v: typeof mode) => (mode = v)}
          items={[
            { value: 'light', 'aria-label': 'Light', icon: sunIcon },
            { value: 'auto', 'aria-label': 'Auto', icon: locateIcon },
            { value: 'dark', 'aria-label': 'Dark', icon: moonIcon },
          ]}
        />
      </Stack>
    </Stack>

    <Stack spacing={1}>
      <Typography variant="body2">List (semantic, interactive rows)</Typography>
      <Card>
        <List>
          <ListItem button onclick={() => statusBus.push({ id: 'list-1', kind: 'info', message: 'Pretended to open station 1.' })}>
            <Avatar variant="square" size={36}><Bus size={18} /></Avatar>
            <ListItemText primary="Piața Mihai Viteazul" secondary="120 m · 6 routes" />
            <Chip size="small" color="success">Live</Chip>
          </ListItem>
          <ListItem button onclick={() => statusBus.push({ id: 'list-2', kind: 'info', message: 'Pretended to open station 2.' })}>
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

<!-- ============================== Bottom navigation ============================== -->
<BottomNavigation
  value={tab}
  onchange={(t: Tab) => (tab = t)}
  items={[
    { value: 'stations', label: 'Stations', icon: stationsIcon },
    { value: 'favorites', label: 'Favorites', icon: favoritesIcon },
    { value: 'planner', label: 'Planner', icon: plannerIcon },
    { value: 'settings', label: 'Settings', icon: settingsIcon },
  ]}
/>

{#snippet stationsIcon()}<MapPin size={20} />{/snippet}
{#snippet favoritesIcon()}<Heart size={20} />{/snippet}
{#snippet plannerIcon()}<Home size={20} />{/snippet}
{#snippet settingsIcon()}<Settings size={20} />{/snippet}
