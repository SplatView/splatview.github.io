import { AdmissionError, checkedBytes } from '../../document/resources';

export type SurfaceTileLayout = {
  /** Two u32s per tile: offset into the compact list, then allocated span. */
  spans: Uint32Array;
  candidateEntries: number;
  /** Physical buffer bytes, including the minimum binding for an empty map. */
  candidateBytes: number;
  tileCapacity: number;
  tileCount: number;
  occupiedTiles: number;
  sortComparisons: number;
};

/** Validate the complete prefix sum before allocating or uploading any list.
 * Padding is local to each occupied tile, so empty/singleton tiles do no sort
 * work and one dense tile cannot inflate every other tile's allocation.
 */
export function planSurfaceTiles(counts: ArrayLike<number>, maximumCandidateBytes: number,
  maximumTileCapacity?: number): SurfaceTileLayout {
  checkedBytes(maximumCandidateBytes, 1);
  if (!Number.isSafeInteger(counts.length) || counts.length < 0 || counts.length > 0xffffffff)
    throw new AdmissionError('Invalid surface tile count.');
  if (maximumTileCapacity !== undefined && (!Number.isSafeInteger(maximumTileCapacity) || maximumTileCapacity < 1))
    throw new AdmissionError('Invalid surface tile ceiling.');
  const layoutBytes = checkedBytes(counts.length, 8);
  let candidateEntries = 0, tileCapacity = 0, occupiedTiles = 0, sortComparisons = 0;
  // Validate first: a rejected prefix must not allocate a large CPU layout.
  const spanFor = (count: number) => {
    if (!Number.isSafeInteger(count) || count < 0 || count > 0xffffffff)
      throw new AdmissionError('Invalid surface tile candidate count.');
    if (maximumTileCapacity !== undefined && count > maximumTileCapacity)
      throw new AdmissionError('The surface tile exceeds its explicit candidate ceiling.');
    return count ? 2 ** Math.ceil(Math.log2(count)) : 0;
  };
  for (let tile = 0; tile < counts.length; tile++) {
    const span = spanFor(counts[tile]);
    candidateEntries += span;
    // Shader offsets and every intermediate list index are u32 values.
    if (candidateEntries > 0xffffffff)
      throw new AdmissionError('The compact surface candidate indices exceed the graphics address limit.');
    if (Math.max(4, checkedBytes(candidateEntries, 4)) > maximumCandidateBytes)
      throw new AdmissionError('The compact surface candidates exceed the graphics device buffer limit.');
    tileCapacity = Math.max(tileCapacity, span);
    if (span) occupiedTiles++;
    const levels = span > 1 ? Math.log2(span) : 0;
    sortComparisons += span / 2 * levels * (levels + 1) / 2;
  }
  const candidateBytes = Math.max(4, checkedBytes(candidateEntries, 4));
  if (candidateBytes > maximumCandidateBytes)
    throw new AdmissionError('The compact surface candidates exceed the graphics device buffer limit.');
  const spans = new Uint32Array(layoutBytes / 4);
  let offset = 0;
  for (let tile = 0; tile < counts.length; tile++) {
    const span = spanFor(counts[tile]);
    spans[tile * 2] = offset; spans[tile * 2 + 1] = span; offset += span;
  }
  return { spans, candidateEntries, candidateBytes, tileCapacity, tileCount: counts.length, occupiedTiles, sortComparisons };
}
