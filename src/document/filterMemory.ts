import { AdmissionError, checkedBytes, MiB } from './resources';

export const FILTER_VIEW_BOOKKEEPING_BYTES = 16 * 1024;
export function estimateFilterWorkBytes(count: number): number {
  if (!Number.isSafeInteger(count) || count < 0 || count > 1_000_000)
    throw new AdmissionError('Selection filters support at most one million loaded splats.');
  // Result/COW masks, exact selection delta, GPU mask staging and transferred
  // bytes overlap. Native transaction/history copies are reserved separately.
  return checkedBytes(count, 32) + 8 * MiB + FILTER_VIEW_BOOKKEEPING_BYTES;
}
