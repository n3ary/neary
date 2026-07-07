<!-- Determinate progress bar. The parent supplies the current value (0-100, clamped). For indeterminate progress, use the StatusBar's loading kind — that's the canonical app-wide loading indicator. -->
<script lang="ts">
  import { cn } from './cn';

  type Props = {
    /** 0-100. Clamped. */
    value: number;
    class?: string;
    'aria-label'?: string;
  };

  let { value, class: className, 'aria-label': ariaLabel = 'Progress' }: Props = $props();
  const pct = $derived(Math.max(0, Math.min(100, value)));
</script>

<div
  role="progressbar"
  aria-label={ariaLabel}
  aria-valuemin={0}
  aria-valuemax={100}
  aria-valuenow={pct}
  class={cn('h-1.5 w-full overflow-hidden rounded-full bg-[color:var(--color-border)]', className)}
>
  <div
    class="h-full bg-[color:var(--color-primary)] transition-[width] duration-150"
    style={`width:${pct}%`}
  ></div>
</div>
