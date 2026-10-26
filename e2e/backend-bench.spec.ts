import { expect, test } from '@playwright/test';
import type {} from './backend-bench-harness';

for (const backend of ['webgpu', 'webgl2'] as const) for (const [multiplier, dpr] of [[1, 1], [2, 2], [4, 2]] as const) {
  test.describe(`${backend} Bench x${multiplier} DPR ${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr });
    test('measures both modes on the same native camera path', async ({ page }, info) => {
    test.setTimeout(180000);
    await page.goto(`/e2e/backend-bench-harness.html?graphics=${backend}`);
    await page.waitForFunction(() => window.backendBench?.ready());
    await page.getByRole('button', { name: 'Open example', exact: true }).click();
    await expect(page).toHaveTitle('Bench example.sog — SplatView');
    const value = await page.evaluate(({ multiplier, dpr }) => window.backendBench.measure(multiplier, dpr), { multiplier, dpr });
    await info.attach('backend-measurements.json', { body: JSON.stringify(value), contentType: 'application/json' });
    expect(value.count).toBe(262556 * multiplier); expect(value.errors).toEqual([]);
    expect(value.memory.bytes).toBe(0); expect(value.memory.allocations).toBe(0);
    for (const mode of value.modes) {
      expect(mode.frameCompletionMs.samples).toHaveLength(8);
      expect(mode.frameCompletionMs.samples.every(sample => Number.isFinite(sample) && sample > 0)).toBe(true);
      expect(mode.afterQueries).toEqual(mode.beforeQueries); expect(mode.afterQueryDisplaySequence).toBe(mode.displaySequence);
      if (mode.quality) { expect(mode.quality.frames).toBe(65); expect(mode.quality.restFrames).toBe(64); expect(mode.quality.refinedMse).toBeLessThan(mode.quality.firstMse); }
    }
    });
  });
}
