import { expect, test } from '@playwright/test';
import type {} from './gpu-harness';

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/gpu-harness.html');
  await page.waitForFunction(() => Boolean(window.gpuHarness || window.gpuHarnessError));
  expect(await page.evaluate(() => window.gpuHarnessError)).toBeUndefined();
});

test('GPU allocation validation is caught without an uncaptured device error', async ({ page }) => {
  const result = await page.evaluate(() => window.gpuHarness.allocationFailure());
  expect(result.failure).toMatch(/usage|buffer/i); expect(result.errors).toEqual([]);
});

test('cancelling an in-flight live Single pick cannot mutate the restored baseline', async ({ page }) => {
  const result = await page.evaluate(() => window.gpuHarness.singleQueryCancellation());
  expect(result.cannotRestart).toBe(true); expect(result.active).toBe(false); expect(result.error).toBeNull();
  expect(result.after.selectionDraft).toBe(false); expect(result.after.transaction).toBe(false);
  expect(result.mask).toEqual([0, 1, 0]); expect(result.before.canRedo).toBe(true); expect(result.after.canRedo).toBe(true);
  expect(result.after.contentRevision).toBe(result.before.contentRevision); expect(result.unchangedOutput).toBe(true);
  expect(result.usageAfter).toBe(result.usageBefore);
});

test.describe('initial viewport readiness', () => {
  test.use({ deviceScaleFactor: 3 });
  test('ready publishes the displayed canvas and capped DPR before the first observer delivery', async ({ page }) => {
    const result = await page.evaluate(() => window.gpuHarness.colorViewportReadiness());
    expect(result.dpr).toBe(2); expect(result.atReady.observed).toBe(0);
    expect(result.atReady.width).toBe(640); expect(result.atReady.height).toBe(400);
    expect(result.atReady.aspect).toBe(Math.fround(320 / 200)); expect(result.error).toBeNull();
  });
});

test('a held first viewport callback preserves the completed adjustable Color owner while a real resize expires it', async ({ page }) => {
  const result = await page.evaluate(() => window.gpuHarness.colorViewportReadiness());
  expect(result.atReady.observed).toBe(0); expect(result.atReady.width).toBe(320); expect(result.atReady.height).toBe(200);
  expect(result.before.summary.toleranceSessionId).not.toBeNull();
  expect(result.afterDelivery).toEqual(result.beforeDelivery);
  expect(result.after.summary).toEqual(result.before.summary); expect(result.after.output).toEqual(result.before.output);
  expect(result.after.masks).toEqual(result.before.masks); expect(result.after.viewport).toEqual(result.before.viewport);
  expect(result.expanded).toBe(3); expect(result.shrunk).toBe(1); expect(result.picks).toBe(1);
  expect(result.afterResize.viewport.width).toBe(321); expect(result.afterResize.viewport.height).toBe(200);
  expect(result.afterResize.viewport.cameraRevision).toBeGreaterThan(result.afterDelivery.cameraRevision);
  expect(result.afterResize.viewport.resizeCallbacks).toBe(result.afterDelivery.resizeCallbacks + 1);
  expect(result.afterResize.summary.toleranceSessionId).toBeNull(); expect(result.afterResize.summary.selected).toBe(1);
  expect(result.undone?.selected).toBe(0); expect(result.undone?.canUndo).toBe(false); expect(result.redone?.selected).toBe(1);
  expect(result.observed).toBeGreaterThanOrEqual(2); expect(result.error).toBeNull();
});

