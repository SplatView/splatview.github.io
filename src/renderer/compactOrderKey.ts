import type { SortPrecision } from './sortPrecision';

// View, projection, framebuffer, geometry and opacity can change visibility.
// Color grading, SH eye direction and selection tint cannot change ordering.
const fields = [...Array.from({ length: 32 }, (_, i) => i), 36, 37, 59,
  ...Array.from({ length: 18 }, (_, i) => 60 + i), 79];
export type CompactOrderKey = { revision: number; precision: SortPrecision; bits: Uint32Array };
export function captureCompactOrderKey(words: Uint32Array, revision: number, precision: SortPrecision): CompactOrderKey {
  return { revision, precision, bits: Uint32Array.from(fields, index => words[index]) };
}
export function compactOrderMatches(key: CompactOrderKey | undefined, words: Uint32Array, revision: number, precision: SortPrecision): boolean {
  return !!key && key.revision === revision && key.precision >= precision && fields.every((index, i) => words[index] === key.bits[i]);
}
