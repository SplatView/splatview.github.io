/** Optional retained worker storage. Transient/query sorts keep 256 bins. */
export const sortScratchLimit = 16 * 1024 ** 2;

export function planSortScratch(count: number) {
  if (!Number.isSafeInteger(count) || count < 0 || count > 3_000_000) throw new RangeError('Invalid sort scratch count.');
  const histogramBins = count >= 65536 ? 65536 : 256;
  return { histogramBins, bytes: count ? count * 12 + histogramBins * 4 : 0 };
}
