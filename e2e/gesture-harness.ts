import { admittedExport, exportWorkObservation } from './admitted-export';
// Real worker, native core, mask upload and WebGPU; only scheduling gates are
// test doubles. The production build does not include this entry point.
import { AppController } from '../src/app/controller';
import { requireGaussianScene } from './gaussian-harness-scene';
import { setSelectionPreferences, useApp } from '../src/app/store';
import type { SceneCommand } from '../src/document/types';
import type { ResourceLedger } from '../src/document/resources';
import { gesturePly, gesturePositions } from './gesture-fixture';

function gate() {
  let release!: () => void, enter!: () => void;
  return { entered: new Promise<void>(resolve => { enter = resolve; }), held: new Promise<void>(resolve => { release = resolve; }), enter: () => enter(), release: () => release() };
}
async function gpuMasks(controller: AppController) {
  const renderer = controller.renderer!, scene = requireGaussianScene(controller.scene), size = scene.count * 4;
  const read = renderer.device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = renderer.device.createCommandEncoder(); encoder.copyBufferToBuffer(scene.buffers.states, 0, read, 0, size);
    renderer.device.queue.submit([encoder.finish()]); await read.mapAsync(GPUMapMode.READ);
    const result = Array.from(new Uint32Array(read.getMappedRange().slice(0))); read.unmap(); return result;
  } finally { read.destroy(); }
}
function csvIds(data: ArrayBuffer) {
  return new TextDecoder().decode(data).trim().split(/\r?\n/).slice(1).map(row => {
    const point = row.split(',').slice(0, 3).map(Number);
    return gesturePositions.findIndex(source => source.every((value, axis) => Math.abs(value - point[axis]) < 1e-5));
  }).sort((a, b) => a - b);
}
async function setup() {
  const canvas = document.createElement('canvas'); canvas.style.width = '480px'; canvas.style.height = '300px'; document.body.append(canvas);
  const controller = new AppController(); await controller.initialize(canvas); await controller.openFiles([new File([gesturePly()], 'gesture-sh0.ply')]);
  if (!controller.client || !controller.scene || !controller.renderer || !controller.camera) throw new Error(useApp.getState().error || 'Gesture fixture unavailable.');
  const client = controller.client, scene = requireGaussianScene(controller.scene);
  controller.camera.set([0, 0, 0, 0, 0, 3, 1, 45, 0, 0, canvas.width / canvas.height]);
  useApp.setState({ tool: 'rectangle', operation: 0, visibleOnly: false, overlap: false, live: true, selectionDragging: false });
  const pixel = (id: number) => {
    const [x, y, z] = gesturePositions[id];
    const multiply = (point: number[], matrix: Float32Array) => Array.from({ length: 4 }, (_, column) =>
      point.reduce((sum, value, row) => sum + value * matrix[row * 4 + column], 0));
    const clip = multiply(multiply([x, -y, -z, 1], controller.camera!.view), controller.camera!.projection);
    return [Math.round((clip[0] / clip[3] + 1) * canvas.width / 2), Math.round((1 - clip[1] / clip[3]) * canvas.height / 2)] as [number, number];
  };
  const a = pixel(2), b = pixel(1), rectangle = [a[0] - 8, a[1] - 8, b[0] + 8, b[1] + 8];
  const region = (operation: number): SceneCommand => ({ command: 'rectangle', camera: controller.camera!.state,
    width: canvas.width, height: canvas.height, rectangle, operation, overlap: false });
  const traffic: SceneCommand[] = [], candidates: number[][] = [];
  let last = '';
  const command = client.command.bind(client), stage = scene.stageMasks.bind(scene);
  const begin = client.beginOperation.bind(client), commit = client.commitOperation.bind(client), rollback = client.rollbackOperation.bind(client);
  // Observe the genuine typed lifecycle separately. Transaction labels remain
  // descriptive traffic; they never replace the semantic command used by GPU
  // publication gates and never stand in for a native acknowledgement.
  client.beginOperation = owner => { traffic.push({ command: 'beginTransaction', operationOwner: structuredClone(owner) }); return begin(owner); };
  client.commitOperation = owner => { traffic.push({ command: 'commitTransaction', operationOwner: structuredClone(owner) }); return commit(owner); };
  client.rollbackOperation = owner => { traffic.push({ command: 'rollbackTransaction', operationOwner: structuredClone(owner) }); return rollback(owner); };
  client.command = async (...args) => {
    const request = args[0], owner = client.operationOwner;
    traffic.push({ ...request, ...(owner ? { operationOwner: structuredClone(owner) } : {}) });
    last = request.command; return command(...args);
  };
  const preview = client.livePreview.bind(client);
  client.livePreview = request => {
    const owner = client.operationOwner;
    traffic.push({ ...request, ...(owner ? { operationOwner: structuredClone(owner) } : {}) });
    last = request.command; return preview(request);
  };
  scene.stageMasks = async bytes => { if (last === 'rectangle') candidates.push(Array.from(new Uint8Array(bytes))); return stage(bytes); };
  const snapshot = async () => {
    const source = await client.command({ command: 'summary' }), positions: number[][] = [];
    let nativeMasks: number[] = [];
    await client.stream(async (first, count, bytes) => {
      if (bytes.byteLength !== count * scene.stride) throw new Error('The actual gesture stream changed its record stride.');
      const view = new DataView(bytes);
      for (let index = 0; index < count; index++)
        positions[first + index] = [0, 4, 8].map((axis, component) =>
          view.getFloat32(index * scene.stride + axis, true) * (component === 0 ? 1 : -1));
    }, bytes => { nativeMasks = Array.from(new Uint8Array(bytes)); });
    if (positions.length !== gesturePositions.length || nativeMasks.length !== positions.length)
      throw new Error('The actual gesture stream changed its fixture membership.');
    const nativeIds = positions.flatMap((point, index) => {
      const id = gesturePositions.findIndex(source => source.every((value, axis) => Math.abs(value - point[axis]) < 1e-5));
      if (id !== index) throw new Error('The actual gesture stream changed its literal fixture position.');
      return (nativeMasks[index] & 3) === 1 ? [id] : [];
    }).sort((a, b) => a - b);
    // An unfinished physical gesture retains its actual native operation.
    // Observe that document without requesting an export or ending its owner.
    const held = source.selectionDraft || source.transaction || Boolean(client.operationOwner);
    const exportedIds = !held && source.selected ? csvIds(await admittedExport(client, 5, 1)) : null;
    return { summary: await client.command({ command: 'summary' }), gpu: await gpuMasks(controller),
      ids: exportedIds ?? nativeIds, nativeIds, nativeMasks, exportedIds,
      workOwnership: exportWorkObservation(client, (controller as unknown as { ledger: ResourceLedger }).ledger) };
  };
  const baseline = async () => {
    await controller.command({ command: 'single', index: 0, operation: 0 });
    await controller.command({ command: 'single', index: 2, operation: 1 });
    await controller.command({ command: 'single', index: 3, operation: 1 });
    await controller.command({ command: 'undo' });
    return snapshot();
  };
  const flush = () => (controller as unknown as { selection?: { session: { draining?: Promise<void> } } }).selection?.session.draining;
  const work = () => exportWorkObservation(client, (controller as unknown as { ledger: ResourceLedger }).ledger).transient.bytes;
  return { controller, client, scene, pixel, region, traffic, candidates, snapshot, baseline, flush, work, last: () => last,
    dispose: () => { controller.dispose(); canvas.remove(); } };
}
function createHarness() {
  return {
    async operation(operation: number, heldPublication: boolean) {
      const h = await setup(), held = gate();
      try {
        const before = await h.baseline(), stage = h.scene.stageMasks.bind(h.scene);
        let heldOnce = false;
        h.scene.stageMasks = async bytes => {
          if (heldPublication && !heldOnce && h.last() === 'rectangle') { heldOnce = true; held.enter(); await held.held; }
          return stage(bytes);
        };
        if (!h.controller.beginSelectionGesture(1)) throw new Error('The real Add gesture did not begin.');
        h.controller.previewSelection(h.region(1));
        if (heldPublication) await held.entered; else await h.flush();
        const gpuBeforeAssignment = await gpuMasks(h.controller);
        h.controller.setSelectionOperation(operation);
        const persistent = useApp.getState().operation;
        held.release(); await h.flush();
        const preview = await h.snapshot(), active = h.controller.selectionActive;
        const accepted = await h.controller.finishSelectionGesture(h.region(1)), after = await h.snapshot();
        await h.controller.command({ command: 'undo' }); const undone = await h.snapshot();
        await h.controller.command({ command: 'redo' }); const redone = await h.snapshot();
        return { before, gpuBeforeAssignment, persistent, preview, active, accepted, after, undone, redone,
          candidates: h.candidates, traffic: h.traffic, work: h.work(), error: useApp.getState().error };
      } finally { held.release(); h.dispose(); }
    },
    async sameValue() {
      const h = await setup();
      try {
        const before = await h.baseline(); setSelectionPreferences({ operation: 0 });
        if (!h.controller.beginSelectionGesture(1)) throw new Error('The modifier-captured Add gesture did not begin.');
        h.controller.previewSelection(h.region(1)); await h.flush(); const added = await h.snapshot();
        h.controller.setSelectionOperation(0); await h.flush(); const replaced = await h.snapshot();
        const accepted = await h.controller.finishSelectionGesture(h.region(1)), after = await h.snapshot();
        await h.controller.command({ command: 'undo' }); const undone = await h.snapshot();
        return { before, added, replaced, after, undone, accepted, persistent: useApp.getState().operation, work: h.work(), error: useApp.getState().error };
      } finally { h.dispose(); }
    },
    async cancelRestart() {
      const h = await setup(), held = gate();
      try {
        const before = await h.baseline(), stage = h.scene.stageMasks.bind(h.scene); let first = true;
        h.scene.stageMasks = async bytes => {
          if (first && h.last() === 'rectangle') { first = false; held.enter(); await held.held; } return stage(bytes);
        };
        if (!h.controller.beginSelectionGesture(1)) throw new Error('The real Add gesture did not begin.');
        h.controller.previewSelection(h.region(1)); await held.entered; h.controller.setSelectionOperation(2);
        const cancelling = h.controller.cancelSelectionGesture(); held.release(); await cancelling;
        const after = await h.snapshot(), active = h.controller.selectionActive;
        await h.controller.command({ command: 'redo' }); const redone = await h.snapshot();
        return { before, after, redone, active, work: h.work(), error: useApp.getState().error };
      } finally { held.release(); h.dispose(); }
    },
  };
}
declare global { interface Window { gestureHarness: ReturnType<typeof createHarness>; gestureHarnessError?: string } }
try { window.gestureHarness = createHarness(); } catch (error) { window.gestureHarnessError = String(error); }
