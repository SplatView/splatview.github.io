import { AdmissionError, estimateSceneBytes } from './resources';
export const TRANSFORM_VIEW_BOOKKEEPING_BYTES = 16 * 1024;
export function estimateTransformWorkBytes(count: number, degree: number): number {
  if (!Number.isSafeInteger(count) || count < 0 || count > 1_000_000) throw new AdmissionError('Unsupported transform scene size.');
  // Old native/GPU bases and retained history have separate existing owners.
  // This admits candidate scene/upload plus detached control/job bookkeeping.
  return estimateSceneBytes(count, degree) + TRANSFORM_VIEW_BOOKKEEPING_BYTES;
}
