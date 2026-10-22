import { AdmissionError, checkedBytes, MiB } from './resources';
import { LOADED_PREVIEW_LIMIT } from './loadProbe';

// Emscripten scalar WASM32 layout, asserted in morphology_job.hpp. This is the
// full stable owner, including Job and six array owners, rather than Job alone.
export const MORPHOLOGY_OWNER_BYTES = 6280;
// Native metrics sample at most16,384 physical records:36 bytes each, plus
// its small cooperative owner. This is separate from edit/history admission.
export const MORPHOLOGY_RANGE_WORK_BYTES = 600 * 1024;

export function morphologyNodeCapacity(count: number): number {
  checkedBytes(count, 1);
  if (count > LOADED_PREVIEW_LIMIT) throw new AdmissionError('Grow/Shrink exceeds the supported preview size.');
  if (count <= 16) return count ? 1 : 0;
  const power = 2 ** Math.floor(Math.log2(Math.floor(count / 16)));
  const leaves = Math.floor(count / power) > 16 ? 2 * power : power + count - 16 * power;
  return 2 * leaves - 1;
}

/** Conservative operation policy, not a closed allocator/heap quota.
 * Six admitted arrays: Bounds24N + order4N + matchedN + Override8N +
 * Node40M + remaining4M. Native publication also holds Changes<=8N and
 * a new COW mask N; later mask staging holds inputN + copyN + expanded4N +
 * candidate GPU4N. 24N covers their conservative sum with 5N headroom.
 * The extra4MiB admits bookkeeping; real native allocators still enforce their
 * own grants, while observed heap growth is reconciled separately. Existing
 * scene/mask/history stay charged; controller adds historyBytes for transaction
 * copy overlap. Neither this allowance nor that overlap is an exact census.
 */
export function estimateMorphologyWorkBytes(count: number): number {
  const nodes = morphologyNodeCapacity(count);
  return checkedBytes(checkedBytes(count, 37) + checkedBytes(nodes, 44) +
    MORPHOLOGY_OWNER_BYTES + checkedBytes(count, 24) + 4 * MiB, 1);
}
