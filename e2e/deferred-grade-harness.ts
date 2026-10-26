import { requireWebGpuRenderer } from './gaussian-harness-scene';
import { admittedExport } from './admitted-export';
// Real App, worker, native edits and GPU readback. Only the timing of a genuine
// manual-grade reply and an explicitly tested publication refusal are gated.
import './auto-color-harness';
import { setApp, setSelectionPreferences, useApp, type SelectionTool } from '../src/app/store';
import type { CoreClient } from '../src/document/coreClient';
import type { DeferredSelectionOptions } from '../src/app/controller';
import type { NativeSummary, SceneCommand } from '../src/document/types';
import { NEUTRAL_COLOR } from '../src/renderer/defaults';
import { gesturePly, gesturePositions } from './gesture-fixture';
import type { OperationOwner } from '../src/document/operationProtocol';

const controller = () => window.geometryViewer.controllerForSourceNavigation();
type Call = { sequence: number; family: 'command' | 'livePreview' | 'operation'; command: SceneCommand; documentId: string; sourceGeneration: number;
  operationOwner?: OperationOwner;
  completed: boolean; failed: boolean; result?: Pick<NativeSummary, 'selected' | 'selectionDraft' | 'contentRevision' | 'transaction'> };
type Pointer = { type: string; pointerId: number; trusted: boolean; buttons: number; button: number; x: number; y: number;
  shift: boolean; primary: boolean; targetCanvas: boolean };
type MouseCompanion = { type: string; detail: number; trusted: boolean; x: number; y: number; targetCanvas: boolean };
type ReleasedCall = { tool: 'color' | 'fill'; x: number; y: number; operation: number; options: DeferredSelectionOptions | undefined };
const calls: Call[] = [], pointers: Pointer[] = [], mouseCompanions: MouseCompanion[] = [], releases: ReleasedCall[] = [];
const clients = new WeakSet<CoreClient>(), inFlight = new Set<Promise<unknown>>();
let sequence = 0, pointerInstalled = false, releaseObserverInstalled = false, held = false, publicationFailed = false, blurs = 0;
let replacement: Promise<void> | undefined, competing: Promise<boolean> | undefined;
let restorePublication: (() => void) | undefined;
let heldAuto: { pending: Promise<boolean>; release(): void; restore(): void } | undefined;

