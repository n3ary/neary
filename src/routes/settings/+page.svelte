<!--
  Settings — user preferences. Theme picker, behavior toggles, and the
  feed selector (sources feeds.json from the neary-gtfs binaries branch via
  jsDelivr). Advanced settings (storage, API key, force reload, version,
  debug toggles) live at /settings/advanced — placeholder linked at the
  bottom for now.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { CheckCheck, Locate, Moon, Sun } from 'lucide-svelte';
  import {
    Box, Button, Card, CardContent, Chip, List, ListItem, ListItemText,
    Spinner, Stack, Switch, ToggleGroup, Typography,
    formatBytes,
  } from '$lib/ui';
  import { feedsStore } from '$lib/stores/feedsStore.svelte';
  import { userPrefs, type Theme } from '$lib/stores/userPrefs.svelte';

  onMount(() => {
    void feedsStore.load();
  });
</script>

<div class="mx-auto max-w-3xl px-4 py-6 space-y-6">
  <!-- ===== Display ===== -->
  <Card>
    <CardContent>
      <Stack spacing={2}>
        <Typography variant="h6">Display</Typography>

        <Stack spacing={1}>
          <Box>
            <Typography variant="body2">Vehicles per station card</Typography>
            <Typography variant="caption">Maximum number of vehicle rows shown on each station card.</Typography>
          </Box>
          <ToggleGroup
            size="small"
            value={String(userPrefs.stationBoardMaxRows)}
            onchange={(v: string) => (userPrefs.stationBoardMaxRows = Number(v))}
            items={[
              { value: '3', label: '3' },
              { value: '5', label: '5' },
              { value: '8', label: '8' },
              { value: '10', label: '10' },
            ]}
          />
        </Stack>

        <Stack spacing={1}>
          <Box>
            <Typography variant="body2">Theme</Typography>
            <Typography variant="caption">Auto follows your system preference (changes when iOS toggles dark mode).</Typography>
          </Box>
          <ToggleGroup
            size="small"
            value={userPrefs.theme}
            onchange={(v: Theme) => (userPrefs.theme = v)}
            items={[
              { value: 'light', label: 'Light', icon: sunIcon },
              { value: 'auto', label: 'Auto', icon: autoIcon },
              { value: 'dark', label: 'Dark', icon: moonIcon },
            ]}
          />
        </Stack>

        <Stack direction="row" align="center" justify="between">
          <Box class="flex-1 min-w-0">
            <Typography variant="body2">Show drop-off-only vehicles</Typography>
            <Typography variant="caption">Include vehicles that stop at this station only to let passengers off (you can't board). They get a "drop off only" chip when shown.</Typography>
          </Box>
          <Switch
            checked={userPrefs.showDropOffOnly}
            onchange={(v) => (userPrefs.showDropOffOnly = v)}
            aria-label="Show drop-off-only vehicles"
          />
        </Stack>

        <Stack direction="row" align="center" justify="between">
          <Box class="flex-1 min-w-0">
            <Typography variant="body2">Show recently departed vehicles</Typography>
            <Typography variant="caption">Include vehicles that already passed this station and are still en route to their terminus. One row per route (the most recent). Map view always shows them all.</Typography>
          </Box>
          <Switch
            checked={userPrefs.showDepartedVehicles}
            onchange={(v) => (userPrefs.showDepartedVehicles = v)}
            aria-label="Show recently departed vehicles"
          />
        </Stack>
      </Stack>
    </CardContent>
  </Card>

  <!-- ===== Feed ===== -->
  <Card>
    <CardContent>
      <Stack spacing={1.5}>
        <Typography variant="h6">Transit feed</Typography>
        <Typography variant="caption">
          Pick one. The schedule database downloads once and is cached for
          offline use. Feeds are published by
          <a href="https://github.com/ciotlosm/neary-gtfs" target="_blank" rel="noopener" class="underline">neary-gtfs</a>
          and served via jsDelivr.
        </Typography>

        {#if feedsStore.error}
          <Box class="text-[color:var(--color-danger)] text-sm">
            Failed to load feed list: {feedsStore.error}
          </Box>
        {:else if feedsStore.loading || !feedsStore.feeds}
          <Stack direction="row" spacing={1} align="center">
            <Spinner size={16} />
            <Typography variant="caption">Loading feed list…</Typography>
          </Stack>
        {:else}
          <List>
            {#each feedsStore.feeds as f (f.id)}
              {@const hasSqlite = f.files?.sqlite_gz != null}
              {@const selected = userPrefs.feedId === f.id}
              <ListItem
                button={hasSqlite}
                onclick={hasSqlite ? () => (userPrefs.feedId = f.id) : undefined}
                class={selected ? 'bg-[color:var(--color-primary)]/10' : ''}
              >
                <ListItemText
                  primary={f.name}
                  secondary={`${f.country}${f.region ? ' · ' + f.region : ''} · ${f.timezone}${f.size_bytes?.sqlite_gz ? ' · ' + formatBytes(f.size_bytes.sqlite_gz) : ''}`}
                />
                {#if selected}
                  <Chip size="small" color="primary">
                    {#snippet icon()}<CheckCheck size={12} />{/snippet}
                    Selected
                  </Chip>
                {:else if !hasSqlite}
                  <Chip size="small" variant="outlined">no data yet</Chip>
                {/if}
              </ListItem>
            {/each}
          </List>
        {/if}

        {#if userPrefs.feedId != null}
          <Stack direction="row" justify="end">
            <Button size="small" variant="outlined" color="danger" onclick={() => (userPrefs.feedId = null)}>
              Clear selection
            </Button>
          </Stack>
        {/if}
      </Stack>
    </CardContent>
  </Card>

  <!-- ===== Advanced ===== -->
  <Card>
    <CardContent>
      <Stack spacing={2}>
        <Typography variant="h6">Advanced</Typography>

        <Stack direction="row" align="center" justify="between">
          <Box class="flex-1 min-w-0">
            <Typography variant="body2">Show off-route vehicles</Typography>
            <Typography variant="caption">Diagnostic: include vehicles the reconciler couldn't match to the route shape (stale GPS, off the line). Not relevant in schedule-only mode; lights up once a live source is configured.</Typography>
          </Box>
          <Switch
            checked={userPrefs.showOffRouteVehicles}
            onchange={(v) => (userPrefs.showOffRouteVehicles = v)}
            aria-label="Show off-route vehicles"
          />
        </Stack>

        <Typography variant="caption">
          Storage breakdown, data freshness, force schedule reload, app version,
          and more debug toggles land in a separate view in Phase 7.
        </Typography>
      </Stack>
    </CardContent>
  </Card>
</div>

{#snippet sunIcon()}<Sun size={16} />{/snippet}
{#snippet autoIcon()}<Locate size={16} />{/snippet}
{#snippet moonIcon()}<Moon size={16} />{/snippet}