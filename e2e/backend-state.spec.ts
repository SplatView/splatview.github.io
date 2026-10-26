import { expect, test } from '@playwright/test';
import type {} from './backend-state-harness';

test('real WebGPU and GL state traces agree through rest 7/8, sample 63/64, caching, motion, content and settings', async ({ page }, info) => {
  await page.goto('/e2e/backend-state-harness.html'); await page.waitForFunction(() => window.backendState?.ready());
  const gpu = await page.evaluate(() => window.backendState.trace('webgpu'));
  const gl = await page.evaluate(() => window.backendState.trace('webgl2'));
  await info.attach('paired-renderer-state.json', { body: JSON.stringify({ gpu, gl }), contentType: 'application/json' });
  expect(gl.rows).toEqual(gpu.rows); expect(gl.zeroExtraRequests).toBe(0); expect(gl.fixedExtraRequests).toBe(0);
  expect(gpu.zeroExtraRequests).toBe(0); expect(gpu.fixedExtraRequests).toBe(0);
  expect(gl.rows.find(row => row.kind === 'rest-64')).toMatchObject({ frame: 65, restFrames: 64, requests: 64, submissions: 65 });
  const cached = gl.rows.find(row => row.kind === 'cached')!, queries = gl.rows.find(row => row.kind === 'queries')!;
  expect({ ...queries, kind: cached.kind }).toEqual(cached);
  expect(gl.memory.bytes).toBe(0); expect(gpu.memory.bytes).toBe(0);
});
for (const backend of ['webgpu', 'webgl2'] as const) test(`${backend} native map creation submits the public display while raw preview cache and direct queries keep their clocks`, async ({ page }, info) => {
  await page.goto(`/e2e/backend-state-harness.html?graphics=${backend}`); await page.waitForFunction(() => window.backendState?.ready());
  const value = await page.evaluate(() => window.backendState.mapBoundary());
  await info.attach('native-map-clock-boundary.json', { body: JSON.stringify(value), contentType: 'application/json' });
  expect(value.created.calls - value.before.calls).toBeGreaterThanOrEqual(1);
  expect(value.created.frame - value.before.frame).toBe(value.created.calls - value.before.calls);
  expect(value.created.submissions - value.before.submissions).toBe(value.created.calls - value.before.calls);
  expect(value.reused).toEqual(value.created); expect(value.queries).toEqual(value.reused);
  expect(value.cachedId).toBe(value.firstId); expect(value.committedId).not.toBe(value.firstId); expect(value.stale).toBe(true);
});
