import { AdmissionError, checkedBytes, type ResourceLease } from '../../document/resources';

/** Host/shader contract. Keep these values aligned with surface.wgsl. */
export const SURFACE_TILE_SIZE = 16;
export const SURFACE_PIXEL_LIMIT = 262_144;
export const SURFACE_PARAMETERS_BYTES = 48;
export const SURFACE_MAX_PACKED_COORDINATE = 65_535;
export const SURFACE_FLAGS = Object.freeze({ colors: 1, visible: 2, downsampled: 4, region: 8 });

/** Half-open coverage in the unchanged, downsampled selection-map grid. */
export type SurfaceRegion = Readonly<{ x: number; y: number; width: number; height: number }>;

/** Undefined coverage means the full map. Color and visibility require full coverage. */
export type SurfaceChannels = Readonly<{ colors?: boolean; visible?: boolean; region?: SurfaceRegion }>;

export type SurfaceProfile = {
  pipelineMs: number; countMs: number; planMs: number; allocationMs: number;
  compositeReadbackMs: number; copyMs: number; retireMs: number; totalMs: number;
  readbackBytes: number; reusedBuffers: number; createdBuffers: number;
};

export class SurfaceCapacityError extends AdmissionError {
  constructor(readonly required: number, readonly capacity: number) {
    super(`A surface tile needs ${required} candidates, exceeding the explicit query limit of ${capacity}.`);
  }
}

export type SurfaceOptions = SurfaceChannels & {
  /** Admission covers candidate lists, GPU outputs/readback and retained CPU arrays. */
  admit(bytes: number): ResourceLease;
  /** Compatibility hint; compact planning no longer allocates a global span. */
  initialTileCapacity?: number;
  /** Optional caller ceiling. The normal query has no fixed per-tile ceiling. */
  maxTileCapacity?: number;
  /** Explicit opt-in; retained physical buffers keep their own memory credit. */
  reuseBuffers?: boolean;
  poolOwner?: object;
  signal?: AbortSignal;
};

/** Published map metadata is immutable. Typed-array contents retain their
 * existing ownership/transport semantics; this adds no freezing or copying.
 */
export type SurfaceMap = Readonly<{
  width: number; height: number; fullWidth: number; fullHeight: number;
  depths: Float32Array; opacities: Float32Array; deviceEpoch: number;
  /** Raw view-dependent SH colors without display grading or selection tint. */
  colors?: Float32Array;
  /** Source-ID bitset from surviving fragments on the full framebuffer grid. */
  visible?: Uint32Array;
  region?: SurfaceRegion;
  profile?: Readonly<SurfaceProfile>;
  attempts: number; tileCapacity: number; allocationBytes: number;
  /** Physical candidate buffer bytes (minimum four), and compact work counts. */
  candidateBytes: number; candidateEntries: number; tileCount: number; occupiedTiles: number; sortComparisons: number;
  /** Rejects a map retained after its view, document or device changes. */
  assertCurrent(): void;
  dispose(): void;
}>;

export function surfaceDimensions(width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
    throw new AdmissionError('Invalid surface viewport dimensions.');
  const fullPixels = checkedBytes(width, height);
  const scale = Math.min(1, Math.sqrt(SURFACE_PIXEL_LIMIT / fullPixels));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)), scale };
}

/** Validate and snapshot depth coverage, preserving the full-map fallback. */
export function resolveSurfaceRegion(channels: SurfaceChannels, width: number, height: number): SurfaceRegion | undefined {
  const value = channels.colors || channels.visible ? undefined : channels.region;
  if (!value) return;
  const { x, y, width: w, height: h } = value;
  if (![x, y, w, h].every(Number.isSafeInteger) || Math.min(x, y, w, h) < 0 || x + w > width || y + h > height)
    throw new AdmissionError('Invalid surface query coverage.');
  // The existing 48-byte uniform has two packed-u16 words. Large thin maps
  // use the full path instead of truncating the encoded coordinates.
  if (width > SURFACE_MAX_PACKED_COORDINATE || height > SURFACE_MAX_PACKED_COORDINATE ||
    x === 0 && y === 0 && w === width && h === height) return;
  return Object.freeze({ x, y, width: w, height: h });
}

export function surfaceChannelFlags(channels: SurfaceChannels, downsampled: boolean): number {
  return (channels.colors ? SURFACE_FLAGS.colors : 0) | (channels.visible ? SURFACE_FLAGS.visible : 0) |
    (downsampled ? SURFACE_FLAGS.downsampled : 0);
}

const parameterWord = {
  fullWidth: 0, fullHeight: 1, width: 2, height: 3, tilesX: 4, tilesY: 5,
  coverageMinPacked: 6, sourceCount: 7, channels: 8, dispatchWidth: 9, scale: 10, coverageMaxPacked: 11,
} as const;

/** Encode already-admitted query inputs into the unchanged SurfaceParams ABI.
 * Coverage maxima are exclusive. scale is an f32 at byte40, not a u32 value.
 * This module owns packing only; GPU submission/retirement stay in surface.ts.
 */
export function encodeSurfaceParameters(input: {
  fullWidth: number; fullHeight: number; width: number; height: number;
  sourceCount: number; channelFlags: number; dispatchWidth: number; scale: number; region?: SurfaceRegion;
}): Uint32Array {
  const words = new Uint32Array(SURFACE_PARAMETERS_BYTES / Uint32Array.BYTES_PER_ELEMENT);
  words[parameterWord.fullWidth] = input.fullWidth;
  words[parameterWord.fullHeight] = input.fullHeight;
  words[parameterWord.width] = input.width;
  words[parameterWord.height] = input.height;
  words[parameterWord.tilesX] = Math.ceil(input.width / SURFACE_TILE_SIZE);
  words[parameterWord.tilesY] = Math.ceil(input.height / SURFACE_TILE_SIZE);
  words[parameterWord.sourceCount] = input.sourceCount;
  words[parameterWord.channels] = input.channelFlags | (input.region ? SURFACE_FLAGS.region : 0);
  words[parameterWord.dispatchWidth] = input.dispatchWidth;
  new Float32Array(words.buffer)[parameterWord.scale] = input.scale;
  if (input.region) {
    const { x, y, width, height } = input.region;
    words[parameterWord.coverageMinPacked] = (x | y << 16) >>> 0;
    words[parameterWord.coverageMaxPacked] = ((x + width) | (y + height) << 16) >>> 0;
  }
  return words;
}
