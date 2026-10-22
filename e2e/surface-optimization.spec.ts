import { expect, test } from '@playwright/test';
import type {} from './surface-harness';

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/surface-harness.html');
  await page.waitForFunction(() => Boolean(window.surfaceHarness || window.surfaceHarnessError));
  expect(await page.evaluate(() => window.surfaceHarnessError)).toBeUndefined();
});

const covariance: [number, number, number, number, number, number] = [.00002, 0, 0, .00002, 0, .00002];
const coefficients = [.5, -.25, .25];
const rawColor = coefficients.map(coefficient => .5 + .2820947918 * coefficient);

function allSourceBits(count: number, deleted: Set<number> = new Set()) {
  const words = new Array<number>(Math.ceil(count / 32)).fill(0);
  for (let i = 0; i < count; i++) if (!deleted.has(i)) words[i >>> 5] = (words[i >>> 5] | (1 << (i & 31))) >>> 0;
  return words;
}

test('more than 8192 overlapping splats retain depth, raw color and sparse visibility IDs without a fixed overlap cap', async ({ page }, info) => {
  const count = 8195, deleted = new Set([32, 8193]);
  const result = await page.evaluate(({ count, deleted, covariance, coefficients }) => window.surfaceHarness.sample({
    width: 511, height: 511, colors: true, visible: true, initial: 1,
    masks: Array.from({ length: count }, (_, i) => deleted.includes(i) ? 2 : 0),
    layers: Array.from({ length: count }, () => ({ z: 0, opacity: .004, covariance, coefficients })),
    samples: [[255, 255], [0, 0]],
  }), { count, deleted: [...deleted], covariance, coefficients });
  await info.attach('dense-overlap-surface', { body: JSON.stringify(result), contentType: 'application/json' });
  expect(result.errors).toEqual([]); expect(result.allFinite).toBe(true);
  expect(result.attempts).toBe(1); expect(result.capacity).toBe(16384);
  expect(result.candidateAllocations).toEqual([result.candidateBytes]);
  // The alpha cutoff confines these faint splats around (255.5, 255.5)
  // within tile (15, 15); the old full quad also touched three empty tiles.
  expect(result.candidateEntries).toBe(16384); expect(result.candidateBytes).toBe(16384 * 4);
  expect(result.occupiedTiles).toBe(1);
  expect(result.samples[0].depth).toBeCloseTo(3, 3);
  expect(result.samples[0].opacity).toBeCloseTo(1 - (1 - .004) ** (count - deleted.size), 4);
  rawColor.forEach((value, channel) => expect(result.samples[0].color![channel]).toBeCloseTo(value, 4));
  expect(result.samples[1]).toMatchObject({ depth: 0, opacity: 0, color: [0, 0, 0] });
  expect(result.visible).toEqual(allSourceBits(count, deleted));
  expect(result.released).toMatchObject({ bytes: 0, allocations: 0 });
});

