import { expect, test, type Page } from '@playwright/test';
import { polygonBaselineIds, polygonCenterIds, polygonPly, polygonPositions } from './polygon-fixture';
import { chooseSelectionTool } from './selectTool';
import type {} from './polygon-harness';

// These browser tests replace a client outcome only AFTER forwarding the real
// native preview. They verify transaction rollback and gesture/UI routing.
// Native computation nonpublication has separate evaluator-seam coverage.
const injectionBoundary = 'test-only client-result replacement after real native preview';
const bytes = polygonPly(), masks = (ids: readonly number[]) => polygonPositions.map((_, id) => Number(ids.includes(id)));
type Snapshot = Awaited<ReturnType<Window['polygonApp']['snapshot']>>;
function exact(value: Snapshot, ids: number[]) {
  expect(value.gpu).toEqual(masks(ids)); expect(value.ids).toEqual(ids); expect(value.summary.selected).toBe(ids.length);
  expect(value.nativeMasks.map(mask => mask & 1)).toEqual(masks(ids));
}
async function snapshot(page: Page) { return page.evaluate(() => window.polygonApp.snapshot()); }
async function state(page: Page) { return page.evaluate(() => window.polygonApp.state()); }
async function counts(page: Page) {
  return page.evaluate(() => ({ previews: window.polygonApp.previewResults.length,
    finals: window.polygonApp.traffic.filter(command => command.command === 'polygon').length - window.polygonApp.previewResults.length,
    cancellations: window.polygonApp.traffic.filter(command => command.command === 'cancelSelection').length }));
}
async function vertices(page: Page) {
  return page.locator('.gesture-overlay polyline').evaluateAll(elements => elements.length ? elements[0].getAttribute('points')!.trim().split(/\s+/).map(point => point.split(',').map(Number)) : []);
}
async function click(page: Page, point: number[]) { await page.mouse.move(point[0], point[1]); await page.mouse.down(); await page.mouse.up(); }
async function outline(page: Page, points: number[][]) { for (const point of points) await click(page, point); }
async function open(page: Page, mode: 'basic' | 'pro', otherLive = false) {
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  await page.getByLabel('Open scene files').setInputFiles({ name: 'polygon-sh0.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
  await expect(page).toHaveTitle('polygon-sh0.ply — SplatView');
  await page.mouse.move(640, 400); await expect(page.locator('main')).not.toHaveClass(/chrome-hidden/);
  await page.getByRole('button', { name: 'Tools', exact: true }).click(); await chooseSelectionTool(page, 'Polygon');
  await page.evaluate(async () => {
    const resource = (path: string) => performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === path)!.name;
    const { AppController } = await import(/* @vite-ignore */ resource('/src/app/controller.ts'));
    const { useApp, setSelectionPreferences, switchToolsMode } = await import(/* @vite-ignore */ resource('/src/app/store.ts'));
    const harnessUrl = '/e2e/polygon-harness.ts', { installPolygonProbe } = await import(/* @vite-ignore */ harnessUrl);
    const original = AppController.prototype.setSelectionOperation;
    AppController.prototype.setSelectionOperation = function(operation: number) {
      AppController.prototype.setSelectionOperation = original;
      window.polygonApp = installPolygonProbe(this, { get: useApp.getState, preferences: setSelectionPreferences, mode: switchToolsMode });
      return original.call(this, operation);
    };
  });
  await page.getByRole('button', { name: 'Replace', exact: true }).click();
  await page.evaluate(({ mode, otherLive }) => window.polygonApp.profiles(mode, true, false, otherLive, true), { mode, otherLive });
  await page.evaluate(() => window.polygonApp.baseline()); exact(await snapshot(page), polygonBaselineIds);
  expect((await snapshot(page)).summary.canRedo).toBe(true);
  return page.evaluate(() => window.polygonApp.outline());
}
async function redoAfterRestoration(page: Page) {
  // Restore can re-enable the Pro Volume statistic before its passive React
  // effect starts. Wait for that real read-only range and its busy owner to
  // settle, so the first physical press is not disabled midway through input.
  await page.waitForFunction(() => {
    const h = window.polygonApp, current = h.state();
    return !current.busy && (current.mode !== 'pro' || h.controller.selectionMorphologyRange !== null);
  }, null, { timeout: 15_000 });
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  exact(await snapshot(page), [0, 2, 3]);
}
async function history(page: Page, ids: number[]) {
  const after = await snapshot(page); exact(after, ids);
  expect(after.summary.selectionDraft).toBe(false); expect(after.summary.canRedo).toBe(false); expect(after.work).toBe(0); expect(after.error).toBeNull();
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); exact(await snapshot(page), polygonBaselineIds);
  await page.getByRole('button', { name: 'Redo', exact: true }).click(); exact(await snapshot(page), ids);
}

