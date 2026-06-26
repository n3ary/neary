<!--
  BackButton — single source of truth for "go one level up" navigation
  on detail views (schedule, map, station). Sole purpose is to avoid
  re-implementing the "history.back with sensible fallback" recipe in
  every header.

  Behaviour:
    - Try history.back() when the previous entry was added in this tab
      (history.length > 1).
    - Otherwise, navigate to `fallback` (default `/`) so a deep-link or
      page-refresh landing doesn't strand the user on the browser's
      blank "no history" stub.
    - Pressing Escape anywhere on the page fires the same handler, so
      keyboard users get the platform "close / dismiss" idiom for
      free. Lives here, not at the page level, so the contract stays
      in one file.

  Intra-view navigation (tab swaps inside the schedule view, direction
  swaps, etc.) MUST use `goto(..., { replaceState: true })` so it
  doesn't push extra history entries — otherwise "back" would walk
  through every tab the user touched instead of returning to where
  they actually came from. That's the calling page's responsibility;
  this component just owns the up-one-level click.
-->
<script lang="ts">
  import { ArrowLeft } from 'lucide-svelte';
  import { goto } from '$app/navigation';
  import IconButton from './IconButton.svelte';

  type Props = {
    /** Where to land when there's no in-tab history to pop. */
    fallback?: string;
    'aria-label'?: string;
  };
  let { fallback = '/', 'aria-label': ariaLabel = 'Back' }: Props = $props();

  function goBack() {
    if (typeof window !== 'undefined' && window.history.length > 1) {
      window.history.back();
    } else {
      void goto(fallback);
    }
  }

  // Escape = "go up one level". Skip when the user is mid-typing or
  // when a dialog / popup has already handled the key (it sets
  // defaultPrevented) so we don't yank the page out from under a
  // close-the-overlay action.
  $effect(() => {
    if (typeof window === 'undefined') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (target.isContentEditable) return;
      }
      goBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
</script>

<IconButton aria-label={ariaLabel} onclick={goBack} size="small">
  <ArrowLeft size={18} />
</IconButton>
