// Open/close singleton for the station search overlay inside Header. Lets any view trigger the overlay without threading callbacks through AppLayout + Header.

class SearchOverlayStore {
  isOpen = $state(false);

  open(): void {
    this.isOpen = true;
  }

  close(): void {
    this.isOpen = false;
  }
}

export const searchOverlayStore = new SearchOverlayStore();