test.afterEach(async ({ page }, info) => {
  const evidence = await page.evaluate(() => window.polygonApp && ({ state: window.polygonApp.state(),
    traffic: window.polygonApp.traffic, previewResults: window.polygonApp.previewResults })).catch(() => undefined);
  if (evidence) await info.attach('live-preview-injection-boundary.json', {
    body: Buffer.from(JSON.stringify({ injectionBoundary, evidence }, null, 2)), contentType: 'application/json' });
});

test.describe('Typed computation outcome: client-result replacement after native forwarding', () => {
  // web-lite has only the Basic profile (the Basic/Pro toggle is gated by processing.advanced), so cases
  // whose stimulus is a mid-polygon profile switch are omitted.
  for (const mode of ['basic'] as const) {
    test(`${mode} Escape during held typed baseline restoration joins one cancel and preserves original mask and isolated Redo`, async ({ page }) => {
      const points = await open(page, mode); await outline(page, points); exact(await snapshot(page), polygonCenterIds);
      await page.evaluate(() => { window.polygonApp.failNextLivePreview(); window.polygonApp.holdBaselineRestore(); });
      await page.mouse.move(points[0][0], points[0][1]); await page.waitForFunction(() => window.polygonApp.restoreControl.entered);
      const before = await counts(page); expect(before.cancellations).toBe(1); expect(before.finals).toBe(0);
      await page.keyboard.press('Escape');
      expect((await counts(page)).cancellations).toBe(1); expect((await counts(page)).finals).toBe(0);
      await page.evaluate(() => window.polygonApp.releaseBaselineRestore());
      const canceled = await snapshot(page); exact(canceled, polygonBaselineIds);
      expect(canceled.summary.selectionDraft).toBe(false); expect(canceled.summary.transaction).toBe(false);
      expect(canceled.summary.canRedo).toBe(true); expect(canceled.active).toBe(false); expect(canceled.error).toBeNull(); expect(canceled.work).toBe(0);
      const settled = await state(page); expect(settled.selectionRecovery).toBe('idle'); expect(settled.busy).toBe(false);
      expect(await vertices(page)).toHaveLength(0); expect((await counts(page)).cancellations).toBe(1); expect((await counts(page)).finals).toBe(0);
      await redoAfterRestoration(page);
      await page.getByRole('button', { name: 'Undo', exact: true }).click(); exact(await snapshot(page), polygonBaselineIds);
    });

    test(`${mode} a held typed outcome superseded by Combine cannot retire its replacement`, async ({ page }) => {
      const points = await open(page, mode); await outline(page, points); exact(await snapshot(page), polygonCenterIds);
      await page.evaluate(() => window.polygonApp.failNextLivePreview(true)); await page.mouse.move(points[0][0], points[0][1]);
      await page.waitForFunction(() => window.polygonApp.typedControl.entered);
      await page.keyboard.press('2'); await page.evaluate(() => window.polygonApp.releaseLivePreview());
      const replacement = await snapshot(page); exact(replacement, [0, 1, 2]);
      expect((await state(page)).polygon).toMatchObject({ computationFailed: false, failed: false, liveRequested: true, complete: true });
      expect(replacement.active).toBe(true); expect(replacement.error).toBeNull(); expect((await counts(page)).finals).toBe(0);
      await page.keyboard.press('Enter'); await history(page, [0, 1, 2]);
    });

    test(`${mode} refusing only the first typed baseline restore requires explicit Restore selection and makes no automatic second cancel`, async ({ page }) => {
      const points = await open(page, mode); await outline(page, points); exact(await snapshot(page), polygonCenterIds);
      await page.evaluate(() => { window.polygonApp.failNextLivePreview(); window.polygonApp.holdBaselineRestore(true); });
      await page.mouse.move(points[0][0], points[0][1]); await page.waitForFunction(() => window.polygonApp.restoreControl.entered);
      await page.evaluate(() => window.polygonApp.releaseBaselineRestore());
      const required = await page.evaluate(() => window.polygonApp.inspect());
      expect(required.summary.selectionDraft).toBe(true); expect(required.summary.transaction).toBe(false);
      expect(required.gpu).toEqual(masks(polygonCenterIds)); expect(required.summary.selected).toBe(polygonCenterIds.length);
      const blocked = await state(page); expect(blocked.selectionRecovery).toBe('required'); expect(blocked.active).toBe(false);
      expect(blocked.error).toMatch(/Injected first baseline restoration refusal/); expect((await counts(page)).cancellations).toBe(1);
      expect(await page.evaluate(() => window.polygonApp.controller.editingAvailable)).toBe(false);
      await page.getByRole('button', { name: 'Restore selection', exact: true }).click();
      const restored = await snapshot(page); exact(restored, polygonBaselineIds); expect(restored.summary.canRedo).toBe(true); expect(restored.summary.selectionDraft).toBe(false); expect(restored.work).toBe(0);
      expect((await state(page)).selectionRecovery).toBe('idle'); expect((await counts(page)).cancellations).toBe(2);
      await redoAfterRestoration(page);
    });

  }
});

