import { expect, test, type Page } from '@playwright/test';
import { gaussianPly } from '../tests/fixtures/gaussians';
import { fixtureCenters } from './sceneCoordinates';
import type {} from './volume-harness';
import { chooseSelectionTool } from './selectTool';

const bytes = gaussianPly(0), positions = [[-.4, 0, 0], [.4, 0, 0], [0, .4, .1]];
// Gaussian PLY RDF coordinates become right/up/back inside the native scene;
// CSV writes the original RDF convention, while projection uses world points.
const worldPoints = positions.map(([x, y, z]) => [x, -y, -z]);
const panel = (page: Page) => page.getByRole('complementary', { name: 'Tools', exact: true });
const option = (page: Page, name: string) => panel(page).getByRole('group', { name: 'Options', exact: true }).getByRole('button', { name, exact: true });
async function setOption(page: Page, name: string, pressed: boolean) {
  const button = option(page, name);
  if (await button.getAttribute('aria-pressed') !== String(pressed)) await button.click();
  await expect(button).toHaveAttribute('aria-pressed', String(pressed));
}
async function ready(page: Page) { await expect(page.locator('.status.panel')).toHaveCount(0); }
async function selected(page: Page, count: number) {
  await expect(panel(page).locator('.model-stats')).toHaveText(new RegExp(`^${count.toLocaleString('en-US')}/[\\d,]+ splats \\| SH[0-3]$`)); await ready(page);
}
async function open(page: Page) {
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  await page.getByLabel('Open scene files').setInputFiles({ name: 'volume-sh0.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
  await expect(page).toHaveTitle('volume-sh0.ply — SplatView');
  await page.mouse.move(640, 400); await expect(page.locator('main')).not.toHaveClass(/chrome-hidden/);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await chooseSelectionTool(page, 'Volume brush');
  await expect(option(page, 'Visible only')).toBeEnabled();
  // Start from the single web-lite profile's defaults, then use the explicit
  // Replace/all-depth state these cases were written against.
  await expect(option(page, 'Visible only')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Add', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Replace', exact: true }).click(); await setOption(page, 'Visible only', false);
}
async function exportSelection(page: Page) {
  await page.getByRole('button', { name: 'Save scene', exact: true }).click();
  await page.getByLabel('Export format', { exact: true }).selectOption('5'); await page.getByLabel('Export scope', { exact: true }).selectOption('1');
  const downloading = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download', exact: true }).click();
  const stream = await (await downloading).createReadStream(), chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const rows = Buffer.concat(chunks).toString('utf8').trim().split(/\r?\n/).slice(1).map(row => row.split(',').slice(0, 3).map(Number));
  const ids = rows.map(row => positions.findIndex(point => point.every((value, i) => Math.abs(value - row[i]) < 1e-5))).sort((a, b) => a - b);
  expect(ids).not.toContain(-1); await page.getByRole('button', { name: 'I have kept the file', exact: true }).click(); return ids;
}

test.describe('Volume App workflows', () => {
  test.beforeEach(async ({ page }) => { await open(page); });
  for (const live of [false, true]) for (const operation of ['Replace', 'Add', 'Subtract', 'Intersect'] as const)
    test(`${live ? 'live' : 'deferred'} Volume ${operation} keeps the complete path and one Undo`, async ({ page }) => {
      const centers = await fixtureCenters(page, bytes, worldPoints);
      if (operation === 'Add') {
        await chooseSelectionTool(page, 'Single splat'); await page.mouse.click(...centers[2] as [number, number]); await selected(page, 1);
        await chooseSelectionTool(page, 'Volume brush');
      } else { await page.getByRole('button', { name: 'Select all', exact: true }).click(); await selected(page, 3); }
      await page.getByRole('button', { name: operation, exact: true }).click(); await setOption(page, 'Live selection', live);
      const baseline = operation === 'Add' ? 1 : 3, firstCount = { Replace: 1, Add: 2, Subtract: 2, Intersect: 1 }[operation]!;
      await page.mouse.move(...centers[0] as [number, number]); await page.mouse.down(); await selected(page, live ? firstCount : baseline);
      await page.mouse.move(...centers[1] as [number, number], { steps: 2 });
      // The release lies on empty background. Keeping only the latest segment
      // would lose the first contributor, especially in the deferred path.
      await page.mouse.move(1200, 100); await page.mouse.up();
      const expected = operation === 'Add' ? [0, 1, 2] : operation === 'Subtract' ? [2] : [0, 1];
      await selected(page, expected.length); expect(await exportSelection(page)).toEqual(expected);
      await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, baseline);
      await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, 0);
      await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled(); await expect(page.getByRole('alert')).toHaveCount(0);
    });

  test('live Volume Escape, blur, lost capture, Undo and option edits restore the original mask', async ({ page }) => {
    const [center] = await fixtureCenters(page, bytes, worldPoints);
    await page.getByRole('button', { name: 'Select all', exact: true }).click(); await selected(page, 3);
    await setOption(page, 'Live selection', true);
    for (const cancel of ['escape', 'blur', 'capture', 'undo', 'visible'] as const) {
      await page.mouse.move(...center as [number, number]); await page.mouse.down(); await selected(page, 1);
      if (cancel === 'escape') await page.keyboard.press('Escape');
      else if (cancel === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      else if (cancel === 'capture') await page.getByLabel('SplatView scene').dispatchEvent('lostpointercapture');
      else if (cancel === 'undo') await page.keyboard.press('ControlOrMeta+z');
      else await option(page, 'Visible only').evaluate((button: HTMLButtonElement) => { button.click(); });
      await page.mouse.up(); await selected(page, 3);
      if (cancel === 'escape') await chooseSelectionTool(page, 'Volume brush');
    }
    await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, 0);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled(); await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('captured Volume points outside the viewport do not discard earlier surface samples', async ({ page }) => {
    const centers = await fixtureCenters(page, bytes, worldPoints);
    await page.mouse.move(...centers[0] as [number, number]); await page.mouse.down();
    await page.mouse.move(-20, 20); await page.mouse.move(...centers[1] as [number, number]); await page.mouse.move(1300, 20); await page.mouse.up();
    await selected(page, 2); expect(await exportSelection(page)).toEqual([0, 1]);
    await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, 0);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled(); await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('an empty Volume stroke preserves selection and Redo without adding a history entry', async ({ page }) => {
    const [center] = await fixtureCenters(page, bytes, worldPoints);
    await chooseSelectionTool(page, 'Single splat'); await page.mouse.click(...center as [number, number]); await selected(page, 1);
    await page.getByRole('button', { name: 'Delete selected', exact: true }).click(); await ready(page);
    await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, 1);
    await chooseSelectionTool(page, 'Volume brush');
    await page.mouse.move(1100, 100); await page.mouse.down(); await page.mouse.move(1200, 100); await page.mouse.up(); await selected(page, 1);
    await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, 0); await expect(page.getByRole('alert')).toHaveCount(0);
  });

  // web-lite has one Tools profile (processing.advanced excludes Pro), so no per-mode switch remains.
  test('Volume shortcuts and applicable visible-only state are retained across tools', async ({ page }) => {
    await setOption(page, 'Visible only', true); await page.getByLabel('SplatView scene').focus();
    await page.keyboard.press('b'); await expect(page.getByRole('button', { name: 'Selection tool', exact: true }).getByText('Brush', { exact: true })).toBeVisible();
    await expect(option(page, 'Visible only')).toBeEnabled(); await expect(option(page, 'Visible only')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Shift+b'); await expect(page.getByRole('button', { name: 'Selection tool', exact: true }).getByText('Volume brush', { exact: true })).toBeVisible();
    await expect(option(page, 'Visible only')).toHaveAttribute('aria-pressed', 'true');
    await chooseSelectionTool(page, 'Box select'); await expect(option(page, 'Visible only')).toHaveCount(0);
    await chooseSelectionTool(page, 'Volume brush'); await expect(option(page, 'Visible only')).toHaveAttribute('aria-pressed', 'true'); await expect(page.getByRole('alert')).toHaveCount(0);
  });
});

test.describe('Retina Volume', () => {
  test.use({ deviceScaleFactor: 2 });
  test('uses framebuffer path and radius while keeping the same CSS-size selection', async ({ page }) => {
    await open(page); const centers = await fixtureCenters(page, bytes, worldPoints);
    await setOption(page, 'Visible only', true); await setOption(page, 'Live selection', true);
    await page.mouse.move(...centers[0] as [number, number]); await page.mouse.down(); await selected(page, 1);
    await page.mouse.move(...centers[1] as [number, number]); await page.mouse.up(); await selected(page, 2);
    expect(await exportSelection(page)).toEqual([0, 1]); await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, 0);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
});

test.describe('Volume controller failure boundaries', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/e2e/volume-harness.html');
    await page.waitForFunction(() => Boolean(window.volumeHarness || window.volumeHarnessError));
    expect(await page.evaluate(() => window.volumeHarnessError)).toBeUndefined();
  });
  for (const boundary of ['cancel', 'view', 'admission'] as const) test(`${boundary} during surface acquisition preserves the exact baseline and Redo`, async ({ page }, testInfo) => {
    const result = await page.evaluate(boundary => window.volumeHarness.failure(boundary), boundary);
    await testInfo.attach('volume-ledger-accounting', { body: Buffer.from(JSON.stringify(result.accounting, null, 2)), contentType: 'application/json' });
    expect(result.after.selected).toBe(result.before.selected); expect(result.after.canRedo).toBe(true);
    expect(result.after.contentRevision).toBe(result.before.contentRevision); expect(result.after.revision).toBe(result.before.revision);
    expect(result.after.transaction).toBe(false); expect(result.after.selectionDraft).toBe(false); expect(result.active).toBe(false);
    expect(result.sameOutput).toBe(true); expect(result.sameGpuMasks).toBe(true);
    const proof = result.accounting, beforeRecovery = proof.before.entries.filter(entry => entry.category === 'recovery'),
      afterRecovery = proof.after.entries.filter(entry => entry.category === 'recovery');
    expect(beforeRecovery).toHaveLength(1); expect(afterRecovery).toHaveLength(1);
    expect(proof.after.entries.filter(entry => entry.category !== 'recovery')).toEqual(proof.before.entries.filter(entry => entry.category !== 'recovery'));
    expect(proof.normalizedEnvelopeEqual).toBe(true);
    expect(proof.after.checkpointBytes).toBe(proof.before.checkpointBytes);
    expect(proof.after.maximumChunkBytes).toBe(proof.before.maximumChunkBytes); expect(proof.after.chunkCount).toBe(proof.before.chunkCount);
    expect(afterRecovery[0].bytes - beforeRecovery[0].bytes).toBe(proof.expectedRecoveryDelta);
    expect(result.bytesAfter).toBe(result.bytesBefore + proof.expectedRecoveryDelta);
    expect(result.after.pendingSelectionMapId).toBeNull(); expect(result.after.selectionMapId).toBeNull();
    if (boundary !== 'cancel') expect(result.accepted).toBe(false);
    if (boundary === 'view') expect(result.viewCancelled).toBe(true);
    expect(result.busy).toBe(false); if (boundary === 'admission') expect(result.error).toMatch(/Injected Volume/); else expect(result.error).toBeNull();
  });
});
