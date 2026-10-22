import { expect, test, type Page } from '@playwright/test';
import { gaussianPly } from '../tests/fixtures/gaussians';
import { fixtureCenters } from './sceneCoordinates';
import { chooseSelectionTool } from './selectTool';

const toolsPanel = (page: Page) => page.getByRole('complementary', { name: 'Tools', exact: true });
const option = (page: Page, name: string) => toolsPanel(page).getByRole('group', { name: 'Options', exact: true }).getByRole('button', { name, exact: true });
async function setOption(page: Page, name: string, pressed: boolean) {
  const button = option(page, name);
  if (await button.getAttribute('aria-pressed') !== String(pressed)) await button.click();
  await expect(button).toHaveAttribute('aria-pressed', String(pressed));
}
async function ready(page: Page) {
  await expect(page.locator('.status.panel')).toHaveCount(0);
}
async function single(page: Page, live = true) {
  await chooseSelectionTool(page, 'Single splat');
  await setOption(page, 'Live selection', live);
  await page.getByRole('button', { name: 'Replace', exact: true }).click();
}
test.beforeEach(async ({ page }) => {
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  await page.getByLabel('Open scene files').setInputFiles({ name: 'single-sh3.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(gaussianPly()) });
  await expect(page).toHaveTitle('single-sh3.ply — SplatView');
  await page.mouse.move(640, 400); await expect(page.locator('main')).not.toHaveClass(/chrome-hidden/);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
});

test('live Single previews only its press contributor, cancels over five pixels and permits a return before release', async ({ page }) => {
  const [first, second] = await fixtureCenters(page), tools = toolsPanel(page); await single(page);
  await page.mouse.move(...first as [number, number]); await page.mouse.down(); await expect(tools.locator('.model-stats')).toHaveText(/^1\/[\d,]+ splats \| SH[0-3]$/);
  await page.mouse.move(...second as [number, number]); await expect(tools.locator('.model-stats')).toHaveText(/^0\/[\d,]+ splats \| SH[0-3]$/);
  await page.mouse.up(); await ready(page); await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.mouse.move(...first as [number, number]); await page.mouse.down(); await expect(tools.locator('.model-stats')).toHaveText(/^1\/[\d,]+ splats \| SH[0-3]$/);
  await page.mouse.move(...second as [number, number]); await expect(tools.locator('.model-stats')).toHaveText(/^0\/[\d,]+ splats \| SH[0-3]$/);
  await page.mouse.move(first[0] + 4, first[1]); await expect(tools.locator('.model-stats')).toHaveText(/^0\/[\d,]+ splats \| SH[0-3]$/);
  await page.mouse.up(); await expect(tools.locator('.model-stats')).toHaveText(/^1\/[\d,]+ splats \| SH[0-3]$/); await ready(page);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(tools.locator('.model-stats')).toHaveText(/^0\/[\d,]+ splats \| SH[0-3]$/);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled(); await expect(page.getByRole('alert')).toHaveCount(0);
});

test('live Single Escape, blur, lost capture and Undo restore the exact pre-press mask', async ({ page }) => {
  const [center] = await fixtureCenters(page), tools = toolsPanel(page); await single(page);
  await page.getByRole('button', { name: 'Select all', exact: true }).click(); await expect(tools.locator('.model-stats')).toHaveText(/^3\/[\d,]+ splats \| SH[0-3]$/);
  for (const cancel of ['escape', 'blur', 'capture', 'undo'] as const) {
    await page.mouse.move(...center as [number, number]); await page.mouse.down(); await expect(tools.locator('.model-stats')).toHaveText(/^1\/[\d,]+ splats \| SH[0-3]$/);
    if (cancel === 'escape') await page.keyboard.press('Escape');
    else if (cancel === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    else if (cancel === 'capture') await page.getByLabel('SplatView scene').dispatchEvent('lostpointercapture');
    else await page.keyboard.press('ControlOrMeta+z');
    await page.mouse.up(); await expect(tools.locator('.model-stats')).toHaveText(/^3\/[\d,]+ splats \| SH[0-3]$/); await ready(page);
    if (cancel === 'escape') await chooseSelectionTool(page, 'Single splat');
  }
  await page.keyboard.press('ControlOrMeta+z'); await expect(tools.locator('.model-stats')).toHaveText(/^0\/[\d,]+ splats \| SH[0-3]$/);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled(); await expect(page.getByRole('alert')).toHaveCount(0);
});

test('empty live Single follows each native combination and creates history only when the mask changes', async ({ page }) => {
  const tools = toolsPanel(page); await single(page);
  await page.getByRole('button', { name: 'Select all', exact: true }).click(); await expect(tools.locator('.model-stats')).toHaveText(/^3\/[\d,]+ splats \| SH[0-3]$/);
  for (const operation of ['Replace', 'Add', 'Subtract', 'Intersect']) {
    await page.getByRole('button', { name: operation, exact: true }).click();
    await page.mouse.move(400, 700); await page.mouse.down();
    await expect(tools.locator('.model-stats')).toHaveText(operation === 'Add' || operation === 'Subtract' ? /^3\/[\d,]+ splats \| SH[0-3]$/ : /^0\/[\d,]+ splats \| SH[0-3]$/);
    await page.mouse.up(); await ready(page);
    if (operation === 'Replace' || operation === 'Intersect') {
      await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(tools.locator('.model-stats')).toHaveText(/^3\/[\d,]+ splats \| SH[0-3]$/);
    }
  }
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(tools.locator('.model-stats')).toHaveText(/^0\/[\d,]+ splats \| SH[0-3]$/);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled(); await expect(page.getByRole('alert')).toHaveCount(0);
});

test('deferred Single waits for release and uses final displacement tolerance', async ({ page }) => {
  const [center] = await fixtureCenters(page), tools = toolsPanel(page); await single(page, false);
  await page.mouse.move(...center as [number, number]); await page.mouse.down(); await expect(tools.locator('.model-stats')).toHaveText(/^0\/[\d,]+ splats \| SH[0-3]$/);
  await page.mouse.move(center[0] + 10, center[1]); await page.mouse.up(); await ready(page);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.mouse.move(...center as [number, number]); await page.mouse.down(); await page.mouse.move(center[0] + 30, center[1]);
  await page.mouse.move(center[0] + 4, center[1]); await page.mouse.up(); await expect(tools.locator('.model-stats')).toHaveText(/^1\/[\d,]+ splats \| SH[0-3]$/);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(tools.locator('.model-stats')).toHaveText(/^0\/[\d,]+ splats \| SH[0-3]$/);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('the single web-lite profile exposes Basic defaults and keeps selection options per window', async ({ page }) => {
  await chooseSelectionTool(page, 'Single splat');
  await expect(page.getByRole('button', { name: 'Add', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(option(page, 'Visible only')).toHaveCount(0); await expect(option(page, 'Include splat edges')).toHaveCount(0);
  await chooseSelectionTool(page, 'Brush');
  await expect(option(page, 'Visible only')).toHaveAttribute('aria-pressed', 'true'); await expect(option(page, 'Include splat edges')).toHaveAttribute('aria-pressed', 'true');
  await chooseSelectionTool(page, 'Single splat');
  await expect(page.getByRole('slider', { name: 'Temperature', exact: true })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Gamma', exact: true })).toHaveCount(0);
  await expect(toolsPanel(page).locator('.mode-button')).toBeHidden();
  await page.getByRole('button', { name: 'Subtract', exact: true }).click(); await setOption(page, 'Live selection', true);
  await chooseSelectionTool(page, 'Brush'); await setOption(page, 'Include splat edges', false);
  await chooseSelectionTool(page, 'Box select'); await expect(option(page, 'Include splat edges')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', { name: 'Subtract', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.reload(); await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add', exact: true })).toHaveAttribute('aria-pressed', 'true'); await expect(page.getByRole('alert')).toHaveCount(0);
});

// Mode requests during a live gesture are gone: web-lite has no Pro profile (processing.advanced).

test.describe('Retina live Single', () => {
  test.use({ deviceScaleFactor: 2 });
  test('keeps the five-pixel cancellation threshold in CSS coordinates', async ({ page }) => {
    const [center] = await fixtureCenters(page), tools = toolsPanel(page); await single(page);
    await page.mouse.move(...center as [number, number]); await page.mouse.down(); await expect(tools.locator('.model-stats')).toHaveText(/^1\/[\d,]+ splats \| SH[0-3]$/);
    await page.mouse.move(center[0] + 4, center[1]); await expect(tools.locator('.model-stats')).toHaveText(/^1\/[\d,]+ splats \| SH[0-3]$/);
    await page.mouse.move(center[0] + 6, center[1]); await expect(tools.locator('.model-stats')).toHaveText(/^0\/[\d,]+ splats \| SH[0-3]$/);
    await page.mouse.up(); await ready(page); await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
});
