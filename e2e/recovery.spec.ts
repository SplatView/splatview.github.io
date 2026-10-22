import { expect, test } from '@playwright/test';
import type {} from './gpu-harness';

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/gpu-harness.html'); await page.waitForFunction(() => Boolean(window.gpuHarness || window.gpuHarnessError));
  expect(await page.evaluate(() => window.gpuHarnessError)).toBeUndefined();
});

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.title.includes('during draft') || testInfo.status !== testInfo.expectedStatus) {
    const diagnostic = await page.evaluate(() => window.gpuRecoveryDiagnostic).catch(error => ({ unavailable: String(error) }));
    await testInfo.attach('original-recovery-readiness', { body: Buffer.from(JSON.stringify(diagnostic ?? null, null, 2)), contentType: 'application/json' });
  }
});

for (const kind of ['ready', 'draft', 'edit', 'refused', 'cancel'] as const) test(`device loss during ${kind} preserves the document and recovers on a new epoch`, async ({ page }) => {
  const failures: string[] = []; page.on('pageerror', error => failures.push(error.message));
  const result = await page.evaluate(kind => window.gpuHarness.deviceRecovery(kind), kind);
  expect(result.recovered).toBe(true); expect(result.sameDocument).toBe(true); expect(result.sameView).toBe(true);
  expect(result.sameOutput).toBe(true); expect(result.image.maxError).toBe(0); expect(result.image.nonblackPixels).toBeGreaterThan(100);
  expect(result.epochs[1]).toBeGreaterThan(result.epochs[0]); expect(result.state).toBe('ready'); expect(result.busy).toBe(false);
  expect(result.active).toBe(false); expect(result.after.selectionDraft).toBe(false); expect(result.after.transaction).toBe(false);
  for (const field of ['contentRevision', 'selected', 'visible', 'canUndo', 'canRedo'] as const) expect(result.after[field]).toBe(result.before[field]);
  expect(result.usage.after.bytes).toBe(result.usage.before.bytes); expect(result.usage.after.allocations).toBe(result.usage.before.allocations);
  expect(result.dirty).toBe(true); expect(result.redone).toBe(true); expect(result.redoneVisible).toBe(2); expect(failures).toEqual([]);
  if (kind === 'edit') expect(result.accepted).toBe(false);
  if (kind === 'refused' || kind === 'cancel') {
    expect(result.first).toBe(false); expect(result.failed.state).toBe('unavailable'); expect(result.failed.exported).toBe(true);
    expect(result.failed.usage.bytes).toBe(result.usage.before.bytes); expect(result.failed.usage.allocations).toBe(result.usage.before.allocations);
    expect(result.failed.error).toMatch(kind === 'cancel' ? /cancelled/i : /Injected recreation/);
  } else expect(result.first).toBe(true);
});

test('queued/in-flight view queries and allocations from an older device are rejected', async ({ page }) => {
  const result = await page.evaluate(() => window.gpuHarness.staleQueries());
  expect(result.queuedRejected).toBe(true); expect(result.readingRejected).toBe(true); expect(result.wrongDevice).toBe(true);
  expect(result.resizedRejected).toBe(true); expect(result.maskedRejected).toBe(true); expect(result.sceneRejected).toBe(true);
  expect(result.previewRejected).toBe(true); expect(result.unchangedIndex).toBe(0);
  expect(result.epochs[1]).toBeGreaterThan(result.epochs[0]); expect(result.nonblackPixels).toBeGreaterThan(100);
});
