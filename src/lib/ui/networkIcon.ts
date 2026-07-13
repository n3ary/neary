import { GraduationCap, MapPin, Moon, Music, Plane, Star, Zap } from 'lucide-svelte';
import { pickContrastingText } from '$lib/domain/types';

type IconComponent = typeof Moon;

// Icon mapping for the cluj-napoca TAGS + the `school` network. The
// icon chosen per id is purely cosmetic — the helper is a lookup
// with a sensible default, callers pass the result into a <Chip>.
// The mapping happens to cover the cluj tag ids by name, which is
// why the file is still called networkIcon (it's the historical
// name from when only networks existed).
const ICONS: Record<string, IconComponent> = {
  night: Moon,
  school: GraduationCap,
  metroline: MapPin,
  festival: Music,
  airport: Plane,
  special: Zap,
};

export function networkIcon(id: string): IconComponent {
  return ICONS[id] ?? Star;
}

/** Contrasting foreground color (black or white) for a network chip hex color. */
export function networkTextColor(hex: string): string {
  return pickContrastingText(hex);
}
