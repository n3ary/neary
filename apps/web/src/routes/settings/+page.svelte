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
    Spinner, Stack, Switch, TextField, ToggleGroup, Typography,
  } from '$lib/ui';
  import { feedsStore } from '$lib/stores/feedsStore.svelte';
  import { userPrefs, type Theme } from '$lib/stores/userPrefs.svelte';

  onMount(() => {
    void feedsStore.load();
  });

  function fmtBytes(n: number | undefined | null): string {
    if (!n) return '';
    return n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
  }
</script>

<div class="mx-auto max-w-3xl px-4 py-6 space-y-6">
  <!-- ===== Theme ===== -->
  <Card>
    <CardContent>
      <Stack spacing={1.5}>
        <Typography variant="h6">Theme</Typography>
        <ToggleGroup
          value={userPrefs.theme}
          onchange={(v: Theme) => (userPrefs.theme = v)}
          items={[
            { value: 'light', label: 'Light', icon: sunIcon },
            { value: 'auto', label: 'Auto', icon: autoIcon },
            { value: 'dark', label: 'Dark', icon: moonIcon },
          ]}
        />
        <Typography variant="caption">
          Auto follows your system preference (changes when iOS toggles dark mode).
        </Typography>
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
                  secondary={`${f.country}${f.region ? ' · ' + f.region : ''} · ${f.timezone}${f.size_bytes?.sqlite_gz ? ' · ' + fmtBytes(f.size_bytes.sqlite_gz) : ''}`}
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

  <!-- ===== Display toggles ===== -->
  <Card>
    <CardContent>
      <Stack spacing={2}>
        <Typography variant="h6">Display</Typography>

        <Stack direction="row" align="center" justify="between">
          <Box class="flex-1 min-w-0">
            <Typography variant="body2">Show "Drop off only" indicators</Typography>
            <Typography variant="caption">Flag stations / vehicles that don't pick up passengers.</Typography>
          </Box>
          <Switch
            checked={userPrefs.showDropOffOnly}
            onchange={(v) => (userPrefs.showDropOffOnly = v)}
            aria-label="Show drop-off-only indicators"
          />
        </Stack>

        <Stack direction="row" align="center" justify="between">
          <Box class="flex-1 min-w-0">
            <Typography variant="body2">Show schedule-only vehicles</Typography>
            <Typography variant="caption">Scheduled runs that don't (yet) have a live GPS feed.</Typography>
          </Box>
          <Switch
            checked={userPrefs.showScheduleOnlyVehicles}
            onchange={(v) => (userPrefs.showScheduleOnlyVehicles = v)}
            aria-label="Show schedule-only vehicles"
          />
        </Stack>
      </Stack>
    </CardContent>
  </Card>

  <!-- ===== Live tracking ===== -->
  <Card>
    <CardContent>
      <Stack spacing={1.5}>
        <Typography variant="h6">Live tracking (optional)</Typography>
        <TextField
          label="Tranzy API key"
          placeholder="Paste your API key to enable live vehicle tracking"
          value={userPrefs.apiKey ?? ''}
          oninput={(e) => (userPrefs.apiKey = (e.currentTarget as HTMLInputElement).value || null)}
          helperText="Optional — without it, the app runs in schedule-only mode."
        />
      </Stack>
    </CardContent>
  </Card>

  <!-- ===== Advanced placeholder ===== -->
  <Card>
    <CardContent>
      <Stack spacing={1}>
        <Typography variant="h6">Advanced</Typography>
        <Typography variant="caption">
          Storage breakdown, data freshness, force schedule reload, app version,
          and debug toggles live here in a separate view (lands with Phase 7).
        </Typography>
      </Stack>
    </CardContent>
  </Card>
</div>

{#snippet sunIcon()}<Sun size={16} />{/snippet}
{#snippet autoIcon()}<Locate size={16} />{/snippet}
{#snippet moonIcon()}<Moon size={16} />{/snippet}