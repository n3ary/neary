// Sticky "dismissed" flag for the first-time home-page "Enable location" prompt. Unlike noLocationCardDismissedStore this does NOT auto-reset on opt-in — once the user has dismissed (or ever enabled GPS), the prompt stays hidden for good.

import { createDismissedFlag } from '../dismissedFlag.svelte';

export const enableLocationPromptDismissedStore = createDismissedFlag({
  storageKey: 'neary:enableLocationPromptDismissed',
});