function observeClient() {
  const client = controller().client!;
  if (clients.has(client)) return;
  clients.add(client);
  const command = client.command.bind(client), live = client.livePreview.bind(client);
  const begin = client.beginOperation.bind(client), commit = client.commitOperation.bind(client), rollback = client.rollbackOperation.bind(client);
  function track<T>(family: Call['family'], request: SceneCommand, operation: () => Promise<T>, owner = client.operationOwner) {
    const call: Call = { sequence: ++sequence, family, command: structuredClone(request), documentId: client.revision.documentId,
      sourceGeneration: client.revision.sourceGeneration, ...(owner ? { operationOwner: structuredClone(owner) } : {}), completed: false, failed: false };
    calls.push(call);
    const pending = operation().then(value => {
      call.completed = true;
      const candidate = value && typeof value === 'object' && 'summary' in value ? value.summary : value;
      const summary = candidate as Partial<NativeSummary> | undefined;
      if (summary && typeof summary.selected === 'number' && typeof summary.selectionDraft === 'boolean' &&
        typeof summary.contentRevision === 'number' && typeof summary.transaction === 'boolean')
        call.result = { selected: summary.selected, selectionDraft: summary.selectionDraft,
          contentRevision: summary.contentRevision, transaction: summary.transaction };
      return value;
    }, error => {
      call.completed = true; call.failed = true; throw error;
    });
    inFlight.add(pending);
    void pending.then(() => inFlight.delete(pending), () => inFlight.delete(pending));
    return pending;
  }
  client.command = (...args) => track('command', args[0], () => command(...args));
  client.livePreview = (...args) => track('livePreview', args[0], () => live(...args));
  // These labels describe actual typed lifecycle invocations. Completion and
  // result fields below still come exclusively from each real native promise.
  client.beginOperation = owner => track('operation', { command: 'beginTransaction' }, () => begin(owner), owner);
  client.commitOperation = owner => track('operation', { command: 'commitTransaction' }, () => commit(owner), owner);
  client.rollbackOperation = owner => track('operation', { command: 'rollbackTransaction' }, () => rollback(owner), owner);
}
function installPointerObserver() {
  if (pointerInstalled) return;
  pointerInstalled = true;
  window.addEventListener('blur', () => { blurs++; });
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'gotpointercapture', 'lostpointercapture'])
    window.addEventListener(type, event => {
      if (!(event instanceof PointerEvent)) return;
      const canvas = requireWebGpuRenderer(controller().renderer).canvas, bounds = canvas.getBoundingClientRect();
      pointers.push({ type, pointerId: event.pointerId, trusted: event.isTrusted, buttons: event.buttons, button: event.button,
        x: Math.round((event.clientX - bounds.left) * canvas.width / bounds.width),
        y: Math.round((event.clientY - bounds.top) * canvas.height / bounds.height),
        shift: event.shiftKey, primary: /Mac|iPhone|iPad/.test(navigator.platform) ? event.metaKey : event.ctrlKey,
        targetCanvas: event.target === canvas });
    }, true);
  for (const type of ['mousedown', 'dblclick']) window.addEventListener(type, event => {
    if (!(event instanceof MouseEvent)) return;
    const canvas = requireWebGpuRenderer(controller().renderer).canvas, bounds = canvas.getBoundingClientRect();
    mouseCompanions.push({ type, detail: event.detail, trusted: event.isTrusted, targetCanvas: event.target === canvas,
      x: Math.round((event.clientX - bounds.left) * canvas.width / bounds.width),
      y: Math.round((event.clientY - bounds.top) * canvas.height / bounds.height) });
  }, true);
}
function installReleaseObserver() {
  if (releaseObserverInstalled) return;
  releaseObserverInstalled = true;
  const app = controller(), color = app.selectColorPixel.bind(app), fill = app.fillPixel.bind(app);
  app.selectColorPixel = (...args) => {
    releases.push({ tool: 'color', x: args[0], y: args[1], operation: args[2], options: structuredClone(args[3]) });
    return color(...args);
  };
  app.fillPixel = (...args) => {
    releases.push({ tool: 'fill', x: args[0], y: args[1], operation: args[2], options: structuredClone(args[3]) });
    return fill(...args);
  };
}
function state() {
  const value = useApp.getState(), app = controller(), canvas = requireWebGpuRenderer(app.renderer).canvas;
  const pointerId = pointers.findLast(pointer => pointer.type === 'pointerdown')?.pointerId;
  return { busy: value.busy, error: value.error, sourceName: value.sourceName, tool: value.tool,
    dragging: value.selectionDragging, pending: value.pendingSelectionCount, draft: value.summary?.selectionDraft ?? false,
    selected: value.summary?.selected ?? 0, active: app.selectionActive, colorPending: app.colorPending,
    controlsEnabled: app.colorControlsEnabled, rendererState: value.rendererState, navigationPrompt: value.navigationPrompt,
    captured: pointerId !== undefined && canvas.hasPointerCapture(pointerId), held, publicationFailed, blurs,
    camera: [...app.camera!.state], framebuffer: [canvas.width, canvas.height],
    sourceFingerprint: app.sourceFingerprint, revision: { ...app.client!.revision },
    calls: structuredClone(calls), pointers: structuredClone(pointers), mouseCompanions: structuredClone(mouseCompanions),
    releases: structuredClone(releases), inFlight: inFlight.size };
}
async function gpu() {
  const app = controller(), scene = app.scene!;
  if (scene.kind !== 'gaussian') throw new Error('Deferred input requires an actual Gaussian scene.');
  return Array.from(new Uint32Array(await gpuBytes(scene.buffers.states, scene.count * 4)));
}
async function gpuBytes(buffer: GPUBuffer, size: number) {
  const app = controller(), readback = requireWebGpuRenderer(app.renderer).device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = requireWebGpuRenderer(app.renderer).device.createCommandEncoder(); encoder.copyBufferToBuffer(buffer, 0, readback, 0, size);
    requireWebGpuRenderer(app.renderer).device.queue.submit([encoder.finish()]); await readback.mapAsync(GPUMapMode.READ);
    const result = readback.getMappedRange().slice(0); readback.unmap(); return result;
  } finally { readback.destroy(); }
}
function ids(bytes: ArrayBuffer) {
  return new TextDecoder().decode(bytes).trim().split(/\r?\n/).slice(1).map(row => {
    const point = row.split(',').slice(0, 3).map(Number);
    return gesturePositions.findIndex(source => source.every((value, axis) => Math.abs(value - point[axis]) < 1e-5));
  }).sort((a, b) => a - b);
}
async function snapshot() {
  if (held) throw new Error('Never issue native queries through a held manual-grade transaction.');
  const app = controller(), client = app.client!;
  const allBytes = Array.from(new Uint8Array(await admittedExport(client, 0, 0)));
  const csv = new TextDecoder().decode(await admittedExport(client, 5, 0)).trim().split(/\r?\n/);
  const selection = await client.command({ command: 'summary' });
  const selectedIds = selection.selected ? ids(await admittedExport(client, 5, 1)) : [];
  const summary = await client.command({ command: 'summary' });
  return { ...state(), summary, allBytes, records: csv.slice(1).map(row => row.split(',').map(Number)),
    ids: selectedIds, gpu: await gpu(),
    grade: [...useApp.getState().grade], appliedGrade: [...useApp.getState().appliedGrade],
    colorSession: useApp.getState().colorSession, dirty: useApp.getState().dirty };
}
/** Observe an actual live selection draft without asking an exporter to settle
 * it. Preserve every native packed view byte, including covariance and active
 * SH words, alongside independently read GPU masks and physical pointer state. */
