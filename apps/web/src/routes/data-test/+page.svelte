<!--
  /data-test — proves the GTFS pipeline works end-to-end. Phase 2 deliverable
  #3 (CLI demo in the plan was originally a Node thing — turned into a
  browser page so iOS Safari / OPFS coverage is exercised at the same time).

  Workflow:
    1. Load manifest (row counts, generated-at, file size).
    2. Call repo.getRoutes() — exercises a real SQL select.
    3. Pick the hardcoded "Piața Mihai Viteazul" stop (id 4012) and the user
       location nearby; render stops within 500 m sorted by Haversine.
    4. Render next 60 minutes of departures from the closest stop.

  Status flows through the global StatusBar (loading kind) so we visually
  exercise the bus while the SQL warms up.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { getGtfsRepo } from '$lib/data/gtfs/repo';
  import type { Manifest, StopWithDistance, UpcomingDeparture } from '$lib/data/gtfs/types';
  import type { Route } from '$lib/domain/types';
  import { statusBus } from '$lib/stores/statusBus.svelte';
  import {
    Box, Card, CardContent, Chip, List, ListItem, ListItemText,
    RouteBadge, Stack, Typography,
  } from '$lib/ui';
  import { MapPin } from 'lucide-svelte';

  // Demo "user location" — Piața Mihai Viteazul, central Cluj.
  const userLat = 46.7712;
  const userLon = 23.6236;

  let manifest = $state<Manifest | null>(null);
  let routes = $state<Route[] | null>(null);
  let nearby = $state<StopWithDistance[] | null>(null);
  let departures = $state<UpcomingDeparture[] | null>(null);
  let error = $state<string | null>(null);

  onMount(async () => {
    const repo = getGtfsRepo();
    statusBus.push({ id: 'gtfs-boot', kind: 'loading', message: 'Loading GTFS database…' });
    try {
      // /data-test is agency-agnostic; force-bind agency 2 since that's the
      // only one with a locally-generated SQLite right now.
      await repo.setAgency(2);
      manifest = await repo.getManifest();
      routes = await repo.getRoutes();
      nearby = await repo.getStopsNear(userLat, userLon, 500);

      if (nearby.length > 0) {
        // localDate "YYYYMMDD", local time in minutes since midnight
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

  function fmtBytes(n: number) {
    return n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`;
  }
  function fmtMeters(m: number) {
    return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
  }
</script>

<svelte:head>
  <title>Data test — neary v2</title>
</svelte:head>

<main class="mx-auto max-w-3xl px-4 py-6 space-y-8">
  <header>
    <Typography variant="h2">GTFS pipeline test</Typography>
    <Typography variant="body2" class="text-[color:var(--color-fg-muted)]">
      First-launch: downloads agency-2.sqlite3.gz (~4 MB), decompresses,
      imports into OPFS via SAH pool, runs real GTFS queries in a Web Worker.
      Subsequent visits skip the download.
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

  <!-- ===== Manifest ===== -->
  <section class="space-y-2">
    <Typography variant="h4">Manifest</Typography>
    {#if !manifest}
      <Typography variant="body2" class="text-[color:var(--color-fg-muted)]">Loading…</Typography>
    {:else}
      <Card>
        <CardContent>
          <Stack spacing={0.5}>
            <Typography variant="body2">Agency #{manifest.agencyId}</Typography>
            <Typography variant="caption">Generated {new Date(manifest.generatedAt).toLocaleString()}</Typography>
            <Typography variant="caption">Source: {manifest.source}</Typography>
            <Typography variant="caption">Raw: {fmtBytes(manifest.rawBytes)} · Gzip: {fmtBytes(manifest.gzipBytes)}</Typography>
            <Box class="mt-2">
              <Stack direction="row" spacing={1} wrap>
                {#each Object.entries(manifest.rowCounts) as [name, n]}
                  <Chip size="small">{name}: {n.toLocaleString()}</Chip>
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
                secondary={`id ${s.id} · ${fmtMeters(s.distance)}${i === 0 ? ' · closest' : ''}`}
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
