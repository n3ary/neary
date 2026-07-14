<!--
  BuyTicketLink — a compact, non-intrusive banner linking to the
  operator's ticket-purchase surface (e.g. 24pay, web shop).

  Appears only when the current feed has a `buyTicketUrl` configured.
  Renders as a small card with a ticket icon and a text link that opens
  in a new tab. Keeps the station arrival rows as the visual focus.
-->
<script lang="ts">
  import { TicketCheck } from 'lucide-svelte';
  import Card from './Card.svelte';
  import CardContent from './CardContent.svelte';
  import Stack from './Stack.svelte';
  import Typography from './Typography.svelte';

  type Props = {
    /** Canonical URL to the operator's ticket-purchase surface. */
    url: string;
  };

  let { url }: Props = $props();
</script>

<a
  href={url}
  target="_blank"
  rel="noopener noreferrer"
  class="block"
  aria-label="Buy ticket via 24pay"
>
  <Card class="border-[color:var(--color-primary)]/30 bg-[color:var(--color-surface)] hover:bg-[color:var(--color-surface)]/80 transition-colors">
    <CardContent class="py-2 px-3">
      <Stack direction="row" spacing={1} align="center">
        <span class="text-[color:var(--color-primary)] shrink-0">
          <TicketCheck size={15} strokeWidth={2} />
        </span>
        <Typography variant="caption" class="text-[color:var(--color-fg-muted)] flex-1">
          Buy ticket via 24pay
        </Typography>
        <Typography
          variant="caption"
          class="text-[color:var(--color-primary)] font-medium"
        >
          Open app
        </Typography>
      </Stack>
    </CardContent>
  </Card>
</a>
