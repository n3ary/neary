/*
 * connectionStore — `navigator.onLine` mirror. Cheap; reflects what the OS
 * tells us about network availability. Not authoritative (the OS sometimes
 * lies, especially on captive portals), but good enough for the header dot
 * and for skipping live-data refresh attempts when clearly offline.
 */

class ConnectionStore {
  online = $state(typeof navigator !== 'undefined' ? navigator.onLine : true);

  constructor() {
    if (typeof window === 'undefined') return;
    window.addEventListener('online', () => (this.online = true));
    window.addEventListener('offline', () => (this.online = false));
  }
}

export const connectionStore = new ConnectionStore();
