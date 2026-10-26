import { test, expect, type Page } from './backend-test';
import { gaussianPly } from '../tests/fixtures/gaussians';
import { chooseSelectionTool } from './selectTool';
async function setOption(page: Page, name: string, pressed: boolean) {
  const button = page.getByRole('group', { name: 'Options', exact: true }).getByRole('button', { name, exact: true });
  if (await button.getAttribute('aria-pressed') !== String(pressed)) await button.click();
  await expect(button).toHaveAttribute('aria-pressed', String(pressed));
}

test('real worker/WASM/GPU editor: open, select, grade, undo and export', async ({ page }) => {
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  await page.getByLabel('Open scene files').setInputFiles({ name: 'fixture-sh3.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(gaussianPly()) });
  await expect(page.locator('.status.panel').filter({ hasText: /Preparing|Opening|Decoding/ })).toHaveCount(0);
  await expect(page).toHaveTitle('fixture-sh3.ply — SplatView');
  await page.mouse.move(640, 400);
  await expect(page.locator('main')).not.toHaveClass(/chrome-hidden/);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Tools', exact: true }).locator('.model-stats')).toHaveText('0/3 splats | SH3');
  await page.getByRole('button', { name: 'Select all', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Tools', exact: true }).locator('.model-stats')).toHaveText(/^3\/[\d,]+ splats \| SH[0-3]$/);
  await page.getByRole('slider', { name: 'Brightness', exact: true }).fill('1.5');
  await page.getByRole('button', { name: 'Apply color', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply color', exact: true })).toBeHidden();
  await expect(page).toHaveTitle('• fixture-sh3.ply — SplatView');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page).toHaveTitle('fixture-sh3.ply — SplatView');
  await page.getByRole('button', { name: 'Save scene', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('fixture-sh3-edited.ply');
  await expect(page.getByRole('alert')).toHaveCount(0); expect(failures).toEqual([]);
});

test('native toolbar geometry and a scheduler that sleeps when idle', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  const button = await page.getByRole('button', { name: 'Open scene', exact: true }).boundingBox();
  expect(button?.x).toBe(12); expect(button?.y).toBe(12); expect(button?.width).toBe(36); expect(button?.height).toBe(36);
  // Ready can precede ResizeObserver's final initialization frame. Require
  // bounded quiescence first; a continuously drawing scheduler still fails.
  let previous: string | null = null, stableSince = 0;
  await expect.poll(async () => {
    const current = await page.getByLabel('SplatView scene').getAttribute('data-frames');
    if (!current || current !== previous) { previous = current; stableSince = Date.now(); return false; }
    return Date.now() - stableSince >= 250;
  }, { timeout: 5_000, intervals: [25, 50] }).toBe(true);
  const frames = await page.getByLabel('SplatView scene').getAttribute('data-frames');
  await page.waitForTimeout(250);
  expect(await page.getByLabel('SplatView scene').getAttribute('data-frames')).toBe(frames);
  await page.screenshot({ path: testInfo.outputPath('desktop-toolbar.png') });
  await page.getByLabel('Open scene files').setInputFiles({ name: 'idle-toolbar.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(gaussianPly()) });
  await expect(page).toHaveTitle('idle-toolbar.ply — SplatView');
  await page.mouse.move(640, 400);
  await expect(page.locator('main')).toHaveClass(/chrome-hidden/);
  const toolsButton = page.getByRole('button', { name: 'Tools', exact: true });
  expect(await page.locator('[data-chrome] button[aria-label="Tools"]').evaluate(element => getComputedStyle(element).pointerEvents)).toBe('none');
  await page.mouse.move(640, 401);
  await expect(page.locator('main')).not.toHaveClass(/chrome-hidden/);
  await toolsButton.click();
  await expect(page.getByRole('complementary', { name: 'Tools', exact: true })).toBeVisible();
});

test('live rectangle shrinks, commits once and cancels on Escape, blur, lost capture or Undo', async ({ page }) => {
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  await page.getByLabel('Open scene files').setInputFiles({ name: 'live-sh3.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(gaussianPly()) });
  await expect(page).toHaveTitle('live-sh3.ply — SplatView');
  await page.mouse.move(640, 400);
  await expect(page.locator('main')).not.toHaveClass(/chrome-hidden/);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const tools = page.getByRole('complementary', { name: 'Tools', exact: true });
  await page.getByRole('button', { name: 'Select all', exact: true }).click(); await expect(tools.locator('.model-stats')).toHaveText(/^3\/[\d,]+ splats \| SH[0-3]$/);
  await chooseSelectionTool(page, 'Box select');
  await page.getByRole('button', { name: 'Replace', exact: true }).click();
  await setOption(page, 'Include splat edges', false); await setOption(page, 'Live selection', true);
  await page.mouse.move(300, 200); await page.mouse.down(); await page.mouse.move(900, 650, { steps: 5 });
  await expect(page.locator('.status.panel')).toHaveCount(0);
  await page.mouse.move(420, 280, { steps: 3 }); await expect(tools.locator('.model-stats')).toHaveText(/^0\/[\d,]+ splats \| SH[0-3]$/);
  await page.mouse.up(); await expect(page.locator('.status.panel')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(tools.locator('.model-stats')).toHaveText(/^3\/[\d,]+ splats \| SH[0-3]$/);
  await expect(page.getByRole('button', { name: 'Selection tool', exact: true })).toBeEnabled();
  for (const cancel of ['escape', 'blur', 'capture', 'undo'] as const) {
    await expect(page.getByRole('button', { name: 'Selection tool', exact: true })).toBeEnabled();
    await page.mouse.move(300, 200); await page.mouse.down(); await page.mouse.move(420, 280, { steps: 3 });
    await expect(tools.locator('.model-stats')).toHaveText(/^0\/[\d,]+ splats \| SH[0-3]$/);
    if (cancel === 'escape') await page.keyboard.press('Escape');
    else if (cancel === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    else if (cancel === 'capture') await page.getByLabel('SplatView scene').dispatchEvent('lostpointercapture');
    else await page.keyboard.press('ControlOrMeta+z');
    await page.mouse.up(); await expect(tools.locator('.model-stats')).toHaveText(/^3\/[\d,]+ splats \| SH[0-3]$/);
    await expect(page.locator('.gesture-overlay > rect')).toHaveCount(0);
    if (cancel === 'escape') await chooseSelectionTool(page, 'Box select');
    await expect(page.getByRole('button', { name: 'Selection tool', exact: true })).toBeEnabled();
  }
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await page.keyboard.press('ControlOrMeta+z'); await expect(tools.locator('.model-stats')).toHaveText(/^0\/[\d,]+ splats \| SH[0-3]$/);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Selection tool', exact: true })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('live polygon supports Backspace, Enter, Escape and one history entry', async ({ page }) => {
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  await page.getByLabel('Open scene files').setInputFiles({ name: 'polygon-sh3.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(gaussianPly()) });
  await expect(page).toHaveTitle('polygon-sh3.ply — SplatView');
  await page.mouse.move(640, 400);
  await expect(page.locator('main')).not.toHaveClass(/chrome-hidden/);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const tools = page.getByRole('complementary', { name: 'Tools', exact: true });
  await chooseSelectionTool(page, 'Polygon');
  await setOption(page, 'Live selection', true);
  const outline = [[300, 180], [900, 180], [900, 650], [300, 650]];
  for (const [x, y] of outline) { await page.mouse.click(x, y); await expect(page.locator('.status.panel')).toHaveCount(0); }
  await expect(tools.locator('.model-stats')).toHaveText(/^3\/[\d,]+ splats \| SH[0-3]$/); await page.keyboard.press('Backspace');
  // Backspace removes the committed vertex; the cursor still previews its current position.
  await expect(page.locator('.gesture-overlay polyline')).toHaveAttribute('points', outline.map(point => point.join(',')).join(' '));
  await page.mouse.move(...outline[2] as [number, number]);
  await expect(page.locator('.gesture-overlay polyline')).toHaveAttribute('points', outline.slice(0, -1).map(point => point.join(',')).join(' '));
  await page.keyboard.press('Escape'); await expect(tools.locator('.model-stats')).toHaveText(/^0\/[\d,]+ splats \| SH[0-3]$/);
  await chooseSelectionTool(page, 'Polygon');
  for (const [x, y] of outline) { await page.mouse.click(x, y); await expect(page.locator('.status.panel')).toHaveCount(0); }
  await expect(tools.locator('.model-stats')).toHaveText(/^3\/[\d,]+ splats \| SH[0-3]$/); await page.keyboard.press('Enter');
  await expect(page.locator('.status.panel')).toHaveCount(0); await expect(page.locator('.gesture-overlay > polyline')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(tools.locator('.model-stats')).toHaveText(/^0\/[\d,]+ splats \| SH[0-3]$/);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Selection tool', exact: true })).toBeEnabled();
  for (const close of ['first point', 'double click'] as const) {
    for (const [x, y] of outline) { await page.mouse.click(x, y); await expect(page.locator('.status.panel')).toHaveCount(0); }
    if (close === 'first point') await page.mouse.click(...outline[0] as [number, number]);
    else await page.mouse.dblclick(500, 500);
    await expect(page.locator('.gesture-overlay > polyline')).toHaveCount(0); await expect(page.locator('.status.panel')).toHaveCount(0);
    await expect(tools.locator('.model-stats')).toHaveText(/^3\/[\d,]+ splats \| SH[0-3]$/);
    await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(tools.locator('.model-stats')).toHaveText(/^0\/[\d,]+ splats \| SH[0-3]$/);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Selection tool', exact: true })).toBeEnabled();
  }
  await expect(page.getByRole('alert')).toHaveCount(0);
});

for (const live of [false, true]) test(`${live ? 'live' : 'deferred'} brush retains the complete stroke and commits one Undo`, async ({ page }) => {
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  await page.getByLabel('Open scene files').setInputFiles({ name: 'brush-sh3.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(gaussianPly()) });
  await expect(page).toHaveTitle('brush-sh3.ply — SplatView');
  await page.mouse.move(640, 400);
  await expect(page.locator('main')).not.toHaveClass(/chrome-hidden/);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const tools = page.getByRole('complementary', { name: 'Tools', exact: true });
  await chooseSelectionTool(page, 'Brush');
  await page.getByRole('slider', { name: 'Brush size', exact: true }).fill('320');
  await setOption(page, 'Live selection', live);
  await page.mouse.move(350, 250); await page.mouse.down();
  for (const [x, y] of [[850, 250], [850, 450], [350, 450], [350, 600], [850, 600], [300, 700]]) await page.mouse.move(x, y, { steps: 2 });
  await expect(tools.locator('.model-stats')).toHaveText(live ? /^3\/[\d,]+ splats \| SH[0-3]$/ : /^0\/[\d,]+ splats \| SH[0-3]$/);
  await page.mouse.up(); await expect(tools.locator('.model-stats')).toHaveText(/^3\/[\d,]+ splats \| SH[0-3]$/);
  await expect(page.locator('.status.panel')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(tools.locator('.model-stats')).toHaveText(/^0\/[\d,]+ splats \| SH[0-3]$/);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Selection tool', exact: true })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
