<!-- Surface container. Tokenized via CSS variables so theme.css fully controls the look. variant adds a small accent stripe used by the unified Station / Route / Vehicle cards. tone swaps the surface for callers that want a different background (currently 'elevated' for the "Your favorites" anchor). -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn } from './cn';

  type Variant = 'plain' | 'station' | 'route' | 'vehicle';
  type Tone = 'plain' | 'elevated';

  type Props = {
    variant?: Variant;
    tone?: Tone;
    /** Override the accent border-left colour. Accepts a CSS colour
     *  string (hex, rgb(), or var(--color-...)). When undefined the
     *  variant's default accent colour is used. */
    accentColor?: string;
    class?: string;
    children?: Snippet;
  };

  let { variant = 'plain', tone = 'plain', accentColor, class: className, children }: Props = $props();

  const ACCENT: Record<Variant, string> = {
    plain: '',
    // --card-accent: inline CSS var set by callers; fallback is the
    // variant's canonical colour so the border reads correctly even when
    // no override is passed.
    station: 'border-l-4 border-l-[color:var(--card-accent,var(--color-primary))]',
    route: 'border-l-4 border-l-[color:var(--card-accent,var(--color-success))]',
    vehicle: 'border-l-4 border-l-[color:var(--card-accent,var(--color-warning))]',
  };
  const TONE: Record<Tone, string> = {
    // plain = the default card frame: surface bg + gray border.
    plain: 'bg-[color:var(--color-surface)] border-[color:var(--color-border)]',
    // 'elevated' = the anchor card (currently "Your favorites"). A
    // different surface (--color-surface-elevated) so the card
    // visually settles into the page; keeps the same gray border as
    // the plain tone so the card has a clear perimeter -- the tint
    // alone wasn't enough to read as a frame in practice.
    elevated: 'bg-[color:var(--color-surface-elevated)] border-[color:var(--color-border)]',
  };
</script>

<div
  class={cn(
    TONE[tone],
    'text-[color:var(--color-fg)]',
    'rounded-[var(--radius-card)] border shadow-sm',
    ACCENT[variant],
    className,
  )}
  style={accentColor
    ? `--card-accent: ${accentColor}`
    : undefined}
>
  {@render children?.()}
</div>
