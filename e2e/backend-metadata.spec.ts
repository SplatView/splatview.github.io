import { expect, test } from '@playwright/test';
import type {} from './backend-metadata-harness';

test('actual stochastic targets agree at sample 0/63/64, equal-depth ties and full-precision projected opacity/axes', async ({ page }, info) => {
  await page.goto('/e2e/backend-metadata-harness.html'); await page.waitForFunction(() => !!window.compareSteadyMetadata);
  const value = await page.evaluate(() => window.compareSteadyMetadata());
  await info.attach('steady-mixed-target-metadata.json', { body: JSON.stringify(value), contentType: 'application/json' });
  expect(value.steps.map(row => row.phase)).toEqual([0, 63, 64]);
  for (const row of value.steps) {
    expect(row.idMismatches).toBe(0); expect(row.hits[1]).toBeGreaterThan(0); expect(row.hits[2]).toBeGreaterThan(0);
    expect(row.depthMax).toBe(0); expect(row.centerMax).toBe(0); expect(row.axesMax).toBeLessThan(1e-4); expect(row.analyticAxesMax).toBeLessThan(1e-4);
    expect(row.opacityMax).toBeLessThan(1e-7); expect(row.analyticOpacityMax).toBeLessThan(1e-7);
  }
  expect(value.memory.bytes).toBe(0); expect(value.memory.allocations).toBe(0);
});
