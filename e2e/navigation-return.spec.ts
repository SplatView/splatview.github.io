import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { gaussianPly } from '../tests/fixtures/gaussians';
import { chooseSelectionTool } from './selectTool';

// Frozen app_ui.cpp:800–805 chooses Orbit when a manual tool is armed or
// Look is active. viewer.cpp:343–347 clears the armed tool on that route.
const manualTools = ['Single splat', 'Brush', 'Volume brush', 'Box select', 'Polygon', 'Color picker', 'Fill'];
const tools = (page: Page) => page.getByRole('complementary', { name: 'Tools', exact: true });
const navigation = (page: Page) => page.getByRole('button', { name: 'Orbit / Look', exact: true });
const scene = (page: Page) => page.getByLabel('SplatView scene', { exact: true });

async function exported(page: Page) {
  await page.getByRole('button', { name: 'Save scene', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Save scene', exact: true });
  await dialog.getByLabel('Export format', { exact: true }).selectOption('0');
  const pending = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download', exact: true }).click();
  const download = await pending, path = await download.path();
  expect(path).not.toBeNull(); const bytes = await readFile(path!);
  await page.getByRole('status').filter({ hasText: 'Download prepared' }).getByRole('button', { name: 'Stay', exact: true }).click();
  return bytes;
}

async function assertOrbit(page: Page, mode: 'basic' | 'pro') {
  await expect(scene(page)).toHaveAttribute('data-navigation', 'orbit');
  await expect(navigation(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Auto orbit', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(tools(page).getByRole('button', { name: 'Selection tool', exact: true }).getByText('Navigate', { exact: true })).toBeVisible();
  if (mode === 'basic') await expect(tools(page).getByRole('button', { name: 'Selection filter', exact: true })).toHaveCount(0);
}

for (const mode of ['basic', 'pro'] as const) test(`${mode} toolbar returns all seven manual tools and an unfinished polygon to Orbit without changing native data or Redo`, async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(mode => localStorage.setItem('splatview.tools-mode.v1', mode), mode);
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  await page.getByLabel('Open scene files').setInputFiles({ name: 'navigation-sh3.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(gaussianPly()) });
  await expect(page).toHaveTitle('navigation-sh3.ply \u2014 SplatView');
  await page.mouse.move(640, 400); await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const original = await exported(page);
  await tools(page).getByRole('button', { name: 'Select all', exact: true }).click();
  await expect(tools(page).locator('.model-stats')).toHaveText('3/3 splats | SH3');
  await tools(page).getByRole('button', { name: 'Invert selection', exact: true }).click();
  await expect(tools(page).locator('.model-stats')).toHaveText('0/3 splats | SH3');
  await tools(page).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(tools(page).locator('.model-stats')).toHaveText('3/3 splats | SH3');
  await expect(tools(page).getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  for (const tool of manualTools) {
    await chooseSelectionTool(page, tool);
    await expect(navigation(page)).toHaveAttribute('aria-pressed', 'false');
    await navigation(page).click(); await assertOrbit(page, mode);
    await expect(tools(page).locator('.model-stats')).toHaveText('3/3 splats | SH3');
    await expect(tools(page).getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
    await navigation(page).click(); await expect(scene(page)).toHaveAttribute('data-navigation', 'look');
    await navigation(page).click(); await assertOrbit(page, mode);
  }
  // Native point alignment is separate from selectionTool(), so navigation
  // still enters Look when it cancels an armed alignment action.
  await tools(page).getByRole('button', { name: 'Alignment', exact: true }).click();
  await page.getByRole('menu', { name: 'Alignment actions', exact: true }).getByRole('menuitemradio', { name: '1-point center', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Alignment action', exact: true })).toBeVisible();
  await navigation(page).click(); await expect(scene(page)).toHaveAttribute('data-navigation', 'look');
  await expect(page.getByRole('region', { name: 'Alignment action', exact: true })).toHaveCount(0);
  await expect(tools(page).getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  await navigation(page).click(); await assertOrbit(page, mode);
  await chooseSelectionTool(page, 'Polygon');
  const live = tools(page).getByRole('group', { name: 'Options', exact: true }).getByRole('button', { name: 'Live selection', exact: true });
  if (await live.getAttribute('aria-pressed') !== 'true') await live.click();
  for (const [x, y] of [[300, 180], [900, 180], [900, 650]]) await page.mouse.click(x, y);
  await expect(page.locator('.gesture-overlay > polyline')).toHaveCount(1);
  await navigation(page).click(); await assertOrbit(page, mode);
  await expect(page.locator('.gesture-overlay > polyline')).toHaveCount(0);
  await expect(tools(page).locator('.model-stats')).toHaveText('3/3 splats | SH3');
  await tools(page).getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(tools(page).locator('.model-stats')).toHaveText('0/3 splats | SH3');
  await tools(page).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(tools(page).locator('.model-stats')).toHaveText('3/3 splats | SH3');
  expect((await exported(page)).equals(original)).toBe(true);
  await expect(page.getByRole('alert')).toHaveCount(0); expect(errors).toEqual([]);
  await info.attach('native-navigation-return.json', { body: JSON.stringify({ mode, tools: manualTools, alignmentCancelledToLook: true, polygonCancelled: true, redoExecuted: true, fullSh3ExportUnchanged: true }), contentType: 'application/json' });
});
