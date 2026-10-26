/** Display depth-key precision. Exact queries and clean output always use 32. */
export type SortPrecision = 16 | 24 | 32;
export function validateSortPrecision(value: unknown): SortPrecision {
  if (value !== 16 && value !== 24 && value !== 32) throw new RangeError('Sort precision must be 16, 24 or 32 bits.');
  return value;
}
