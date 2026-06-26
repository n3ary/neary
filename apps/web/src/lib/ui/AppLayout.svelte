<!--
  AppLayout — overall page shell: Header + StatusBar + scrollable main +
  fixed BottomNavigation. All routes wrap their content in this via
  +layout.svelte; per-route specifics (title, nav active) are passed in.

  The main element gets bottom padding (pb-20) so the fixed BottomNavigation
  doesn't cover the last content row. Top safe-area inset is added inside
  Header (so the colored band extends into the notch on iOS).
-->
<script lang="ts" generics="T extends string">
  import type { Snippet } from 'svelte';
  import BottomNavigation from './BottomNavigation.svelte';
  import Header, { type HeaderHealth } from './Header.svelte';
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
    navItems: NavItem[];
    activeNav: T;
    onnav: (next: T) => void;
    children?: Snippet;
  };

  let {
    title,
    health,
    onrefresh,
    refreshing = false,
    navItems,
    activeNav,
    onnav,
    children,
  }: Props = $props();
</script>

<div class="min-h-svh flex flex-col bg-[color:var(--color-bg)] text-[color:var(--color-fg)]">
  <Header {title} {health} {onrefresh} {refreshing} />
  <StatusBar />
  <main class="flex-1 overflow-x-hidden pb-20">
    {@render children?.()}
  </main>
  <BottomNavigation
    value={activeNav}
    onchange={onnav}
    items={navItems}
  />
</div>
