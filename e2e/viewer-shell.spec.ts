import { expect, test, type Page } from '@playwright/test';
import type {} from './geometry-viewer-harness';
import { gaussianPly } from '../tests/fixtures/gaussians';

// Current Windows src/app_ui.cpp:1461–1499 and the retained toolbar contract.
// These UI contracts use the real App, worker, native decoder and GPU.
const groups = [
  // Browser folder acquisition and remembered views live in Settings;
  // retain the desktop order and target sizes for the remaining controls.
  ['Scene files', ['Open scene', 'Save scene', 'Capture image', 'Copy image']],
  ['View navigation', ['Reset camera', 'Orbit / Look', 'Auto orbit', 'Flip up', 'Viewport guides', 'Background']],
  ['Lens and display', ['Narrower lens', 'Wider lens', 'Fullscreen']],
  ['Viewer panel', ['Tools']],
] as const;
async function wake(page: Page) {
  await page.mouse.move(8, 300); await page.mouse.move(9, 300);
  await expect(page.locator('main')).not.toHaveClass(/chrome-hidden/);
  await expect(page.getByRole('toolbar', { name: 'Scene controls' })).toHaveCSS('opacity', '1');
}

test('desktop shell groups its toolbar and opens a real scene from the empty primary action', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/');
  const open = page.getByRole('button', { name: 'Choose a scene file', exact: true });
  await expect(open).toBeEnabled();
  await expect(page.getByRole('heading', { name: 'Your scene, in focus.', exact: true })).toHaveCount(0);
  await expect(page.getByText('Drop a Gaussian splat file to begin.', { exact: true })).toBeVisible();
  await expect(page.locator('.empty-state').getByText('Memory and GPU limits apply', { exact: true })).toHaveCount(0);
  const example = page.getByRole('button', { name: 'Open example', exact: true });
  await expect(example).toBeEnabled();
  expect(await open.boundingBox()).toMatchObject({ width: 154, height: 28 });
  const openBounds = (await open.boundingBox())!, exampleBounds = (await example.boundingBox())!;
  expect(exampleBounds).toMatchObject({ width: openBounds.width, height: 28, y: openBounds.y });
  expect(exampleBounds.x - openBounds.x - openBounds.width).toBe(6);
  await expect(open).toHaveCSS('background-color', 'rgb(184, 184, 184)');
  await expect(open.locator('.icon')).toHaveCSS('width', '18px');
  const toolbar = page.getByRole('toolbar', { name: 'Scene controls' });
  const boxes = [];
  for (const [name, labels] of groups) {
    const group = toolbar.getByRole('group', { name, exact: true });
    expect(await group.getByRole('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')))).toEqual(labels);
    const bounds = (await group.boundingBox())!; boxes.push(bounds);
    expect(bounds.width).toBe(labels.length * 36); expect(bounds.height).toBe(36);
    for (const label of labels) expect(await group.getByRole('button', { name: label, exact: true }).boundingBox()).toMatchObject({ width: 36, height: 36 });
  }
  expect(boxes[0]).toMatchObject({ x: 12, y: 12 });
  for (let i = 1; i < boxes.length; i++) expect(boxes[i].x - boxes[i - 1].x - boxes[i - 1].width).toBe(6);
  // Desktop supplies paint defaults for the two fullscreen SVGs without attributes.
  const fullscreen = toolbar.getByRole('button', { name: 'Fullscreen', exact: true });
  await expect(fullscreen.locator('.icon')).toHaveCSS('width', '22px');
  await expect(fullscreen.locator('path')).toHaveCSS('stroke', 'rgb(168, 168, 168)');
  await expect(fullscreen.locator('path')).toHaveCSS('stroke-width', '2px');
  await expect(fullscreen.locator('path')).toHaveCSS('stroke-linecap', 'round');
  const brand = page.getByRole('link', { name: 'OpsiClear website', exact: true });
  expect(await brand.boundingBox()).toMatchObject({ x: 4, y: 1028, width: 48, height: 48 });
  expect(await brand.locator('img').boundingBox()).toMatchObject({ x: 12, y: 1036, width: 32, height: 32 });
  await expect(brand).toHaveAttribute('href', 'https://opsiclear.com');
  await expect(brand).toHaveAttribute('rel', 'noopener noreferrer');
  await wake(page); await page.screenshot({ path: testInfo.outputPath('actual-app-empty-1920x1080.png') });
  const choosing = page.waitForEvent('filechooser'); await open.click();
  await (await choosing).setFiles({ name: 'primary-open.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(gaussianPly()) });
  await expect(page).toHaveTitle('primary-open.ply — SplatView');
  await expect(open).toHaveCount(0); await expect(page.getByRole('alert')).toHaveCount(0);
});

