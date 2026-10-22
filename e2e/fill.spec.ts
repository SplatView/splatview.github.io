import { expect, test, type Page } from '@playwright/test';
import { fixtureCenters } from './sceneCoordinates';
import { fillPly, fillPositions } from './fill-fixture';
import type {} from './fill-harness';
import { chooseSelectionTool } from './selectTool';
import { appIdle } from './app-idle';

const bytes = fillPly();
const panel = (page: Page) => page.getByRole('complementary', { name: 'Tools', exact: true });
const slider = (page: Page) => page.getByRole('slider', { name: 'Selection tolerance', exact: true });
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
async function tolerance(page: Page, percent: number) {
  await slider(page).click({ button: 'right' });
  const exact = page.getByRole('spinbutton', { name: 'Tolerance percent', exact: true });
  await exact.fill(String(percent)); await exact.press('Enter'); await ready(page);
}
async function open(page: Page) {
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  await page.getByLabel('Open scene files').setInputFiles({ name: 'fill-opacity.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
  await expect(page).toHaveTitle('fill-opacity.ply — SplatView');
  await page.mouse.move(640, 400); await expect(page.locator('main')).not.toHaveClass(/chrome-hidden/);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await chooseSelectionTool(page, 'Fill');
  await setOption(page, 'Visible only', false); await setOption(page, 'Include splat edges', false);
}
async function exportSelection(page: Page) {
  await page.getByRole('button', { name: 'Save scene', exact: true }).click();
  await page.getByLabel('Export format', { exact: true }).selectOption('5');
  await page.getByLabel('Export scope', { exact: true }).selectOption('1');
  const downloading = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download', exact: true }).click();
  const stream = await (await downloading).createReadStream(), chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const rows = Buffer.concat(chunks).toString('utf8').trim().split(/\r?\n/).slice(1).map(row => row.split(',').slice(0, 3).map(Number));
  const ids = rows.map(row => fillPositions.findIndex(point => point.every((value, i) => Math.abs(value - row[i]) < 1e-5))).sort((a, b) => a - b);
  expect(ids).not.toContain(-1); await page.getByRole('button', { name: 'I have kept the file', exact: true }).click(); return ids;
}

test.describe('Fill App workflows', () => {
  test.beforeEach(async ({ page }) => { await open(page); });
  for (const operation of ['Replace', 'Add', 'Subtract', 'Intersect'] as const)
    test(`${operation} Fill grows and shrinks the connected opacity island in one Undo`, async ({ page }) => {
      const [center] = await fixtureCenters(page, bytes, fillPositions);
      if (operation !== 'Add') { await page.getByRole('button', { name: 'Select all', exact: true }).click(); await selected(page, 4); }
      await page.getByRole('button', { name: operation, exact: true }).click();
      // Ten displayed percent (.01 opacity difference) tolerates viewport/map
      // quantization while remaining below every other source-center gap.
      await tolerance(page, 10);
      await page.mouse.move(...center as [number, number]); await page.mouse.down(); await selected(page, operation === 'Add' ? 0 : 4);
      await page.mouse.up(); await selected(page, operation === 'Subtract' ? 3 : 1);
      await tolerance(page, 60); await selected(page, 2);
      await tolerance(page, 100); await selected(page, operation === 'Subtract' ? 1 : 3);
      expect(await exportSelection(page)).toEqual(operation === 'Subtract' ? [3] : [0, 1, 2]);
      await tolerance(page, 10); await selected(page, operation === 'Subtract' ? 3 : 1);
      expect(await exportSelection(page)).toEqual(operation === 'Subtract' ? [1, 2, 3] : [0]);
      await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, operation === 'Add' ? 0 : 4);
      if (operation !== 'Add') { await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, 0); }
      await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled(); await expect(page.getByRole('alert')).toHaveCount(0);
    });

  test('empty clicks preserve every Combine mask and the preceding completed Fill checkpoint', async ({ page }) => {
    await tolerance(page, 10);
    const [center] = await fixtureCenters(page, bytes, fillPositions); await page.mouse.click(...center as [number, number]); await selected(page, 1);
    for (const operation of ['Replace', 'Add', 'Subtract', 'Intersect']) {
      await page.getByRole('button', { name: operation, exact: true }).click(); await page.mouse.click(1100, 100); await selected(page, 1);
    }
    await tolerance(page, 100); await selected(page, 3); expect(await exportSelection(page)).toEqual([0, 1, 2]);
    await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, 0);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled(); await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('Fill rejects drags and cancelled presses while preserving the last adjustable click', async ({ page }) => {
    await tolerance(page, 10);
    const centers = await fixtureCenters(page, bytes, fillPositions); await page.mouse.click(...centers[0] as [number, number]); await selected(page, 1);
    for (const cancel of ['drag', 'blur', 'capture', 'escape'] as const) {
      await page.mouse.move(...centers[3] as [number, number]); await page.mouse.down(); await selected(page, 1);
      if (cancel === 'drag') await page.mouse.move(centers[3][0] + 6, centers[3][1]);
      else if (cancel === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      else if (cancel === 'capture') await page.getByLabel('SplatView scene').dispatchEvent('lostpointercapture');
      else await page.keyboard.press('Escape');
      await page.mouse.up(); await selected(page, 1);
      if (cancel !== 'escape') { await tolerance(page, 100); await selected(page, 3); await tolerance(page, 10); await selected(page, 1); }
      else { await chooseSelectionTool(page, 'Fill'); await tolerance(page, 100); await selected(page, 1); }
    }
    await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, 0); await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('blur cancels a released pending Fill without expiring the preceding completed click', async ({ page }) => {
    await tolerance(page, 10);
    const centers = await fixtureCenters(page, bytes, fillPositions); await page.mouse.click(...centers[0] as [number, number]); await selected(page, 1);
    await page.evaluate(async () => {
      const url = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === '/src/app/selectionMaps.ts')?.name;
      if (!url) throw new Error('The actual document map owner module was not loaded.');
      const { DocumentSelectionMaps } = await import(/* @vite-ignore */ url);
      const original = DocumentSelectionMaps.prototype.request;
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const control = { entered: false, returned: false, release };
      (window as unknown as { fillReadback: typeof control }).fillReadback = control;
      DocumentSelectionMaps.prototype.request = async function(...args: unknown[]) {
        const map = await original.apply(this, args); DocumentSelectionMaps.prototype.request = original;
        control.entered = true; await gate; control.returned = true; return map;
      };
    });
    await page.mouse.click(...centers[3] as [number, number]);
    await page.waitForFunction(() => (window as unknown as { fillReadback: { entered: boolean } }).fillReadback.entered);
    await selected(page, 1); await expect(slider(page)).toBeEnabled();
    await tolerance(page, 100); await selected(page, 1);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.evaluate(() => (window as unknown as { fillReadback: { release(): void } }).fillReadback.release());
    await page.waitForFunction(() => (window as unknown as { fillReadback: { returned: boolean } }).fillReadback.returned);
    // Enter a different value: replacing an input's existing "100" with "100"
    // emits no DOM change and therefore would not request an amendment.
    await tolerance(page, 99); await selected(page, 3); expect(await exportSelection(page)).toEqual([0, 1, 2]);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await tolerance(page, 10); await selected(page, 1);
    await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, 0); await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('view, tool, history and explicit Fill option changes expire completed tolerance ownership', async ({ page }) => {
    for (const change of ['view', 'tool', 'history', 'visible', 'edges'] as const) {
      await page.getByRole('button', { name: 'Reset camera', exact: true }).click();
      await chooseSelectionTool(page, 'Fill');
      await tolerance(page, 10); const [center] = await fixtureCenters(page, bytes, fillPositions);
      await page.mouse.click(...center as [number, number]); await selected(page, 1);
      if (change === 'view') {
        await page.mouse.move(...center as [number, number]); await page.mouse.down({ button: 'right' });
        await page.mouse.move(center[0] + 25, center[1] + 10); await page.mouse.up({ button: 'right' });
      } else if (change === 'tool') {
        await chooseSelectionTool(page, 'Brush'); await chooseSelectionTool(page, 'Fill');
      } else if (change === 'history') { await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, 0); }
      else await setOption(page, change === 'visible' ? 'Visible only' : 'Include splat edges', true);
      await tolerance(page, 100); await selected(page, change === 'history' ? 0 : 1);
      const clear = page.getByRole('button', { name: 'Clear selection', exact: true });
      if (change === 'history') await expect(clear).toBeDisabled();
      else await clear.click();
      await selected(page, 0);
      await setOption(page, 'Visible only', false); await setOption(page, 'Include splat edges', false);
    }
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  // web-lite has one Tools profile (processing.advanced excludes Pro), so no cross-profile switch remains.
  test('Fill retains independent logarithmic tolerance and captured operation', async ({ page }) => {
    await expect(slider(page)).toHaveAttribute('aria-valuetext', '1%'); await expect(option(page, 'Live selection')).toHaveCount(0);
    await expect(option(page, 'Visible only')).toBeEnabled(); await expect(option(page, 'Include splat edges')).toBeEnabled();
    await chooseSelectionTool(page, 'Color picker'); await tolerance(page, 35);
    await chooseSelectionTool(page, 'Fill');
    await expect(page.getByRole('button', { name: 'Selection tool', exact: true }).getByText('Fill', { exact: true })).toBeVisible();
    await expect(slider(page)).toHaveAttribute('aria-valuetext', '1%');
    await slider(page).fill('0.5'); await expect(slider(page)).toHaveAttribute('aria-valuetext', '0.1%'); await tolerance(page, 10);
    await page.getByRole('button', { name: 'Select all', exact: true }).click(); await selected(page, 4); await appIdle(page);
    await page.getByRole('button', { name: 'Subtract', exact: true }).click(); const [center] = await fixtureCenters(page, bytes, fillPositions);
    await page.mouse.click(...center as [number, number]); await selected(page, 3);
    await expect(page.getByRole('button', { name: 'Subtract', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await chooseSelectionTool(page, 'Color picker'); await expect(slider(page)).toHaveAttribute('aria-valuetext', '35%');
    await chooseSelectionTool(page, 'Fill'); await expect(slider(page)).toHaveAttribute('aria-valuetext', '10%');
    await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, 4); await expect(page.getByRole('alert')).toHaveCount(0);
  });
});

test.describe('Retina Fill', () => {
  test.use({ deviceScaleFactor: 2 });
  test('keeps opacity connectivity and the five CSS-pixel release threshold at DPR2', async ({ page }) => {
    await open(page); const centers = await fixtureCenters(page, bytes, fillPositions);
    await tolerance(page, 100);
    await page.mouse.move(...centers[0] as [number, number]); await page.mouse.down();
    await page.mouse.move(centers[0][0] + 4, centers[0][1]); await page.mouse.up(); await selected(page, 3);
    expect(await exportSelection(page)).toEqual([0, 1, 2]);
    await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, 0);
    await page.mouse.move(...centers[0] as [number, number]); await page.mouse.down();
    await page.mouse.move(centers[0][0] + 6, centers[0][1]); await page.mouse.up(); await selected(page, 0);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled(); await expect(page.getByRole('alert')).toHaveCount(0);
  });
});

test.describe('Fill controller boundaries', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/e2e/fill-harness.html'); await page.waitForFunction(() => Boolean(window.fillHarness || window.fillHarnessError));
    expect(await page.evaluate(() => window.fillHarnessError)).toBeUndefined();
  });
  for (const boundary of ['cancel', 'view', 'options', 'admission'] as const)
    test(`${boundary} while Fill acquires the actual map preserves masks and Redo`, async ({ page }) => {
      const result = await page.evaluate(boundary => window.fillHarness.failure(boundary), boundary);
      expect(result.accepted).toBe(false); expect(result.after.selected).toBe(result.before.selected); expect(result.after.canRedo).toBe(true);
      expect(result.after.revision).toBe(result.before.revision); expect(result.after.contentRevision).toBe(result.before.contentRevision);
      expect(result.sameOutput).toBe(true); expect(result.sameGpuMasks).toBe(true); expect(result.after.transaction).toBe(false);
      expect(result.busy).toBe(false); if (boundary === 'admission') expect(result.error).toMatch(/Injected Fill/); else expect(result.error).toBeNull();
    });
  for (const empty of [false, true]) test(`pending ${empty ? 'empty' : 'valid'} Fill replacement owns new tolerance and orders export`, async ({ page }) => {
    const result = await page.evaluate(empty => window.fillHarness.pending(empty), empty);
    expect(result.before.selected).toBe(1); expect(result.whilePending.selected).toBe(1); expect(result.remembered).toBe(1);
    expect(result.blocked).toBe(true); expect(result.accepted).toBe(!empty); expect(result.rows).toBe(empty ? 1 : 3);
    expect(result.after.selected).toBe(empty ? 1 : 3);
    if (empty) { expect(result.expanded).toBe(3); expect(result.shrunk).toBe(1); }
    expect(result.undone.selected).toBe(empty ? 0 : 1); expect(result.busy).toBe(false); expect(result.error).toBeNull();
  });
  for (const kind of ['pick', 'amendment'] as const) test(`refused Fill ${kind} retains the preceding adjustable checkpoint`, async ({ page }) => {
    const result = await page.evaluate(kind => window.fillHarness.publication(kind), kind);
    expect(result.before.selected).toBe(1); expect(result.after.selected).toBe(1); expect(result.sameOutput).toBe(true); expect(result.sameGpuMasks).toBe(true);
    expect(result.after.revision).toBe(result.before.revision); expect(result.error).toMatch(/Injected Fill/); expect(result.busy).toBe(false);
    expect(result.expanded).toBe(3); expect(result.shrunk).toBe(1); expect(result.undone.selected).toBe(0); expect(result.undone.canUndo).toBe(false);
  });
  test('a native empty result overrides a valid browser precheck without retiring the preceding owner', async ({ page }) => {
    const result = await page.evaluate(() => window.fillHarness.authoritativeEmpty());
    expect(result.accepted).toBe(false); expect(result.after.toleranceSessionId).toBe(result.before.toleranceSessionId);
    expect(result.after.selected).toBe(1); expect(result.sameOutput).toBe(true); expect(result.sameGpuMasks).toBe(true);
    expect(result.expanded).toBe(3); expect(result.shrunk).toBe(1); expect(result.undone.selected).toBe(0); expect(result.undone.canUndo).toBe(false);
    expect(result.busy).toBe(false); expect(result.error).toBeNull();
  });
  test('fractional framebuffer coordinates stay in the opacity seed cell containing the click', async ({ page }) => {
    const result = await page.evaluate(() => window.fillHarness.fractionalCell());
    expect(result.integerAccepted).toBe(true); expect(result.fractionalAccepted).toBe(true);
    expect(result.integer.selected).toBe(1); expect(result.fractional.selected).toBe(1); expect(result.sameOutput).toBe(true);
    expect(result.undone.selected).toBe(0); expect(result.undone.canUndo).toBe(false); expect(result.busy).toBe(false); expect(result.error).toBeNull();
  });
  for (const kind of ['pick', 'amendment', 'cancelled'] as const) test(`export resolves held Fill ${kind} before its Selected snapshot`, async ({ page }) => {
    const result = await page.evaluate(kind => window.fillHarness.exportBarrier(kind), kind);
    expect(result.blocked).toBe(true); expect(result.exportCalls).toBe(1); expect(result.rows).toBe(kind === 'cancelled' ? 4 : 3);
    expect(result.after.selected).toBe(kind === 'cancelled' ? 4 : 3); expect(result.receipt).toBe(true); expect(result.busy).toBe(false); expect(result.error).toBeNull();
    expect(result.undone.selected).toBe(kind === 'cancelled' ? 0 : kind === 'amendment' ? 0 : 4);
  });
});
