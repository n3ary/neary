<!--
  NoLocationCard - shared surface for the "we can't get your location"
  state. Lives in the home-page denied-GPS stack (dismissible) and in
  the settings privacy section (non-dismissible, replaces the lying
  toggle when location can't be enabled).

  When `dismissible`, an X button appears top-right; the dismissal
  flag is shared via `noLocationCardDismissedStore` so dismissing in
  one place persists in the other.

  When not dismissible, the card is always visible - the consumer is
  expected to gate its own render based on the relevant GPS state.
-->
<script lang="ts">
  import { MapPin, X } from 'lucide-svelte';
  import { Button, Card, CardContent, IconButton, Stack, Typography } from '$lib/ui';
  import { locationStore } from '$lib/stores/locationStore.svelte';
  import { noLocationCardDismissedStore } from '$lib/stores/noLocationCardDismissedStore.svelte';

  type Props = {
    /** Show a dismiss X in the top-right. Dismissal persists across
     *  reloads and is shared across all consumers. Default false. */
    dismissible?: boolean;
  };

  let { dismissible = false }: Props = $props();
</script>

{#if !dismissible || !noLocationCardDismissedStore.dismissed}
  <Card>
    <CardContent class={dismissible ? 'relative' : undefined}>
      <Stack direction="row" spacing={1} align="center" class={dismissible ? 'pr-8' : undefined}>
        <MapPin size={16} class="shrink-0 text-[color:var(--color-fg-muted)]" />
        <Typography variant="h6">No location</Typography>
      </Stack>
      <Typography variant="caption" class="block pt-1">
        Want stops near you automatically? Allow location in your browser's
        site settings, then tap try again.
      </Typography>
      <Stack direction="row" spacing={1} align="center" class="pt-2">
        <Button variant="text" size="small" onclick={() => locationStore.enable()}>
          Try again
        </Button>
      </Stack>
      {#if dismissible}
        <IconButton
          size="small"
          color="inherit"
          aria-label="Dismiss"
          onclick={() => noLocationCardDismissedStore.dismiss()}
          class="absolute top-1 right-1 text-[color:var(--color-fg-muted)]"
        >
          <X size={16} />
        </IconButton>
      {/if}
    </CardContent>
  </Card>
{/if}