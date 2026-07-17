<!-- User preferences. Theme picker, behavior toggles, feed selector (sources feeds.json from gtfs binaries branch on GitHub), and a tiny Advanced section with the app version + first-seen date. A dedicated /settings/advanced view will land alongside storage / debug toggles in a later phase. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { version } from '$app/environment';
  import { Bug, Circle, CircleDot, ExternalLink, Locate, MapPin, Moon, Sun, Trash2 } from 'lucide-svelte';
  import {
    Box, Button, Card, CardContent, Chip, Dialog, DialogContent, DialogTitle,
    IconButton, InfoCard, NoLocationCard, Spinner, Stack, Switch, ToggleGroup, Tooltip, Typography,
    formatBytes, formatWhen,
  } from '$lib/ui';
  import { getGtfsRepo } from '$lib/data/gtfs/repo';
  import type { Feed } from '$lib/data/feeds';
  import { feedsStore } from '$lib/stores/feedsStore.svelte';
  import { locationStore } from '$lib/stores/gps/locationStore.svelte';
  import { statusBus } from '$lib/stores/statusBus.svelte';
  import { userPrefs, type Theme } from '$lib/stores/userPrefs.svelte';

  /** localStorage key for tracking when this client first saw the current
   *  app version. Stored as `{ version, at }` so a version bump resets the
   *  timestamp on next load. */
  const VERSION_SEEN_KEY = 'neary:version-first-seen';

  const regionNames =
    typeof Intl !== 'undefined' && typeof Intl.DisplayNames === 'function'
      ? new Intl.DisplayNames(undefined, { type: 'region' })
      : null;

  function feedLocation(f: { country?: string | null; region?: string | null }): string {
    const country = f.country ? (regionNames?.of(f.country) ?? f.country) : '';
    return [f.region, country].filter(Boolean).join(', ');
  }

  /** Visual severity for the on-row size badge. Sub-30 MB feeds render
   *  muted; 30–100 MB turns the size label yellow as a soft "this is
   *  heavy" signal; >100 MB goes red + bold so the user notices before
   *  they tap. */
  function sizeSeverity(bytes: number | null | undefined): 'large' | 'medium' | 'default' {
    if (!bytes || bytes <= 0) return 'default';
    const mb = bytes / (1024 * 1024);
    if (mb > 100) return 'large';
    if (mb > 30) return 'medium';
    return 'default';
  }

  const SIZE_CLASS: Record<ReturnType<typeof sizeSeverity>, string> = {
    large: 'text-[color:var(--color-danger)] font-bold',
    medium: 'text-yellow-600 dark:text-yellow-400',
    default: '',
  };

  // Issue #226: when the browser is denying geolocation, the privacy
  // Switch would lie - it reflects gpsOptedIn but cannot actually turn
  // GPS on when permission is denied. Replace the Switch with the
  // shared NoLocationCard in that state. Same card as the home page;
  // non-dismissible here because the user came to settings to fix it.
  // When the browser doesn't expose geolocation at all, the Switch
  // also lies (toggling it can't work) - show a static unsupported
  // message instead. The dismissal reset on fresh opt-in is owned by
  // `noLocationCardDismissedStore` itself.
  const denied = $derived(
    locationStore.permission === 'denied',
  );

  let versionFirstSeenAt = $state<number | null>(null);

  /** Feed ids whose sqlite snapshot currently lives in OPFS. Refreshed
   *  on mount, after the registry refresh, and after every delete.
   *  Drives the per-row trash button visibility for non-active feeds.
   *  The active feed is always treated as cached too (heuristic —
   *  we couldn't be bound to it without a file existing), so the
   *  trash appears the moment the page mounts instead of after the
   *  worker-init round-trip. */
  let cachedFeedIds = $state<Set<string>>(new Set());
  /** Feed awaiting confirm before its OPFS file is removed. Null when
   *  no dialog is open. Kept separate from `deleting` so the dialog
   *  can show a loading state inside without re-creating mid-flight. */
  let confirmingDelete = $state<Feed | null>(null);
  let deleting = $state(false);

  async function refreshCachedFeeds(): Promise<void> {
    const feeds = feedsStore.feeds;
    if (!feeds) return;
    // `$state.snapshot` strips the Svelte 5 proxy so the array +
    // nested Feed objects are structured-cloneable across the worker's
    // postMessage boundary. Without it the call throws
    // "DataCloneError: The object can not be cloned" and the trash
    // never renders for any feed.
    const feedSnapshot = $state.snapshot(feeds) as readonly Feed[];
    try {
      const ids = await getGtfsRepo().listCachedFeeds(feedSnapshot);
      cachedFeedIds = new Set(ids);
    } catch (e) {
      // Likely the pool failed to install (worker still warming up, or
      // an OPFS lock from another tab). Caches stay invisible until
      // the next refresh succeeds; non-cached rows just don't show a
      // trash affordance.
      console.warn('[settings] listCachedFeeds failed:', e);
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!confirmingDelete) return;
    deleting = true;
    // Same proxy → structured-clone issue as refreshCachedFeeds;
    // snapshot the feed once and pass the plain object across the
    // worker boundary.
    const target = $state.snapshot(confirmingDelete) as Feed;
    const wasActive = userPrefs.feedId === target.id;
    try {
      const removed = await getGtfsRepo().deleteFeedCache(target);
      // If the deleted feed was the user's selected one, deselect so
      // +layout's effect un-binds cleanly. closeCurrent() ran inside
      // deleteFeedCache when wasActive; dropping the user pref here
      // means the worker stays unbound until the user re-picks (at
      // which point setFeed re-bootstraps from scratch).
      if (wasActive) userPrefs.feedId = null;
      await refreshCachedFeeds();
      statusBus.push({
        id: 'feed-cache-deleted',
        kind: 'success',
        message:
          removed > 0
            ? wasActive
              ? `Deleted cached data for ${target.name} and deselected it.`
              : `Deleted cached data for ${target.name}.`
            : `${target.name} had nothing cached.`,
      });
    } catch (e) {
      statusBus.push({
        id: 'feed-cache-delete-failed',
        kind: 'error',
        message: `Couldn't delete ${target.name} cache: ${(e as Error).message}`,
      });
    } finally {
      deleting = false;
      confirmingDelete = null;
    }
  }

  // Re-poll cached ids whenever the registry changes (a feed that's
  // never been downloaded won't have an OPFS file by definition, but
  // a feed that appears in a registry refresh might now have local
  // data, e.g. the user just selected it elsewhere).
  $effect(() => {
    const feeds = feedsStore.feeds;
    if (!feeds) return;
    void refreshCachedFeeds();
  });

  // Re-poll cached ids when the bind lifecycle flips. The /settings
  // page may be open while the user waits for a feed to download;
  // once the bind completes the row needs to swap from spinner to
  // trash, and once a delete-then-rebind completes the same row
  // needs the trash to reappear. Watching the bindingFeedId covers
  // both transitions (null → id on start, id → null on end). The
  // onMount kick + the feedsStore effect above handle the first paint.
  $effect(() => {
    feedsStore.bindingFeedId;
    if (!feedsStore.feeds) return;
    void refreshCachedFeeds();
  });

  onMount(() => {
    // Always re-check the registry when the user opens Settings
    // (rather than `load()`, which short-circuits when the in-memory
    // copy is already populated). SPA navigation here from anywhere
    // else doesn't reload the page, so without `refresh()` we'd be
    // showing the snapshot from first app boot.
    void feedsStore.refresh();
    // Kick off the OPFS pool probe in parallel — on a cold worker
    // the first listCachedFeeds round-trip includes SQLite-WASM
    // payload + pool init (~hundreds of ms), so starting it as soon
    // as the page mounts gives the trash icon the longest possible
    // head start on appearing for non-active cached feeds.
    void refreshCachedFeeds();

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

<!--
  Short-view wrapper: `flex flex-col min-h-[calc(100svh-3.5rem-3rem)]` pins the
  column to a definite minimum height (viewport minus header strip minus nav).
  Cards sit inside a sub-div with their original `space-y-6` so the inter-card
  gap is preserved; the `flex-1 aria-hidden` spacer at the end fills any
  leftover space so the visible bottom sits flush with the fixed nav instead
  of leaving a `--color-surface` void. Same pattern as home / station /
  schedule / map (PR #322).
-->
<div class="mx-auto max-w-3xl w-full px-4 py-6 flex flex-col min-h-[calc(100svh-3.5rem-3rem)]">
  <div class="space-y-6">
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

  <!-- ===== Privacy ===== -->
  {#if !locationStore.isSupported}
    <InfoCard title="Location not supported">
      {#snippet icon()}<MapPin size={16} />{/snippet}
      {#snippet body()}
        Your browser doesn't expose a geolocation API, so the location toggle
        below wouldn't do anything.
      {/snippet}
    </InfoCard>
  {:else if denied}
    <!-- NoLocationCard is its own card with its own title; no
         surrounding Privacy header is needed and adding one outside
         the card makes it look orphaned. -->
    <NoLocationCard />
  {:else}
    <Card>
      <CardContent>
        <Stack spacing={2}>
          <Typography variant="h6">Privacy</Typography>
          <Stack direction="row" align="center" justify="between">
            <Box class="flex-1 min-w-0">
              <Typography variant="body2">Use location</Typography>
              <Typography variant="caption">
                Sort nearby stations and put real-time arrivals closer to you first.
                Your position stays on this device - never sent, stored, or used to
                track you.
              </Typography>
            </Box>
            <Switch
              checked={userPrefs.gpsOptedIn}
              onchange={(v) => (v ? locationStore.enable() : locationStore.disable())}
              aria-label="Use location"
            />
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  {/if}

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
              {@const sizeBytes = f.size_bytes?.sqlite_gz ?? null}
              {@const size = sizeBytes ? formatBytes(sizeBytes) : null}
              {@const location = feedLocation(f)}
              <!-- Right-column affordances resolve in priority order:
                   - no sqlite_gz in registry → "no data yet" chip
                   - setFeed in flight for this feed → spinner (with
                     download-progress tooltip; not clickable so the
                     user can't kick a second download mid-fetch)
                   - sqlite on disk → trash
                   - otherwise → blank (feed could be downloaded but
                     hasn't been yet) -->
              {@const isCached = cachedFeedIds.has(f.id)}
              {@const isBinding = feedsStore.bindingFeedId === f.id}
              {@const bindingPct = isBinding ? feedsStore.bindingProgress : null}
              <div
                class={[
                  'flex items-stretch gap-1 rounded-md border transition-colors',
                  selected
                    ? 'border-[color:var(--color-primary)] bg-[color:var(--color-primary)]/10'
                    : 'border-[color:var(--color-border)]',
                  hasSqlite ? 'hover:bg-[color:var(--color-border)]/30' : '',
                  'focus-within:ring-2 focus-within:ring-[color:var(--color-primary)]',
                ].join(' ')}
              >
                <button
                  type="button"
                  disabled={!hasSqlite}
                  aria-pressed={selected}
                  onclick={hasSqlite ? () => (userPrefs.feedId = selected ? null : f.id) : undefined}
                  class={[
                    'flex-1 min-w-0 text-left flex items-start gap-3 px-3 py-2.5 rounded-md',
                    'focus-visible:outline-none',
                    hasSqlite ? 'cursor-pointer' : 'opacity-60 cursor-not-allowed',
                  ].join(' ')}
                >
                  {#if selected}
                    <CircleDot size={18} class="mt-0.5 shrink-0 text-[color:var(--color-primary)]" />
                  {:else}
                    <Circle size={18} class="mt-0.5 shrink-0 text-[color:var(--color-fg-muted)]" />
                  {/if}
                  <div class="flex-1 min-w-0">
                    <div class="font-medium text-sm">{f.name}</div>
                    {#if location}
                      <div class="text-xs text-[color:var(--color-fg-muted)]">{location}</div>
                    {/if}
                    <div class="text-xs text-[color:var(--color-fg-muted)]">{f.timezone}</div>
                    {#if size || updated || f.realtime}
                      <div class="text-xs text-[color:var(--color-fg-muted)] flex items-center gap-2 flex-wrap">
                        {#if size}<span class={SIZE_CLASS[sizeSeverity(sizeBytes)]}>{size}</span>{/if}
                        {#if size && (updated || f.realtime)} · {/if}
                        {#if updated}<span>updated {updated}</span>{/if}
                        {#if f.realtime}
                          <Chip size="small" variant="filled" color="success">Live</Chip>
                        {/if}
                      </div>
                    {/if}
                  </div>
                </button>
                <div class="flex items-center pr-3">
                  {#if !hasSqlite}
                    <Chip size="small" variant="outlined">no data yet</Chip>
                  {:else if isBinding}
                    <Tooltip
                      title={bindingPct != null
                        ? `Downloading… ${bindingPct}%`
                        : 'Downloading…'}
                    >
                      <span
                        role="progressbar"
                        aria-label="Downloading"
                        aria-valuemin="0"
                        aria-valuemax="100"
                        aria-valuenow={bindingPct ?? undefined}
                        class="inline-flex"
                      >
                        <Spinner size={18} />
                      </span>
                    </Tooltip>
                  {:else if isCached}
                    <Tooltip title="Delete local data">
                      <IconButton
                        size="small"
                        color="danger"
                        aria-label={`Delete local data for ${f.name}`}
                        onclick={() => (confirmingDelete = f)}
                      >
                        <Trash2 size={16} />
                      </IconButton>
                    </Tooltip>
                  {/if}
                </div>
              </div>
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
            <Typography variant="body2">Enable Debug</Typography>
            <Typography variant="caption">Diagnostic overlays for troubleshooting. Off unless asked.</Typography>
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

        <!-- Bug-report CTA. Button renders as an anchor when href is set,
             so this drops the duplicated outlined-small styling that the
             earlier anchor-with-Button-classes workaround needed. -->
        <Box class="px-3 py-2 rounded-md border border-[color:var(--color-border)]/60 bg-[color:var(--color-surface-raised,var(--color-surface))]">
          <Stack direction="row" spacing={2} align="center" wrap>
            <Bug size={16} class="shrink-0 text-[color:var(--color-fg-muted)]" />
            <Typography variant="caption" class="flex-1 min-w-0">
              Found a bug? Search existing reports on GitHub or open a new one.
            </Typography>
            <Button
              variant="outlined"
              size="small"
              color="primary"
              href="https://github.com/n3ary/app/issues"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open GitHub issues in a new tab"
            >
              {#snippet startIcon()}<ExternalLink size={12} strokeWidth={2.25} />{/snippet}
              Open issues
            </Button>
          </Stack>
        </Box>
      </Stack>
    </CardContent>
  </Card>
  </div>
  <div class="flex-1" aria-hidden="true"></div>
</div>

<!-- Confirm dialog for the per-feed delete button. Body copy says
     plainly what happens next (re-download when you select the feed
     again) so the destructive action isn't a black box. The Delete
     button is `color="danger"` so it visually matches the trash
     icon it pairs with. -->
<Dialog
  open={confirmingDelete != null}
  onclose={() => (confirmingDelete = null)}
  maxWidth="sm"
>
  {#if confirmingDelete}
    {@const isActive = userPrefs.feedId === confirmingDelete.id}
    <DialogTitle onclose={() => (confirmingDelete = null)}>
      Delete local data?
    </DialogTitle>
    <DialogContent>
      <Stack spacing={2}>
        <Typography variant="body2">
          Remove the downloaded schedule for <strong>{confirmingDelete.name}</strong>?
          {#if isActive}
            This is your currently selected feed — Neary will also deselect it.
            Pick a feed again (this one or another) to re-download
            {#if confirmingDelete.size_bytes?.sqlite_gz}
              ~{formatBytes(confirmingDelete.size_bytes.sqlite_gz)}
            {:else}
              it
            {/if}.
          {:else}
            Next time you select this feed Neary will re-download
            {#if confirmingDelete.size_bytes?.sqlite_gz}
              ~{formatBytes(confirmingDelete.size_bytes.sqlite_gz)}
            {:else}
              it
            {/if}.
          {/if}
        </Typography>
        <Stack direction="row" spacing={1} justify="end">
          <Button
            variant="text"
            size="small"
            onclick={() => (confirmingDelete = null)}
            disabled={deleting}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            color="danger"
            size="small"
            onclick={confirmDelete}
            disabled={deleting}
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </Button>
        </Stack>
      </Stack>
    </DialogContent>
  {/if}
</Dialog>

{#snippet sunIcon()}<Sun size={16} />{/snippet}
{#snippet autoIcon()}<Locate size={16} />{/snippet}
{#snippet moonIcon()}<Moon size={16} />{/snippet}