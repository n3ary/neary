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
  import { Circle, CircleDot, Locate, Moon, Sun } from 'lucide-svelte';
  import {
    Box, Card, CardContent, Chip,
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
            <Typography variant="body2">Vehicles per section</Typography>
            <Typography variant="caption">Cap applied to the Incoming, Drop off and Departed sections. The action sections (Departing, At station, Arriving) are always uncapped so you never miss an imminent boarding option.</Typography>
          </Box>
          <ToggleGroup
            size="small"
            value={String(userPrefs.stationBoardMaxRows)}
            onchange={(v: string) => (userPrefs.stationBoardMaxRows = Number(v))}
            items={[
              { value: '3', label: '3' },
              { value: '5', label: '5' },
              { value: '7', label: '7' },
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
          Pick a feed. Downloads once, cached offline. Tap again to deselect.
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
          <Stack spacing={1}>
            {#each feedsStore.feeds as f (f.id)}
              {@const hasSqlite = f.files?.sqlite_gz != null}
              {@const selected = userPrefs.feedId === f.id}
              {@const generatedMs = f.generated_at ? Date.parse(f.generated_at) : NaN}
              {@const updated = Number.isFinite(generatedMs) ? formatWhen(generatedMs) : null}
              {@const size = f.size_bytes?.sqlite_gz ? formatBytes(f.size_bytes.sqlite_gz) : null}
              <button
                type="button"
                disabled={!hasSqlite}
                aria-pressed={selected}
                onclick={hasSqlite ? () => (userPrefs.feedId = selected ? null : f.id) : undefined}
                class={[
                  'w-full text-left flex items-start gap-3 px-3 py-2.5 rounded-md',
                  'border transition-colors',
                  selected
                    ? 'border-[color:var(--color-primary)] bg-[color:var(--color-primary)]/10'
                    : 'border-[color:var(--color-border)]',
                  hasSqlite
                    ? 'hover:bg-[color:var(--color-border)]/30 cursor-pointer'
                    : 'opacity-60 cursor-not-allowed',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary)]',
                ].join(' ')}
              >
                {#if selected}
                  <CircleDot size={18} class="mt-0.5 shrink-0 text-[color:var(--color-primary)]" />
                {:else}
                  <Circle size={18} class="mt-0.5 shrink-0 text-[color:var(--color-fg-muted)]" />
                {/if}
                <div class="flex-1 min-w-0">
                  <div class="font-medium text-sm">{f.name}</div>
                  <div class="text-xs text-[color:var(--color-fg-muted)]">{f.timezone}</div>
                  {#if size || updated}
                    <div class="text-xs text-[color:var(--color-fg-muted)]">
                      {[size, updated && `updated ${updated}`].filter(Boolean).join(' · ')}
                    </div>
                  {/if}
                </div>
                {#if !hasSqlite}
                  <Chip size="small" variant="outlined">no data yet</Chip>
                {/if}
              </button>
            {/each}
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

        <Stack direction="row" align="center" justify="between">
          <Box class="flex-1 min-w-0">
            <Typography variant="body2">Enable Debug</Typography>
            <Typography variant="caption">Render <code>tripId · kind · dir</code> on every vehicle card and map marker. Use when reporting cross-view discrepancies so screenshots can be correlated.</Typography>
          </Box>
          <Switch
            checked={userPrefs.showDebugIds}
            onchange={(v) => (userPrefs.showDebugIds = v)}
            aria-label="Enable Debug"
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