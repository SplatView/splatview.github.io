import { describe, expect, it } from 'vitest';
import { estimateDuplicateWorkBytes, DUPLICATE_JOB_BYTES, DUPLICATE_LINEAGE_BYTES } from '../src/document/duplicateMemory';
import { estimateSceneBytes, MiB } from '../src/document/resources';

describe('Duplicate candidate admission', () => {
  it('retains the full replacement and growing masks while the original mirror remains live', () => {
    const bytes = estimateDuplicateWorkBytes(400_000, 200_000, 3);
    expect(bytes).toBe(estimateSceneBytes(600_000, 3) + 600_000 * 6 +
      DUPLICATE_JOB_BYTES + 2 * DUPLICATE_LINEAGE_BYTES + 4 * MiB);
    expect(bytes).toBeGreaterThan(estimateSceneBytes(400_000, 3));
  });
  it('admits a camera-clipped candidate without assuming every selected splat will be copied', () => {
    expect(estimateDuplicateWorkBytes(900_000, 900_000, 0)).toBe(estimateDuplicateWorkBytes(900_000, 100_000, 0));
  });
  it.each([[0, 0], [1_000_000, 1], [10, 0], [10, 11], [1.5, 1], [-1, 1], [10, NaN]])(
    'refuses invalid count/selection %s/%s before allocation', (count, selected) => {
      expect(() => estimateDuplicateWorkBytes(count, selected, 0)).toThrow();
    });
});
