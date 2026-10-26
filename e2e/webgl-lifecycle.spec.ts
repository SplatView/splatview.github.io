import { expect, test } from '@playwright/test';
import type {} from './webgl-lifecycle-harness';

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/webgl-lifecycle-harness.html?graphics=webgl2'); await page.waitForFunction(() => window.webglLifetime?.ready());
});
test('resize and cancellation keep an actual pending SteadySplats allocation admitted until retirement', async ({ page }, info) => {
  const value = await page.evaluate(() => window.webglLifetime.pendingInitialization());
  await info.attach('gl-initialization-retirement.json', { body: JSON.stringify(value), contentType: 'application/json' });
  expect(value.admitted.steady.status).toBe('preparing'); expect(value.admitted.steady.allocationBytes).toBeGreaterThan(0);
  expect(value.whileHeld.retired).toBe(false); expect(value.whileHeld.steady.allocationBytes).toBe(value.admitted.steady.allocationBytes);
  expect(value.after.allocationBytes).toBe(0); expect(value.after.status).toBe('sorted'); expect(value.final.bytes).toBe(0); expect(value.final.allocations).toBe(0);
});
test('cancelled worker publication keeps credits until the genuine terminal delivery and candidate refusal retires its job', async ({ page }, info) => {
  const value = await page.evaluate(() => window.webglLifetime.workerCancellation());
  await info.attach('gl-worker-retention.json', { body: JSON.stringify(value), contentType: 'application/json' });
  expect(value.whileHeld).toMatchObject({ settled: false, published: false }); expect(value.whileHeld.memory.bytes).toBeGreaterThan(value.whileHeld.baseline);
  expect(value.result).toBe('AbortError'); expect(value.after.published).toBe(false); expect(value.after.memory.bytes).toBe(value.whileHeld.baseline);
  expect(value.resizeCalls).toBeGreaterThan(0); expect(value.refused).toBe(true); expect(value.final.bytes).toBe(0); expect(value.final.allocations).toBe(0);
});
for (const mode of ['freeze', 'close'] as const) test(`actual GL image readback ${mode === 'freeze' ? 'freezes the pre-yield camera and background' : 'retains image ownership through Close'}`, async ({ page }, info) => {
  const value = await page.evaluate(mode => window.webglLifetime.captureLifetime(mode), mode);
  await info.attach(`gl-readback-${mode}.json`, { body: JSON.stringify(value), contentType: 'application/json' });
  expect(value.whileHeld).toMatchObject({ settled: false, closed: false }); expect(value.whileHeld.image.bytes).toBeGreaterThan(value.initialImage.bytes);
  expect(value.finalImage).toEqual(value.initialImage); expect(value.error).toBeNull();
  if (mode === 'freeze') { expect(value.result.image).toEqual(value.baseline); expect(value.result.error).toBeNull(); expect(value.hasScene).toBe(true); }
  else { expect(value.result.error).toBe('AbortError'); expect(value.result.image).toBeNull(); expect(value.closed).toBe(true); expect(value.hasScene).toBe(false); expect(value.hasClient).toBe(false); }
});
test('real context loss restores an accepted Basic preview, clean image, camera and executable native Undo', async ({ page }, info) => {
  const value = await page.evaluate(() => window.webglLifetime.acceptedPreviewRecovery());
  await info.attach('gl-accepted-preview-recovery.json', { body: JSON.stringify(value), contentType: 'application/json' });
  expect(value.after.image).toEqual(value.before.image); expect(value.after.camera).toEqual(value.before.camera);
  expect(value.after.summary.contentRevision).toBe(value.before.summary.contentRevision);
  expect(value.after.summary.canUndo).toBe(true); expect(value.undone.canRedo).toBe(true);
  expect(value.backend).toBe('webgl2'); expect(value.newEpoch).not.toBe(value.oldEpoch); expect(value.error).toBeNull();
});
test('a failed GL restoration retains the native document and Redo until a successful sticky-backend retry', async ({ page }, info) => {
  const value = await page.evaluate(() => window.webglLifetime.failedRecovery());
  await info.attach('gl-failed-restoration.json', { body: JSON.stringify(value), contentType: 'application/json' });
  expect(value.refused).toBe(true); expect(value.unavailable.rendererState).toBe('unavailable'); expect(value.unavailable.sameClient).toBe(true);
  for (const key of ['count', 'visible', 'selected', 'contentRevision', 'canUndo', 'canRedo'] as const) expect(value.unavailable.summary[key]).toBe(value.before[key]);
  expect(value.unavailable.error).toBeTruthy(); expect(value.restored).toBe(true); expect(value.backend).toBe('webgl2');
  expect(value.redone).toBe(true); expect(value.afterRedo.visible).toBe(value.before.visible - 1);
  expect(value.undone).toBe(true); expect(value.afterUndo.visible).toBe(value.before.visible); expect(value.error).toBeNull();
});