for (const kind of ['pick', 'amendment'] as const) test(`refused Color ${kind} preserves its preceding adjustable pick and one Undo`, async ({ page }) => {
  const result = await page.evaluate(kind => window.gpuHarness.colorPublicationFailure(kind), kind);
  if (kind === 'pick') expect(result.accepted).toBe(false);
  expect(result.error).toMatch(/Injected Color/); expect(result.busy).toBe(false);
  expect(result.after.toleranceSessionId).toBe(result.before.toleranceSessionId);
  for (const key of ['revision', 'contentRevision', 'selected', 'visible', 'canUndo', 'canRedo', 'memoryBytes'] as const)
    expect(result.after[key], key).toBe(result.before[key]);
  expect(result.after.transaction).toBe(false); expect(result.after.selectionDraft).toBe(false);
  expect(result.sameOutput).toBe(true); expect(result.sameGpuMasks).toBe(true);
  // A refused transaction can establish a new lifetime high-water mark while
  // releasing every transient owner. Admission includes a history checkpoint,
  // 24 bytes per scene element for masks and 4 MiB of work; a released pick owns its
  // 1024-byte queue record. Native selection maps have separate reservations.
  const retainedExport = result.before.exportBytes;
  if (retainedExport === undefined || !Number.isSafeInteger(retainedExport) || retainedExport <= 0)
    throw new Error('The completed diagnostic export must expose its retained native output owner.');
  expect(result.before.exportOutputBytes).toBe(retainedExport);
  expect(result.after.exportBytes).toBe(retainedExport); expect(result.after.exportOutputBytes).toBe(retainedExport);
  const payloadBytes = result.before.count * 144 + (result.before.selectionMapBytes ?? 0) + retainedExport;
  expect(payloadBytes).toBeLessThanOrEqual(result.before.memoryBytes);
  const historyBytes = result.before.memoryBytes - payloadBytes;
  expect(historyBytes).toBeGreaterThanOrEqual(0);
  const refusalPeak = result.usageBefore.bytes + historyBytes + result.before.count * 24 + 4 * 1024 * 1024 +
    (kind === 'pick' ? 1024 : 0);
  expect(result.usageAfter).toEqual({ ...result.usageBefore, peakBytes: Math.max(result.usageBefore.peakBytes, refusalPeak) });
  expect(result.expanded).toBe(3); expect(result.shrunk).toBe(1);
  expect(result.undone?.selected).toBe(0); expect(result.undone?.canUndo).toBe(false);
  expect(result.redone?.selected).toBe(1); expect(result.picks).toBe(kind === 'pick' ? 2 : 1);
});

for (const kind of ['pick', 'amendment', 'cancelled'] as const) test(`export resolves the held Color ${kind} before capturing Selected scope`, async ({ page }) => {
  const result = await page.evaluate(kind => window.gpuHarness.colorExportBarrier(kind), kind);
  expect(result.blocked).toBe(true); expect(result.exportCalls).toBe(1); expect(result.receipt).toBe(true);
  expect(result.busy).toBe(false); expect(result.error).toBeNull(); expect(result.picks).toBe(1);
  expect(result.after.transaction).toBe(false); expect(result.after.selectionDraft).toBe(false);
  const count = kind === 'pick' ? 1 : 3;
  expect(result.beforeSelected).toBe(kind === 'amendment' ? 1 : 3);
  expect(result.after.selected).toBe(count); expect(result.rows).toHaveLength(count);
  expect(result.masks).toEqual(kind === 'pick' ? [1, 0, 0] : [1, 1, 1]);
  if (kind === 'pick') { expect(result.accepted).toBe(true); expect(result.rows?.[0][0]).toBeCloseTo(-.4, 6); expect(result.undone?.selected).toBe(3); }
  else { if (kind === 'cancelled') expect(result.accepted).toBe(false); expect(result.undone?.selected).toBe(0); expect(result.undone?.canUndo).toBe(false); }
});

