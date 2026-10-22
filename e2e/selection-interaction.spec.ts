import { expect, test } from '@playwright/test';
import type {} from './map-cache-harness';
import type { SurfaceProfile } from '../src/renderer/webgpu/surfaceQuery';

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/map-cache-harness.html');
  await page.waitForFunction(() => Boolean(window.mapCacheHarness || window.mapCacheHarnessError));
  expect(await page.evaluate(() => window.mapCacheHarnessError)).toBeUndefined();
});

function expectProfile(profile: SurfaceProfile | undefined) {
  expect(profile).toBeDefined();
  for (const value of Object.values(profile!)) { expect(Number.isFinite(value)).toBe(true); expect(value).toBeGreaterThanOrEqual(0); }
  expect(profile!.totalMs).toBeGreaterThanOrEqual(profile!.pipelineMs);
  expect(profile!.totalMs).toBeGreaterThanOrEqual(profile!.compositeReadbackMs);
}

for (const dimensions of [{ width: 320, height: 200 }, { width: 1025, height: 769 }]) {
  test(`local 3D brush maps match full GPU depth and native selection at ${dimensions.width} by ${dimensions.height}`, async ({ page }) => {
    const result = await page.evaluate(options => window.mapCacheHarness.interactionRegions(options), dimensions);
    expect(result.errors).toEqual([]); expect(result.rows).toHaveLength(5);
    for (const row of result.rows) {
      expect(row.width).toBe(result.dimensions.width); expect(row.height).toBe(result.dimensions.height);
      expect(row.fullWidth).toBe(dimensions.width); expect(row.fullHeight).toBe(dimensions.height);
      expect(row.covered).toBe(true); expect(row.insideError).toBe(0); expect(row.outsideNonzero).toBe(0);
      expect(row.localMasks).toEqual(row.fullMasks); expectProfile(row.profile);
      if (row.selected) { expect(row.undoMasks).toEqual([0, 0, 0]); expect(row.redoMasks).toEqual(row.localMasks); }
    }
    expect(result.rows[0].selected).toBeGreaterThan(0);
    expect(result.rows[1].selected).toBeGreaterThanOrEqual(2);
    expect(result.rows[3].selected).toBeGreaterThanOrEqual(2);
    expect(result.rows[4].selected).toBe(0);
    expect(result.rows[0].insidePixels).toBeLessThan(result.dimensions.width * result.dimensions.height);
    expect(result.rows[0].profile!.readbackBytes).toBeLessThan(result.fullReadbackBytes!);
  });
}

test.describe('physical framebuffer coverage at DPR 2', () => {
  test.use({ deviceScaleFactor: 2 });
  test('uses physical coordinates for exact local depth and native membership', async ({ page }) => {
    const result = await page.evaluate(() => window.mapCacheHarness.interactionRegions({ width: 640, height: 400 }));
    expect(result.errors).toEqual([]); expect(result.dpr).toBe(2); expect(result.cssWidth).toBe(320);
    for (const row of result.rows) {
      expect(row.insideError).toBe(0); expect(row.outsideNonzero).toBe(0); expect(row.localMasks).toEqual(row.fullMasks);
    }
    expect(result.rows[0].selected).toBeGreaterThan(0); expect(result.rows[1].selected).toBeGreaterThanOrEqual(2);
  });
});

test('growing depth coverage preserves contained hits and upgrades safely for Color and visibility', async ({ page }) => {
  const result = await page.evaluate(() => window.mapCacheHarness.interactionCoverageUpgrade());
  expect(result.errors).toEqual([]); expect(result.growingId).toBeGreaterThan(result.firstId);
  expect(result.firstRegion).toEqual({ x: 64, y: 48, width: 32, height: 32 }); expect(result.firstRegionUnchanged).toBe(true);
  expect(result.growingRegion).toEqual({ x: 64, y: 48, width: 128, height: 64 });
  expect(result.containedId).toBe(result.growingId); expect(result.fullId).toBeGreaterThan(result.growingId);
  expect(result.fromFullId).toBe(result.fullId); expect(result.fullRegion).toBeNull();
  expect(result.hasColors).toBe(true); expect(result.hasVisible).toBe(true);
  expect(result.firstRetired).toBe(true); expect(result.growingRetired).toBe(true); expect(result.fullValid).toBe(true);
  const completed = result.events.filter(event => event.status === 'completed');
  expect(completed.filter(event => event.stage === 'surface-create')).toHaveLength(3);
  expect(completed.filter(event => event.stage === 'native-adopt')).toHaveLength(3);
  for (const event of completed) { expect(Number.isFinite(event.elapsedMs)).toBe(true); expect(event.elapsedMs).toBeGreaterThanOrEqual(0); }
  expect(result.released).toBe(0); expect(result.scratch.allocatedBytes).toBe(0);
});

test('retired scratch is reused with exact fresh results after camera, density and visibility changes', async ({ page }) => {
  const result = await page.evaluate(() => window.mapCacheHarness.interactionScratchReuse());
  expect(result.errors).toEqual([]); expect(result.rows).toHaveLength(5);
  for (const row of result.rows) {
    expect(row.difference).toEqual({ depth: 0, opacity: 0, color: 0, visible: 0 });
    expect(row.ledgerDelta).toBe(row.expectedDelta); expect(row.scratch.activeBuffers).toBe(0);
    expect(row.scratch.idleBytes).toBeGreaterThan(0); expect(row.scratch.idleBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(row.scratch.idleBuffers).toBeLessThanOrEqual(32); expectProfile(row.profile);
  }
  expect(result.rows[0].profile!.createdBuffers).toBeGreaterThan(0);
  expect(result.rows[1].profile!.reusedBuffers).toBeGreaterThan(0);
  expect(result.rows[2].profile!.reusedBuffers).toBeGreaterThan(0);
  expect(result.rows[3].nonempty).toBe(0); expect(result.rows[3].visible).toEqual([0]);
  expect(result.rows[4].nonempty).toBeGreaterThan(0);
  expect(result.released).toBe(0); expect(result.scratch.allocatedBytes).toBe(0); expect(result.scratch.idleBuffers).toBe(0);
});

test('first scene frame warms shared asynchronous pipelines and leaves visibility lazy', async ({ page }) => {
  const result = await page.evaluate(() => window.mapCacheHarness.interactionPreparation());
  const base = ['bin', 'scatter', 'sortTile', 'composite', 'prepareAuxiliary'];
  expect(result.frames).toBeGreaterThan(0); expect(result.prewarmed).toEqual(base); expect(result.sharedPipelines).toBe(true);
  expect(result.afterDepth).toEqual(base); expect(result.entries).toEqual([...base, 'markVisible']);
  expect(result.gestureAccepted).toBe(true); expect(result.gestureRegion).toEqual(result.expectedRegion);
  expect(result.gestureRegion).toBeDefined(); expect(result.selected).toBeGreaterThan(0);
  expectProfile(result.depth); expectProfile(result.visible); expect(result.error).toBeNull();
});
