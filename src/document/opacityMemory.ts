import { AdmissionError, estimateSceneBytes } from './resources';
export const OPACITY_VIEW_BOOKKEEPING_BYTES = 16 * 1024;
export function estimateOpacityWorkBytes(count: number, degree: number): number {
  if (!Number.isSafeInteger(count) || count < 0 || count > 1_000_000) throw new AdmissionError('Unsupported opacity scene size.');
  // One cooperative candidate plus bounded job/scene metadata. Immutable base,
  // frozen mask and retained history are charged through their existing owners.
  return estimateSceneBytes(count, degree) + OPACITY_VIEW_BOOKKEEPING_BYTES;
}
