/**
 * Shared maths for the tiled canvas charts. Bars and the donut are painted the
 * same way — a field of small squares whose size is driven by a slowly drifting
 * wave — so the wave, the jitter hash and the colour lookup live here once.
 *
 * A canvas cannot read `var(--chart-1)`, so colours are resolved against the live
 * computed style when chart inputs or the theme change, then reused while frames
 * are painted.
 */

export const TAU = Math.PI * 2;

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function smoothstep(value: number): number {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

/** Deterministic 0..1 noise, so a tile keeps its size jitter across frames. */
export function hashUnit(x: number, y: number): number {
  let h = Math.imul(Math.round(x * 16) ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13) ^ Math.round(y * 16), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Three summed sines cluster near their mean, so mapping the full [-3,3] range
 * leaves crests too rare to read; clipping to [-2,2] lets smoothstep saturate
 * the tails and the drift becomes visible.
 */
export function tileWave(x: number, y: number, drift: number): number {
  const flow =
    Math.sin(x * 0.09 + drift) +
    Math.sin(y * 0.075 - drift * 0.83) +
    Math.sin((x + y) * 0.045 + drift * 1.31);
  return smoothstep((flow + 2) / 4);
}

/** Round up to the next 1/2/5/10 × power of ten so gridlines read cleanly. */
export function niceMax(raw: number): number {
  if (raw <= 0) return 1;
  const power = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = raw / power;
  return (step <= 1 ? 1 : step <= 2 ? 2 : step <= 5 ? 5 : 10) * power;
}

const CSS_VAR = /^var\((--[\w-]+)\)$/;

export function resolveColor(style: CSSStyleDeclaration, color: string): string {
  const name = CSS_VAR.exec(color)?.[1];
  if (!name) return color;
  return style.getPropertyValue(name).trim() || color;
}

export function resolveColors(element: Element, colors: readonly string[]): string[] {
  const style = getComputedStyle(element);
  return colors.map((color) => resolveColor(style, color));
}

/** Only hex is expanded; anything else is returned as-is and drawn opaque. */
export function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)?.[1];
  if (!hex) return color;
  const full = hex.length === 3 ? hex.replace(/./g, (c) => c + c) : hex;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