for (const empty of [false, true]) test(`tolerance entered during a pending ${empty ? 'empty' : 'valid'} replacement belongs to that Color pick`, async ({ page }) => {
  const result = await page.evaluate(empty => window.gpuHarness.colorPendingTolerance(empty), empty);
  expect(result.before.selected).toBe(1); expect(result.whilePending.selected).toBe(1);
  expect(result.whilePending.toleranceSessionId).toBe(result.before.toleranceSessionId);
  expect(result.whilePending.contentRevision).toBe(result.before.contentRevision); expect(result.remembered).toBe(.5);
  expect(result.exportBlocked).toBe(true); expect(result.exportCalls).toBe(1);
  expect(result.accepted).toBe(!empty); expect(result.after.selected).toBe(empty ? 1 : 3); expect(result.outputRows).toBe(empty ? 1 : 3);
  if (empty) {
    expect(result.after.toleranceSessionId).toBe(result.before.toleranceSessionId);
    expect(result.expanded).toBe(3); expect(result.shrunk).toBe(1); expect(result.undone?.selected).toBe(0);
  } else {
    expect(result.after.toleranceSessionId).not.toBe(result.before.toleranceSessionId); expect(result.undone?.selected).toBe(1);
  }
  expect(result.final?.selected).toBe(0); expect(result.final?.canUndo).toBe(false);
  expect(result.busy).toBe(false); expect(result.error).toBeNull(); expect(result.after.transaction).toBe(false);
});

for (const kind of ['geometry', 'mask', 'history', 'cancel'] as const) {
  test(`failed ${kind} update restores exact native history, GPU image and reservations`, async ({ page }) => {
    const result = await page.evaluate(kind => window.gpuHarness.editFailure(kind), kind);
    expect(result.historyPublicationRefused).toBe(kind === 'history');
    expect(result.accepted).toBe(false); expect(result.sameScene).toBe(true); expect(result.sameOutput).toBe(true);
    expect(result.before.canRedo).toBe(true); expect(result.after.transaction).toBe(false);
    for (const field of ['revision', 'contentRevision', 'selected', 'visible', 'canUndo', 'canRedo'] as const)
      expect(result.after[field], field).toBe(result.before[field]);
    expect(result.image.maxError).toBe(0); expect(result.image.nonblackPixels).toBeGreaterThan(100);
    expect(result.usage.after).toBe(result.usage.before); expect(result.usage.afterAllocations).toBe(result.usage.beforeAllocations);
    expect(result.dirty).toBe(false); expect(result.busy).toBe(false);
    if (kind === 'cancel') expect(result.error).toBeNull(); else expect(result.error).toMatch(/Injected/);
    expect(result.redone).toBe(true); expect(result.redoneVisible).toBe(2);
  });
}

for (const boundary of ['preview', 'confirm'] as const) test(`failed gesture ${boundary} restores its baseline without leaving a draft`, async ({ page }) => {
  const result = await page.evaluate(boundary => window.gpuHarness.gestureFailure(boundary), boundary);
  expect(result.accepted).toBe(false); expect(result.after.transaction).toBe(false); expect(result.after.selectionDraft).toBe(false);
  expect(result.mask).toEqual([0, 1, 0]); expect(result.after.canRedo).toBe(true); expect(result.redone).toBe(true);
  expect(result.after.contentRevision).toBe(result.before.contentRevision);
  expect(result.busy).toBe(false); expect(result.active).toBe(false); expect(result.error).toMatch(/Injected gesture/);
});

test('selection transfers only the native source mask and no packed scene chunks', async ({ page }) => {
  const result = await page.evaluate(() => window.gpuHarness.maskTransfer());
  expect(result.mask).toEqual([0, 1, 0]); expect(result.selected).toBe(1);
  expect(result.messages).toEqual([{ type: 'masks', bytes: 3 }]);
});

