import { expect, test, type Page } from '@playwright/test';
import { queuePly } from '../../e2e/queue-fixture';
import { exportBytes } from './initialization-helpers';
import type { NativeSummary, SceneCommand } from '../../src/document/types';

type Gaussian = { position: number[]; covariance: number[]; appearance: number[]; opacity: number };
type NativeStream = { channel: string; baseId?: number; records: Gaussian[] };
type Observation = { commands: SceneCommand[]; summary?: NativeSummary; streams: NativeStream[]; gpu: Gaussian[];
  gpuMasks: number[]; nativeMasks?: number[]; targets: number[]; overflow: boolean;
  projectionDevices: number; graphicsLosses: number; workers: number; sourceLoads: number };
declare global { interface Window { gizmoActionsObservation: {
  projectionDevices: number; snapshot(): Promise<Observation>; loseGraphics(): Promise<void>;
} } }

/** Observe the actual projection bind group and uniform writes, then copy its
 * five packed records and masks. All observations are bounded; no development
 * app exports or replacement worker/native results are involved. */
async function open(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('splatview.tools-mode.v1', 'pro');
    const commands: SceneCommand[] = [], streams: NativeStream[] = [];
    let summary: NativeSummary | undefined, nativeMasks: number[] | undefined, overflow = false;
    let graphicsLosses = 0, workers = 0, sourceLoads = 0;
    type Projection = { device: GPUDevice; frame: GPUBuffer; records: GPUBuffer; states: GPUBuffer; targets: GPUBuffer };
    const groups = new WeakMap<GPUBindGroup, Projection>(), uniforms = new WeakMap<GPUBuffer, Float32Array>(), devices = new WeakSet<GPUDevice>();
    let projected: Projection | undefined;
    const unpack = (bytes: ArrayBuffer): Gaussian[] => {
      if (bytes.byteLength !== 240) throw new Error('The five-splat SH0 records must occupy 240 bytes.');
      const view = new DataView(bytes);
      return Array.from({ length: 5 }, (_, id) => ({
        position: [0, 4, 8].map(offset => view.getFloat32(id * 48 + offset, true)),
        covariance: [16, 20, 24, 28, 32, 36].map(offset => view.getFloat32(id * 48 + offset, true)),
        opacity: view.getFloat32(id * 48 + 12, true), appearance: Array.from(new Uint8Array(bytes, id * 48 + 40, 8)),
      }));
    };
    const create = GPUDevice.prototype.createBindGroup;
    GPUDevice.prototype.createBindGroup = function (this: GPUDevice, descriptor: GPUBindGroupDescriptor) {
      const group = create.call(this, descriptor), buffers = new Map<number, GPUBuffer>();
      for (const entry of descriptor.entries) { const buffer = (entry.resource as { buffer?: GPUBuffer }).buffer; if (buffer) buffers.set(entry.binding, buffer); }
      const records = buffers.get(1), states = buffers.get(2), frame = buffers.get(0);
      if (records?.label === 'Packed native covariance and SH' && states && frame) {
        groups.set(group, { device: this, frame, records, states, targets: buffers.get(9) ?? states });
        if (!devices.has(this)) { devices.add(this); window.gizmoActionsObservation.projectionDevices++; }
      }
      return group;
    };
    const set = GPUComputePassEncoder.prototype.setBindGroup;
    GPUComputePassEncoder.prototype.setBindGroup = function (this: GPUComputePassEncoder, ...args: unknown[]) {
      const group = args[1] as GPUBindGroup | null, source = group && groups.get(group); if (source) projected = source;
      Reflect.apply(set, this, args);
    };
    const write = GPUQueue.prototype.writeBuffer;
    GPUQueue.prototype.writeBuffer = function (this: GPUQueue, ...args: unknown[]) {
      const buffer = args[0] as GPUBuffer, data = args[2];
      if (args[1] === 0 && buffer.size === 320 && data instanceof Float32Array && data.length === 80 && args[3] === undefined)
        uniforms.set(buffer, data.slice());
      Reflect.apply(write, this, args);
    };
    const read = async (value: Projection, buffer: GPUBuffer, size: number) => {
      const output = value.device.createBuffer({ label: 'Gizmo action oracle readback', size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      try {
        const encoder = value.device.createCommandEncoder(); encoder.copyBufferToBuffer(buffer, 0, output, 0, size);
        value.device.queue.submit([encoder.finish()]); await output.mapAsync(GPUMapMode.READ);
        const bytes = output.getMappedRange().slice(0); output.unmap(); return bytes;
      } finally { output.destroy(); }
    };
    window.gizmoActionsObservation = { projectionDevices: 0, async snapshot() {
      const value = projected, uniform = value && uniforms.get(value.frame);
      if (!value || !uniform) throw new Error('The actual shipping projection frame is unavailable.');
      const [packed, states, targetBytes] = await Promise.all([read(value, value.records, 240), read(value, value.states, 20), read(value, value.targets, 20)]);
      const gpu = unpack(packed), targets = Array.from(new Uint32Array(targetBytes)), flags = new Uint32Array(uniform.buffer);
      const a = Array.from({ length: 3 }, (_, row) => [0, 1, 2].map(column => uniform[60 + column * 4 + row]));
      // Apply the matrix and eligibility actually supplied to WGSL, rather than
      // assuming raw retained source buffers are already materialized geometry.
      for (let id = 0; id < gpu.length; id++) if (flags[76] && (!flags[77] || (targets[id] & 1))) {
        const record = gpu[id], p = record.position, c = record.covariance;
        record.position = a.map((row, axis) => row.reduce((sum, component, at) => sum + component * p[at], uniform[72 + axis]));
        const matrix = [[c[0], c[1], c[2]], [c[1], c[3], c[4]], [c[2], c[4], c[5]]];
        const transformed = a.map(left => a.map(right => left.reduce((sum, x, i) => sum + right.reduce((part, y, j) => part + x * matrix[i][j] * y, 0), 0)));
        record.covariance = [transformed[0][0], transformed[0][1], transformed[0][2], transformed[1][1], transformed[1][2], transformed[2][2]];
      }
      return { commands: structuredClone(commands), summary: summary && structuredClone(summary), streams: structuredClone(streams),
        gpu, gpuMasks: Array.from(new Uint32Array(states)), nativeMasks: nativeMasks?.slice(), targets, overflow,
        projectionDevices: this.projectionDevices, graphicsLosses, workers, sourceLoads };
    }, async loseGraphics() {
      if (!projected) throw new Error('No actual shipping projection device is available.');
      const device = projected.device; graphicsLosses++; device.destroy(); await device.lost;
    } };
    const Original = window.Worker;
    window.Worker = class extends Original {
      private requests = new Map<number, { type?: string; channel?: string; transformBase?: { baseId: number } }>();
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options); workers++; this.addEventListener('message', event => {
          const value = event.data, request = this.requests.get(value?.requestId);
          if (value?.summary) summary = structuredClone(value.summary);
          if (value?.type === 'chunk' && value.bytes instanceof ArrayBuffer && request?.type === 'stream') {
            if (value.first === 0 && value.count === 5 && value.bytes.byteLength === 240) {
              streams.push({ channel: request.channel ?? 'document', baseId: request.transformBase?.baseId, records: unpack(value.bytes) });
              if (streams.length > 12) streams.shift();
            } else overflow = true;
          }
          if (value?.type === 'masks' && value.bytes instanceof ArrayBuffer &&
              (request?.type === 'stream' || request?.type === 'masks') && (!request.channel || request.channel === 'document')) {
            if (value.bytes.byteLength === 5) nativeMasks = Array.from(new Uint8Array(value.bytes)); else overflow = true;
          }
        });
      }
      override postMessage(value: unknown, options?: Transferable[] | StructuredSerializeOptions) {
        const request = value as { requestId?: number; type?: string; channel?: string; transformBase?: { baseId: number }; command?: SceneCommand };
        if (request.type === 'source-load' || request.type === 'source-group-load') sourceLoads++;
        if (request.requestId !== undefined && request.type !== 'ack') {
          if (this.requests.size < 1024) this.requests.set(request.requestId, { type: request.type, channel: request.channel, transformBase: request.transformBase });
          else overflow = true;
        }
        if (request.command) { if (commands.length < 256) commands.push(structuredClone(request.command)); else overflow = true; }
        if (Array.isArray(options)) super.postMessage(value, options); else super.postMessage(value, options);
      }
    };
  });
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  await page.getByLabel('Open scene files').setInputFiles({ name: 'gizmo-actions.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(queuePly()) });
  const tools = page.getByRole('complementary', { name: 'Tools', exact: true });
  if (!await tools.isVisible()) await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await tools.getByRole('button', { name: 'Select all', exact: true }).click(); await expect(tools.locator('.model-stats')).toHaveText('5/5 splats | SH0');
  return { tools, scene: page.getByLabel('SplatView scene', { exact: true }), tray: page.locator('.transform-gizmo-finish'),
    widget: tools.getByRole('group', { name: 'Transform gizmo', exact: true }),
    undo: tools.getByRole('button', { name: 'Undo', exact: true }), redo: tools.getByRole('button', { name: 'Redo', exact: true }) };
}
async function snapshot(page: Page) {
  await expect(page.locator('.status.panel')).toHaveCount(0);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const value = await page.evaluate(() => window.gizmoActionsObservation.snapshot());
  expect(value.overflow).toBe(false); expect(value.nativeMasks).toEqual([1, 1, 1, 1, 1]); expect(value.gpuMasks).toEqual(value.nativeMasks);
  expect(value.workers).toBe(1); expect(value.sourceLoads).toBe(1);
  expect(value.summary).toMatchObject({ ok: true, loaded: true, count: 5, sourceCount: 5, selected: 5, pending: false, transaction: false });
  return value;
}
async function target(page: Page, handle = 1) {
  const candidates = await page.locator('.transform-gizmo-overlay').evaluate((svg, handle) => {
    const box = document.querySelector('canvas')!.getBoundingClientRect();
    const lines = Array.from(svg.querySelectorAll<SVGLineElement>(`line[data-gizmo-handle="${handle}"]`));
    return lines.flatMap(line => {
      const x = line.x1.baseVal.value, y = line.y1.baseVal.value, dx = line.x2.baseVal.value - x, dy = line.y2.baseVal.value - y, length = Math.hypot(dx, dy);
      return length > 5 ? [.55, .75, .35].map(t => ({ x: box.left + x + t * dx, y: box.top + y + t * dy,
        endX: box.left + x + t * dx + 30 * dx / length, endY: box.top + y + t * dy + 30 * dy / length })) : [];
    });
  }, handle);
  for (const candidate of candidates) {
    await page.mouse.move(candidate.x, candidate.y);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    if (await page.locator('.transform-gizmo-overlay').getAttribute('data-gizmo-hit') === String(handle)) return candidate;
  }
  throw new Error(`No actual native hit was found on transform handle ${handle}.`);
}
async function drag(page: Page, previous: Observation, handle = 1, release = true) {
  const point = await target(page, handle); await page.mouse.down();
  await expect(page.locator('.transform-gizmo-overlay')).toHaveAttribute('data-gizmo-captured', String(handle));
  await page.mouse.move(point.endX, point.endY, { steps: 6 });
  if (!release) return previous;
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.gizmoActionsObservation.snapshot().then(value => value.summary!.contentRevision))).toBeGreaterThan(previous.summary!.contentRevision);
  await expect(page.locator('.transform-gizmo-finish')).toBeVisible(); return snapshot(page);
}
function closeRecords(actual: Gaussian[], expected: Gaussian[]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((record, id) => {
    record.position.forEach((value, axis) => expect(value).toBeCloseTo(expected[id].position[axis], 5));
    record.covariance.forEach((value, axis) => expect(value).toBeCloseTo(expected[id].covariance[axis], 5));
    expect(record.appearance).toEqual(expected[id].appearance); expect(record.opacity).toBe(expected[id].opacity);
  });
}
function transformed(records: Gaussian[], command: SceneCommand): Gaussian[] {
  const matrix = (command.parameters as { matrix: number[] }).matrix, a = [0, 1, 2].map(row => matrix.slice(row * 4, row * 4 + 3));
  return records.map(record => {
    const c = record.covariance, covariance = [[c[0], c[1], c[2]], [c[1], c[3], c[4]], [c[2], c[4], c[5]]];
    const result = a.map(left => a.map(right => left.reduce((sum, x, i) => sum + right.reduce((part, y, j) => part + x * covariance[i][j] * y, 0), 0)));
    return { ...record, position: a.map((row, axis) => Math.fround(row.reduce((sum, value, i) => sum + value * record.position[i], matrix[axis * 4 + 3]))),
      covariance: [result[0][0], result[0][1], result[0][2], result[1][1], result[1][2], result[2][2]].map(Math.fround) };
  });
}
function body(bytes: Buffer) { const offset = bytes.indexOf(Buffer.from('end_header\n')); expect(offset).toBeGreaterThan(0); return bytes.subarray(offset + 11); }
function exportedPositions(bytes: Buffer) {
  const header = bytes.subarray(0, bytes.indexOf(Buffer.from('end_header\n'))).toString(), payload = body(bytes);
  expect(header).toContain('format binary_little_endian 1.0'); expect(header).toContain('element vertex 5');
  const stride = payload.length / 5;
  return Array.from({ length: 5 }, (_, id) => [payload.readFloatLE(id * stride), -payload.readFloatLE(id * stride + 4), -payload.readFloatLE(id * stride + 8)]);
}

