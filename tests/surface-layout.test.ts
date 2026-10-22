import { describe, expect, it } from 'vitest';
import { planSurfaceTiles } from '../src/renderer/webgpu/surfaceLayout';

describe('compact surface tile planning', () => {
  it('assigns no entries to empty tiles and one entry to singletons', () => {
    const plan = planSurfaceTiles([0, 1, 0, 3, 2, 0], 1024);
    expect([...plan.spans]).toEqual([0, 0, 0, 1, 1, 0, 1, 4, 5, 2, 7, 0]);
    expect(plan).toMatchObject({ candidateEntries: 7, candidateBytes: 28, tileCapacity: 4,
      tileCount: 6, occupiedTiles: 3, sortComparisons: 7 });
  });
  it('keeps one dense tile local and accepts counts above the former 8192 ceiling', () => {
    const plan = planSurfaceTiles([0, 8193, 1, 0], 65_540);
    expect(plan.candidateEntries).toBe(16_385);
    expect(plan.candidateBytes).toBe(65_540);
    expect(plan.tileCapacity).toBe(16_384);
    expect(plan.occupiedTiles).toBe(2);
    expect([...plan.spans]).toEqual([0, 0, 0, 16_384, 16_384, 1, 16_385, 0]);
  });
  it('reserves only the mandatory binding for an entirely empty map', () => {
    expect(planSurfaceTiles([0, 0, 0], 4)).toMatchObject({ candidateEntries: 0, candidateBytes: 4,
      tileCapacity: 0, occupiedTiles: 0, sortComparisons: 0 });
    expect(() => planSurfaceTiles([], 3)).toThrow(/buffer limit/);
  });
  it('refuses complete padded spans beyond the device budget', () => {
    expect(() => planSurfaceTiles([5, 1], 35)).toThrow(/buffer limit/);
    expect(planSurfaceTiles([5, 1], 36).candidateEntries).toBe(9);
  });
  it('refuses unsafe u32 prefixes before typed-array wrapping', () => {
    expect(() => planSurfaceTiles([0xffffffff], Number.MAX_SAFE_INTEGER)).toThrow(/address limit/);
    expect(() => planSurfaceTiles([0x80000000, 0x80000000], Number.MAX_SAFE_INTEGER)).toThrow(/address limit/);
    expect(planSurfaceTiles([0x80000000], Number.MAX_SAFE_INTEGER).spans[1]).toBe(0x80000000);
  });
  it.each([-1, 0.5, NaN, Infinity, 0x100000000])('refuses malformed candidate count %s', count => {
    expect(() => planSurfaceTiles([count], 1024)).toThrow(/candidate count/);
  });
  it('retains an explicit caller ceiling independently of the device budget', () => {
    expect(() => planSurfaceTiles([8193], 1_000_000, 8192)).toThrow(/explicit candidate ceiling/);
    expect(planSurfaceTiles([8192], 32768, 8192).candidateEntries).toBe(8192);
  });
});
