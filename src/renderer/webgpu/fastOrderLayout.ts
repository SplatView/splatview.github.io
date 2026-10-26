import { checkedBytes } from '../../document/resources';

/** Optional retained buffers; source pairs/ranks are borrowed from the scene. */
export function planFastOrder(count: number) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 3_000_000) throw new RangeError('Invalid fast-order count.');
  const groups = Math.ceil(count / 256), blocks = Math.ceil(groups / 256);
  const sizes = {
    visibleCounts: checkedBytes(groups, 4), indirect: 20,
    compactA: checkedBytes(count, 8),
    visibleOffsets: checkedBytes(groups,4), visibleSums: checkedBytes(blocks,4), visibleBlocks: checkedBytes(blocks,4),
    visibleTotal:4,
  };
  const bufferBytes = Object.values(sizes).reduce((sum, value) => sum + value, 0);
  return { groups, blocks, sizes, bufferBytes, bytes: checkedBytes(bufferBytes + 16 * 1024, 1) };
}
