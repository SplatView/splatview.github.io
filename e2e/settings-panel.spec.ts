import { expect, test, type Page } from '@playwright/test';
import { chooseSelectionTool } from './selectTool';
import type {} from './geometry-viewer-harness';

const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings', exact: true });
async function load(page: Page) {
  await page.goto('/e2e/geometry-viewer-harness.html');
  await page.waitForFunction(() => window.geometryViewerError || window.geometryViewer?.ready());
  expect(await page.evaluate(() => window.geometryViewerError)).toBeUndefined();
  await page.evaluate(() => window.geometryViewer.load('gaussian'));
  // Readiness can outlast the toolbar's idle timer. Wake it as a user would.
  await page.mouse.move(20, 200);
  await expect(page.locator('main')).not.toHaveClass(/chrome-hidden/);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
}

for (const [size, width, left] of [['small', 300, 656], ['medium', 336, 584], ['large', 375, 506]] as const) {
  test(`${size} Settings follows desktop floating geometry with and without Tools`, async ({ page }) => {
    await page.addInitScript(size => localStorage.setItem('splatview.ui-size.v1', size), size);
    await page.setViewportSize({ width: 1280, height: 720 }); await load(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = settings(page), tools = (await page.getByRole('complementary', { name: 'Tools', exact: true }).boundingBox())!;
    const bounds = (await dialog.boundingBox())!;
    expect(bounds).toMatchObject({ x: left, y: 12, width });
    expect(tools.x - bounds.x - bounds.width).toBe(12);
    await expect(page.locator('.settings-backdrop')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(dialog).toHaveCSS('padding', '6px 12px');
    const tabs = dialog.getByRole('tablist', { name: 'Settings sections', exact: true });
    const boxes = [];
    for (const name of ['General', 'Privacy', 'Help']) boxes.push((await tabs.getByRole('tab', { name, exact: true }).boundingBox())!);
    for (const box of boxes) expect(box.height).toBe(24);
    for (let i = 1; i < boxes.length; i++) expect(boxes[i].x).toBeCloseTo(boxes[i - 1].x + boxes[i - 1].width, 1);
    // All tab references remain valid while inactive page contents are unmounted.
    for (const tab of await tabs.getByRole('tab').all()) {
      const target = await tab.getAttribute('aria-controls');
      await expect(page.locator(`[id="${target}"]`)).toHaveCount(1);
    }
    await dialog.getByRole('button', { name: 'Close Settings', exact: true }).click();
    await page.evaluate(() => window.geometryViewer.load('points'));
    await expect(page.getByRole('complementary', { name: 'Tools', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    expect(await dialog.boundingBox()).toMatchObject({ x: 12, y: 12, width });
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
}

test('changing Settings tabs cancels a real font preview and keeps the active page on reopen', async ({ page }) => {
  await load(page); await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = settings(page), before = await page.evaluate(() => window.geometryViewer.snapshot());
  await dialog.getByRole('button', { name: 'Font size', exact: true }).click();
  await page.getByRole('listbox', { name: 'Font size choices', exact: true }).getByRole('option', { name: 'Large', exact: true }).hover();
  await expect(page.locator('main')).toHaveAttribute('data-ui-size', 'large');
  await dialog.getByRole('tab', { name: 'Privacy', exact: true }).click();
  await expect(dialog.getByRole('tabpanel', { name: 'Privacy', exact: true })).toBeVisible();
  await expect(page.getByRole('listbox', { name: 'Font size choices', exact: true })).toHaveCount(0);
  await expect(page.locator('main')).toHaveAttribute('data-ui-size', 'small');
  expect(await page.evaluate(() => localStorage.getItem('splatview.ui-size.v1'))).toBeNull();
  await expect(dialog.getByRole('button', { name: 'Font size', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.geometryViewer.snapshot())).toEqual(before);
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  const opener = page.getByRole('button', { name: 'Settings', exact: true }); await expect(opener).toBeFocused();
  await opener.click(); await expect(dialog.getByRole('tab', { name: 'Privacy', exact: true })).toHaveAttribute('aria-selected', 'true');
  await dialog.getByRole('tab', { name: 'General', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Font size', exact: true })).toHaveAttribute('aria-description', 'Current size: Small');
});

test('short windows keep Settings header and tabs fixed while the active page scrolls', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('splatview.ui-size.v1', 'large'));
  await page.setViewportSize({ width: 360, height: 240 }); await load(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = settings(page); expect(await dialog.boundingBox()).toMatchObject({ x: 12, y: 12, width: 336 });
  await dialog.getByRole('tab', { name: 'Help', exact: true }).click();
  const header = dialog.locator('.panel-heading'), tabs = dialog.getByRole('tablist'), content = dialog.getByRole('tabpanel', { name: 'Help', exact: true });
  const before = { header: await header.boundingBox(), tabs: await tabs.boundingBox() };
  expect(await content.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await content.evaluate(element => { element.scrollTop = element.scrollHeight; });
  expect(await content.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  expect({ header: await header.boundingBox(), tabs: await tabs.boundingBox() }).toEqual(before);
  await expect(content.getByText('Move with W/A/S/D, Q/E or Space; use arrows to turn. Hold Shift to move faster or Alt to move slowly.', { exact: true })).toBeInViewport();
  const bounds = (await dialog.boundingBox())!; expect(bounds.y + bounds.height).toBeLessThanOrEqual(228);
  await dialog.getByRole('tab', { name: 'Privacy', exact: true }).click();
  await dialog.getByRole('tab', { name: 'Help', exact: true }).click();
  expect(await content.evaluate(element => element.scrollTop)).toBe(0);
  await expect(header.getByRole('button', { name: 'Close Settings', exact: true })).toBeInViewport();
});

test('transparent Settings shield blocks Alt-wheel and outside drag from changing the scene or brush', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 }); await load(page);
  await chooseSelectionTool(page, 'Brush');
  const brush = page.getByRole('slider', { name: 'Brush size', exact: true }), size = await brush.inputValue();
  const before = await page.evaluate(() => window.geometryViewer.snapshot());
  const opener = page.getByRole('button', { name: 'Settings', exact: true });
  for (const button of ['left', 'right'] as const) {
    await opener.click(); await expect(settings(page)).toBeVisible();
    await page.mouse.move(400, 300); await page.keyboard.down('Alt'); await page.mouse.wheel(0, 300); await page.keyboard.up('Alt');
    await expect(brush).toHaveValue(size); expect(await page.evaluate(() => window.geometryViewer.snapshot())).toEqual(before);
    await page.mouse.down({ button }); await page.mouse.move(450, 350, { steps: 5 }); await page.mouse.up({ button });
    await expect(settings(page)).toHaveCount(0); await expect(opener).toBeFocused();
    await expect(brush).toHaveValue(size); expect(await page.evaluate(() => window.geometryViewer.snapshot())).toEqual(before);
  }
  await expect(page.getByRole('alert')).toHaveCount(0);
});
