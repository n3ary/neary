<!--
  NoFeedState — the "pick a feed in Settings first" empty state used by
  every page that depends on a bound GTFS feed (/, /favorites,
  /station/[id], /schedule/route/[id]). Single source for the copy +
  layout so future tweaks land in one place.

  Pages render it conditionally on `userPrefs.feedId == null` before
  any data-loading effect fires.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { Bus } from 'lucide-svelte';
  import Button from './Button.svelte';
  import Card from './Card.svelte';
  import CardContent from './CardContent.svelte';
  import Stack from './Stack.svelte';
  import Typography from './Typography.svelte';

  type Props = {
    /** Override the default body line when a page wants to tailor the
     *  message (e.g. /schedule says "Pick a feed to view schedules"). */
    message?: string;
  };

  let { message }: Props = $props();

  const body = $derived(
    message
    ?? 'Neary needs a transit feed to load schedules and routes. Pick one in Settings to get started.',
  );
</script>

<Card class="text-center">
  <CardContent>
    <Stack spacing={2} align="center">
      <div class="inline-flex items-center justify-center w-12 h-12 rounded-full bg-[color:var(--color-primary)]/10 text-[color:var(--color-primary)]">
        <Bus size={24} />
      </div>
      <Typography variant="h4">Select your transit feed</Typography>
      <Typography variant="body2" class="max-w-prose text-[color:var(--color-fg-muted)]">
        {body}
      </Typography>
      <Button onclick={() => goto('/settings')}>Open Settings</Button>
    </Stack>
  </CardContent>
</Card>