test('sparse tiles beside a dense tile use compact spans and avoid global padded sorting work', async ({ page }, info) => {
  const dense = 2049, focal = 256 / Math.tan(Math.PI / 8);
  const layers = Array.from({ length: dense }, (_, i) => ({ z: (dense - 1 - i) * .00001, opacity: .01, covariance, coefficients, x: 0, y: 0 }));
  for (let y = 0; y < 15; y++) for (let x = 0; x < 15; x++) {
    if (x === 7 && y === 7) continue;
    layers.push({ x: (16 + x * 32 - 256) * 3 / focal, y: (16 + y * 32 - 256) * 3 / focal,
      z: 0, opacity: .5, covariance, coefficients });
  }
  const result = await page.evaluate(layers => window.surfaceHarness.sample({ width: 512, height: 512,
    layers, colors: true, visible: true, samples: [[256, 256], [0, 0]] }), layers);
  const paddedCandidateBytes = result.tileCount * result.capacity * 4;
  const stages = Math.log2(result.capacity) * (Math.log2(result.capacity) + 1) / 2;
  const paddedSortComparisons = result.tileCount * result.capacity / 2 * stages;
  const pixels = 512 * 512, visibilityBytes = Math.ceil(layers.length / 32) * 4;
  // Previous global-padding reservation for this exact full-resolution RGB /
  // visibility fixture, including retained CPU arrays and every old channel.
  const paddedPeakBytes = pixels * 20 + visibilityBytes + paddedCandidateBytes + result.tileCount * 4 +
    pixels * 16 + layers.length * 16 + 48 + pixels * 32 + visibilityBytes * 2 + 80;
  await info.attach('compact-surface-allocation-and-work', {
    body: JSON.stringify({ ...result, paddedCandidateBytes, paddedSortComparisons, paddedPeakBytes }), contentType: 'application/json',
  });
  expect(result.errors).toEqual([]); expect(result.allFinite).toBe(true);
  expect(result.attempts).toBe(1); expect(result.tileCount).toBe(1024); expect(result.capacity).toBe(4096);
  expect(result.candidateAllocations).toEqual([result.candidateBytes]);
  // Three adjacent grid footprints each share one of the four dense tiles;
  // those entries fit its existing 4096-slot span instead of adding a slot.
  expect(result.candidateEntries).toBe(4 * 4096 + 224 * 4 - 3);
  expect(result.candidateBytes).toBe(result.candidateEntries * 4);
  expect(result.sortComparisons).toBe(4 * 4096 / 2 * stages);
  expect(result.candidateBytes).toBeLessThan(paddedCandidateBytes / 200);
  expect(result.sortComparisons).toBeLessThan(paddedSortComparisons / 200);
  expect(result.retained.peakBytes).toBeLessThan(paddedPeakBytes * .6);
  // Independent analytic composition at the half-pixel center. Every dense
  // source contributes: no transmission threshold or nearest-ID substitute.
  let transmission = 1, depth = 0, opacity = 0;
  for (let i = 0; i < dense; i++) {
    const z = 3 + Math.fround(i * .00001);
    const variance = Math.fround(covariance[0]) * (focal / z) ** 2 + .3;
    const alpha = Math.fround(.01) * Math.exp(-.25 / variance), weight = transmission * alpha;
    depth += z * weight; opacity += weight; transmission *= 1 - alpha;
  }
  expect(Math.abs(result.samples[0].depth - depth / opacity)).toBeLessThan(.0001);
  expect(Math.abs(result.samples[0].opacity - opacity)).toBeLessThan(.00002);
  rawColor.forEach((value, channel) => expect(Math.abs(result.samples[0].color![channel] - value)).toBeLessThan(.00002));
  expect(result.samples[1]).toMatchObject({ depth: 0, opacity: 0, color: [0, 0, 0] });
  // Independent visibility bound: depth span .02048 is below the minimum
  // covariance-plus-depth margin 3*sqrt(.00002)+3*.005 > .0284.
  // Every source has surviving center fragments and must retain its own bit.
  expect(result.visible).toEqual(allSourceBits(layers.length));
  expect(result.released).toMatchObject({ bytes: 0, allocations: 0 });
});

test('empty tiles allocate only a valid dummy candidate binding and skip every sort comparator', async ({ page }) => {
  const result = await page.evaluate(() => window.surfaceHarness.sample({ width: 512, height: 512,
    layers: [{ z: 0, opacity: .8 }], masks: [2], colors: true, visible: true }));
  expect(result.errors).toEqual([]); expect(result.allFinite).toBe(true); expect(result.nonempty).toBe(0);
  expect(result.capacity).toBe(0); expect(result.occupiedTiles).toBe(0);
  expect(result.candidateEntries).toBe(0); expect(result.candidateBytes).toBe(4); expect(result.candidateAllocations).toEqual([4]);
  expect(result.sortComparisons).toBe(0); expect(result.visible).toEqual([0]);
  expect(result.samples[0]).toMatchObject({ depth: 0, opacity: 0, color: [0, 0, 0] });
  expect(result.released).toMatchObject({ bytes: 0, allocations: 0 });
});

test('a legacy initial capacity hint cannot reintroduce minimum padding or redundant candidate attempts', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const fixture = { width: 512, height: 512, layers: [{ z: 0, opacity: .8 }] };
    return { ordinary: await window.surfaceHarness.sample(fixture), hinted: await window.surfaceHarness.sample({ ...fixture, initial: 65536 }) };
  });
  expect(result.ordinary.errors).toEqual([]); expect(result.hinted.errors).toEqual([]);
  expect(result.hinted.samples).toEqual(result.ordinary.samples);
  expect(result.hinted.capacity).toBe(1); expect(result.hinted.attempts).toBe(1);
  expect(result.hinted.candidateBytes).toBe(result.ordinary.candidateBytes);
  expect(result.hinted.candidateEntries).toBe(result.hinted.occupiedTiles);
  expect(result.hinted.candidateAllocations).toEqual([result.hinted.candidateBytes]);
  expect(result.hinted.sortComparisons).toBe(0);
  expect(result.hinted.retained.peakBytes).toBe(result.ordinary.retained.peakBytes);
  expect(result.hinted.released).toMatchObject({ bytes: 0, allocations: 0 });
});
