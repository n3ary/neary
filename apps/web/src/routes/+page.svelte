<!--
  Stations — the default landing route. Until an agency is selected, shows
  an empty state pointing to Settings. Once an agency exists, the real
  proximity-based list lands here in Phase 4.

  Side effect: starts the location watch on mount so the header's GPS dot
  lights up immediately (any other route doesn't need GPS so the prompt
  doesn't appear until you've at least visited /).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { Bus, Settings } from 'lucide-svelte';
  import {
    Button, Card, CardContent, Stack, Typography,
  } from '$lib/ui';
  import { locationStore } from '$lib/stores/locationStore.svelte';
  import { userPrefs } from '$lib/stores/userPrefs.svelte';

  onMount(() => {
    locationStore.start();
  });
</script>

<div class="mx-auto max-w-3xl px-4 py-6">
  {#if userPrefs.agencyId == null}
    <Card class="text-center">
      <CardContent>
        <Stack spacing={2} align="center">
          <div class="inline-flex items-center justify-center w-12 h-12 rounded-full bg-[color:var(--color-primary)]/10 text-[color:var(--color-primary)]">
            <Bus size={24} />
          </div>
          <Typography variant="h4">Select your transit agency</Typography>
          <Typography variant="body2" class="max-w-prose text-[color:var(--color-fg-muted)]">
            Neary needs a transit agency to load schedules and routes. Pick
            one in Settings to get started. The data downloads once and is
            cached for offline use — no account needed.
          </Typography>
          {#snippet settingsIcon()}<Settings size={16} />{/snippet}
          <Button startIcon={settingsIcon} onclick={() => goto('/settings')}>
            Open Settings
          </Button>
        </Stack>
      </CardContent>
    </Card>
  {:else}
    <Card>
      <CardContent>
        <Stack spacing={1.5}>
          <Typography variant="h4">Stations</Typography>
          <Typography variant="body2" class="text-[color:var(--color-fg-muted)]">
            Agency {userPrefs.agencyId} selected. Real proximity-based station
            list lands in Phase 4 (domain layer + GPS hook). For now, see
            <a href="/data-test" class="underline">/data-test</a> for the raw
            GTFS pipeline exercise.
          </Typography>
        </Stack>
      </CardContent>
    </Card>
  {/if}
</div>
