import { describe, expect, it } from 'vitest';
import { validateNativeAllocationCensus } from '../src/document/allocationCensus';
import { emptyCensus } from './fixtures/allocation-census';

const heap = { sequence: 9, heapBytes: 65_536 };
function occupied() {
  return { ...emptyCensus(4), scenePayloadBytes: 1000, ownedRawBytes: 1400, overlapBytes: 1000,
    contextBytes: 64, unionBytes: 1400, liveBlocks: 3, liveContexts: 2 };
}
describe('native allocation census authentication', () => {
  it('copies immutable physical counters and keeps its sequence independent of the heap envelope', () => {
    const input = occupied(), value = validateNativeAllocationCensus(input, heap, emptyCensus(2));
    input.unionBytes = 0; input.sequence = 10;
    expect(value.unionBytes).toBe(1400); expect(value.sequence).toBe(4); expect(Object.isFrozen(value)).toBe(true);
    expect(validateNativeAllocationCensus(emptyCensus(7), heap, value).unionBytes).toBe(0);
  });
  it('reads caller counters once and rejects hidden extra authority', () => {
    const input = occupied(); let reads = 0;
    Object.defineProperty(input, 'ownedRawBytes', { enumerable: true, get() { reads++; return reads === 1 ? 1400 : 1; } });
    expect(validateNativeAllocationCensus(input, heap).ownedRawBytes).toBe(1400); expect(reads).toBe(1);
    expect(() => validateNativeAllocationCensus(Object.defineProperty(occupied(), 'extra', { value: 1 }), heap)).toThrow();
    expect(() => validateNativeAllocationCensus({ ...occupied(), [Symbol('extra')]: 1 }, heap)).toThrow();
  });
  it.each([null, [], {}, { ...occupied(), ok: false }, { ...occupied(), version: 2 },
    { ...occupied(), scope: 'whole-heap' }, { ...occupied(), sequence: 0 },
    { ...occupied(), sequence: Number.MAX_SAFE_INTEGER + 1 }, { ...occupied(), extra: 0 },
    { ...occupied(), overlapBytes: 1001 }, { ...occupied(), ownedRawBytes: 999 },
    { ...occupied(), contextBytes: 1401 }, { ...occupied(), unionBytes: 1399 },
    { ...occupied(), ownedRawBytes: 70_000, unionBytes: 70_000 },
    { ...occupied(), scenePayloadBytes: Number.MAX_SAFE_INTEGER, overlapBytes: 0, unionBytes: Number.MAX_SAFE_INTEGER },
  ])('rejects malformed or impossible census %j', value => {
    expect(() => validateNativeAllocationCensus(value, heap)).toThrow();
  });
  for (const key of ['scenePayloadBytes', 'ownedRawBytes', 'overlapBytes', 'contextBytes', 'unionBytes', 'liveBlocks', 'liveContexts'])
    it(`rejects unsafe ${key} counters`, () => {
      for (const bad of [-1, .5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0', null])
        expect(() => validateNativeAllocationCensus({ ...emptyCensus(1), [key]: bad }, heap)).toThrow();
    });
  it('rejects replay, regression and exhausted sequence without wrapping', () => {
    for (const sequence of [3, 4]) expect(() => validateNativeAllocationCensus(emptyCensus(sequence), heap, occupied())).toThrow();
    const last = validateNativeAllocationCensus(emptyCensus(Number.MAX_SAFE_INTEGER), heap);
    expect(() => validateNativeAllocationCensus(emptyCensus(Number.MAX_SAFE_INTEGER + 1), heap, last)).toThrow();
    expect(() => validateNativeAllocationCensus(emptyCensus(1), heap, last)).toThrow();
  });
});
