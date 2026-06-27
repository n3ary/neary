<!--
  Settings — user preferences. Theme picker, behavior toggles, the feed
  selector (sources feeds.json from the neary-gtfs binaries branch on
  GitHub), and a tiny Advanced section with the app version + when this
  client first saw it. A dedicated /settings/advanced view will land
  alongside storage / debug toggles in a later phase.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { version } from '$app/environment';
  import { CheckCheck, Locate, Moon, Sun } from 'lucide-svelte';
  import {
    Box, Button, Card, CardContent, Chip, List, ListItem, ListItemText,
    Spinner, Stack, Switch, ToggleGroup, Typography,
    formatBytes, formatWhen,
  } from '$lib/ui';
  import { feedsStore } from '$lib/stores/feedsStore.svelte';
  import { userPrefs, type Theme } from '$lib/stores/userPrefs.svelte';

  /** localStorage key for tracking when this client first saw the current
   *  app version. Stored as `{ version, at }` so a version bump resets the
   *  timestamp on next load. */
  const VERSION_SEEN_KEY = 'neary:version-first-seen';

  let versionFirstSeenAt = $state<number | null>(null);

  onMount(() => {
    void feedsStore.load();

    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(VERSION_SEEN_KEY);
      const parsed = raw ? (JSON.parse(raw) as { version: string; at: number }) : null;
      if (parsed && parsed.version === version && typeof parsed.at === 'number') {
        versionFirstSeenAt = parsed.at;
      } else {
        const at = Date.now();
        localStorage.setItem(VERSION_SEEN_KEY, JSON.stringify({ version, at }));
        versionFirstSeenAt = at;
      }
    } catch {
      // localStorage unavailable or corrupted; fall back to "unknown"
    }
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
            <Typography variant="caption">Vehicles you can't board here. Marked with a chip.</Typography>
          </Box>
          <Switch
            checked={userPrefs.showDropOffOnly}
            onchange={(v) => (userPrefs.showDropOffOnly = v)}
            aria-label="Show drop-off-only vehicles"
          />
        </Stack>

        <Stack direction="row" align="center" justify="between">
          <Box class="flex-1 min-w-0">
            <Typography variant="body2">Show recently departed</Typography>
            <Typography variant="caption">Vehicles that just passed this stop. One row per route.</Typography>
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
          to the <code>binaries</code> branch.
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
            <Typography variant="caption">Diagnostic: vehicles too far from the route shape to match a trip.</Typography>
          </Box>
          <Switch
            checked={userPrefs.showOffRouteVehicles}
            onchange={(v) => (userPrefs.showOffRouteVehicles = v)}
            aria-label="Show off-route vehicles"
          />
        </Stack>

        <Stack spacing={0.5}>
          <Typography variant="body2">App version</Typography>
          <Typography variant="caption">
            v{version} · updated {formatWhen(versionFirstSeenAt)}
          </Typography>
        </Stack>
      </Stack>
    </CardContent>
  </Card>
</div>

{#snippet sunIcon()}<Sun size={16} />{/snippet}
{#snippet autoIcon()}<Locate size={16} />{/snippet}
{#snippet moonIcon()}<Moon size={16} />{/snippet}