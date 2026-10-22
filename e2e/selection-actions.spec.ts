import { expect, test, type Page } from '@playwright/test';
import { chooseSelectionTool } from './selectTool';
import type {} from './geometry-viewer-harness';

// Committed desktop 4e1be155 selection_ui.cpp:624-744, preserved in
// .build/view-scope-tests/desktop-reference (Actions and Selection controls).
// Exercise the actual App, native edits and GPU masks, including manual drafts.
async function open(page: Page) {
  await page.goto('/e2e/geometry-viewer-harness.html');
  await page.waitForFunction(() => window.geometryViewerError || window.geometryViewer?.ready());
  expect(await page.evaluate(() => window.geometryViewerError)).toBeUndefined();
  await page.evaluate(() => window.geometryViewer.load('gaussian'));
  await page.mouse.move(8, 400);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  return page.getByRole('complementary', { name: 'Tools', exact: true });
}
async function snapshot(page: Page) { return page.evaluate(() => window.geometryViewer.selectionSnapshot()); }
async function masks(page: Page, expected: number[]) {
  await expect(page.getByRole('button', { name: 'Select all', exact: true })).toBeEnabled();
  await expect.poll(async () => (await snapshot(page)).gpuMasks).toEqual(expected);
}

// web-lite has one Tools profile (processing.advanced) and omits Current view only (selection.advanced).
const SELECTION_ACTIONS = ['Select all', 'Clear selection', 'Invert selection'];
test('Basic uses joined desktop actions with selection-dependent availability', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const panel = await open(page);
  for (const mode of ['Basic'] as const) {
    const selection = panel.getByRole('group', { name: 'Selection actions', exact: true });
    const destructive = panel.getByRole('group', { name: 'Delete or keep selection', exact: true });
    expect(await selection.getByRole('button').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))))
      .toEqual(SELECTION_ACTIONS);
    expect(await destructive.getByRole('button').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))))
      .toEqual(['Delete selected', 'Keep selected']);
    for (const group of [selection, destructive]) for (const button of await group.getByRole('button').all()) {
      expect(await button.boundingBox()).toMatchObject({ width: 30, height: 28 });
      await expect(button.locator('.icon')).toHaveCSS('width', '18px');
    }
    const left = (await selection.boundingBox())!, right = (await destructive.boundingBox())!;
    expect(right.y).toBe(left.y); expect(right.x - left.x - left.width).toBe(8);
    expect(left.width).toBe(30 * SELECTION_ACTIONS.length); expect(right.width).toBe(60);
    for (const label of ['Clear selection', 'Delete selected', 'Keep selected', 'Reset cleanup'])
      await expect(panel.getByRole('button', { name: label, exact: true })).toBeDisabled();
    for (const label of ['Select all', 'Invert selection', 'Selection controls'])
      await expect(panel.getByRole('button', { name: label, exact: true })).toBeEnabled();
    await panel.getByRole('button', { name: 'Select all', exact: true }).click(); await masks(page, [1, 1, 1]);
    for (const label of ['Clear selection', 'Delete selected', 'Keep selected'])
      await expect(panel.getByRole('button', { name: label, exact: true })).toBeEnabled();
    await panel.getByRole('button', { name: 'Delete selected', exact: true }).click(); await masks(page, [2, 2, 2]);
    for (const label of ['Select all', 'Invert selection', 'Reset cleanup'])
      await expect(panel.getByRole('button', { name: label, exact: true })).toBeEnabled();
    for (const label of ['Clear selection', 'Delete selected', 'Keep selected'])
      await expect(panel.getByRole('button', { name: label, exact: true })).toBeDisabled();
    // Native Restore is a separate browser extension, outside the five-button strip.
    expect(await destructive.getByRole('button', { name: 'Restore deleted', exact: true }).count()).toBe(0);
    await panel.getByRole('button', { name: 'Restore deleted', exact: true }).click(); await masks(page, [0, 0, 0]);
    await page.screenshot({ path: testInfo.outputPath(`selection-actions-${mode.toLowerCase()}.png`) });
  }
  await page.setViewportSize({ width: 200, height: 600 });
  const left = (await panel.getByRole('group', { name: 'Selection actions', exact: true }).boundingBox())!;
  const right = (await panel.getByRole('group', { name: 'Delete or keep selection', exact: true }).boundingBox())!;
  expect(left.width).toBe(30 * SELECTION_ACTIONS.length); expect(right.width).toBe(60);
  expect(right.x).toBe(left.x); expect(right.y).toBe(left.y + 28 + 8);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('Keep and Restore preserve selection while Cleanup Reset clears masks and returns to Orbit', async ({ page }) => {
  const panel = await open(page);
  await page.evaluate(async () => {
    const app = window.geometryViewer.controllerForSourceNavigation();
    const values = [1.2, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    await app.command({ command: 'grade', values });
    await app.command({ command: 'transform', matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, .1, 0, 0, 1] });
    await app.command({ command: 'single', index: 0, operation: 0 });
  });
  await masks(page, [1, 0, 0]);
  const content = await snapshot(page);
  await panel.getByRole('button', { name: 'Keep selected', exact: true }).click(); await masks(page, [1, 2, 2]);
  await panel.getByRole('button', { name: 'Restore deleted', exact: true }).click(); await masks(page, [1, 0, 0]);
  const restored = await snapshot(page); expect(restored.exported).toBe(content.exported);
  await chooseSelectionTool(page, 'Brush');
  await panel.getByRole('button', { name: 'Reset cleanup', exact: true }).click(); await masks(page, [0, 0, 0]);
  const reset = await snapshot(page);
  expect(reset.tool).toBeNull(); expect(reset.camera).toEqual(content.camera);
  expect(reset.exported).toBe(content.exported);
  expect(reset.summary.contentRevision).toBe(restored.summary.contentRevision);
  await expect(panel.getByRole('button', { name: 'Selection tool', exact: true }).getByText('Navigate', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Reset cleanup', exact: true })).toBeDisabled();
  // A clean scene with an armed tool still has a meaningful Reset.
  await chooseSelectionTool(page, 'Polygon');
  await expect(panel.getByRole('button', { name: 'Reset cleanup', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: 'Reset cleanup', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Selection tool', exact: true }).getByText('Navigate', { exact: true })).toBeVisible();
  expect((await snapshot(page)).summary.revision).toBe(reset.summary.revision);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('Selection Help captures shortcuts and dismissal without changing a live manual draft', async ({ page }, testInfo) => {
  const panel = await open(page);
  await chooseSelectionTool(page, 'Box select');
  const content = await snapshot(page); expect(content.exported).not.toBeNull();
  await page.evaluate(async () => {
    const app = window.geometryViewer.controllerForSourceNavigation(), canvas = app.renderer!.canvas;
    await app.command({ command: 'single', index: 0, operation: 0 });
    // The selection change starts the automatic pivot query; let it finish first.
    const url = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === '/src/app/store.ts')!.name;
    const { useApp } = await import(/* @vite-ignore */ url);
    for (const deadline = performance.now() + 5000; (useApp.getState().busy || useApp.getState().transformPivotPending) && performance.now() < deadline;)
      await new Promise(resolve => setTimeout(resolve, 10));
    if (!app.beginSelectionGesture(0)) throw new Error('Manual draft did not begin.');
    app.previewSelection({ command: 'rectangle', camera: app.camera!.state, width: canvas.width,
      height: canvas.height, rectangle: [0, 0, canvas.width, canvas.height], operation: 0, overlap: false });
  });
  await expect(page.evaluate(() => window.geometryViewer.controllerForSourceNavigation().client!.sceneExportPlan(0, 0)))
    .rejects.toThrow('Resolve the retained edit before starting other scene work.');
  await masks(page, [1, 1, 1]); const before = await snapshot(page);
  expect(before.summary.selectionDraft).toBe(true);
  expect(before.exported).toBeNull();
  expect(before.nativeMasks).toEqual([1, 1, 1]); expect(before.gpuMasks).toEqual(before.nativeMasks);
  expect(before.nativeViewBytes.length).toBeGreaterThan(0);
  expect(before.nativeViewBytes).toEqual(content.nativeViewBytes);
  expect(before.gpuViewBytes).toEqual(before.nativeViewBytes);
  expect(before.summary.contentRevision).toBe(content.summary.contentRevision);
  await panel.getByRole('button', { name: 'Selection controls', exact: true }).click();
  const help = page.getByRole('dialog', { name: 'Selection controls', exact: true });
  await expect(help).toBeVisible(); await expect(help).toHaveAttribute('aria-modal', 'false');
  await expect(help.getByRole('columnheader')).toHaveText(['Control', 'Input']);
  await expect(help.getByText('Combine', { exact: true })).toBeVisible();
  await expect(help.getByText('Brush size', { exact: true })).toHaveCount(0);
  const bounds = (await help.boundingBox())!, tools = (await panel.boundingBox())!;
  expect(bounds.y).toBe(12); expect(tools.x - bounds.x - bounds.width).toBe(12);
  for (const key of ['Control+a', 'Control+i', 'Control+Shift+a', 'Control+z', 'Delete', 'c', 'i', 'PageDown', 'g'])
    await page.keyboard.press(key);
  expect(await snapshot(page)).toEqual(before);
  await page.screenshot({ path: testInfo.outputPath('selection-help-live-draft.png') });
  await page.keyboard.press('Escape'); await expect(help).toHaveCount(0);
  expect(await snapshot(page)).toEqual(before);
  await panel.getByRole('button', { name: 'Selection controls', exact: true }).click();
  await help.getByRole('button', { name: 'Close Selection controls', exact: true }).click(); expect(await snapshot(page)).toEqual(before);
  await panel.getByRole('button', { name: 'Selection controls', exact: true }).click();
  await page.mouse.click(2, 790); await expect(help).toHaveCount(0); expect(await snapshot(page)).toEqual(before);
  // The same shortcut is legal once Help closes: cancel the gesture baseline,
  // then clear it, while retaining the armed Box tool.
  await page.locator('canvas').focus(); await page.keyboard.press('Control+Shift+a'); await masks(page, [0, 0, 0]);
  const after = await snapshot(page); expect(after.summary.selectionDraft).toBe(false); expect(after.tool).toBe('rectangle');
  // Fresh packed bytes cover the live rendered records above. The actual PLY
  // hashes bracket the draft to retain lossless Gaussian/export-byte equality.
  expect(after.exported).toBe(content.exported);
  expect(after.nativeViewBytes).toEqual(content.nativeViewBytes); expect(after.gpuViewBytes).toEqual(after.nativeViewBytes);
  expect(after.nativeMasks).toEqual([0, 0, 0]); expect(after.gpuMasks).toEqual(after.nativeMasks);
  expect(after.summary.contentRevision).toBe(content.summary.contentRevision);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('desktop Ctrl+I, Ctrl+Shift+A and Ctrl+Y aliases share the edit history', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.geometryViewer.controllerForSourceNavigation().command({ command: 'single', index: 0, operation: 0 }));
  await page.locator('canvas').focus(); await page.keyboard.press('Control+i'); await masks(page, [0, 1, 1]);
  await page.keyboard.press('Control+Shift+a'); await masks(page, [0, 0, 0]);
  await page.keyboard.press('Control+z'); await masks(page, [0, 1, 1]);
  await page.keyboard.press('Control+y'); await masks(page, [0, 0, 0]);
  const beforeRepeat = await snapshot(page);
  await page.locator('canvas').evaluate(canvas => {
    for (const key of ['i', 'a', 'y', 'z']) canvas.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, repeat: true, bubbles: true }));
  });
  expect(await snapshot(page)).toEqual(beforeRepeat);
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
