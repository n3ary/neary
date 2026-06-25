/* Barrel for primitives. Deep-imports work too; barrel exists for taste. */

export { default as Box } from './Box.svelte';
export { default as Stack } from './Stack.svelte';
export { default as Typography } from './Typography.svelte';
export { default as Card } from './Card.svelte';
export { default as CardContent } from './CardContent.svelte';
export { default as Chip } from './Chip.svelte';
export { default as Avatar } from './Avatar.svelte';
export { default as Button } from './Button.svelte';
export { default as IconButton } from './IconButton.svelte';
export { default as Spinner } from './Spinner.svelte';
export { default as StatusBar } from './StatusBar.svelte';
export { default as BottomNavigation } from './BottomNavigation.svelte';

export { default as Dialog } from './Dialog.svelte';
export { default as DialogTitle } from './DialogTitle.svelte';
export { default as DialogContent } from './DialogContent.svelte';
export { default as Tooltip } from './Tooltip.svelte';
export { default as Collapsible } from './Collapsible.svelte';
export { default as Switch } from './Switch.svelte';
export { default as TextField } from './TextField.svelte';
export { default as ProgressBar } from './ProgressBar.svelte';

export { default as Tabs } from './Tabs.svelte';
export { default as ToggleGroup } from './ToggleGroup.svelte';
export { default as List } from './List.svelte';
export { default as ListItem } from './ListItem.svelte';
export { default as ListItemText } from './ListItemText.svelte';

// Composite primitives — domain-shaped, consume the discriminated Vehicle
// union from $lib/domain/types so taxonomy decisions live in one place.
export { default as RouteBadge } from './RouteBadge.svelte';
export { default as VehicleCard } from './VehicleCard.svelte';
export { default as StationCard } from './StationCard.svelte';

export { cn } from './cn';

