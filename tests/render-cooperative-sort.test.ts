import { expect, it } from 'vitest';
import { cooperativeSort } from '../src/renderer/webgl2/cooperativeSort';

it('preserves exact candidate depth and descending source ties inside a dense tile', async () => {
  const count = 20001, depths = Float32Array.from({ length: count }, (_, i) => Math.fround((i * 7919) % 17 / 3));
  const compare = (a: number, b: number) => depths[a] - depths[b] || b - a;
  const actual = Uint32Array.from({ length: count }, (_, i) => i), expected = actual.slice().sort(compare);
  let yields = 0;
  await cooperativeSort(actual, new Uint32Array(count), compare, async () => { yields++; });
  expect(actual).toEqual(expected); expect(yields).toBeGreaterThan(20);
});
it('admits cancellation inside a single large tile rather than waiting for the tile to finish', async () => {
  const actual = Uint32Array.from({ length: 262556 }, (_, i) => i);
  let checkpoints = 0;
  await expect(cooperativeSort(actual, new Uint32Array(actual.length), (a, b) => b - a,
    async () => { if (++checkpoints === 2) throw new DOMException('cancel', 'AbortError'); })).rejects.toMatchObject({ name: 'AbortError' });
  expect(checkpoints).toBe(2);
});
