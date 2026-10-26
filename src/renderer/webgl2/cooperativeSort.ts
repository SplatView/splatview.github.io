import type { ComputeCheckpoint } from './radix';

/** Bottom-up merge preserves the exact comparator, including depth/source ties.
 * Scratch is caller-admitted and never transferred. Yield inside one huge tile.
 */
export async function cooperativeSort(values: Uint32Array, scratch: Uint32Array,
  compare: (a: number, b: number) => number, checkpoint: ComputeCheckpoint) {
  if (values.length <= 2048) { values.sort(compare); return; }
  if (scratch.length < values.length) throw new RangeError('Insufficient sort scratch.');
  let input = values, output = scratch.subarray(0, values.length), steps = 0;
  for (let width = 1; width < values.length; width *= 2) {
    for (let start = 0; start < values.length; start += 2 * width) {
      let a = start, b = Math.min(start + width, values.length);
      const mid = b, end = Math.min(start + 2 * width, values.length);
      for (let at = start; at < end; at++) {
        output[at] = a < mid && (b >= end || compare(input[a], input[b]) <= 0) ? input[a++] : input[b++];
        if ((++steps & 8191) === 0) await checkpoint();
      }
    }
    [input, output] = [output, input];
  }
  if (input !== values) values.set(input);
}
