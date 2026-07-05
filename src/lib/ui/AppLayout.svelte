<!--
  AppLayout - overall page shell: Header + StatusBar + scrollable main +
  fixed BottomNavigation. All routes wrap their content in this via
  +layout.svelte; per-route specifics (title, nav active) are passed in.

  Header + StatusBar are wrapped in a single `sticky top-0` strip so
  they stick together at the top of the viewport during body scroll
  (StatusBar alone isn't sticky and would scroll away). BottomNavigation
  is rendered OUTSIDE the flex column because `position: fixed` inside
  a flex parent is a known iOS Safari quirk - taking it out guarantees
  the nav pins to the viewport bottom regardless of the layout chain.

  Main has bottom padding (pb-calc) so the fixed BottomNavigation (h-14
  ~ 56 px) PLUS the iOS home-indicator inset don't cover the last
  content row. Top safe-area inset is added inside Header (so the
  colored band extends into the notch on iOS).

  The shell uses `min-h-dvh` (dynamic viewport height), not `min-h-svh`
  (smallest viewport height). In iOS PWA standalone mode `100svh` can
  include the area below the home indicator, which makes the flex
  container taller than the visible viewport; a `position: fixed`
  element anchored at `bottom: 0` then appears to float up with a
  blank strip below it (#184). `100dvh` tracks the current visible
  viewport, so the container stays inside the screen and the nav
  pins where it should.
-->
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
