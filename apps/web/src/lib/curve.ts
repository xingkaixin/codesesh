/**
 * Resampling for the tiled area plot. The tile engine reads a fixed-width curve
 * rather than the raw series, so a redraw never has to know how many days it is
 * showing, and a change in the number of days is just another reshape.
 */

/** Resolution of the resampled curve the tile engine reads from. */
export const SAMPLES = 512;

/** Fraction of the plot kept empty above the tallest point. */
export const HEADROOM = 0.16;

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Bars above are drawn centred in their column, so the curve's ends sit half a
 * column inside the plot: a peak then lines up with the bar it belongs to.
 */
export function resampleCurve(
  values: readonly number[],
  out: Float32Array = new Float32Array(SAMPLES),
): Float32Array {
  const count = values.length;
  if (count === 0) {
    out.fill(0);
    return out;
  }

  for (let s = 0; s < SAMPLES; s++) {
    const position = clamp((s / (SAMPLES - 1)) * count - 0.5, 0, count - 1);
    const index = Math.min(count - 2, Math.floor(position));
    if (index < 0) {
      out[s] = values[0]!;
      continue;
    }
    const blend = smoothstep(position - index);
    out[s] = values[index]! * (1 - blend) + values[index + 1]! * blend;
  }
  return out;
}

/** Read the resampled curve at an arbitrary x fraction. */
export function curveAt(curve: Float32Array, fx: number): number {
  const position = clamp(fx, 0, 1) * (SAMPLES - 1);
  const index = Math.min(SAMPLES - 2, Math.floor(position));
  const blend = position - index;
  return curve[index]! * (1 - blend) + curve[index + 1]! * blend;
}

/** Vertical position of a value as a fraction from the top of the plot. */
export function topFraction(value: number, max: number): number {
  return 1 - (max > 0 ? Math.min(1, value / max) : 0) * (1 - HEADROOM);
}