test.describe('Geometric controller fatal publication and retained restoration authority', () => {
  for (const mode of ['basic'] as const) for (const tool of ['rectangle', 'volume'] as const) {
    test(`${mode} ${tool} physical publication refusal after Combine stays fatal and preserves first Redo`, async ({ page }, info) => {
      await page.goto('/e2e/polygon-harness.html'); await page.waitForFunction(() => Boolean(window.polygonHarness));
      const result = await page.evaluate(({ tool, mode }) => window.polygonHarness.supersededPublication(tool, mode), { tool, mode });
      exact(result.before, polygonBaselineIds); exact(result.after, polygonBaselineIds); expect(result.accepted).toBe(false);
      expect(result.candidate).toEqual(masks(polygonCenterIds)); expect(result.after.summary.selectionDraft).toBe(false); expect(result.after.summary.canRedo).toBe(true);
      expect(result.after.active).toBe(false); expect(result.after.error).toMatch(/physical publication refusal after Combine/);
      expect(result.previewResults).toHaveLength(1); expect(result.previewResults[0].injected).toBe(false);
      exact(result.redone, [0, 2, 3]); exact(result.settled, [0, 2, 3]); expect(result.work).toBe(0); expect(result.settled.summary.selectionMapBytes).toBe(0);
      await info.attach('geometric-physical-refusal.json', { body: Buffer.from(JSON.stringify(result, null, 2)), contentType: 'application/json' });
    });
    test(`${mode} ${tool} typed failure with first-only baseline refusal locks editing before release and waits for explicit recovery`, async ({ page }, info) => {
      await page.goto('/e2e/polygon-harness.html'); await page.waitForFunction(() => Boolean(window.polygonHarness));
      const result = await page.evaluate(({ tool, mode }) => window.polygonHarness.geometricRestoreRefusal(tool, mode), { tool, mode });
      expect(result.required.summary.selectionDraft).toBe(true); expect(result.required.summary.transaction).toBe(false);
      expect(result.required.gpu).toEqual(masks(polygonBaselineIds)); expect(result.required.state.selectionRecovery).toBe('required');
      expect(result.required.editing).toBe(false); expect(result.required.cancellations).toBe(1);
      expect(result.restored).toBe(true); exact(result.after, polygonBaselineIds); expect(result.after.summary.canRedo).toBe(true);
      exact(result.redone, [0, 2, 3]); expect(result.traffic.filter(command => command.command === 'cancelSelection')).toHaveLength(2);
      expect(result.previewResults).toHaveLength(1); expect(result.previewResults[0].injected).toBe(true); expect(result.work).toBe(0);
      await info.attach('geometric-typed-restore-refusal.json', { body: Buffer.from(JSON.stringify({ injectionBoundary, result }, null, 2)), contentType: 'application/json' });
    });
  }
});
