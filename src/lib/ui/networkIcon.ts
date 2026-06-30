import { GraduationCap, MapPin, Moon, Music, Plane, Star, Zap } from 'lucide-svelte';
import { rotateHueOklch } from '$lib/domain/oklch';
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

// Distribute 6 perceptually distinct colors around the OKLCh hue wheel,
// starting from a dark purple for "night". Lightness and chroma are
// preserved across all rotations so every chip reads at equal weight.
const NIGHT_HEX = '5B2D8E';
const NETWORK_ORDER = ['night', 'school', 'festival', 'airport', 'metroline', 'special'] as const;
const STEP = 360 / NETWORK_ORDER.length;

const NETWORK_COLORS: Record<string, string> = Object.fromEntries(
  NETWORK_ORDER.map((id, i) => [id, `#${rotateHueOklch(NIGHT_HEX, i * STEP)}`]),
);

/** Hex background color for a network chip (e.g. `#5B2D8E`). */
export function networkColor(id: string): string {
  return NETWORK_COLORS[id] ?? NETWORK_COLORS['special'] ?? '#5B2D8E';
}

/** Contrasting foreground color (black or white) for `networkColor(id)`. */
export function networkTextColor(id: string): string {
  return pickContrastingText(networkColor(id));
}