async function viewSnapshot() {
  if (held) throw new Error('Never issue native queries through a held manual-grade transaction.');
  const app = controller(), client = app.client!, scene = app.scene, camera = app.camera;
  if (scene?.kind !== 'gaussian' || !camera) throw new Error('A live selection observation requires an actual Gaussian scene.');
  const current = () => {
    if (app.client !== client || app.scene !== scene || app.camera !== camera)
      throw new Error('The observed selection view changed owners.');
  };
  const chunks: Uint8Array[] = [];
  let next = 0, nativeMasks = new Uint8Array();
  const summary = await client.stream(async (first, count, bytes) => {
    current();
    if (first !== next || bytes.byteLength !== count * scene.stride) throw new Error('The native selection view stream changed its range.');
    chunks.push(new Uint8Array(bytes)); next += count;
  }, bytes => { current(); nativeMasks = new Uint8Array(bytes); });
  current();
  if (summary.count !== scene.count || next !== scene.count || nativeMasks.length !== scene.count)
    throw new Error('The native selection view did not include every actual record and mask.');
  const packed = new Uint8Array(scene.count * scene.stride);
  let offset = 0; for (const chunk of chunks) { packed.set(chunk, offset); offset += chunk.byteLength; }
  const view = new DataView(packed.buffer);
  const records = Array.from({ length: scene.count }, (_, row) => [
    ...Array.from({ length: 10 }, (_, field) => view.getFloat32(row * scene.stride + 4 * field, true)),
    ...Array.from({ length: (scene.stride - 40) / 2 }, (_, half) => view.getUint16(row * scene.stride + 40 + 2 * half, true)),
  ]);
  const selectedIds = records.flatMap((record, index) => {
    if ((nativeMasks[index] & 3) !== 1) return [];
    const point = [record[0], -record[1], -record[2]];
    const id = gesturePositions.findIndex(source => source.every((value, axis) => Math.abs(value - point[axis]) < 1e-5));
    if (id < 0) throw new Error('A selected native view record does not match the literal fixture.');
    return [id];
  }).sort((a, b) => a - b);
  const gpuMasks = await gpu(), gpuViewBytes = Array.from(new Uint8Array(await gpuBytes(scene.buffers.splats, packed.byteLength))); current();
  return { ...state(), summary, records, ids: selectedIds, gpu: gpuMasks,
    nativeViewBytes: Array.from(packed), gpuViewBytes, nativeMasks: Array.from(nativeMasks) };
}
async function settle() {
  if (held) throw new Error('Release the actual grade barrier before joining native work.');
  const deadline = performance.now() + 15_000;
  let quiet = 0, observed = sequence;
  while (quiet < 3) {
    if (performance.now() > deadline) throw new Error(`Deferred input did not settle: ${JSON.stringify(state())}`);
    const value = state();
    quiet = !value.busy && !value.dragging && !value.pending && !value.draft && !value.active && !inFlight.size && sequence === observed ? quiet + 1 : 0;
    observed = sequence;
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  }
}
async function load(tool: SelectionTool = 'single', live = false) {
  await window.autoColorHarness.load('deferred-grade.ply', gesturePly());
  const app = controller(), canvas = requireWebGpuRenderer(app.renderer).canvas;
  app.camera!.set([0, 0, 0, 0, 0, 3, 1, 45, 0, 0, canvas.width / canvas.height]); app.invalidate();
  setSelectionPreferences({ operation: 0, live, overlap: false, visibleOnly: false });
  setApp({ toolsOpen: false, tool, brushSize: 16 });
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  await app.command({ command: 'single', index: 0, operation: 0 });
  observeClient(); installPointerObserver(); installReleaseObserver(); clear();
}
function clear() { calls.length = 0; pointers.length = 0; mouseCompanions.length = 0; releases.length = 0; publicationFailed = false; blurs = 0; }
function centers() {
  const app = controller(), canvas = requireWebGpuRenderer(app.renderer).canvas, bounds = canvas.getBoundingClientRect();
  // Independently project the fixture's literal positions with the actual native
  // camera. Never use a renderer hit or selected result to choose a test point.
  const multiply = (point: number[], matrix: Float32Array) => Array.from({ length: 4 }, (_, column) =>
    point.reduce((sum, value, row) => sum + value * matrix[row * 4 + column], 0));
  return gesturePositions.map(([x, y, z]) => {
    const clip = multiply(multiply([x, -y, -z, 1], app.camera!.view), app.camera!.projection);
    return [bounds.left + (clip[0] / clip[3] + 1) * bounds.width / 2,
      bounds.top + (1 - clip[1] / clip[3]) * bounds.height / 2];
  });
}
async function hold() {
  if (held) throw new Error('A manual bake is already held.');
  const values = [...NEUTRAL_COLOR]; values[0] = 1.25;
  window.autoColorHarness.preview(values); held = true;
  try { await window.autoColorHarness.holdManualBake(); } catch (error) { held = false; throw error; }
}
async function release() {
  if (!held) throw new Error('No actual manual bake is held.');
  held = false;
  try { return await window.autoColorHarness.releaseManualBake(); }
  finally { restorePublication?.(); restorePublication = undefined; }
}
async function holdAuto() {
  if (held) throw new Error('A real color operation is already held.');
  const app = controller(), client = app.client!, original = client.command.bind(client);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
  client.command = async (...args) => {
    const result = await original(...args);
    if (args[0].command === 'autoColor') { enter(); await blocked; }
    return result;
  };
  held = true;
  const pending = app.autoColor('exposure');
  const owner = { pending, release, restore: () => { client.command = original; } }; heldAuto = owner;
  try {
    await Promise.race([entered, pending.then(() => { throw new Error('The actual native Auto operation did not enter its reply gate.'); })]);
  } catch (error) {
    held = false; owner.restore(); heldAuto = undefined; throw error;
  }
}
async function releaseAuto() {
  const owner = heldAuto;
  if (!held || !owner) throw new Error('No genuine Auto reply is held.');
  held = false; heldAuto = undefined; owner.release();
  try { return await owner.pending; } finally { owner.restore(); }
}
function failPublication() {
  const queue = requireWebGpuRenderer(controller().renderer).device.queue, original = queue.onSubmittedWorkDone.bind(queue);
  queue.onSubmittedWorkDone = async () => {
    await original();
    if (!publicationFailed) { publicationFailed = true; throw new Error('Deferred fixture refused publication after actual GPU completion.'); }
  };
  restorePublication = () => { queue.onSubmittedWorkDone = original; };
}
function loseCapture() {
  const canvas = requireWebGpuRenderer(controller().renderer).canvas, pointer = pointers.findLast(value => value.type === 'pointerdown');
  if (!pointer || !canvas.hasPointerCapture(pointer.pointerId)) throw new Error('The actual physical pointer does not own capture.');
  canvas.releasePointerCapture(pointer.pointerId);
}
function resize() {
  const canvas = requireWebGpuRenderer(controller().renderer).canvas;
  canvas.style.width = `${Math.max(400, canvas.getBoundingClientRect().width - 80)}px`;
}
function startCommand() { competing = controller().command({ command: 'selectAll' }); }
async function joinCommand() { if (!competing) throw new Error('No competing command was started.'); return competing; }
function startReplacement() {
  const bytes = gesturePly();
  // A different literal position makes a replacement fingerprint distinct.
  const changed = new TextEncoder().encode(new TextDecoder().decode(bytes).replace('-0.65 -0.65 0', '-0.6 -0.65 0'));
  replacement = window.autoColorHarness.load('deferred-replacement.ply', changed).then(() => observeClient());
}
async function joinReplacement() { if (!replacement) throw new Error('No actual replacement was started.'); await replacement; }
async function command(value: SceneCommand) {
  if (!await controller().command(value)) throw new Error(useApp.getState().error ?? `Actual ${value.command} was refused.`);
  await settle(); return snapshot();
}
const harness = { ready: () => window.autoColorHarness?.ready() ?? false, load, state, snapshot, viewSnapshot, settle, clear, centers, hold, release, holdAuto, releaseAuto,
  gpu, failPublication, loseCapture, resize, startCommand, joinCommand, startReplacement, joinReplacement, command,
  brushSize: (value: number) => setApp({ brushSize: value }), defaults: setSelectionPreferences,
  toleranceDefaults: (value: Partial<Pick<DeferredSelectionOptions, 'colorTolerance' | 'fillTolerance' | 'connectedColor'>>) => setApp(value) };
declare global { interface Window { deferredGrade: typeof harness } }
window.deferredGrade = harness;
