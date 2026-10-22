import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { gaussianPly } from '../tests/fixtures/gaussians';

async function open(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  await page.getByLabel('Open scene files').setInputFiles({ name: 'export-sh3.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(gaussianPly()) });
  await expect(page).toHaveTitle('export-sh3.ply — SplatView');
  await page.mouse.move(640, 400);
  await expect(page.locator('main')).not.toHaveClass(/chrome-hidden/);
}
async function dialog(page: Page) {
  await page.getByRole('button', { name: 'Save scene', exact: true }).click();
  const popup = page.getByRole('dialog', { name: 'Save scene', exact: true });
  await expect(popup).toBeVisible(); return popup;
}

test('desktop export order preserves wire IDs and Cancel discards only the dialog draft', async ({ page }) => {
  await open(page); const popup = await dialog(page);
  expect(await popup.getByLabel('Export format', { exact: true }).locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)))
    .toEqual(['0', '8', '1', '2', '3', '4', '5', '6', '7']);
  await popup.getByLabel('Export format', { exact: true }).selectOption('8');
  await popup.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect((await dialog(page)).getByLabel('Export format', { exact: true })).toHaveValue('0');
});

test('SPZ v4 downloads a real framed file and reopens through the browser decoder', async ({ page }, testInfo) => {
  const failures: string[] = []; page.on('pageerror', error => failures.push(error.message));
  await open(page); const popup = await dialog(page);
  await popup.getByLabel('Export format', { exact: true }).selectOption('8');
  const pending = page.waitForEvent('download'); await popup.getByRole('button', { name: 'Download', exact: true }).click();
  const downloaded = await pending; expect(downloaded.suggestedFilename()).toBe('export-sh3-edited.spz');
  const output = testInfo.outputPath('exported-v4.spz'); await downloaded.saveAs(output); const bytes = await readFile(output);
  expect(bytes.readUInt32LE(0)).toBe(0x5053474e); expect(bytes.readUInt32LE(4)).toBe(4);
  expect(bytes.readUInt32LE(8)).toBe(3); expect(bytes.length).toBeGreaterThan(32);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('status').filter({ hasText: 'Download prepared' }).getByRole('button', { name: 'Stay', exact: true }).click();
  await expect((await dialog(page)).getByLabel('Export format', { exact: true })).toHaveValue('8');
  await page.getByRole('dialog', { name: 'Save scene', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByLabel('Open scene files').setInputFiles({ name: 'roundtrip-v4.spz', mimeType: 'application/octet-stream', buffer: bytes });
  await expect(page).toHaveTitle('roundtrip-v4.spz — SplatView');
  await page.mouse.move(640, 401); await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Tools', exact: true }).locator('.model-stats')).toHaveText('0/3 splats | SH3');
  await expect(page.getByRole('alert')).toHaveCount(0); expect(failures).toEqual([]);
});

test('legacy SPZ v3 keeps its original wire ID and gzip framing', async ({ page }, testInfo) => {
  const failures: string[] = []; page.on('pageerror', error => failures.push(error.message));
  await open(page); const popup = await dialog(page);
  await popup.getByLabel('Export format', { exact: true }).selectOption('1');
  const pending = page.waitForEvent('download'); await popup.getByRole('button', { name: 'Download', exact: true }).click();
  const downloaded = await pending; expect(downloaded.suggestedFilename()).toBe('export-sh3-edited.spz');
  const output = testInfo.outputPath('exported-v3.spz'); await downloaded.saveAs(output);
  const bytes = await readFile(output); expect([...bytes.subarray(0, 2)]).toEqual([0x1f, 0x8b]);
  const payload = gunzipSync(bytes);
  expect(payload.readUInt32LE(0)).toBe(0x5053474e); expect(payload.readUInt32LE(4)).toBe(3); expect(payload.readUInt32LE(8)).toBe(3);
  expect(payload[12]).toBe(3); await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('status').filter({ hasText: 'Download prepared' }).getByRole('button', { name: 'Stay', exact: true }).click();
  await page.getByLabel('Open scene files').setInputFiles({ name: 'roundtrip-v3.spz', mimeType: 'application/octet-stream', buffer: bytes });
  await expect(page).toHaveTitle('roundtrip-v3.spz \u2014 SplatView');
  await page.mouse.move(640, 401); await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Tools', exact: true }).locator('.model-stats')).toHaveText('0/3 splats | SH3');
  await expect(page.getByRole('alert')).toHaveCount(0); expect(failures).toEqual([]);
});

test('compressed PLY uses the desktop compound filename suffix', async ({ page }) => {
  await open(page); const popup = await dialog(page);
  await popup.getByLabel('Export format', { exact: true }).selectOption('3');
  const pending = page.waitForEvent('download'); await popup.getByRole('button', { name: 'Download', exact: true }).click();
  expect((await pending).suggestedFilename()).toBe('export-sh3-edited.compressed.ply');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('an empty Selected scope is refused before remembering a new format', async ({ page }) => {
  await open(page); const popup = await dialog(page); const downloads: string[] = [];
  page.on('download', output => downloads.push(output.suggestedFilename()));
  await popup.getByLabel('Export format', { exact: true }).selectOption('8');
  await popup.getByLabel('Export scope', { exact: true }).selectOption('1');
  await popup.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('No visible splats'); expect(downloads).toEqual([]);
  await popup.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect((await dialog(page)).getByLabel('Export format', { exact: true })).toHaveValue('0');
});

for (const format of ['0', '1', '6', '7', '8']) {
  test(`format ${format} exports settled color edits and preserves isolated Redo`, async ({ page }, testInfo) => {
    await open(page);
    await page.getByRole('button', { name: 'Tools', exact: true }).click();
    await page.getByRole('button', { name: 'Select all', exact: true }).click();
    const save = async (name: string) => {
      await page.mouse.move(640, 401);
      const popup = await dialog(page);
      await popup.getByLabel('Export format', { exact: true }).selectOption(format);
      const pending = page.waitForEvent('download');
      await popup.getByRole('button', { name: 'Download', exact: true }).click();
      const download = await pending;
      const output = testInfo.outputPath(name); await download.saveAs(output);
      const bytes = await readFile(output);
      await page.getByRole('status').filter({ hasText: 'Download prepared' }).getByRole('button', { name: 'Stay', exact: true }).click();
      await expect(page.getByRole('alert')).toHaveCount(0);
      return bytes;
    };
    const extension = format === '0' ? 'ply' : format === '6' ? 'sog' : format === '7' ? 'sogs' : 'spz';
    const original = await save(`original.${extension}`);
    await page.getByRole('slider', { name: 'Brightness', exact: true }).fill('1.3');
    await page.getByRole('button', { name: 'Apply color', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Apply color', exact: true })).toBeHidden();
    const edited = await save(`graded.${extension}`);
    expect(edited.equals(original)).toBe(false);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
    expect((await save(`undone.${extension}`)).equals(original)).toBe(true);
    await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    expect((await save(`redone.${extension}`)).equals(edited)).toBe(true);
  });
}
