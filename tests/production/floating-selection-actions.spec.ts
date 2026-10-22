import { expect, test, type Locator, type Page } from '@playwright/test';
import { queuePly } from '../../e2e/queue-fixture';
import { chooseSelectionTool } from '../../e2e/selectTool';
import type { NativeSummary, SceneCommand } from '../../src/document/types';

type FloatingSnapshot = { commands: SceneCommand[]; summary?: NativeSummary; nativeMasks?: number[]; gpuMasks: number[]; overflow: boolean };
declare global { interface Window { floatingActionsObservation: { snapshot(): Promise<FloatingSnapshot> } } }

/** Observe actual shipping worker replies and the states buffer bound to the
 * real projection pass. The only extra GPU work is a 20-byte readonly copy;
 * no app/controller exports, replacement results or development modules. */
async function open(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('splatview.tools-mode.v1', 'pro');
    const commands: SceneCommand[] = [];
    let summary: NativeSummary | undefined, nativeMasks: number[] | undefined, overflow = false;
    let projected: { device: GPUDevice; buffer: GPUBuffer } | undefined;
    const groups = new WeakMap<GPUBindGroup, { device: GPUDevice; buffer: GPUBuffer }>();
    const createGroup = GPUDevice.prototype.createBindGroup;
    GPUDevice.prototype.createBindGroup = function (this: GPUDevice, descriptor: GPUBindGroupDescriptor) {
      const group = createGroup.call(this, descriptor);
      for (const entry of descriptor.entries) {
        const buffer = (entry.resource as { buffer?: GPUBuffer }).buffer;
        if (entry.binding === 2 && buffer && ['Source ID states', 'Candidate source states'].includes(buffer.label))
          groups.set(group, { device: this, buffer });
      }
      return group;
    };
    const setGroup = GPUComputePassEncoder.prototype.setBindGroup;
    GPUComputePassEncoder.prototype.setBindGroup = function (this: GPUComputePassEncoder, ...args: unknown[]) {
      const group = args[1] as GPUBindGroup | null, source = group && groups.get(group);
      if (source) projected = source;
      Reflect.apply(setGroup, this, args);
    };
    window.floatingActionsObservation = { async snapshot() {
      const current = projected;
      if (!current || current.buffer.size !== 20) throw new Error('The actual five-splat projection states are unavailable.');
      const readback = current.device.createBuffer({ label: 'Floating action oracle readback', size: 20,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      try {
        const encoder = current.device.createCommandEncoder();
        encoder.copyBufferToBuffer(current.buffer, 0, readback, 0, 20); current.device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const gpuMasks = Array.from(new Uint32Array(readback.getMappedRange().slice(0))); readback.unmap();
        return { commands: structuredClone(commands), summary: summary && structuredClone(summary), nativeMasks: nativeMasks?.slice(), gpuMasks, overflow };
      } finally { readback.destroy(); }
    } };
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      private requests = new Map<number, { type?: string; channel?: string }>();
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
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
        if (data.command) { if (commands.length < 256) commands.push(structuredClone(data.command)); else overflow = true; }
        if (Array.isArray(options)) super.postMessage(value, options); else super.postMessage(value, options);
      }
    };
  });
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  await page.getByLabel('Open scene files').setInputFiles({ name: 'floating-actions.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(queuePly()) });
  const tools = page.getByRole('complementary', { name: 'Tools', exact: true });
  if (!await tools.isVisible()) await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect(tools.locator('.model-stats')).toHaveText('0/5 splats | SH0');
  return { tools, scene: page.getByLabel('SplatView scene', { exact: true }),
    manual: page.locator('.manual-selection-finish'), filter: page.locator('.filter-finish'),
    undo: tools.getByRole('button', { name: 'Undo', exact: true }), redo: tools.getByRole('button', { name: 'Redo', exact: true }) };
}
async function snapshot(page: Page) {
  await expect(page.locator('.status.panel')).toHaveCount(0);
  // Wait for the app's invalidated real render to bind its published masks.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return page.evaluate(() => window.floatingActionsObservation.snapshot());
}
async function masks(page: Page, tools: Locator, expected: number[], filterDraft: boolean) {
  await expect(tools.locator('.model-stats')).toHaveText(`${expected.filter(value => value === 1).length}/5 splats | SH0`);
  const value = await snapshot(page);
  expect(value.overflow).toBe(false); expect(value.nativeMasks).toEqual(expected); expect(value.gpuMasks).toEqual(expected);
  expect(value.summary).toMatchObject({ ok: true, loaded: true, count: 5, sourceCount: 5, pending: false, transaction: false, selectionDraft: false });
  if (filterDraft) expect(value.summary!.filter).not.toBeNull(); else expect(value.summary!.filter).toBeNull();
  return value;
}
async function sphere(page: Page, tools: Locator) {
  await tools.getByRole('button', { name: 'Selection filter', exact: true }).click();
  await page.getByRole('menu', { name: 'Selection filters', exact: true }).getByRole('menuitemradio', { name: 'Sphere', exact: true }).click();
  const preview = tools.getByRole('button', { name: 'Preview', exact: true });
  await expect(tools.getByRole('spinbutton', { name: 'Radius', exact: true })).toBeEnabled();
  await tools.getByRole('spinbutton', { name: 'Center / position X', exact: true }).fill('-.6');
  await tools.getByRole('spinbutton', { name: 'Radius', exact: true }).fill('.25');
  await preview.click();
  return masks(page, tools, [1, 1, 0, 0, 0], true);
}

test('shipped manual Clear keeps its tool, floating Undo restores highlights, and Check finishes in Orbit', async ({ page }, info) => {
  const f = await open(page); await chooseSelectionTool(page, 'Single splat');
  await f.tools.getByRole('button', { name: 'Select all', exact: true }).click();
  const selected = await masks(page, f.tools, [1, 1, 1, 1, 1], false);
  await f.manual.getByRole('button', { name: 'Clear selection (C)', exact: true }).click();
  const cleared = await masks(page, f.tools, [0, 0, 0, 0, 0], false);
  await expect(f.tools.getByRole('button', { name: 'Selection tool', exact: true }).getByText('Single splat', { exact: true })).toBeVisible();
  await f.manual.getByRole('button', { name: 'Undo (Selection)', exact: true }).click();
  const restored = await masks(page, f.tools, [1, 1, 1, 1, 1], false);
  expect(restored.summary!.canRedo).toBe(true); expect(restored.summary!.contentRevision).toBe(selected.summary!.contentRevision);
  await f.manual.getByRole('button', { name: 'Finalize selection', exact: true }).click();
  await expect(f.tools.getByRole('button', { name: 'Selection tool', exact: true }).getByText('Navigate', { exact: true })).toBeVisible();
  await expect(f.manual).toBeHidden(); const finished = await masks(page, f.tools, [1, 1, 1, 1, 1], false);
  expect(finished.summary).toMatchObject({ revision: restored.summary!.revision, contentRevision: restored.summary!.contentRevision,
    canUndo: restored.summary!.canUndo, canRedo: restored.summary!.canRedo });
  await f.redo.click(); await masks(page, f.tools, [0, 0, 0, 0, 0], false);
  await info.attach('manual-floating-native-gpu-history', { body: JSON.stringify({ selected, cleared, restored, finished }), contentType: 'application/json' });
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('shipped filter X clears its last acknowledged preview without evaluating invalid dirty Radius, then Undo restores it', async ({ page }, info) => {
  const f = await open(page); await f.tools.getByRole('button', { name: 'Select all', exact: true }).click();
  await masks(page, f.tools, [1, 1, 1, 1, 1], false); const accepted = await sphere(page, f.tools);
  const radius = f.tools.getByRole('spinbutton', { name: 'Radius', exact: true });
  await radius.fill('-1'); await radius.blur();
  const dirty = await masks(page, f.tools, [1, 1, 0, 0, 0], true);
  expect(dirty.summary!.filter).toEqual(accepted.summary!.filter);
  const start = dirty.commands.length;
  await f.filter.getByRole('button', { name: 'Clear selection (C)', exact: true }).click();
  const cleared = await masks(page, f.tools, [0, 0, 0, 0, 0], true);
  await expect(radius).toHaveValue('-1.000'); expect(cleared.summary!.filter).toMatchObject({ kind: 'sphere', epoch: 0, previewEpoch: null, changed: false });
  const clearCommands = cleared.commands.slice(start), confirm = clearCommands.find(command => command.command === 'confirmFilter');
  expect(confirm).toMatchObject({ id: accepted.summary!.filter!.id, epoch: accepted.summary!.filter!.previewEpoch, visiblePreview: true });
  expect(clearCommands.filter(command => command.command === 'previewFilter')).toEqual([]);
  expect(clearCommands.filter(command => ['confirmFilter', 'selectNone', 'beginFilter'].includes(command.command)).map(command => command.command))
    .toEqual(['confirmFilter', 'selectNone', 'beginFilter']);
  await f.filter.getByRole('button', { name: 'Undo (Filter)', exact: true }).click();
  const restored = await masks(page, f.tools, [1, 1, 0, 0, 0], true);
  expect(restored.summary!.filter).toMatchObject({ kind: 'sphere', epoch: 0, previewEpoch: null, changed: false });
  expect(restored.summary!.canRedo).toBe(true); await expect(radius).toHaveValue('-1.000');
  expect(restored.commands.slice(start).filter(command => command.command === 'previewFilter')).toEqual([]);
  await f.scene.focus(); await page.keyboard.press('Escape'); await masks(page, f.tools, [1, 1, 0, 0, 0], false);
  await f.redo.click(); await masks(page, f.tools, [0, 0, 0, 0, 0], false);
  await info.attach('filter-visible-epoch-clear-and-undo', { body: JSON.stringify({ accepted, dirty, cleared, restored }), contentType: 'application/json' });
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('shipped changed filter Undo cancels the draft before an older history Undo and keeps the enclosure paused', async ({ page }, info) => {
  const f = await open(page); await f.tools.getByRole('button', { name: 'Select all', exact: true }).click();
  const baseline = await masks(page, f.tools, [1, 1, 1, 1, 1], false), changed = await sphere(page, f.tools);
  expect(changed.summary!.filter).toMatchObject({ changed: true }); const start = changed.commands.length;
  await f.filter.getByRole('button', { name: 'Undo (Filter)', exact: true }).click();
  const cancelled = await masks(page, f.tools, [1, 1, 1, 1, 1], true);
  expect(cancelled.summary!.canUndo).toBe(true); expect(cancelled.summary!.contentRevision).toBe(baseline.summary!.contentRevision);
  expect(cancelled.summary!.filter).toMatchObject({ kind: 'sphere', epoch: 0, previewEpoch: null, changed: false });
  expect(cancelled.commands.slice(start).filter(command => command.command === 'undo')).toEqual([]);
  await expect(f.tools.getByRole('spinbutton', { name: 'Radius', exact: true })).toHaveValue('0.250');
  await f.filter.getByRole('button', { name: 'Undo (Filter)', exact: true }).click();
  const undone = await masks(page, f.tools, [0, 0, 0, 0, 0], true);
  expect(undone.commands.slice(start).filter(command => command.command === 'undo')).toHaveLength(1);
  expect(undone.summary!.canRedo).toBe(true); expect(undone.summary!.filter).toMatchObject({ previewEpoch: null, changed: false });
  await info.attach('filter-draft-priority-before-history', { body: JSON.stringify({ baseline, changed, cancelled, undone }), contentType: 'application/json' });
  await expect(page.getByRole('alert')).toHaveCount(0);
});
