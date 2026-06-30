import { GraduationCap, MapPin, Moon, Music, Plane, Star, Zap } from 'lucide-svelte';

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
