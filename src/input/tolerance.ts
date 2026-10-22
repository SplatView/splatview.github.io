// Frozen desktop valueSlider uses %.4g percent and ImGui's logarithmic
// zero epsilon 10^-4 in that displayed 0..100 range. Preserve exact endpoints
// and do not round the stored fraction to its four-digit display format.
export function toleranceFromRatio(ratio: number): number {
  return ratio <= 0 ? 0 : ratio >= 1 ? 1 : Math.pow(10, -6 + 6 * ratio);
}
export function toleranceRatio(fraction: number): number {
  return fraction <= 1e-6 ? 0 : fraction >= 1 ? 1 : (Math.log10(fraction) + 6) / 6;
}
export function tolerancePercent(fraction: number): string {
  const rounded = Number((fraction * 100).toPrecision(4));
  if (!rounded) return '0';
  const exponent = Math.floor(Math.log10(Math.abs(rounded)));
  if (exponent < -4 || exponent >= 4) {
    const [mantissa, power] = rounded.toExponential(3).split('e');
    return `${Number(mantissa)}e${Number(power) < 0 ? '-' : '+'}${Math.abs(Number(power)).toString().padStart(2, '0')}`;
  }
  return String(rounded);
}
