<!-- Single source for "go one level up" on detail views. Try history.back() when previous was added in this tab (history.length > 1); otherwise navigate to `fallback` (default `/`) so a deep-link or page-refresh doesn't strand the user on the browser's blank "no history" stub. Escape fires the same handler. -->

<!-- Intra-view navigation (tab swaps, direction swaps) MUST use `goto(..., { replaceState: true })` so "back" returns to where the user came from instead of walking every tab they touched. -->
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
