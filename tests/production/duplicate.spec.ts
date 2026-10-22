import { expect, test, type Page } from '@playwright/test';
import { queuePly } from '../../e2e/queue-fixture';
import { exportBytes } from './initialization-helpers';
import type { NativeSummary } from '../../src/document/types';
import type { RecoveryCheckpointBinding, RecoveryCheckpointPlan } from '../../src/document/recoveryCheckpoint';

type Observation = { workers: number; imports: number; commands: string[]; summary?: NativeSummary;
  restore?: { binding: RecoveryCheckpointBinding; plan: RecoveryCheckpointPlan }; fail(): void };
declare global { interface Window { duplicateObservation: Observation } }
async function open(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('splatview.tools-mode.v1', 'pro');
    const NativeWorker = window.Worker;
    let current: Worker | undefined;
    const observation: Observation = { workers: 0, imports: 0, commands: [], fail() {
      if (!current) throw new Error('No authoritative worker is available.');
      current.terminate();
      current.dispatchEvent(new ErrorEvent('error', { cancelable: true, message: 'Duplicate test terminated the actual scene worker.' }));
    } };
    window.duplicateObservation = observation;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options); current = this; observation.workers++;
        this.addEventListener('message', event => {
          const value = event.data;
          if (value?.summary) observation.summary = structuredClone(value.summary);
        });
      }
      override postMessage(value: unknown, options?: Transferable[] | StructuredSerializeOptions) {
        const data = value as { type?: string; command?: { command?: string }; binding: RecoveryCheckpointBinding; plan: RecoveryCheckpointPlan };
        if (data.type === 'source-load' || data.type === 'source-group-load') observation.imports++;
        if (data.command?.command) observation.commands.push(data.command.command);
        if (data.type === 'recovery-restore') observation.restore = structuredClone({ binding: data.binding, plan: data.plan });
        if (Array.isArray(options)) super.postMessage(value, options); else super.postMessage(value, options);
      }
    };
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  await page.getByLabel('Open scene files').setInputFiles({ name: 'duplicate.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(queuePly()) });
  const tools = page.getByRole('complementary', { name: 'Tools', exact: true });
  if (!await tools.isVisible()) await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await tools.getByRole('button', { name: 'Select all', exact: true }).click();
  await expect(tools.locator('.model-stats')).toHaveText('5/5 splats | SH0');
  return { tools, duplicate: tools.getByRole('button', { name: 'Duplicate selection', exact: true }),
    undo: tools.getByRole('button', { name: 'Undo', exact: true }), redo: tools.getByRole('button', { name: 'Redo', exact: true }) };
}
function records(bytes: Buffer, count: number) {
  const marker = Buffer.from('end_header\n'), end = bytes.indexOf(marker);
  expect(end).toBeGreaterThan(0);
  expect(bytes.subarray(0, end).toString()).toContain(`element vertex ${count}\n`);
  return bytes.subarray(end + marker.length);
}
async function greenPixels(page: Page) {
  const bytes = await page.getByLabel('SplatView scene', { exact: true }).screenshot();
  return page.evaluate(async payload => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(payload)], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0); bitmap.close();
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let green = 0;
    for (let i = 0; i < pixels.length; i += 4)
      if (pixels[i + 1] > 70 && pixels[i + 1] > pixels[i] * 1.2 && pixels[i + 1] > pixels[i + 2] * 1.2) green++;
    return green;
  }, Array.from(bytes));
}

test('shipped Pro Duplicate preserves raw records, displays green copies, and swaps count on Undo/Redo', async ({ page }, info) => {
  const f = await open(page), original = records(await exportBytes(page, 'duplicate'), 5), yellow = await greenPixels(page);
  await expect(f.duplicate).toBeEnabled(); await f.duplicate.click();
  await expect(f.tools.locator('.model-stats')).toHaveText('5/10 splats | SH0'); await expect(f.duplicate).toBeDisabled();
  const green = await greenPixels(page); expect(green).toBeGreaterThan(yellow + 20);
  const grown = records(await exportBytes(page, 'duplicate'), 10);
  expect(grown.length).toBe(original.length * 2);
  expect(grown.subarray(0, original.length).equals(original)).toBe(true);
  expect(grown.subarray(original.length).equals(original)).toBe(true);
  await f.undo.click(); await expect(f.tools.locator('.model-stats')).toHaveText('5/5 splats | SH0'); await expect(f.duplicate).toBeEnabled();
  await f.redo.click(); await expect(f.tools.locator('.model-stats')).toHaveText('5/10 splats | SH0'); await expect(f.duplicate).toBeDisabled();
  await f.tools.getByRole('button', { name: 'Select all', exact: true }).click(); await expect(f.duplicate).toBeEnabled();
  await f.duplicate.click(); await expect(f.tools.locator('.model-stats')).toHaveText('10/20 splats | SH0'); await expect(f.duplicate).toBeDisabled();
  await info.attach('duplicate-display', { body: JSON.stringify({ yellowGreenPixels: yellow, copyGreenPixels: green,
    originalRecordBytes: original.length, firstCopyRecordBytes: grown.length }), contentType: 'application/json' });
  await expect(page.getByRole('alert')).toHaveCount(0);
});

for (const smaller of [false, true]) test(`shipped Duplicate worker recovery restores ${smaller ? 'smaller current scene with grown Redo' : 'grown scene and copy guard'} without source reread`, async ({ page }, info) => {
  const f = await open(page), original = await exportBytes(page, 'duplicate');
  await f.duplicate.click(); await expect(f.tools.locator('.model-stats')).toHaveText('5/10 splats | SH0');
  const grown = await exportBytes(page, 'duplicate');
  if (smaller) { await f.undo.click(); await expect(f.tools.locator('.model-stats')).toHaveText('5/5 splats | SH0'); }
  await page.evaluate(() => window.duplicateObservation.fail());
  await expect.poll(() => page.evaluate(() => window.duplicateObservation.workers)).toBe(2);
  await expect(f.duplicate)[smaller ? 'toBeEnabled' : 'toBeDisabled']();
  await expect(f.tools.locator('.model-stats')).toHaveText(smaller ? '5/5 splats | SH0' : '5/10 splats | SH0');
  const restored = await exportBytes(page, 'duplicate'); expect(restored.equals(smaller ? original : grown)).toBe(true);
  const observed = await page.evaluate(() => {
    const { workers, imports, commands, summary, restore } = window.duplicateObservation;
    return { workers, imports, commands, summary, restore };
  });
  expect(observed.imports).toBe(1); expect(observed.commands.filter(command => command === 'duplicate')).toHaveLength(1);
  expect(observed.restore?.binding.subset.loadedCount).toBe(5); expect(observed.restore?.binding.subset.sourceCount).toBe(5);
  expect(observed.restore?.plan).toMatchObject({ version: 2, currentLoadedCount: smaller ? 5 : 10,
    currentSourceCount: smaller ? 5 : 10, maximumGraphSplats: 10, currentDuplicateRange: smaller ? null : { first: 5, count: 5 } });
  if (smaller) await f.redo.click(); else { await f.undo.click(); await f.redo.click(); }
  await expect(f.tools.locator('.model-stats')).toHaveText('5/10 splats | SH0'); await expect(f.duplicate).toBeDisabled();
  expect((await exportBytes(page, 'duplicate')).equals(grown)).toBe(true);
  await info.attach('duplicate-worker-recovery', { body: JSON.stringify(observed), contentType: 'application/json' });
  await expect(page.getByRole('alert')).toHaveCount(0);
});
