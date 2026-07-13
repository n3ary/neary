import { GraduationCap, MapPin, Moon, Music, Plane, Star, Zap } from 'lucide-svelte';

type IconComponent = typeof Moon;

// Lucide-svelte icon slug -> component.
//
// The slug is the lucide name in kebab-case, minus any "lucide-" or
// trailing brand prefix (e.g. `moon`, `map-pin`, `plane`, `music`,
// `zap`). The cluj adapter's `CATEGORIES.icon` field carries these
// strings; this registry maps them to actual lucide components.
//
// Why a registry (vs. a wider `Record<string, IconComponent>` that
// wraps the whole lucide-svelte module): lucide-svelte ships 1000+
// icons, the app uses 5. Shipping a hand-picked registry keeps the
// bundle small AND pinpoints where the icon set lives — adding a
// new tag icon = one entry in CATEGORIES + one entry here, with
// the build failing loudly at the registry if a slug is misspelled.
//
// Network chips (school, normal) deliberately do NOT go through
// this registry: networks don't get icons per the app's UI choice.
const ICONS: Record<string, IconComponent> = {
  moon: Moon,
  'map-pin': MapPin,
  graduation: GraduationCap, // reserved for any future "education" tag
  music: Music,
  plane: Plane,
  zap: Zap,
};

/** Return the lucide-svelte component for a tag's `icon` slug, or
 *  the `Star` default for unknown / missing icons. The app
 *  deliberately doesn't fall back to a `tag.id` lookup — the
 *  adapter owns the slug, not the id. */
export function tagIcon(slug: string | undefined): IconComponent {
  if (slug && ICONS[slug]) return ICONS[slug];
  return Star;
}

/** True when the registry has a real component for this slug. Lets
 *  the chip renderer skip the icon slot entirely when the tag
 *  carries no icon (vs rendering a misleading `Star`). */
export function hasTagIcon(slug: string | undefined): slug is keyof typeof ICONS {
  return !!slug && slug in ICONS;
}

