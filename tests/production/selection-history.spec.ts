import { expect, test, type Locator, type Page } from '@playwright/test';
import { queuePly } from '../../e2e/queue-fixture';
import { chooseSelectionTool } from '../../e2e/selectTool';
import type { NativeSummary, SceneCommand } from '../../src/document/types';

type HistorySnapshot = {
  commands: SceneCommand[]; summary?: NativeSummary; nativeMasks?: number[]; gpuMasks: number[];
  workers: number; imports: number; projectionDevices: number; graphicsLosses: number; overflow: boolean;
};
declare global {
  interface Window {
    selectionHistoryObservation: {
      projectionDevices: number; snapshot(): Promise<HistorySnapshot>; loseGraphics(): Promise<void>;
    };
  }
}

/** Bounded observation of actual shipping replies and the states buffer bound
 * to the real projection pass. No app exports or replacement native results.
 * The graphics case destroys that actual device, then uses production recovery. */
async function open(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('splatview.tools-mode.v1', 'pro');
    const commands: SceneCommand[] = [];
    let summary: NativeSummary | undefined, nativeMasks: number[] | undefined;
    let workers = 0, imports = 0, graphicsLosses = 0, overflow = false;
    let projected: { device: GPUDevice; buffer: GPUBuffer } | undefined;
    const devices = new WeakSet<GPUDevice>();
    const groups = new WeakMap<GPUBindGroup, { device: GPUDevice; buffer: GPUBuffer }>();
    const createGroup = GPUDevice.prototype.createBindGroup;
    GPUDevice.prototype.createBindGroup = function (this: GPUDevice, descriptor: GPUBindGroupDescriptor) {
      const group = createGroup.call(this, descriptor);
      for (const entry of descriptor.entries) {
        const buffer = (entry.resource as { buffer?: GPUBuffer }).buffer;
        if (entry.binding === 2 && buffer && ['Source ID states', 'Candidate source states'].includes(buffer.label)) {
          groups.set(group, { device: this, buffer });
          if (!devices.has(this)) { devices.add(this); window.selectionHistoryObservation.projectionDevices++; }
        }
      }
      return group;
    };
    const setGroup = GPUComputePassEncoder.prototype.setBindGroup;
    GPUComputePassEncoder.prototype.setBindGroup = function (this: GPUComputePassEncoder, ...args: unknown[]) {
      const group = args[1] as GPUBindGroup | null, source = group && groups.get(group);
      if (source) projected = source;
      Reflect.apply(setGroup, this, args);
    };
    window.selectionHistoryObservation = {
      projectionDevices: 0,
      async snapshot() {
        const current = projected;
        if (!current || current.buffer.size !== 20) throw new Error('The actual five-splat projection states are unavailable.');
        const readback = current.device.createBuffer({ label: 'Selection history oracle readback', size: 20,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        try {
          const encoder = current.device.createCommandEncoder();
          encoder.copyBufferToBuffer(current.buffer, 0, readback, 0, 20); current.device.queue.submit([encoder.finish()]);
          await readback.mapAsync(GPUMapMode.READ);
          const gpuMasks = Array.from(new Uint32Array(readback.getMappedRange().slice(0))); readback.unmap();
          return { commands: structuredClone(commands), summary: summary && structuredClone(summary), nativeMasks: nativeMasks?.slice(),
            gpuMasks, workers, imports, projectionDevices: this.projectionDevices, graphicsLosses, overflow };
        } finally { readback.destroy(); }
      },
      async loseGraphics() {
        if (!projected) throw new Error('No actual projection device is available.');
        const device = projected.device; graphicsLosses++; device.destroy(); await device.lost;
      },
    };
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      private requests = new Map<number, { type?: string; channel?: string }>();
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options); workers++;
        this.addEventListener('message', event => {
          const value = event.data, request = this.requests.get(value?.requestId);
          if (value?.summary) summary = structuredClone(value.summary);
          if (value?.type === 'masks' && value.bytes instanceof ArrayBuffer &&
              (request?.type === 'masks' || request?.type === 'stream') && (!request.channel || request.channel === 'document')) {
            if (value.bytes.byteLength === 5) nativeMasks = Array.from(new Uint8Array(value.bytes)); else overflow = true;
          }
        });
      }
      override postMessage(value: unknown, options?: Transferable[] | StructuredSerializeOptions) {
        const data = value as { requestId?: number; type?: string; channel?: string; command?: SceneCommand };
        if (data.requestId !== undefined && data.type !== 'ack') {
          if (this.requests.size < 512 || this.requests.has(data.requestId)) this.requests.set(data.requestId, { type: data.type, channel: data.channel });
          else overflow = true;
        }
        if (data.type === 'source-load' || data.type === 'source-group-load') imports++;
        if (data.command) { if (commands.length < 256) commands.push(structuredClone(data.command)); else overflow = true; }
        if (Array.isArray(options)) super.postMessage(value, options); else super.postMessage(value, options);
      }
    };
  });
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  await page.getByLabel('Open scene files').setInputFiles({ name: 'selection-history.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(queuePly()) });
  const tools = page.getByRole('complementary', { name: 'Tools', exact: true });
  if (!await tools.isVisible()) await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect(tools.locator('.model-stats')).toHaveText('0/5 splats | SH0');
  return { tools, scene: page.getByLabel('SplatView scene', { exact: true }), manual: page.locator('.manual-selection-finish'),
    all: tools.getByRole('button', { name: 'Select all', exact: true }),
    // Deliberately use the ordinary toolbar command: no floating-Clear latch.
    clear: tools.getByRole('button', { name: 'Clear selection', exact: true }),
    undo: tools.getByRole('button', { name: 'Undo', exact: true }), redo: tools.getByRole('button', { name: 'Redo', exact: true }) };
}
async function snapshot(page: Page) {
  await expect(page.locator('.status.panel')).toHaveCount(0);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return page.evaluate(() => window.selectionHistoryObservation.snapshot());
}
async function masks(page: Page, tools: Locator, expected: number[]) {
  const selected = expected.filter(value => value === 1).length, visible = expected.filter(value => value !== 2).length;
  await expect(tools.locator('.model-stats')).toHaveText(`${selected}/${visible} splats | SH0`);
  await expect.poll(async () => {
    const value = await snapshot(page);
    return { selected: value.summary?.selected, visible: value.summary?.visible, pending: value.summary?.pending,
      nativeMasks: value.nativeMasks, gpuMasks: value.gpuMasks, overflow: value.overflow };
  }).toEqual({ selected, visible, pending: false, nativeMasks: expected, gpuMasks: expected, overflow: false });
  const value = await snapshot(page);
  expect(value.summary).toMatchObject({ ok: true, loaded: true, count: 5, sourceCount: 5,
    transaction: false, selectionDraft: false, filter: null });
  expect(Number.isSafeInteger(value.summary!.undoSelectionRevision)).toBe(true);
  expect(value.summary!.undoSelectionRevision).toBeGreaterThanOrEqual(0);
  expect(value.workers).toBe(1); expect(value.imports).toBe(1);
  return value;
}
const all = [1, 1, 1, 1, 1], none = [0, 0, 0, 0, 0], deleted = [2, 2, 2, 2, 2];

test('shipped zero-result toolbar selection history survives manual switches and profiles, then expires on reentry', async ({ page }, info) => {
  const f = await open(page); await f.all.click(); const beforeEntry = await masks(page, f.tools, all);
  await chooseSelectionTool(page, 'Single splat'); await f.clear.click();
  const cleared = await masks(page, f.tools, none);
  expect(cleared.summary!.undoSelectionRevision).toBeGreaterThan(beforeEntry.summary!.revision);
  await expect(f.manual).toBeVisible(); await expect(f.manual.getByRole('button', { name: 'Undo (Selection)', exact: true })).toBeEnabled();
  await chooseSelectionTool(page, 'Box select'); await expect(f.manual).toBeVisible();
  await chooseSelectionTool(page, 'Fill'); await expect(f.manual).toBeVisible();
  // A same-tool shortcut rearms input without starting a new history window.
  await f.scene.focus(); await page.keyboard.press('g'); await expect(f.manual).toBeVisible();
  const mode = f.tools.locator('.mode-button'); await expect(mode).toHaveAttribute('aria-pressed', 'true');
  await mode.click(); await expect(mode).toHaveAttribute('aria-pressed', 'false'); await expect(f.manual).toBeVisible();
  await mode.click(); await expect(mode).toHaveAttribute('aria-pressed', 'true'); await expect(f.manual).toBeVisible();
  const continued = await masks(page, f.tools, none);
  expect(continued.summary).toMatchObject({ revision: cleared.summary!.revision,
    undoSelectionRevision: cleared.summary!.undoSelectionRevision, contentRevision: cleared.summary!.contentRevision });
  await chooseSelectionTool(page, 'Navigate'); await expect(f.manual).toBeHidden();
  await chooseSelectionTool(page, 'Single splat'); await expect(f.manual).toBeHidden();
  const reentered = await masks(page, f.tools, none);
  expect(reentered.summary!.canUndo).toBe(true); expect(reentered.summary!.undoSelectionRevision).toBe(cleared.summary!.undoSelectionRevision);
  await info.attach('continuous-manual-session-and-fresh-entry', { body: JSON.stringify({ beforeEntry, cleared, continued, reentered }), contentType: 'application/json' });
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('shipped Undo and Redo preserve the original selection stamp, including Redo of history older than a new entry', async ({ page }, info) => {
  const f = await open(page); await f.all.click(); const oldSelection = await masks(page, f.tools, all);
  await chooseSelectionTool(page, 'Single splat'); await f.clear.click(); const cleared = await masks(page, f.tools, none);
  await expect(f.manual).toBeVisible(); await f.undo.click(); const undone = await masks(page, f.tools, all);
  expect(undone.summary!.undoSelectionRevision).toBe(oldSelection.summary!.undoSelectionRevision);
  await f.redo.click(); const redone = await masks(page, f.tools, none); await expect(f.manual).toBeVisible();
  expect(redone.summary!.revision).toBeGreaterThan(cleared.summary!.revision);
  expect(redone.summary!.undoSelectionRevision).toBe(cleared.summary!.undoSelectionRevision);
  await chooseSelectionTool(page, 'Navigate'); await f.undo.click(); const beforeNewEntry = await masks(page, f.tools, all);
  await chooseSelectionTool(page, 'Single splat'); await f.redo.click(); const oldRedone = await masks(page, f.tools, none);
  expect(oldRedone.summary!.canUndo).toBe(true);
  expect(oldRedone.summary!.undoSelectionRevision).toBe(cleared.summary!.undoSelectionRevision);
  expect(oldRedone.summary!.undoSelectionRevision).toBeLessThanOrEqual(beforeNewEntry.summary!.revision);
  await expect(f.manual).toBeHidden();
  // New selection changes in that same reentered session qualify normally.
  await f.undo.click(); await masks(page, f.tools, all); await f.clear.click(); const fresh = await masks(page, f.tools, none);
  expect(fresh.summary!.undoSelectionRevision).toBeGreaterThan(beforeNewEntry.summary!.revision); await expect(f.manual).toBeVisible();
  await info.attach('original-stamps-across-undo-redo-and-reentry', { body: JSON.stringify({ oldSelection, cleared, undone, redone, beforeNewEntry, oldRedone, fresh }), contentType: 'application/json' });
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('shipped nonselection top history blocks an empty manual tray and Undo exposes eligible selection history again', async ({ page }, info) => {
  const f = await open(page); await f.all.click(); const beforeEntry = await masks(page, f.tools, all);
  await chooseSelectionTool(page, 'Single splat'); await f.clear.click(); const cleared = await masks(page, f.tools, none);
  await f.all.click(); const selected = await masks(page, f.tools, all);
  expect(selected.summary!.undoSelectionRevision).toBeGreaterThan(beforeEntry.summary!.revision);
  await f.tools.getByRole('button', { name: 'Delete selected', exact: true }).click(); const removed = await masks(page, f.tools, deleted);
  expect(removed.summary!.canUndo).toBe(true); expect(removed.summary!.undoSelectionRevision).toBe(0);
  await expect(f.tools.getByRole('button', { name: 'Selection tool', exact: true }).getByText('Single splat', { exact: true })).toBeVisible();
  await expect(f.manual).toBeHidden();
  await f.undo.click(); const restored = await masks(page, f.tools, all);
  expect(restored.summary!.undoSelectionRevision).toBe(selected.summary!.undoSelectionRevision);
  await f.undo.click(); const emptyAgain = await masks(page, f.tools, none);
  expect(emptyAgain.summary!.undoSelectionRevision).toBe(cleared.summary!.undoSelectionRevision); await expect(f.manual).toBeVisible();
  await f.redo.click(); await masks(page, f.tools, all); await f.redo.click(); const removedAgain = await masks(page, f.tools, deleted);
  expect(removedAgain.summary!.undoSelectionRevision).toBe(0); await expect(f.manual).toBeHidden();
  await info.attach('only-the-top-undo-entry-qualifies', { body: JSON.stringify({ beforeEntry, cleared, selected, removed, restored, emptyAgain, removedAgain }), contentType: 'application/json' });
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('shipped graphics-only device recovery preserves the continuous manual history window', async ({ page }, info) => {
  const f = await open(page); await f.all.click(); await masks(page, f.tools, all);
  await chooseSelectionTool(page, 'Single splat'); await f.clear.click(); const before = await masks(page, f.tools, none);
  await expect(f.manual).toBeVisible(); await page.evaluate(() => window.selectionHistoryObservation.loseGraphics());
  await expect.poll(async () => {
    // Device loss normally retries automatically. If it needs the exposed
    // Retry action, use the same UI recovery available to the user.
    const retry = page.getByRole('button', { name: 'Retry graphics', exact: true });
    if (await retry.first().isVisible()) await retry.first().click();
    return page.evaluate(() => window.selectionHistoryObservation.projectionDevices);
  }, { timeout: 30_000 }).toBe(before.projectionDevices + 1);
  await expect(f.undo).toBeEnabled(); await expect(f.manual).toBeVisible(); const recovered = await masks(page, f.tools, none);
  expect(recovered.graphicsLosses).toBe(1); expect(recovered.projectionDevices).toBe(before.projectionDevices + 1);
  expect(recovered.summary).toMatchObject({ revision: before.summary!.revision, contentRevision: before.summary!.contentRevision,
    undoSelectionRevision: before.summary!.undoSelectionRevision, canUndo: true });
  expect(recovered.commands.slice(before.commands.length).filter(command => ['selectAll', 'selectNone', 'undo', 'redo'].includes(command.command))).toEqual([]);
  await f.undo.click(); await masks(page, f.tools, all); await f.redo.click(); const redone = await masks(page, f.tools, none);
  expect(redone.summary!.undoSelectionRevision).toBe(before.summary!.undoSelectionRevision); await expect(f.manual).toBeVisible();
  await info.attach('graphics-only-session-retention', { body: JSON.stringify({ before, recovered, redone }), contentType: 'application/json' });
  await expect(page.getByRole('alert')).toHaveCount(0);
});
