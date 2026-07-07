// Sticky "dismissed" flag for the NoLocationCard. Persists in localStorage; auto-resets on a fresh opt-in (userPrefs.gpsOptedIn false -> true) so the card reappears if the next permission attempt fails.

import { userPrefs } from '../userPrefs.svelte';
import { createDismissedFlag } from '../dismissedFlag.svelte';

export const noLocationCardDismissedStore = createDismissedFlag({
  storageKey: 'neary:noLocationCardDismissed',
  resetOn: () => userPrefs.gpsOptedIn,
});
