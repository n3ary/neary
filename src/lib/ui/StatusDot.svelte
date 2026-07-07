<!-- Small colored circle used by the header to surface health (GPS / Connection / Schedule / Live). Each dot owns a Tooltip explaining the source on hover/focus AND posts the same message as a transient StatusBar entry when tapped (touch surfaces can't hover). State colors are theme-token-backed (ok=success, stale=warning, error=danger, idle=muted). -->
<script lang="ts">
  import Tooltip from './Tooltip.svelte';
  import { cn } from './cn';
  import { statusBus } from '$lib/stores/statusBus.svelte';

  type State = 'ok' | 'stale' | 'error' | 'idle' | 'off';

  type Props = {
    state: State;
    label: string;
    tooltip?: string;
    /** Pulse animation for "ok" state to signal liveness (e.g. live vehicles tick). */
    pulse?: boolean;
    /** Overrides the default tap handler (which surfaces the tooltip to the StatusBar). Used by the GPS dot's 'off' state to trigger the enable flow instead. */
    onclick?: () => void;
    class?: string;
  };

  let { state, label, tooltip, pulse = false, onclick, class: className }: Props = $props();

  const COLOR: Record<State, string> = {
    ok: 'bg-[color:var(--color-success)]',
    stale: 'bg-[color:var(--color-warning)]',
    error: 'bg-[color:var(--color-danger)]',
    idle: 'bg-[color:var(--color-fg-muted)]/40',
    off: 'bg-[color:var(--color-fg-muted)]/30 border border-[color:var(--color-fg-muted)]/50',
  };

  // Tap = surface the same text the hover tooltip carries, but in the
  // StatusBar so touch users get the info too. Severity tracks the dot
  // state so a red dot's message reads as an error in the bar, not a
  // neutral info. `id` is stable per label so re-tapping the same dot
  // updates the existing entry instead of stacking.
  const KIND: Record<State, 'success' | 'warning' | 'error' | 'info'> = {
    ok: 'success',
    stale: 'warning',
    error: 'error',
    idle: 'info',
    off: 'info',
  };
  function handleTap() {
    if (onclick) {
      onclick();
      return;
    }
    statusBus.push({
      id: `status-dot:${label}`,
      kind: KIND[state],
      message: tooltip ?? label,
    });
  }
</script>

<Tooltip title={tooltip ?? label} placement="bottom">
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <span
    role="button"
    tabindex={0}
    aria-label={`${label}: ${state}`}
    onclick={handleTap}
    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleTap(); } }}
    class={cn(
      'inline-block w-2.5 h-2.5 rounded-full transition-colors cursor-pointer',
      COLOR[state],
      pulse && state === 'ok' && 'animate-pulse',
      className,
    )}
  ></span>
</Tooltip>
