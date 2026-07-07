<!-- Indeterminate circular activity indicator. Pure CSS, no SVG, no per-render style cost. Default 20px to match MUI's small CircularProgress. -->
<script lang="ts">
  import { cn } from './cn';

  type Props = {
    size?: number;
    class?: string;
  };

  let { size = 20, class: className }: Props = $props();

  // Border scales with size so the visible stroke stays roughly proportional when caller swaps sizes.
  const border = $derived(Math.max(2, Math.floor(size / 10)));
</script>

<span
  role="progressbar"
  aria-label="Loading"
  style={`width:${size}px;height:${size}px;border-width:${border}px;`}
  class={cn(
    'inline-block rounded-full border-[color:var(--color-border)] border-t-[color:var(--color-primary)] animate-spin',
    className,
  )}
></span>