// web-lite has no Pro mode (processing.advanced and the Pro sections are excluded).
test('desktop-ordered Basic controls preserve the real edited document and executable Redo', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/e2e/geometry-viewer-harness.html');
  await page.waitForFunction(() => window.geometryViewerError || window.geometryViewer?.ready());
  expect(await page.evaluate(() => window.geometryViewerError)).toBeUndefined();
  await page.evaluate(async () => {
    await window.geometryViewer.load('gaussian');
    const app = window.geometryViewer.controllerForSourceNavigation();
    const { useApp } = await import(/* @vite-ignore */ performance.getEntriesByType('resource').map(entry => entry.name)
      .find(name => new URL(name).pathname === '/src/app/store.ts') ?? new URL('../src/app/store.ts', location.href).href) as typeof import('../src/app/store');
    // A selection change queues a short automatic pivot query that owns busy;
    // require color controls to stay ready across a pause before editing.
    const ready = () => !useApp.getState().busy && !useApp.getState().transformPivotPending && app.colorControlsEnabled;
    const idle = async () => {
      const started = performance.now();
      while (!ready() || (await new Promise(resolve => setTimeout(resolve, 50)), !ready())) {
        if (performance.now() - started > 10_000) throw new Error('The editor did not become idle.');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    await app.command({ command: 'selectAll' }); await idle();
    const values = [1.2, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    if (!await app.command({ command: 'grade', values })) throw new Error('First edit failed');
    await idle(); values[0] = 1.5;
    if (!await app.command({ command: 'grade', values })) throw new Error('Redo fixture failed');
    await idle(); if (!await app.command({ command: 'undo' })) throw new Error('Redo fixture failed');
    await idle();
  });
  await wake(page); await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const before = await page.evaluate(() => window.geometryViewer.snapshot());
  expect(before.dirty).toBe(true); expect(before.summary.canRedo).toBe(true);
  const panel = page.getByRole('complementary', { name: 'Tools', exact: true });
  await expect(panel.locator('.mode-button')).toBeHidden();
  {
    const headings = panel.getByRole('heading', { level: 2 });
    await expect(headings).toHaveCount(3);
    for (const [index, title] of ['Selection', 'Transform', 'Color'].entries())
      await expect(headings.nth(index)).toHaveAccessibleName(title);
    const undo = (await panel.getByRole('button', { name: 'Undo', exact: true }).boundingBox())!;
    const redo = (await panel.getByRole('button', { name: 'Redo', exact: true }).boundingBox())!;
    expect(undo.width).toBe(24); expect(redo.x).toBe(undo.x + undo.width);
    await expect(panel.getByRole('button', { name: 'Undo', exact: true }).locator('.icon')).toHaveCSS('width', '16px');
    await wake(page); await page.screenshot({ path: testInfo.outputPath('actual-app-basic-1920x1080.png') });
    expect(await page.evaluate(() => window.geometryViewer.snapshot())).toEqual(before);
  }
  await panel.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  const redone = await page.evaluate(() => window.geometryViewer.snapshot());
  expect(redone.exported).not.toBe(before.exported);
  await panel.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.geometryViewer.snapshot())).toEqual({ ...before,
    summary: { ...before.summary, revision: before.summary.revision + 2 } });
  await expect(page.getByRole('alert')).toHaveCount(0);
});

for (const size of ['small', 'large'] as const) test(`${size} controls wrap without overlapping the Tools panel in narrow browser windows`, async ({ page }) => {
  await page.addInitScript(size => localStorage.setItem('splatview.ui-size.v1', size), size);
  await page.setViewportSize({ width: 640, height: 800 });
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  await page.getByLabel('Open scene files').setInputFiles({ name: 'narrow-shell.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(gaussianPly()) });
  await expect(page).toHaveTitle('narrow-shell.ply — SplatView');
  await wake(page); await page.getByRole('button', { name: 'Tools', exact: true }).click();
  for (const width of [640, 400, 360]) {
    await page.setViewportSize({ width, height: 800 }); await wake(page);
    const panel = (await page.getByRole('complementary', { name: 'Tools', exact: true }).boundingBox())!;
    const buttons = await page.getByRole('toolbar', { name: 'Scene controls' }).getByRole('button').evaluateAll(elements => elements.map(element => {
      const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    }));
    expect(buttons).toHaveLength(14);
    for (const button of buttons) {
      expect(button.x).toBeGreaterThanOrEqual(0); expect(button.y).toBeGreaterThanOrEqual(0);
      expect(button.right).toBeLessThanOrEqual(panel.x); expect(button.bottom).toBeLessThanOrEqual(800);
      expect(button.width).toBe(36); expect(button.height).toBe(36);
    }
    expect(panel.x + panel.width).toBeLessThanOrEqual(width);
  }
  await expect(page.getByRole('alert')).toHaveCount(0);
});
