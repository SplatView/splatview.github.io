export const STEADY_NOISE_BYTES = 32 * 32 * 64;
export const STEADY_UNIFORM_BYTES = 240;
export const STEADY_HISTORY_BYTES = 68;
export const STEADY_PIXEL_BYTES = 136;

/** Keep each history binding within portable storage limits without reducing display resolution. */
export function planSteadyResources(width: number, height: number, limits: Pick<GPUSupportedLimits,
  'maxTextureDimension2D' | 'maxBufferSize' | 'maxStorageBufferBindingSize' | 'maxComputeWorkgroupsPerDimension'>) {
  if (![width, height].every(v => Number.isSafeInteger(v) && v > 0 && v <= limits.maxTextureDimension2D) ||
      Math.ceil(width / 8) > limits.maxComputeWorkgroupsPerDimension || Math.ceil(height / 8) > limits.maxComputeWorkgroupsPerDimension)
    throw new RangeError('The SteadySplats viewport exceeds the graphics device limits.');
  const rows = Math.min(height, Math.floor(Math.min(limits.maxBufferSize, limits.maxStorageBufferBindingSize) / (width * STEADY_HISTORY_BYTES)));
  if (rows < 1) throw new RangeError('The SteadySplats history exceeds the graphics device buffer limit.');
  const stripes = Array.from({ length: Math.ceil(height / rows) }, (_, i) => ({
    start: i * rows, rows: Math.min(rows, height - i * rows),
  }));
  const bytes = width * height * STEADY_PIXEL_BYTES + STEADY_NOISE_BYTES + stripes.length * STEADY_UNIFORM_BYTES;
  if (!Number.isSafeInteger(bytes)) throw new RangeError('The SteadySplats allocation is too large.');
  return { width, height, stripes, bytes };
}
