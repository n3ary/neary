// Reactive counter the shared header refresh button bumps; pages read `tick` inside their data-loading effect so they re-fire on refresh. Svelte tracks the read automatically — no event-listener cleanup.

class RefreshBus {
  tick = $state(0);

  fire(): void {
    this.tick += 1;
  }
}

export const refreshBus = new RefreshBus();
