/*
 * noLocationCardDismissedStore - sticky "dismissed" flag for the
 * NoLocationCard. Persists in localStorage so a dismissed card stays
 * hidden across reloads.
 *
 * Auto-resets on a fresh opt-in (userPrefs.gpsOptedIn false -> true)
 * so the card reappears if the next permission attempt fails. The
 * shared createDismissedFlag factory centralises the load/persist/
 * SSR-safety logic so this file is just a data declaration.
 */

import { userPrefs } from '../userPrefs.svelte';
import { createDismissedFlag } from '../dismissedFlag.svelte';

export const noLocationCardDismissedStore = createDismissedFlag({
  storageKey: 'neary:noLocationCardDismissed',
  resetOn: () => userPrefs.gpsOptedIn,
});