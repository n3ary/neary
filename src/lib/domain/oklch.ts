/*
 * Minimal OKLab / OKLCh helpers — ported from neary-gtfs.
 * Björn Ottosson's OKLab is a perceptually uniform color space; rotating
 * hue in OKLCh changes the perceived color family while keeping lightness
 * and chroma constant, so the output is a genuinely different hue rather
 * than a tint/shade of the same color.
 * https://bottosson.github.io/posts/oklab/
 */

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  return [r, g, b]
    .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
    .join('');
}

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(c: number): number {
  const clamped = Math.max(0, Math.min(1, c));
  const v = clamped <= 0.0031308
    ? 12.92 * clamped
    : 1.055 * clamped ** (1 / 2.4) - 0.055;
  return v * 255;
}

function rgbToOklab([R, G, B]: [number, number, number]): [number, number, number] {
  const r = srgbToLinear(R);
  const g = srgbToLinear(G);
  const b = srgbToLinear(B);
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  return [
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  ];
}

function oklabToRgb([L, a, b]: [number, number, number]): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  return [
    linearToSrgb( 4.0767416621 * l_ ** 3 - 3.3077115913 * m_ ** 3 + 0.2309699292 * s_ ** 3),
    linearToSrgb(-1.2684380046 * l_ ** 3 + 2.6097574011 * m_ ** 3 - 0.3413193965 * s_ ** 3),
    linearToSrgb(-0.0041960863 * l_ ** 3 - 0.7034186147 * m_ ** 3 + 1.7076147010 * s_ ** 3),
  ];
}

/**
 * Rotate the hue of a 6-char hex color by `degrees` in OKLCh space.
 * Lightness and chroma are preserved exactly; only the hue angle changes.
 * Returns a 6-char lowercase hex (no leading `#`).
 */
export function rotateHueOklch(hex: string, degrees: number): string {
  const [L, a, b] = rgbToOklab(hexToRgb(hex));
  const C = Math.sqrt(a * a + b * b);
  const h = Math.atan2(b, a) + (degrees * Math.PI) / 180;
  return rgbToHex(oklabToRgb([L, C * Math.cos(h), C * Math.sin(h)]));
}
