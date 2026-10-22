/** Histogram of the displayed frame, in RGB channel-major order. */
export type RenderedHistogram = {
  bins: Uint32Array;
  /** Number of sample columns/rows, rather than the display resolution. */
  width: number;
  height: number;
  frame: number;
  deviceEpoch: number;
};

export const HISTOGRAM_BINS = 256;
export const HISTOGRAM_HEIGHT = 54;
export const HISTOGRAM_COLORS = ['#ec6464', '#7dd292', '#69a5f5'] as const;
const empty = new Uint32Array(3 * HISTOGRAM_BINS);

/** Desktop uses a single logarithmic scale shared by all three channels. */
export function histogramPaths(bins: Uint32Array | undefined, width: number): string[] {
  const values = bins ?? empty;
  if (values.length !== empty.length || !Number.isFinite(width) || width < 8)
    throw new Error('Invalid rendered histogram.');
  let peak = 1;
  for (const value of values) peak = Math.max(peak, value);
  const normalization = (HISTOGRAM_HEIGHT - 8) / Math.log1p(peak);
  return HISTOGRAM_COLORS.map((_, channel) => Array.from({ length: HISTOGRAM_BINS }, (_, bin) => {
    const x = 4 + bin * (width - 8) / (HISTOGRAM_BINS - 1);
    const y = HISTOGRAM_HEIGHT - 4 - Math.log1p(values[channel * HISTOGRAM_BINS + bin]) * normalization;
    return `${bin ? 'L' : 'M'}${x.toFixed(3)},${y.toFixed(3)}`;
  }).join(' '));
}
