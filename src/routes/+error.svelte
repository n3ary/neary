<!--
  Global error boundary. SvelteKit renders this whenever an uncaught
  Error is thrown during navigation (server errors, failed loads, etc.)
  that isn't caught by a route's own try/catch.

  Must account for the fixed BottomNavigation (3.5rem) so the error
  message isn't clipped. Mirrors the min-height pattern from Settings
  (+page.svelte, PR #322).
-->
<script lang="ts">
  import { page } from '$app/state';
  import { Button, Stack, Typography } from '$lib/ui';

  const status = $derived(page.status);
  const message = $derived(page.error?.message ?? 'Something went wrong.');
</script>

<!--
  Short-view wrapper: `min-h-[calc(100svh-3.5rem-3rem)]` pins the column to
  a definite minimum height (viewport minus header strip minus nav). This
  matches the padding-bottom on <main> in AppLayout so the error sits above
  the fixed BottomNav instead of being obscured by it.
-->
<div class="mx-auto max-w-3xl w-full px-4 py-6 flex flex-col min-h-[calc(100svh-3.5rem-3rem)]">
  <Stack spacing={3} align="center" justify="center" class="flex-1 text-center">
    <Typography variant="h4" class="text-[color:var(--color-fg-muted)]">
      {status === 404 ? 'Page not found' : 'Application error'}
    </Typography>
    <Typography variant="body2" class="text-[color:var(--color-fg-muted)] max-w-xs">
      {message}
    </Typography>
    <Stack direction="row" spacing={2}>
      <Button variant="outlined" size="small" onclick={() => history.back()}>
        Go back
      </Button>
      <Button variant="text" size="small" onclick={() => (window.location.href = '/')}>
        Home
      </Button>
    </Stack>
  </Stack>
</div>
