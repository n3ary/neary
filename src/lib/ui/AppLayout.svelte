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

<!-- Shell bg is --color-bg (not --color-surface) so the page canvas is the LIGHTER layer in dark mode and the cards (--color-surface) read as darker blocks popping against it. The nav and header paint --color-surface (same as cards), framing the lighter canvas with a top / bottom border in --color-border. -->
<div class="min-h-svh flex flex-col bg-[color:var(--color-bg)] text-[color:var(--color-fg)]">
  <!-- Sticky strip so Header and StatusBar scroll together (StatusBar alone would scroll away). Header paints --color-surface; the bg here matches the body so the strip's top edge blends with the canvas. -->
  <div class="sticky top-0 z-40 bg-[color:var(--color-bg)]">
    <Header {title} {health} {onrefresh} {refreshing} {showSearch} />
    <StatusBar />
  </div>
  <!-- Canvas bg (--color-bg) keeps the page background continuous into flex-1's slack area on short views (Stations with one card, Schedule, empty Favs/Settings). Bottom padding clears the fixed BottomNavigation plus the iOS home-indicator inset. -->
  <main class="flex-1 overflow-x-hidden bg-[color:var(--color-bg)] pb-[calc(3.5rem+env(safe-area-inset-bottom,0px))]">
    {@render children?.()}
  </main>
</div>
<!-- Rendered as a sibling of the flex container (not a flex child) because position: fixed inside display: flex is a documented iOS Safari quirk that anchors the nav to the flex container's bottom instead of the viewport bottom. -->
<BottomNavigation
  value={activeNav}
  onchange={onnav}
  items={navItems}
/>
