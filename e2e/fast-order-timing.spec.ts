import { expect, test } from '@playwright/test';
import type {} from './fast-order-timing-harness';

for (const count of [4096,65536,262144,1_000_000]) for(const visibility of [.25,1] as const) test(`GPU timestamp comparison at ${count} sources with visibility ${visibility}`, async ({ page }, info) => {
  test.setTimeout(180000);
  await page.goto('/e2e/fast-order-timing-harness.html'); await page.waitForFunction(() => !!window.fastOrderTiming);
  const value = await page.evaluate(({count,visibility}) => window.fastOrderTiming.measure(count,visibility), {count,visibility});
  test.skip(!value.timestampAvailable, 'Optional WebGPU timestamp queries are unavailable.');
  await info.attach('gpu-depth-pass-timestamps.json', { body: JSON.stringify(value), contentType: 'application/json' });
  if (value.timestampAvailable) {
    expect(value.fastAvailable).toBe(count>=262144); expect(value.memory.bytes).toBe(0);expect(value.errors).toEqual([]);
    for (const mode of ['baseline32', 'compact32', 'compact24']) {
      const samples = value.samples[mode]['Stable depth sort'];
      expect(samples).toHaveLength(32); expect(samples.every(ms => Number.isFinite(ms) && ms >= 0)).toBe(true);
      expect(samples.some(ms=>ms>0)).toBe(true);
    }
  }
});
