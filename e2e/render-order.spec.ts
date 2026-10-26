import { expect, test } from '@playwright/test';
import type {} from './render-order-harness';

for (const backend of ['webgpu', 'webgl2'] as const) test(`${backend} reuses exact installed order across every sorted consumer and restores it after captured-view overwrite`, async ({ page }, info) => {
  await page.goto('/e2e/render-order-harness.html'); await page.waitForFunction(() => !!window.renderOrder);
  const value = await page.evaluate(backend => window.renderOrder.reuse(backend), backend);
  await info.attach('installed-order.json', { body: JSON.stringify(value), contentType: 'application/json' });
  expect(value.errors).toEqual([]); expect(value.memory.bytes).toBe(0);
  for (const row of value.rows.slice(0, 5)) expect(row.order).toEqual([1, 4, 0, 2, 3]);
  for (const row of value.rows.slice(1, 5)) { expect(row.sorts).toBe(0); expect(row.uploads).toBe(0); }
  expect(value.rows[1].projections).toBe(0);
  expect(value.rows[5].order).toEqual([3, 0, 2, 1, 4]); expect(value.rows[5].sorts).toBe(1);
  expect(value.rows[6].order).toEqual([1, 4, 0, 2, 3]); expect(value.rows[6].sorts).toBe(1);
  expect(value.rows[7].order).toEqual([2, 1, 4, 0, 3]);
});
for (const degree of [0, 1, 2, 3]) test(`SH${degree} compact GPU picks exactly equal the baseline, including radius occlusion and source ties`, async ({ page }, info) => {
  await page.goto('/e2e/render-order-harness.html'); await page.waitForFunction(() => !!window.renderOrder);
  const value = await page.evaluate(degree => window.renderOrder.picks(degree), degree);
  await info.attach('compact-pick-parity.json', { body: JSON.stringify(value), contentType: 'application/json' });
  expect(value.errors).toEqual([]); expect(value.memory.bytes).toBe(0);
  for (const row of value.rows) { expect(row.compact).toBe(1); expect(row.fast).toEqual(row.baseline); }
});
test('GL display completes independently while obsolete map cancellation still joins a held worker terminal acknowledgement', async ({ page }, info) => {
  await page.goto('/e2e/render-order-harness.html'); await page.waitForFunction(() => !!window.renderOrder);
  const value = await page.evaluate(() => window.renderOrder.glQueryInterleave());
  await info.attach('query-display-ownership.json', { body: JSON.stringify(value), contentType: 'application/json' });
  expect(value.heldBytes).toBeGreaterThan(value.before); expect(value.afterBytes).toBe(value.before);
  expect(value.displayedWhileTerminalHeld).toBe(2); expect(value.finishedBeforeTerminal).toBe(false);
  expect(value.queryStatus).toBe('rejected'); expect(value.memory.bytes).toBe(0);
});
test('GPU scene disposal retains compact-pick scratch until pending allocation validation settles', async ({ page }, info) => {
  await page.goto('/e2e/render-order-harness.html'); await page.waitForFunction(() => !!window.renderOrder);
  const value = await page.evaluate(() => window.renderOrder.gpuPickRetirement());
  await info.attach('compact-pick-retirement.json', { body: JSON.stringify(value), contentType: 'application/json' });
  expect(value.errors).toEqual([]); expect(value.heldBytes).toBeGreaterThan(0); expect(value.disposedBeforeValidation).toBe(false);
  expect(value.queryStatus).toBe('rejected'); expect(value.memory.bytes).toBe(0);
});
for (const backend of ['webgpu', 'webgl2'] as const) test(`${backend} rejects speculative cache publication after a failed submit/order upload`, async ({ page }) => {
  await page.goto('/e2e/render-order-harness.html'); await page.waitForFunction(() => !!window.renderOrder);
  const value = await page.evaluate(backend => window.renderOrder.failedPublication(backend), backend);
  expect(value.failed).toBe(true); expect(value.errors).toEqual([]); expect(value.memory.bytes).toBe(0);
  expect(value.order).toEqual(backend === 'webgpu' ? [3, 0, 2, 1, 4] : [1, 4, 0, 2, 3]);
});
test('GL sorted display/capture keeps working with optional float, timer and parallel-compile extensions absent', async ({ page }) => {
  await page.addInitScript(() => {
    const original = WebGL2RenderingContext.prototype.getExtension as (name:string)=>unknown;
    const override = function (this:WebGL2RenderingContext,name: string) {
      if (['EXT_color_buffer_float', 'EXT_disjoint_timer_query_webgl2', 'KHR_parallel_shader_compile'].includes(name)) return null;
      return original.call(this, name);
    };
    WebGL2RenderingContext.prototype.getExtension=override as typeof WebGL2RenderingContext.prototype.getExtension;
  });
  await page.goto('/e2e/render-order-harness.html'); await page.waitForFunction(() => !!window.renderOrder);
  const value = await page.evaluate(() => window.renderOrder.reuse('webgl2'));
  expect(value.errors).toEqual([]); expect(value.rows[6].order).toEqual([1, 4, 0, 2, 3]); expect(value.memory.bytes).toBe(0);
});
