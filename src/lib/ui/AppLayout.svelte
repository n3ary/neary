<!-- Overall page shell: Header + StatusBar + scrollable main + fixed BottomNavigation. Header+StatusBar share a single sticky strip (StatusBar alone would scroll away); BottomNavigation is rendered outside the flex column because position: fixed inside flex is an iOS Safari quirk. Shell uses min-h-dvh (current visible viewport) not min-h-svh (which in iOS PWA standalone includes the area below the home indicator). -->
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

<div class="min-h-dvh flex flex-col bg-[color:var(--color-bg)] text-[color:var(--color-fg)]">
  <!-- Sticky strip: Header (sticky itself) + StatusBar. Wrapping them
       in one sticky element means they move together as a unit while
       the user scrolls, instead of the Header pinning and the StatusBar
       scrolling away. The wrapper's surface background fills any gap
       between the Header (also surface) and an inactive StatusBar so
       content scrolling under it stays hidden. -->
  <div class="sticky top-0 z-40 bg-[color:var(--color-surface)]">
    <Header {title} {health} {onrefresh} {refreshing} {showSearch} />
    <StatusBar />
  </div>
  <!-- Bottom padding clears the fixed BottomNavigation (h-14 ≈ 56 px)
       PLUS the iOS home-indicator inset. Without the safe-area in this
       calc, the last content row on iPhones with a home indicator gets
       covered by the inset (the nav itself pads up by safe-bottom, the
       page must too). -->
  <main class="flex-1 overflow-x-hidden pb-[calc(3.5rem+env(safe-area-inset-bottom,0px))]">
    {@render children?.()}
  </main>
</div>
<!-- Rendered as a sibling of the flex container rather than a flex
     child — `position: fixed` inside a `display: flex` parent is a
     documented iOS Safari quirk that occasionally anchors the nav to
     the flex container's bottom instead of the viewport bottom. -->
<BottomNavigation
  value={activeNav}
  onchange={onnav}
  items={navItems}
/>
