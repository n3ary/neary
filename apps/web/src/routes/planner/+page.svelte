<!--
  Planner — placeholder. Implementation deferred to Phase 8 per plan §9.
  Visible in the bottom nav now so the navigation surface is final.
-->
<script lang="ts">
  import { Home } from 'lucide-svelte';
  import { Card, CardContent, Chip, Stack, Typography } from '$lib/ui';
</script>

<div class="mx-auto max-w-3xl px-4 py-6">
  <Card>
    <CardContent>
      <Stack spacing={1.5} align="center" class="text-center">
        <div class="inline-flex items-center justify-center w-12 h-12 rounded-full bg-[color:var(--color-primary)]/10 text-[color:var(--color-primary)]">
          <Home size={24} />
        </div>
        <Typography variant="h4">Trip Planner</Typography>
        <Chip size="small" variant="outlined">Coming soon</Chip>
      </Stack>
    </CardContent>
  </Card>
</div>