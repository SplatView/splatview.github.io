import { AdmissionError, checkedBytes, estimateSceneBytes, MiB } from './resources';
import { DUPLICATE_SCENE_LIMIT } from './duplicateProtocol';

// WASM32 sizes are exercised by the real native Duplicate contract executable.
export const DUPLICATE_JOB_BYTES = 184;
export const DUPLICATE_LINEAGE_BYTES = 1024;

/** Reserve the largest candidate the current selection could produce. The
 * captured view may reduce it; native counting owns the actual limit refusal.
 * Existing scene/GPU/history remain charged throughout this candidate's life. */
export function estimateDuplicateWorkBytes(count: number, selected: number, degree: number): number {
  checkedBytes(count, 1); checkedBytes(selected, 1);
  if (!count || count >= DUPLICATE_SCENE_LIMIT || !selected || selected > count)
    throw new AdmissionError('Duplicate requires selected splats and room within the one-million loaded-splat limit.');
  const candidate = Math.min(DUPLICATE_SCENE_LIMIT, count + selected);
  // Full native Scene and GPU replacement, growing mask, transferred byte mask
  // and expanded mask upload. Fixed job/tables and allocator/string bookkeeping
  // have independent headroom. Outer transaction history is added by the owner.
  return checkedBytes(estimateSceneBytes(candidate, degree) + checkedBytes(candidate, 6) +
    DUPLICATE_JOB_BYTES + 2 * DUPLICATE_LINEAGE_BYTES + 4 * MiB, 1);
}