test('ordered contributors, composited depth, empty pixels and deleted source IDs', async ({ page }) => {
  const result = await page.evaluate(() => window.gpuHarness.overlap());
  // Pixel samples lie at x+.5/y+.5. These independent covariance calculations
  // include the desktop .3 pixel low-pass term for each layer's depth.
  const focal = 100 / Math.tan(Math.PI / 8);
  const alpha = (opacity: number, depth: number) => opacity * Math.exp(-.25 / (.01 * (focal / depth) ** 2 + .3));
  const front = alpha(.2, 3), rear = alpha(.9, 4), opacity = front + (1 - front) * rear;
  expect(result.errors).toEqual([]);
  expect(result.center.index).toBe(1); // Rear contribution .8*.9 beats front .2.
  expect(result.center.opacity).toBeCloseTo(opacity, 6);
  expect(result.center.depth).toBeCloseTo((3 * front + 4 * (1 - front) * rear) / opacity, 5);
  expect(result.empty.index).toBeNull(); expect(result.empty.opacity).toBe(0);
  expect(result.deletedFront.index).toBe(1); expect(result.deletedFront.opacity).toBeCloseTo(rear, 6);
  expect(result.deletedFront.depth).toBeCloseTo(4, 6);
});

test('bounded contributor queries retain foreground occlusion and reject invalid pixels', async ({ page }) => {
  const result = await page.evaluate(() => window.gpuHarness.boundedPick());
  expect(result.errors).toEqual([]); expect(result.unbounded.index).toBe(0);
  expect(result.obscured.index).toBeNull(); expect(result.obscured.contribution).toBe(0);
  expect(result.obscured.opacity).toBeGreaterThan(.999);
  expect(result.revealed.index).toBe(2); expect(result.revealed.contribution).toBeGreaterThan(.89);
  for (const hit of result.invalid) expect(hit).toEqual({ index: null, depth: 0, opacity: 0, contribution: 0, deviceEpoch: result.unbounded.deviceEpoch });
});

test('native footprint limits, anisotropy, offscreen overlap and clipping agree with raster samples', async ({ page }) => {
  const result = await page.evaluate(() => window.gpuHarness.footprints());
  expect(result.errors).toEqual([]);
  const scale = (100 / Math.tan(Math.PI / 8) / 3) ** 2;
  // The fixed RDF camera reverses world Y in view space, so xy covariance
  // changes sign before projection.
  const a = .04 * scale + .3, b = -.012 * scale, c = .01 * scale + .3, x = 8.5, y = -5.5;
  const radius = (c * x * x - 2 * b * x * y + a * y * y) / (a * c - b * b);
  expect(result.anisotropic.opacity).toBeCloseTo(.8 * Math.exp(-.5 * radius), 5);
  expect(result.edgeInside.index).toBe(0); expect(result.offscreen.index).toBe(0); expect(result.offscreen.projected).toBe(true);
  for (const sample of [result.anisotropic, result.edgeInside, result.offscreen])
    for (const channel of sample.rgb) expect(Math.abs(channel - Math.round(sample.opacity * .5 * 255))).toBeLessThanOrEqual(1);
  for (const sample of [result.edgeOutside, result.faint, result.behind, result.far, result.near]) {
    expect(sample.index).toBeNull(); expect(sample.opacity).toBe(0); expect(sample.rgb).toEqual([0, 0, 0]);
  }
  for (const sample of [result.behind, result.far, result.near]) expect(sample.projected).toBe(false);
});

test('global radix order and stable ties cross prefix blocks and partial groups', async ({ page }) => {
  const result = await page.evaluate(() => window.gpuHarness.globalOrder());
  expect(result.errors).toEqual([]); expect(result.count).toBeGreaterThan(65_536);
  expect(result.mismatch, `actual ${result.actual}, expected ${result.expected}`).toBe(-1);
});

for (const kind of ['grade', 'transform'] as const) {
  test(`selected-only ${kind} preview agrees with real C++ commit and repack`, async ({ page }) => {
    const result = await page.evaluate(kind => window.gpuHarness.preview(kind), kind);
    expect(result.errors).toEqual([]); expect(result.contentRevision).toBeGreaterThan(0);
    expect(result.comparison.nonblackPixels).toBeGreaterThan(100);
    expect(result.effect.changedChannels).toBeGreaterThan(100);
    expect(result.comparison.maxError).toBeLessThanOrEqual(2);
    expect(result.comparison.totalError).toBeLessThanOrEqual(100);
  });
}
