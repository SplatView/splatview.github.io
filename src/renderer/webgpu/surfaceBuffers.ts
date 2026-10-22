import { AdmissionError, checkedBytes } from '../../document/resources';
import { SURFACE_PARAMETERS_BYTES, SURFACE_TILE_SIZE, type SurfaceChannels } from './surfaceQuery';

export type SurfaceBufferPlan = Readonly<{
  pixels: number; tilesX: number; tilesY: number; tileCount: number;
  countBytes: number; layoutBytes: number; outputBytes: number; readbackBytes: number;
  auxiliaryBytes: number; projectionBytes: number; colorBytes: number; visibilityBytes: number;
  /** CPU count view, span array/upload and parameter array/upload. */
  hostScratchBytes: number;
  /** Every noncandidate GPU buffer, including readbacks and dummy bindings. */
  physicalScratchBytes: number;
  /** Full-size CPU map arrays retained after GPU retirement. */
  retainedCpuBytes: number;
}>;

/** Size an already-bounded map and resolved coverage without allocating it.
 * Candidate spans are deliberately absent: surface.ts admits them only after
 * the count stage. Device limits, leases and retirement also stay in that owner.
 */
export function planSurfaceBuffers(input: SurfaceChannels & Readonly<{
  width: number; height: number; sourceCount: number; downsampled: boolean;
}>): SurfaceBufferPlan {
  const { width, height, sourceCount, downsampled, colors, visible, region } = input;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
    throw new AdmissionError('Invalid surface viewport dimensions.');
  checkedBytes(sourceCount, 1);
  const pixels = checkedBytes(width, height);
  const tilesX = Math.ceil(width / SURFACE_TILE_SIZE), tilesY = Math.ceil(height / SURFACE_TILE_SIZE);
  const tileCount = checkedBytes(tilesX, tilesY);
  const countBytes = checkedBytes(tileCount, 4), layoutBytes = checkedBytes(tileCount, 8);
  const outputBytes = checkedBytes(pixels, 8);
  const readbackBytes = region ? Math.max(4, checkedBytes(checkedBytes(region.width, region.height), 8)) : outputBytes;
  const auxiliaryBytes = colors || visible ? checkedBytes(sourceCount, 16) : 16;
  const projectionBytes = downsampled ? checkedBytes(sourceCount, 48) : colors || visible ? 48 : 0;
  const colorBytes = colors ? checkedBytes(pixels, 16) : 16;
  const visibilityBytes = visible ? checkedBytes(Math.ceil(sourceCount / 32), 4) : 0;
  const retainedCpuBytes = checkedBytes(checkedBytes(pixels, colors ? 20 : 8) + visibilityBytes, 1);

  // Parameters retain one host array and one queued upload copy. Their GPU
  // uniform is a third copy, charged below to physical scratch. Span uploads
  // likewise have two host copies; mapped counts keep one bounded host view.
  const hostScratchBytes = checkedBytes(countBytes + checkedBytes(layoutBytes, 2) +
    checkedBytes(SURFACE_PARAMETERS_BYTES, 2), 1);
  // Counts need storage/readback, spans one storage buffer, and each requested
  // color/visibility channel needs storage/readback. The depth output remains
  // full-size even when its readback is restricted to a depth-only region.
  const physicalScratchBytes = checkedBytes(checkedBytes(countBytes, 2) + layoutBytes + outputBytes + readbackBytes +
    auxiliaryBytes + projectionBytes + checkedBytes(colorBytes, colors ? 2 : 1) + checkedBytes(visibilityBytes, 2) +
    SURFACE_PARAMETERS_BYTES, 1);
  return { pixels, tilesX, tilesY, tileCount, countBytes, layoutBytes, outputBytes, readbackBytes,
    auxiliaryBytes, projectionBytes, colorBytes, visibilityBytes, hostScratchBytes, physicalScratchBytes, retainedCpuBytes };
}
