import { clsx, type ClassValue } from 'clsx';

/**
 * Tiny class composer used by every primitive. Re-exports clsx under a short
 * local name. If we ever need Tailwind class-conflict resolution (twMerge),
 * upgrade just this module — call sites stay unchanged.
 */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
