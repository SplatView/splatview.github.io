import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { assertKsplatPly } from '../tests/fixtures/ksplat-oracle';

// Ordinary production UI and actual downloads. The Node-side attribute oracle
// imports no app parser, writer, native math or fixture-construction code.
const sources = [
  { file: 'mode1-sh3.ksplat', mode: 1, degree: 3 },
  { file: 'mode2-sh3.ksplat', mode: 2, degree: 3 },
  { file: 'mode2-mixed.ksplat', mode: 2, degree: 3, mixed: true },
] as const;
const ids = Array.from({ length: 263 }, (_, index) => index);
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const panel = (page: Page) => page.getByRole('complementary', { name: 'Tools', exact: true });
const stats = (page: Page) => panel(page).locator('.model-stats');
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function savePly(page: Page, info: TestInfo, name: string) {
  await page.mouse.move(640, 400); await button(page, 'Save scene').click();
  const dialog = page.getByRole('dialog', { name: 'Save scene', exact: true });
  await dialog.getByLabel('Export format', { exact: true }).selectOption('0');
  await dialog.getByLabel('Export scope', { exact: true }).selectOption('0');
  const pending = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download', exact: true }).click();
  const download = await pending, path = info.outputPath(name);
  expect(await download.failure()).toBeNull(); await download.saveAs(path);
  const bytes = await readFile(path);
  await info.attach(name, { path, contentType: 'application/octet-stream' });
  await button(page, 'Stay').click();
  await expect(dialog).toHaveCount(0); await expect(page.getByRole('alert')).toHaveCount(0);
  return { bytes, sha256: digest(bytes), filename: download.suggestedFilename() };
}

for (const source of sources) test(`independent ${source.file} opens, retains a failed replacement and executable Redo, exports and reopens through production UI`, async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const original = await readFile(resolve('tests/fixtures/formats/ksplat-v1', source.file));
  await page.goto('/'); await expect(button(page, 'Open scene')).toBeEnabled();
  await page.getByLabel('Open scene files', { exact: true }).setInputFiles({ name: source.file, mimeType: 'application/octet-stream', buffer: original });
  await expect(page).toHaveTitle(`${source.file} \u2014 SplatView`);
  await page.mouse.move(640, 400);
  if (!await panel(page).count()) await button(page, 'Tools').click();
  await expect(stats(page)).toHaveText('0/263 splats | SH3');
  await panel(page).getByRole('button', { name: 'Select all', exact: true }).click();
  await expect(stats(page)).toHaveText('263/263 splats | SH3');
  await panel(page).getByRole('button', { name: 'Delete selected', exact: true }).click();
  await expect(stats(page)).toHaveText('0/0 splats | SH3');
  await expect(page).toHaveTitle(`\u2022 ${source.file} \u2014 SplatView`);
  await panel(page).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(stats(page)).toHaveText('263/263 splats | SH3');
  await expect(page).toHaveTitle(`${source.file} \u2014 SplatView`);
  const first = await savePly(page, info, 'original-decoded.ply');
  const initial = assertKsplatPly(first.bytes, source, ids);

  // Refuse a real replacement through the ordinary file input; source, native
  // attributes and the previously executable delete branch must survive.
  const invalid = Buffer.from(original); invalid.writeUInt16LE(3, 20);
  await page.getByLabel('Open scene files', { exact: true }).setInputFiles({ name: 'invalid-compression.ksplat', mimeType: 'application/octet-stream', buffer: invalid });
  await expect(page.getByRole('alert')).toContainText('KSPLAT compression level');
  await expect(page).toHaveTitle(`${source.file} \u2014 SplatView`);
  await expect(stats(page)).toHaveText('263/263 splats | SH3');
  await button(page, 'Dismiss error').click();
  await expect(panel(page).getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  await panel(page).getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(stats(page)).toHaveText('0/0 splats | SH3');
  await panel(page).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(stats(page)).toHaveText('263/263 splats | SH3');
  const retained = await savePly(page, info, 'after-refusal-redo-undo.ply');
  expect(retained.bytes).toEqual(first.bytes);
  const restored = assertKsplatPly(retained.bytes, source, ids);

  const reopenedName = source.file.replace('.ksplat', '-roundtrip.ply');
  await page.getByLabel('Open scene files', { exact: true }).setInputFiles({ name: reopenedName, mimeType: 'application/octet-stream', buffer: first.bytes });
  await expect(page).toHaveTitle(`${reopenedName} \u2014 SplatView`);
  await expect(stats(page)).toHaveText('0/263 splats | SH3');
  const second = await savePly(page, info, 'reopened-decoded.ply');
  const reopened = assertKsplatPly(second.bytes, source, ids);
  await button(page, 'Settings').click();
  await page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('button', { name: 'Close scene', exact: true }).click();
  await expect(page.locator('main')).toHaveAttribute('data-scene-ready', 'false');
  await expect(page.getByLabel('SplatView scene', { exact: true })).toHaveAttribute('aria-busy', 'false');
  await expect(button(page, 'Open scene')).toBeEnabled(); await expect(page).toHaveTitle('SplatView');
  await expect(button(page, 'Save scene')).toBeDisabled();
  await expect(page.getByRole('alert')).toHaveCount(0); expect(errors).toEqual([]);
  await info.attach('ksplat-independent-production-workflow.json', { contentType: 'application/json', body: JSON.stringify({
    source, origin: new URL(page.url()).origin, input: { bytes: original.length, sha256: digest(original) },
    initial, restored, reopened, firstSha256: first.sha256, restoredSha256: retained.sha256,
    reopenedSha256: second.sha256, sourceCount: 263, exactRetainedOutput: true, errors,
  }) });
});
