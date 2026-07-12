<!-- Page shell: Header + StatusBar + scrollable main + fixed BottomNavigation. BottomNavigation is rendered as a sibling of the flex column (not inside it) because position: fixed inside display: flex is a known iOS Safari quirk. Header+StatusBar share one sticky strip so they scroll together (StatusBar alone would scroll away). -->
<script lang="ts" generics="T extends string">
  import type { Snippet } from 'svelte';
  import BottomNavigation from './BottomNavigation.svelte';
  import Header from './Header.svelte';
  import type { HeaderHealth } from './headerTypes';
  import StatusBar from './StatusBar.svelte';

  type NavItem = {
    value: T;
    label: string;
    icon: Snippet;
  };

  type Props = {
    title: string;
    health: HeaderHealth;
    onrefresh?: () => void;
    refreshing?: boolean;
    /** Show the station-search icon in the header. Owner of the feed
     *  selection (typically +layout.svelte) decides; defaults to off. */
    showSearch?: boolean;
    navItems: readonly NavItem[];
    activeNav: T;
    onnav: (next: T) => void;
    children?: Snippet;
  };

  let {
    title,
    health,
    onrefresh,
    refreshing = false,
    showSearch = false,
    navItems,
    activeNav,
    onnav,
    children,
  }: Props = $props();
</script>

<!-- Shell bg is --color-surface (not --color-bg) so the band immediately below the fixed BottomNavigation matches the nav; with --color-bg the band's --bg shows through and reads as a dark stripe between the last card and the screen bottom on short views. -->
<div class="min-h-svh flex flex-col bg-[color:var(--color-surface)] text-[color:var(--color-fg)]">
  <!-- Sticky strip so Header and StatusBar scroll together (StatusBar alone would scroll away); wrapper's surface background hides the gap between an active Header and an inactive StatusBar. -->
  <div class="sticky top-0 z-40 bg-[color:var(--color-surface)]">
    <Header {title} {health} {onrefresh} {refreshing} {showSearch} />
    <StatusBar />
  </div>
  <!-- Surface bg hides the --bg shell showing through flex-1's slack area on short views (Stations with one card, Schedule, empty Favs/Settings) where that slack read as a stripe between the last card and the fixed nav. -->
  <!-- flex flex-col lets route wrappers use `flex-1 min-h-0` to fill the available height and push trailing content (e.g. the version watermark on /) to the bottom of the visible area, closing the gap between the last card and the fixed nav. -->
  <!-- Bottom padding clears the fixed BottomNavigation plus the iOS home-indicator inset so the nav + inset don't cover the last content row. -->
  <main class="flex-1 flex flex-col overflow-x-hidden bg-[color:var(--color-surface)] pb-[calc(3.5rem+env(safe-area-inset-bottom,0px))]">
    {@render children?.()}
  </main>
</div>
<!-- Rendered as a sibling of the flex container (not a flex child) because position: fixed inside display: flex is a documented iOS Safari quirk that anchors the nav to the flex container's bottom instead of the viewport bottom. -->
<BottomNavigation
  value={activeNav}
  onchange={onnav}
  items={navItems}
/>
