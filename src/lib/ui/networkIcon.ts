import { GraduationCap, MapPin, Moon, Music, Plane, Star, Zap } from 'lucide-svelte';
import { pickContrastingText } from '$lib/domain/types';

type IconComponent = typeof Moon;

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
