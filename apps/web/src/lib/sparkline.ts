/**
 * SVG polyline points ("x,y x,y …") for a value series drawn left-to-right in
 * a width×height box with 1px padding. An all-zero series draws a flat
 * baseline, and a single-value series collapses to its leftmost point.
 */
export const sparklinePoints = (
  values: number[],
  width: number,
  height: number,
): string => {
  if (values.length === 0) return "";
  const pad = 1;
  const max = Math.max(...values);
  const stepX = (width - pad * 2) / Math.max(values.length - 1, 1);
  const y = (v: number): number =>
    max > 0 ? height - pad - (v / max) * (height - pad * 2) : height - pad;
  return values
    .map((v, i) => `${(pad + i * stepX).toFixed(1)},${y(v).toFixed(1)}`)
    .join(" ");
};
