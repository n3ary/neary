<!-- Single-line strip pinned below the header. Replaces toasts and per-view loading spinners. Driven by statusBus so any module can post an entry. Concurrent loading entries collapse into one line. Severity: error (red, no dismiss) > loading/progress (primary, no dismiss) > warning (amber ~6s) > info (~4s) > success (~2.5s). Idle = 0 height. -->
<script lang="ts">
  import { statusBus, type StatusEntry } from '$lib/stores/statusBus.svelte';
  import { cn } from './cn';

  // Pick the highest-priority active entry; collapse all `loading` entries
  // into a single rendered row so multiple parallel loads don't flicker.
  const active = $derived.by(() => {
    const entries: StatusEntry[] = statusBus.entries;
    if (entries.length === 0) return null;
    const priorityOf = (k: StatusEntry['kind']) =>
      k === 'error' ? 5 :
      k === 'loading' || k === 'progress' ? 4 :
      k === 'warning' ? 3 :
      k === 'info' ? 2 : 1;
    return [...entries].sort((a, b) => priorityOf(b.kind) - priorityOf(a.kind))[0];
  });

  const loadingMessages = $derived(
    statusBus.entries.filter((e) => e.kind === 'loading').map((e) => e.message),
  );

  const KIND_CLASS: Record<StatusEntry['kind'], string> = {
    error: 'bg-[color:var(--color-danger)] text-white',
    loading: 'bg-[color:var(--color-primary)]/15 text-[color:var(--color-primary)]',
    progress: 'bg-[color:var(--color-primary)]/15 text-[color:var(--color-primary)]',
    warning: 'bg-[color:var(--color-warning)] text-black',
    info: 'bg-[color:var(--color-border)] text-[color:var(--color-fg)]',
    success: 'bg-[color:var(--color-success)] text-white',
  };
</script>

{#snippet body()}
  {#if active}
    <div
      class={cn(
        'relative w-full h-7 overflow-hidden text-xs flex items-center px-3 transition-colors',
        KIND_CLASS[active.kind],
      )}
      role="status"
    >
      <!-- Indeterminate stripe behind loading rows -->
      {#if active.kind === 'loading'}
        <span
          aria-hidden="true"
          class="absolute inset-y-0 left-0 w-1/3 bg-[color:var(--color-primary)]/40 animate-[statusbar-stripe_1.4s_ease-in-out_infinite]"
        ></span>
      {/if}
      <!-- Determinate fill for progress entries -->
      {#if active.kind === 'progress' && typeof active.progress === 'number'}
        <span
          aria-hidden="true"
          class="absolute inset-y-0 left-0 bg-[color:var(--color-primary)]/40 transition-[width]"
          style={`width:${Math.max(0, Math.min(100, active.progress))}%`}
        ></span>
      {/if}
      <span class="relative z-10 truncate">
        {active.kind === 'loading' && loadingMessages.length > 1
          ? `Loading: ${loadingMessages.join(', ')}`
          : active.message}
      </span>
    </div>
  {/if}
{/snippet}

<!-- Always reserve the row so transient status messages don't shove
     the page content up and down. -->
<div class="h-7 w-full">
  {@render body()}
</div>

<style>
  @keyframes statusbar-stripe {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(400%); }
  }
</style>
