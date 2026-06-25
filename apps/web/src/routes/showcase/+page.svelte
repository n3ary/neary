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
    IconButton, Spinner, Stack, StatusBar, Typography,
  } from '$lib/ui';
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
              <Typography variant="h6" class="truncate">Piața Mihai Viteazul</Typography>
              <Stack direction="row" spacing={1} align="center" wrap>
                <Chip size="small">{#snippet icon()}<MapPin size={12} />{/snippet}120 m</Chip>
                <Chip size="small" variant="outlined" color="danger">Drop off only</Chip>
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
              <Typography variant="h6">Cluj-Napoca → Mănăștur</Typography>
              <Typography variant="caption">Route 24 · Trolleybus · 12 stops</Typography>
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
</main>

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
