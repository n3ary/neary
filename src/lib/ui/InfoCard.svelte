<!--
  InfoCard — reusable empty/info state card used by views that need to
  show a one-line title + paragraph + optional action buttons in place
  of their main content.

  Pattern was duplicated across the Stations view (no-feed, location-
  needed, wrong-feed, etc.); this consolidates it so the chrome is
  consistent and copy changes land in one place.

  Layout:
    [Icon] Title
    Body paragraph (caption-muted)
    [Primary action] [Secondary action]
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Card from './Card.svelte';
  import CardContent from './CardContent.svelte';
  import Stack from './Stack.svelte';
  import Typography from './Typography.svelte';

  type Variant = 'default' | 'primary' | 'danger' | 'warning';

  type Props = {
    /** Icon snippet (typically a lucide-svelte icon sized 16). Wrapped
     *  in a tinted color span keyed off `variant`. */
    icon?: Snippet;
    title: string;
    /** Tints the icon. Body + buttons stay neutral so the variant is
     *  a quiet cue, not a wall of color. */
    variant?: Variant;
    /** Body paragraph snippet. Wrapped in muted caption typography. */
    body?: Snippet;
    /** Action row snippet (typically one or two `<Button>` instances).
     *  Omit when the card is informational with no call-to-action. */
    actions?: Snippet;
  };

  let { icon, title, variant = 'default', body, actions }: Props = $props();

  const ICON_COLOR: Record<Variant, string> = {
    default: 'text-[color:var(--color-fg-muted)]',
    primary: 'text-[color:var(--color-primary)]',
    danger: 'text-[color:var(--color-danger)]',
    warning: 'text-[color:var(--color-warning)]',
  };
</script>

<Card>
  <CardContent>
    <Stack spacing={1}>
      <Stack direction="row" spacing={1} align="center">
        {#if icon}
          <span class={`shrink-0 inline-flex ${ICON_COLOR[variant]}`}>
            {@render icon()}
          </span>
        {/if}
        <Typography variant="h6">{title}</Typography>
      </Stack>
      {#if body}
        <Typography variant="caption" class="text-[color:var(--color-fg-muted)]">
          {@render body()}
        </Typography>
      {/if}
      {#if actions}
        <Stack direction="row" spacing={1} align="center" class="pt-1">
          {@render actions()}
        </Stack>
      {/if}
    </Stack>
  </CardContent>
</Card>