test('shipped multi-drag Scale remains armed, rebases native geometry and Check preserves incremental results', async ({ page }, info) => {
  const f = await open(page), baseline = await snapshot(page);
  await f.widget.getByRole('button', { name: 'Scale', exact: true }).click(); await expect(f.tray).toBeVisible();
  await expect(f.tray.getByRole('button', { name: 'Undo transform', exact: true })).toBeDisabled();
  const armed = await snapshot(page); expect(armed.summary!.transformSession!.gizmo).toMatchObject({ cancelBaseId: null, cancelContentRevision: null, canUndo: false, canRedo: false });
  await f.tray.getByRole('button', { name: 'Finish transform tool (Enter)', exact: true }).click(); await expect(f.tray).toBeHidden();
  expect((await snapshot(page)).summary!.revision).toBe(armed.summary!.revision);
  await f.widget.getByRole('button', { name: 'Scale', exact: true }).click(); await expect(f.tray).toBeVisible();
  const first = await drag(page, baseline, 12), firstBake = first.commands.filter(command => command.command === 'applyTransform').at(-1)!;
  expect(first.summary!.transformSession!.gizmo!.cancelBaseId).toBeGreaterThan(0);
  const expectedFirst = transformed(baseline.gpu, firstBake); closeRecords(first.gpu, expectedFirst);
  const firstNative = first.streams.findLast(stream => stream.channel === 'transformBase' && stream.baseId === first.summary!.transformSession!.baseId);
  expect(firstNative).toBeDefined(); closeRecords(firstNative!.records, expectedFirst);
  await expect(f.widget.getByRole('button', { name: 'Scale', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const second = await drag(page, first, 13), secondBake = second.commands.filter(command => command.command === 'applyTransform').at(-1)!;
  expect(second.summary!.transformSession!.id).toBe(first.summary!.transformSession!.id);
  expect(second.summary!.transformSession!.gizmo!.cancelBaseId).toBe(first.summary!.transformSession!.gizmo!.cancelBaseId);
  const expectedSecond = transformed(expectedFirst, secondBake); closeRecords(second.gpu, expectedSecond);
  const nativeBase = second.streams.findLast(stream => stream.channel === 'transformBase' && stream.baseId === second.summary!.transformSession!.baseId);
  expect(nativeBase).toBeDefined(); closeRecords(nativeBase!.records, expectedSecond);
  const settledRevision = second.summary!.revision;
  await f.tray.getByRole('button', { name: 'Finish transform tool (Enter)', exact: true }).click(); await expect(f.tray).toBeHidden();
  const checked = await snapshot(page); expect(checked.summary!.revision).toBe(settledRevision); expect(checked.summary!.transformSession).toBeNull(); closeRecords(checked.gpu, expectedSecond);
  const output = exportedPositions(await exportBytes(page, 'gizmo-actions'));
  output.forEach((position, id) => position.forEach((value, axis) => expect(value).toBeCloseTo(expectedSecond[id].position[axis], 5)));
  await info.attach('incremental-native-gpu-and-export', { body: JSON.stringify({ baseline, first, second, checked, output }), contentType: 'application/json' });
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('shipped gizmo floating Undo stops at entry and Cancel restores original geometry through an undoable edit', async ({ page }, info) => {
  const f = await open(page), originalBytes = await exportBytes(page, 'gizmo-actions'), baseline = await snapshot(page);
  await f.widget.getByRole('button', { name: 'Move', exact: true }).click();
  const first = await drag(page, baseline), second = await drag(page, first);
  const undo = f.tray.getByRole('button', { name: 'Undo transform', exact: true });
  await undo.click(); await expect.poll(async () => (await snapshot(page)).summary!.contentRevision).toBe(first.summary!.contentRevision);
  const undone = await snapshot(page); closeRecords(undone.gpu, first.gpu);
  await undo.click(); await expect(undo).toBeDisabled(); const atEntry = await snapshot(page); closeRecords(atEntry.gpu, baseline.gpu);
  expect(atEntry.summary!.transformSession!.gizmo).toMatchObject({ canUndo: false, canRedo: true });
  expect(atEntry.summary!.canUndo).toBe(true); // The pre-entry Select all is still real history.
  await f.redo.click(); await expect(undo).toBeEnabled(); await f.redo.click();
  await expect.poll(async () => (await snapshot(page)).summary!.contentRevision).toBe(second.summary!.contentRevision);
  closeRecords((await snapshot(page)).gpu, second.gpu);
  await f.tray.getByRole('button', { name: 'Cancel transforms (Esc)', exact: true }).click(); await expect(f.tray).toBeHidden();
  const cancelled = await snapshot(page); closeRecords(cancelled.gpu, baseline.gpu); expect(cancelled.summary!.contentRevision).toBe(baseline.summary!.contentRevision);
  expect(cancelled.summary!.transformSession).toBeNull();
  expect(body(await exportBytes(page, 'gizmo-actions')).equals(body(originalBytes))).toBe(true);
  await f.undo.click(); await expect.poll(async () => (await snapshot(page)).summary!.contentRevision).toBe(second.summary!.contentRevision);
  const restored = await snapshot(page); closeRecords(restored.gpu, second.gpu);
  await f.redo.click(); await expect.poll(async () => (await snapshot(page)).summary!.contentRevision).toBe(baseline.summary!.contentRevision);
  const redone = await snapshot(page); closeRecords(redone.gpu, baseline.gpu);
  await info.attach('session-undo-redo-and-undoable-cancel', { body: JSON.stringify({ baseline, first, second, undone, atEntry, cancelled, restored, redone }), contentType: 'application/json' });
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('shipped captured Ctrl+Z keeps earlier drags, profiles preserve the session, and Enter or Escape own the gizmo action', async ({ page }, info) => {
  const f = await open(page), baseline = await snapshot(page); await f.widget.getByRole('button', { name: 'Move', exact: true }).click();
  await drag(page, baseline, 1, false); await expect(f.tray).toBeHidden();
  await page.keyboard.press('ControlOrMeta+z'); await page.mouse.up(); await expect(f.tray).toBeVisible();
  const firstCancelled = await snapshot(page); closeRecords(firstCancelled.gpu, baseline.gpu);
  expect(firstCancelled.summary!.contentRevision).toBe(baseline.summary!.contentRevision);
  const first = await drag(page, firstCancelled); await drag(page, first, 1, false);
  await page.keyboard.press('ControlOrMeta+z'); await page.mouse.up(); await expect(f.tray).toBeVisible();
  const capturedUndo = await snapshot(page); closeRecords(capturedUndo.gpu, first.gpu); expect(capturedUndo.summary!.contentRevision).toBe(first.summary!.contentRevision);
  const owner = capturedUndo.summary!.transformSession!.id, mode = f.tools.locator('.mode-button');
  await mode.click(); await expect(mode).toHaveAttribute('aria-pressed', 'false'); await expect(f.tray).toBeVisible();
  expect((await snapshot(page)).summary!.transformSession!.id).toBe(owner);
  await mode.click(); await expect(mode).toHaveAttribute('aria-pressed', 'true'); await expect(f.tray).toBeVisible();
  await f.scene.focus(); await page.keyboard.press('Enter'); await expect(f.tray).toBeHidden(); const checked = await snapshot(page); closeRecords(checked.gpu, first.gpu);
  await f.widget.getByRole('button', { name: 'Move', exact: true }).click(); const later = await drag(page, checked);
  await f.scene.focus(); await page.keyboard.press('Escape'); await expect(f.tray).toBeHidden(); const escaped = await snapshot(page); closeRecords(escaped.gpu, first.gpu);
  expect(escaped.summary!.contentRevision).toBe(checked.summary!.contentRevision); expect(later.summary!.contentRevision).not.toBe(escaped.summary!.contentRevision);
  await info.attach('captured-keyboard-profile-and-fresh-cancel-base', { body: JSON.stringify({ baseline, firstCancelled, first, capturedUndo, checked, later, escaped }), contentType: 'application/json' });
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('shipped graphics-only device recovery retains the gizmo session and its exact original Cancel baseline', async ({ page }, info) => {
  const f = await open(page), originalBytes = await exportBytes(page, 'gizmo-actions'), baseline = await snapshot(page);
  await f.widget.getByRole('button', { name: 'Move', exact: true }).click();
  const first = await drag(page, baseline), before = await drag(page, first);
  const session = before.summary!.transformSession!, cancel = session.gizmo!;
  expect(cancel.cancelBaseId).toBeGreaterThan(0); expect(cancel.canUndo).toBe(true);
  await page.evaluate(() => window.gizmoActionsObservation.loseGraphics());
  await expect.poll(async () => {
    const retry = page.getByRole('button', { name: 'Retry graphics', exact: true });
    if (await retry.first().isVisible()) await retry.first().click();
    return page.evaluate(() => window.gizmoActionsObservation.projectionDevices);
  }, { timeout: 30_000 }).toBe(before.projectionDevices + 1);
  await expect(f.tray).toBeVisible(); await expect(f.widget.getByRole('button', { name: 'Move', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(f.tray.getByRole('button', { name: 'Undo transform', exact: true })).toBeEnabled();
  const recovered = await snapshot(page); closeRecords(recovered.gpu, before.gpu);
  expect(recovered.graphicsLosses).toBe(1); expect(recovered.summary!.revision).toBe(before.summary!.revision);
  expect(recovered.summary!.contentRevision).toBe(before.summary!.contentRevision);
  expect(recovered.summary!.transformSession).toMatchObject({ id: session.id, gizmo: {
    cancelBaseId: cancel.cancelBaseId, cancelContentRevision: cancel.cancelContentRevision, canUndo: true,
  } });
  expect(recovered.commands.slice(before.commands.length).filter(command =>
    ['beginTransform', 'applyTransform', 'rebaseTransform', 'undoTransform', 'redoTransform', 'cancelTransform', 'endTransform'].includes(command.command))).toEqual([]);
  await f.tray.getByRole('button', { name: 'Cancel transforms (Esc)', exact: true }).click(); await expect(f.tray).toBeHidden();
  const cancelled = await snapshot(page); closeRecords(cancelled.gpu, baseline.gpu);
  expect(cancelled.summary!.contentRevision).toBe(baseline.summary!.contentRevision); expect(cancelled.summary!.transformSession).toBeNull();
  expect(body(await exportBytes(page, 'gizmo-actions')).equals(body(originalBytes))).toBe(true);
  await info.attach('actual-device-loss-retained-cancel-owner-and-original-ply', { body: JSON.stringify({ baseline, first, before, recovered, cancelled }), contentType: 'application/json' });
  await expect(page.getByRole('alert')).toHaveCount(0);
});
