import { expect, it } from 'vitest';
import { planFastOrder } from '../src/renderer/webgpu/fastOrderLayout';
import { captureCompactOrderKey, compactOrderMatches } from '../src/renderer/compactOrderKey';
import { validateSortPrecision } from '../src/renderer/sortPrecision';
import { stableDepthOrder } from '../src/renderer/webgl2/radix';

it('accounts private compact pairs, visibility scans and retained metadata', () => {
  const plan = planFastOrder(65537);
  expect(plan.groups).toBe(257); expect(plan.blocks).toBe(2);
  expect(plan.sizes.compactA).toBe(65537 * 8);
  expect(plan.sizes.visibleCounts).toBe(257 * 4);
  expect(plan.bufferBytes).toBe(Object.values(plan.sizes).reduce((sum, bytes) => sum + bytes, 0));
  expect(plan.bytes - plan.bufferBytes).toBe(16384);
  for (const count of [0, -1, NaN, Infinity, 3_000_001]) expect(() => planFastOrder(count)).toThrow();
});
it('shares compact order across grade/tint changes but invalidates visibility, source and precision changes', () => {
  const words = new Uint32Array(80), key = captureCompactOrderKey(words, 3, 32);
  for (const field of [32, 33, 34, 35, 42, 43, 44, 58, 78]) {
    const changed = words.slice(); changed[field] = 1;
    expect(compactOrderMatches(key, changed, 3, 16), `color field ${field}`).toBe(true);
  }
  for (const field of [0, 10, 12, 16, 31, 36, 37, 59, 60, 75, 76, 77, 79]) {
    const changed = words.slice(); changed[field] = 1;
    expect(compactOrderMatches(key, changed, 3, 32), `visibility field ${field}`).toBe(false);
  }
  expect(compactOrderMatches(key, words, 4, 32)).toBe(false);
  expect(compactOrderMatches(captureCompactOrderKey(words, 3, 16), words, 3, 32)).toBe(false);
  words[0] = 2; expect(key.bits[0]).toBe(0);
});
it('worker reduced precision keeps deterministic source ties and exact mode restores full depth order', async () => {
  const frame = new Float32Array(80); frame[10] = 1;
  const source = new Float32Array(4 * 12); [-2.00001, -2.00004, -2.00002, -2.00003].forEach((depth, i) => { source[i * 12 + 2] = depth; });
  const mask = new Uint8Array(4), stages: string[] = [];
  const fast = await stableDepthOrder(source, 4, 12, frame, mask, async () => {}, undefined, undefined, stage => stages.push(stage), 16);
  const exact = await stableDepthOrder(source, 4, 12, frame, mask, async () => {});
  expect([...fast]).toEqual([0, 1, 2, 3]); expect([...exact]).toEqual([1, 3, 2, 0]);
  expect(stages).toEqual(['depth-key-generation']); // All requested key bits tie: no sort pass is needed.
  expect(validateSortPrecision(16)).toBe(16); expect(validateSortPrecision(24)).toBe(24); expect(validateSortPrecision(32)).toBe(32);
  for (const value of [0, 8, 20, '16', null, NaN]) expect(() => validateSortPrecision(value)).toThrow();
});
