/** Rounds an axis maximum up to 1, 2 or 5 times a power of ten. */
export function niceMax(raw: number): number {
  if (raw <= 0) return 1;
  const power = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = raw / power;
  return (step <= 1 ? 1 : step <= 2 ? 2 : step <= 5 ? 5 : 10) * power;
}

export type ChartPoint = readonly [x: number, y: number];

/**
 * SVG path through every point as cubic Béziers with Steffen's monotone tangents:
 * the curve never overshoots a neighboring value, so a spike next to a zero day
 * cannot dip below the baseline or rise past the axis maximum.
 */
export function smoothPath(points: readonly ChartPoint[]): string {
  if (points.length === 0) return "";
  const fixed = (value: number) => Number(value.toFixed(2));
  const widths = points.slice(1).map((point, index) => point[0] - points[index]![0]);
  const slopes = points
    .slice(1)
    .map((point, index) => (point[1] - points[index]![1]) / (widths[index] || 1));
  const tangents = points.map((_, index) => {
    if (index === 0) return slopes[0] ?? 0;
    if (index === points.length - 1) return slopes[index - 1]!;
    const before = slopes[index - 1]!;
    const after = slopes[index]!;
    const blended =
      (before * widths[index]! + after * widths[index - 1]!) /
      (widths[index - 1]! + widths[index]!);
    return (
      (Math.sign(before) + Math.sign(after)) *
      Math.min(Math.abs(before), Math.abs(after), Math.abs(blended) / 2)
    );
  });
  let path = `M${fixed(points[0]![0])} ${fixed(points[0]![1])}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const [x0, y0] = points[index]!;
    const [x1, y1] = points[index + 1]!;
    const third = widths[index]! / 3;
    path += ` C${fixed(x0 + third)} ${fixed(y0 + tangents[index]! * third)} ${fixed(x1 - third)} ${fixed(y1 - tangents[index + 1]! * third)} ${fixed(x1)} ${fixed(y1)}`;
  }
  return path;
}
