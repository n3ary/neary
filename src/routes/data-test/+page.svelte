<!-- End-to-end GTFS pipeline proof. Browser page (not Node script) so iOS Safari / OPFS coverage is exercised too. Workflow: load manifest (row counts, generated_at, file size); call repo.getRoutes() (real SQL select); pick the hardcoded Cluj test stop; render stops within 500 m sorted by Haversine; render next 60 min of departures. Status flows through the global StatusBar (loading kind) while SQL warms up. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import type { Feed } from '$lib/data/feeds';
  import { getGtfsRepo } from '$lib/data/gtfs/repo';
  import type { StopWithDistance, UpcomingDeparture } from '$lib/data/gtfs/types';
  import type { Route } from '$lib/domain/types';
  import { feedsStore } from '$lib/stores/feedsStore.svelte';
  import { statusBus } from '$lib/stores/statusBus.svelte';
  import { userPrefs } from '$lib/stores/userPrefs.svelte';
  import {
    Box, Card, CardContent, Chip, List, ListItem, ListItemText,
    RouteBadge, Stack, Typography,
    formatBytes,
  } from '$lib/ui';
  import { MapPin } from 'lucide-svelte';

  // Demo "user location" — a central European city centre. Generic
  // coordinates; the page is feed-agnostic.
  const userLat = 46.7712;
  const userLon = 23.6236;

  // /data-test is feed-agnostic: picks whichever feed appears first
  // in the published registry. To test a different feed, switch to it
  // in /settings before loading this page (it'll be picked up via the
  // user's currently selected feed id).
  const DEMO_FEED_ID = null; // sentinel: use the user's currently selected feed

  let feed = $state<Feed | null>(null);
  let routes = $state<Route[] | null>(null);
  let nearby = $state<StopWithDistance[] | null>(null);
  let departures = $state<UpcomingDeparture[] | null>(null);
  let error = $state<string | null>(null);

  onMount(async () => {
    const repo = getGtfsRepo();
    statusBus.push({ id: 'gtfs-boot', kind: 'loading', message: 'Loading GTFS database…' });
    try {
      await feedsStore.load();
      // Pick the user's currently selected feed; fall back to the
      // first entry in the registry when nothing's selected.
      const targetId = DEMO_FEED_ID ?? userPrefs.feedId ?? feedsStore.feeds?.[0]?.id ?? null;
      if (!targetId) throw new Error('No feed available — check the registry');
      const f = feedsStore.byId(targetId);
      if (!f) throw new Error(`Feed "${targetId}" not in registry`);
      feed = f;
      await repo.setFeed($state.snapshot(f) as typeof f);
      routes = await repo.getRoutes();
      nearby = await repo.getStopsNear(userLat, userLon, 500);

      if (nearby.length > 0) {
        const now = new Date();
        const localDate =
          `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
        const minutes = now.getHours() * 60 + now.getMinutes();
        departures = await repo.getDeparturesFromStop(nearby[0].id, localDate, minutes, 60);
      } else {
        departures = [];
      }
      statusBus.push({ id: 'gtfs-boot', kind: 'success', message: 'GTFS database ready.' });
    } catch (e) {
      console.error(e);
      error = e instanceof Error ? e.message : String(e);
      statusBus.push({ id: 'gtfs-boot', kind: 'error', message: 'GTFS load failed.' });
    }
  });

  function fmtMeters(m: number) {
    return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
  }
</script>

<svelte:head>
  <title>Data test — neary</title>
</svelte:head>

<main class="mx-auto max-w-3xl px-4 py-6 space-y-8">
  <header>
    <Typography variant="h2">GTFS pipeline test</Typography>
    <Typography variant="body2" class="text-[color:var(--color-fg-muted)]">
      First-launch: downloads the selected feed's <code>sqlite3.gz</code>
      from <code>gtfs.n3ary.com</code>, decompresses, imports into OPFS via
      SAH pool, runs real GTFS queries in a Web Worker. Subsequent visits
      skip the download.
    </Typography>
  </header>

  {#if error}
    <Card variant="vehicle">
      <CardContent>
        <Typography variant="body" class="text-[color:var(--color-danger)]">
          {error}
        </Typography>
      </CardContent>
    </Card>
  {/if}

  <!-- ===== Feed info ===== -->
  <section class="space-y-2">
    <Typography variant="h4">Feed</Typography>
    {#if !feed}
      <Typography variant="body2" class="text-[color:var(--color-fg-muted)]">Loading…</Typography>
    {:else}
      <Card>
        <CardContent>
          <Stack spacing={0.5}>
            <Typography variant="body2">{feed.name} ({feed.id})</Typography>
            <Typography variant="caption">Generated {new Date(feed.generated_at).toLocaleString()}</Typography>
            <Typography variant="caption">Source: {feed.source.publisher} ({feed.source.type})</Typography>
            {#if feed.size_bytes.sqlite_gz}
              <Typography variant="caption">Sqlite gz: {formatBytes(feed.size_bytes.sqlite_gz)}</Typography>
            {/if}
            <Box class="mt-2">
              <Stack direction="row" spacing={1} wrap>
                {#each feed.agencies as a}
                  <Chip size="small">{a.agency_name}</Chip>
                {/each}
              </Stack>
            </Box>
          </Stack>
        </CardContent>
      </Card>
    {/if}
  </section>

  <!-- ===== Routes ===== -->
  <section class="space-y-2">
    <Typography variant="h4">Routes ({routes?.length ?? '…'})</Typography>
    {#if routes}
      <Stack direction="row" spacing={1} wrap>
        {#each routes as r (r.id)}
          <RouteBadge route={r} size="small" />
        {/each}
      </Stack>
    {/if}
  </section>

  <!-- ===== Nearby stops ===== -->
  <section class="space-y-2">
    <Typography variant="h4">Stops within 500 m of ({userLat}, {userLon})</Typography>
    {#if nearby === null}
      <Typography variant="body2" class="text-[color:var(--color-fg-muted)]">Querying…</Typography>
    {:else if nearby.length === 0}
      <Typography variant="body2">No stops in range.</Typography>
    {:else}
      <Card>
        <List>
          {#each nearby as s, i (s.id)}
            <ListItem>
              <ListItemText
                primary={s.name}
                secondary={`id ${s.id} · ${fmtMeters(s.distance ?? 0)}${i === 0 ? ' · closest' : ''}`}
              />
              {#if i === 0}
                <Chip size="small" color="primary">
                  {#snippet icon()}<MapPin size={12} />{/snippet}
                  closest
                </Chip>
              {/if}
            </ListItem>
          {/each}
        </List>
      </Card>
    {/if}
  </section>

  <!-- ===== Upcoming departures ===== -->
  {#if nearby && nearby.length > 0}
    <section class="space-y-2">
      <Typography variant="h4">
        Next 60 min from {nearby[0].name}
        {#if departures} ({departures.length}){/if}
      </Typography>
      {#if departures === null}
        <Typography variant="body2" class="text-[color:var(--color-fg-muted)]">Querying…</Typography>
      {:else if departures.length === 0}
        <Typography variant="body2">No scheduled departures in the next hour.</Typography>
      {:else}
        <Card>
          <List>
            {#each departures as d (d.tripId + d.departureTime)}
              <ListItem>
                <RouteBadge route={{ id: d.routeId, shortName: d.routeShortName, color: d.routeColor }} size="small" />
                <ListItemText primary={d.headsign ?? '—'} secondary={`trip ${d.tripId}`} />
                <Chip size="small">{d.departureTime}</Chip>
              </ListItem>
            {/each}
          </List>
        </Card>
      {/if}
    </section>
  {/if}
</main>
