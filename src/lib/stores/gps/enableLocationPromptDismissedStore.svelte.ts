/*
 * enableLocationPromptDismissedStore - sticky "dismissed" flag for the
 * first-time "Enable location" prompt on the home page. Once the user
 * dismisses it, the prompt stays hidden across reloads.
 *
 * Unlike noLocationCardDismissedStore this flag does NOT auto-reset on
 * a fresh opt-in: once the user has dismissed the prompt (or enabled
 * location once, which the home page gates the prompt on via
 * userPrefs.hasEverEnabledGPS), they don't need to see it again.
 */

import { createDismissedFlag } from '../dismissedFlag.svelte';

export const enableLocationPromptDismissedStore = createDismissedFlag({
  storageKey: 'neary:enableLocationPromptDismissed',
});