import { expect, test } from '@playwright/test';
import type {} from './surface-harness';

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/surface-harness.html');
  await page.waitForFunction(() => window.surfaceHarness || window.surfaceHarnessError);
  expect(await page.evaluate(() => window.surfaceHarnessError)).toBeUndefined();
});
test('boost revives a transparent nearer source in its existing rank, then fade and neutral restore the same base', async ({ page }, info) => {
  const result = await page.evaluate(() => window.surfaceHarness.opacitySeries());
  await info.attach('global-opacity-surface-phases', { body: JSON.stringify(result), contentType: 'application/json' });
  const [neutral, boost, faded, restored] = result.frames;
  expect(result.errors).toEqual([]); expect(result.sortCalls).toBe(0); expect(result.released.bytes).toBe(0);
  expect(neutral.depth).toBeCloseTo(2, 5); expect(neutral.opacity).toBeCloseTo(.6, 5);
  // alphaNear=.5, alphaFar=.8; contributions=.5 and .4, total=.9.
  expect(boost.depth).toBeCloseTo(13 / 9, 5); expect(boost.opacity).toBeCloseTo(.9, 5);
  expect(boost.pick.index).toBe(1); expect(boost.pick.contribution).toBeCloseTo(.5, 5);
  // Native visibility uses the composited depth plus the covariance margin.
  // Far depth 2 exceeds 13/9 + that margin; only revived near source 1 qualifies.
  expect(boost.visible[0] & 3).toBe(2); expect(boost.visible[0] & 4).toBe(0);
  boost.color.forEach(value => expect(value).toBeCloseTo(.5, 5));
  expect(faded.depth).toBe(0); expect(faded.opacity).toBe(0); expect(faded.pick.index).toBeNull();
  expect(faded.visible).toEqual([0]); expect(restored).toEqual(neutral);
});
test('selected opacity boosts the frozen selected source without changing the unselected far source', async ({ page }, info) => {
  const result = await page.evaluate(() => window.surfaceHarness.opacitySeries(true));
  await info.attach('selected-opacity-surface-phases', { body: JSON.stringify(result), contentType: 'application/json' });
  const [neutral, boost, faded, restored] = result.frames;
  // Selected near=.5, unselected far=.6: weights=.5/.3, total=.8, depth=11/8.
  expect(boost.opacity).toBeCloseTo(.8, 5); expect(boost.depth).toBeCloseTo(11 / 8, 5);
  expect(faded.opacity).toBeCloseTo(.6, 5); expect(faded.depth).toBeCloseTo(2, 5);
  expect(restored).toEqual(neutral); expect(result.sortCalls).toBe(0); expect(result.released.bytes).toBe(0);
});
test('boost participates in the independent downsampled projection and full-frame visibility', async ({ page }) => {
  const result = await page.evaluate(() => window.surfaceHarness.sample({ width: 1025, height: 769,
    opacityScale: 2, colors: true, visible: true, layers: [{ z: 0, opacity: 0 }] }));
  expect(result.width * result.height).toBeLessThanOrEqual(262144); expect(result.nonempty).toBeGreaterThan(0);
  const scale = Math.sqrt(262144 / (1025 * 769)), width = Math.floor(1025 * scale), height = Math.floor(769 * scale);
  expect(result.width).toBe(width); expect(result.height).toBe(height);
  const focal = 769 / 2 / Math.tan(Math.PI / 8), fx = focal * width / 1025, fy = focal * height / 769;
  const a = .01 * (fx / 3) ** 2 + .3 * scale ** 2, c = .01 * (fy / 3) ** 2 + .3 * scale ** 2;
  const x = Math.floor(width / 2) + .5 - width / 2, y = Math.floor(height / 2) + .5 - height / 2;
  expect(result.samples[0].depth).toBeCloseTo(3, 5);
  expect(result.samples[0].opacity).toBeCloseTo(.5 * Math.exp(-.5 * (x * x / a + y * y / c)), 5);
  expect(result.visible).toEqual([1]); expect(result.errors).toEqual([]); expect(result.released.bytes).toBe(0);
});
for (const kind of ['opacity', 'opacity-color', 'opacity-visibility'] as const) {
  test(`an opacity edit before the next frame refuses pending ${kind} readback and releases its admitted buffers`, async ({ page }) => {
    const result = await page.evaluate(kind => window.surfaceHarness.failure(kind, true), kind);
    expect(result.accepted).toBe(false); expect(result.stale).toBe(true);
    expect(result.after.bytes).toBe(0); expect(result.destroyed).toBe(result.allocations); expect(result.errors).toEqual([]);
  });
}
