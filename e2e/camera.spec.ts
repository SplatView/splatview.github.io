import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { gaussianPly } from '../tests/fixtures/gaussians';
import { fixtureCenters } from './sceneCoordinates';
import { chooseSelectionTool } from './selectTool';

async function frames(page: Page) { return Number(await page.getByLabel('SplatView scene').getAttribute('data-frames')); }
async function wakeChrome(page: Page) {
  await page.mouse.move(640, 400); await expect(page.locator('main')).not.toHaveClass(/chrome-hidden/);
}
async function image(page: Page) {
  // Compare rendered scene pixels across focus changes, excluding the canvas's
  // inset keyboard-focus outline along with other DOM-only feedback.
  const bytes = await page.getByLabel('SplatView scene').screenshot({ style: '[data-chrome], .panel, .gesture-overlay, .manual-feedback-root { visibility: hidden !important; } canvas { outline: none !important; }' });
  return createHash('sha256').update(bytes).digest('hex');
}
async function idle(page: Page) {
  let previous = -1, stable = 0;
  await expect.poll(async () => {
    const current = await frames(page); stable = current === previous ? stable + 1 : 0; previous = current; return stable;
  }, { timeout: 5000, intervals: [100] }).toBeGreaterThanOrEqual(3);
  return previous;
}
test.beforeEach(async ({ page }) => {
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  await page.getByLabel('Open scene files').setInputFiles({ name: 'camera-sh3.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(gaussianPly()) });
  await expect(page).toHaveTitle('camera-sh3.ply — SplatView'); await idle(page);
});

test('keyboard flight clears tools and auto orbit, eases on release and sleeps', async ({ page }) => {
  const scene = page.getByLabel('SplatView scene'), original = await image(page);
  await wakeChrome(page); await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await chooseSelectionTool(page, 'Brush');
  await scene.focus(); await page.keyboard.down('w');
  await expect(scene).toHaveAttribute('data-navigation', 'look');
  await expect(page.getByRole('button', { name: 'Selection tool', exact: true }).getByText('Navigate', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Auto orbit', exact: true })).toHaveAttribute('aria-pressed', 'false');
  const first = await frames(page); await expect.poll(() => frames(page)).toBeGreaterThan(first + 2);
  await page.keyboard.up('w'); const released = await frames(page), stopped = await idle(page);
  expect(stopped).toBeGreaterThan(released); expect(await image(page)).not.toBe(original);
  await page.waitForTimeout(200); expect(await frames(page)).toBe(stopped);
  await page.getByRole('button', { name: 'Orbit / Look', exact: true }).click(); await scene.focus();
  await page.keyboard.down('ArrowRight'); await expect.poll(() => frames(page)).toBeGreaterThan(stopped + 2);
  await expect(scene).toHaveAttribute('data-navigation', 'orbit'); await page.keyboard.up('ArrowRight'); await idle(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('blur, focus changes and primary shortcuts cancel held navigation', async ({ page }) => {
  const scene = page.getByLabel('SplatView scene'); await scene.focus();
  await page.keyboard.down('w'); const first = await frames(page); await expect.poll(() => frames(page)).toBeGreaterThan(first + 2);
  await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await page.keyboard.up('w');
  const stopped = await idle(page), stoppedImage = await image(page);
  await page.waitForTimeout(200); expect(await frames(page)).toBe(stopped); expect(await image(page)).toBe(stoppedImage);
  await wakeChrome(page); await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page.getByRole('slider', { name: 'Brightness', exact: true }).focus();
  await page.keyboard.down('w'); await page.waitForTimeout(150); await page.keyboard.up('w'); await idle(page);
  expect(await image(page)).toBe(stoppedImage);
  await scene.focus(); await page.keyboard.down('w'); const moving = await frames(page);
  await expect.poll(() => frames(page)).toBeGreaterThan(moving + 2);
  await page.keyboard.press('ControlOrMeta+s'); await page.keyboard.up('w');
  await expect(page.getByRole('dialog', { name: 'Save scene', exact: true })).toBeVisible();
  const modalStopped = await idle(page); await page.waitForTimeout(200); expect(await frames(page)).toBe(modalStopped);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('wheel motion remains eased and Alt wheel scales the brush without navigation', async ({ page }) => {
  const scene = page.getByLabel('SplatView scene'), original = await image(page);
  await scene.hover(); await page.mouse.wheel(0, -100); const first = await frames(page);
  await expect.poll(() => frames(page), { intervals: [20] }).toBeGreaterThan(first + 2);
  const moving = await frames(page); await expect.poll(() => frames(page), { intervals: [20] }).toBeGreaterThan(moving + 2);
  await idle(page); const zoomed = await image(page); expect(zoomed).not.toBe(original);
  await wakeChrome(page); await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await chooseSelectionTool(page, 'Brush'); await scene.hover();
  await page.keyboard.down('Alt'); await page.mouse.wheel(0, -100); await page.keyboard.up('Alt');
  await expect.poll(async () => Number(await page.getByRole('slider', { name: 'Brush size', exact: true }).getAttribute('value'))).toBeCloseTo(55.2, 5);
  const stopped = await idle(page); expect(await image(page)).toBe(zoomed);
  await page.waitForTimeout(200); expect(await frames(page)).toBe(stopped);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('right click clears selection once while four-pixel jitter and returning drags follow native routing', async ({ page }) => {
  await wakeChrome(page); await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const tools = page.getByRole('complementary', { name: 'Tools', exact: true });
  await page.getByRole('button', { name: 'Select all', exact: true }).click(); await expect(tools.locator('.model-stats')).toHaveText(/^3\/[\d,]+ splats \| SH[0-3]$/);
  const selectedImage = await image(page);
  await page.mouse.move(800, 400); await page.mouse.down({ button: 'right' });
  await page.mouse.move(802, 402); await page.mouse.move(804, 400);
  expect(await image(page)).toBe(selectedImage); await page.mouse.up({ button: 'right' });
  await expect(tools.locator('.model-stats')).toHaveText(/^0\/[\d,]+ splats \| SH[0-3]$/);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(tools.locator('.model-stats')).toHaveText(/^3\/[\d,]+ splats \| SH[0-3]$/);
  await page.mouse.move(800, 400); await page.mouse.down({ button: 'right' }); await page.mouse.move(820, 400);
  expect(await image(page)).not.toBe(selectedImage);
  await page.mouse.move(800, 400); await page.mouse.up({ button: 'right' }); await expect(tools.locator('.model-stats')).toHaveText(/^3\/[\d,]+ splats \| SH[0-3]$/);
  await page.mouse.move(1, 400); await page.mouse.down({ button: 'right' }); await page.mouse.move(-1, 400); await page.mouse.up({ button: 'right' });
  await expect(tools.locator('.model-stats')).toHaveText(/^3\/[\d,]+ splats \| SH[0-3]$/);
  await page.mouse.move(800, 400); await page.mouse.down({ button: 'right' });
  await page.getByLabel('SplatView scene').dispatchEvent('lostpointercapture'); await page.mouse.up({ button: 'right' });
  await expect(tools.locator('.model-stats')).toHaveText(/^3\/[\d,]+ splats \| SH[0-3]$/);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(tools.locator('.model-stats')).toHaveText(/^0\/[\d,]+ splats \| SH[0-3]$/);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled(); await expect(page.getByRole('alert')).toHaveCount(0);
});

test('right-click clearing rejects a changed native revision and right press cancels a polygon without panning', async ({ page }) => {
  const [center] = await fixtureCenters(page); await wakeChrome(page); await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const tools = page.getByRole('complementary', { name: 'Tools', exact: true });
  await chooseSelectionTool(page, 'Single splat'); await page.mouse.click(center[0], center[1]);
  await expect(tools.locator('.model-stats')).toHaveText(/^1\/[\d,]+ splats \| SH[0-3]$/); await page.getByRole('button', { name: 'Select all', exact: true }).click(); await expect(tools.locator('.model-stats')).toHaveText(/^3\/[\d,]+ splats \| SH[0-3]$/);
  await page.mouse.move(800, 400); await page.mouse.down({ button: 'right' }); await page.keyboard.press('ControlOrMeta+z');
  await expect(tools.locator('.model-stats')).toHaveText(/^1\/[\d,]+ splats \| SH[0-3]$/); await page.mouse.up({ button: 'right' }); await expect(tools.locator('.model-stats')).toHaveText(/^1\/[\d,]+ splats \| SH[0-3]$/);
  await chooseSelectionTool(page, 'Polygon');
  await page.mouse.click(500, 250); await page.mouse.click(800, 250);
  const before = await image(page); await page.mouse.move(800, 400); await page.mouse.down({ button: 'right' });
  await page.mouse.move(850, 450); await page.mouse.up({ button: 'right' });
  await expect(page.locator('.gesture-overlay > polyline')).toHaveCount(0); await expect(tools.locator('.model-stats')).toHaveText(/^1\/[\d,]+ splats \| SH[0-3]$/);
  expect(await image(page)).toBe(before); await expect(page.getByRole('alert')).toHaveCount(0);
});

test('middle drag rotates the native orbit and pointer press stops a queued wheel tail', async ({ page }) => {
  const original = await image(page); await page.mouse.move(800, 400); await page.mouse.down({ button: 'middle' });
  await page.mouse.move(850, 430); await page.mouse.up({ button: 'middle' }); await idle(page);
  const orbited = await image(page); expect(orbited).not.toBe(original);
  await page.getByRole('button', { name: 'Reset camera', exact: true }).click();
  await page.mouse.move(800, 400); await page.mouse.down(); await page.mouse.move(850, 430); await page.mouse.up(); await idle(page);
  expect(await image(page)).toBe(orbited);
  await page.mouse.wheel(0, -100); const first = await frames(page);
  await expect.poll(() => frames(page), { intervals: [20] }).toBeGreaterThan(first + 1);
  await page.mouse.down(); await page.mouse.up(); const stopped = await idle(page);
  await page.waitForTimeout(200); expect(await frames(page)).toBe(stopped);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('doubleclick focuses an eligible contributor and leaves empty or distant centers unchanged', async ({ page }) => {
  const [center] = await fixtureCenters(page), scene = page.getByLabel('SplatView scene');
  await wakeChrome(page); await page.getByRole('button', { name: 'Orbit / Look', exact: true }).click(); const original = await image(page);
  await page.mouse.dblclick(30, 700); await idle(page); await expect(scene).toHaveAttribute('data-navigation', 'look');
  expect(await image(page)).toBe(original);
  await page.mouse.dblclick(center[0] + 12, center[1]); await idle(page); await expect(scene).toHaveAttribute('data-navigation', 'look');
  expect(await image(page)).toBe(original);
  await page.mouse.dblclick(center[0], center[1]); await expect(scene).toHaveAttribute('data-navigation', 'orbit'); await idle(page);
  expect(await image(page)).not.toBe(original); await expect(page).toHaveTitle('camera-sh3.ply — SplatView');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a selection tool owns doubleclick and prevents changing the camera pivot', async ({ page }) => {
  const [center] = await fixtureCenters(page), original = await image(page);
  await wakeChrome(page); await page.getByRole('button', { name: 'Tools', exact: true }).click(); await chooseSelectionTool(page, 'Single splat');
  await page.mouse.dblclick(center[0], center[1]); await expect(page.getByRole('complementary', { name: 'Tools', exact: true }).locator('.model-stats')).toHaveText(/^1\/[\d,]+ splats \| SH[0-3]$/);
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click(); await idle(page);
  expect(await image(page)).toBe(original); await expect(page.getByRole('alert')).toHaveCount(0);
});

test('polygon doubleclick commits one history entry and preserves the view', async ({ page }) => {
  const original = await image(page); await wakeChrome(page); await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await chooseSelectionTool(page, 'Polygon');
  for (const [x, y] of [[300, 180], [900, 180], [900, 650]]) await page.mouse.click(x, y);
  await page.mouse.dblclick(300, 650);
  const tools = page.getByRole('complementary', { name: 'Tools', exact: true });
  await expect(tools.locator('.model-stats')).toHaveText(/^3\/[\d,]+ splats \| SH[0-3]$/); await expect(page.locator('.gesture-overlay > polyline')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(tools.locator('.model-stats')).toHaveText(/^0\/[\d,]+ splats \| SH[0-3]$/);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled(); await idle(page);
  expect(await image(page)).toBe(original); await expect(page.getByRole('alert')).toHaveCount(0);
});

test.describe('Retina navigation', () => {
  test.use({ deviceScaleFactor: 2 });
  test('uses CSS-pixel pan thresholds and DPR-scaled doubleclick contributor coordinates', async ({ page }) => {
    const [center] = await fixtureCenters(page), scene = page.getByLabel('SplatView scene'), original = await image(page);
    await page.mouse.move(800, 400); await page.mouse.down({ button: 'right' }); await page.mouse.move(804, 400);
    expect(await image(page)).toBe(original); await page.mouse.up({ button: 'right' });
    await page.getByRole('button', { name: 'Orbit / Look', exact: true }).click();
    await page.mouse.dblclick(center[0] + 12, center[1]); await idle(page); await expect(scene).toHaveAttribute('data-navigation', 'look');
    await page.mouse.dblclick(center[0], center[1]); await expect(scene).toHaveAttribute('data-navigation', 'orbit');
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
});
