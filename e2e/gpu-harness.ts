import { admittedExport } from './admitted-export';
// Test-only entry point. Vite's production build includes only index.html.
import { GaussianRenderer, StaleGpuQueryError, type GpuScene } from '../src/renderer/webgpu/renderer';
import { CameraController } from '../src/input/camera';
import { CoreClient } from '../src/document/coreClient';
import { IDENTITY_MATRIX, NEUTRAL_COLOR } from '../src/document/types';
import { gaussianPly } from '../tests/fixtures/gaussians';
import { AppController } from '../src/app/controller';
import { useApp } from '../src/app/store';
import { AdmissionError, ResourceLedger } from '../src/document/resources';
import { requireGaussianScene } from './gaussian-harness-scene';
import type { SelectionSession } from '../src/input/selectionSession';

type RecoveryReadinessDiagnostic = { kind: string; events: { at: number; event: string; value: unknown }[] };

type Layer = { z: number; opacity: number; x?: number; y?: number; covariance?: [number, number, number, number, number, number] };
function pack(layers: Layer[]): ArrayBuffer {
  // Independent degree-zero fixture: xyz/opacity, symmetric covariance and zero
  // SH coefficients (RGB 0.5). No production packer or editable JS model.
  const bytes = new ArrayBuffer(layers.length * 48), floats = new Float32Array(bytes);
  layers.forEach((layer, i) => floats.set([layer.x ?? 0, layer.y ?? 0, layer.z, layer.opacity,
    ...(layer.covariance ?? [.01, 0, 0, .01, 0, .01])], i * 12));
  return bytes;
}
async function readBuffer(renderer: GaussianRenderer, source: GPUBuffer, size: number) {
  const result = renderer.device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = renderer.device.createCommandEncoder(); encoder.copyBufferToBuffer(source, 0, result, 0, size);
    renderer.device.queue.submit([encoder.finish()]); await result.mapAsync(GPUMapMode.READ);
    const bytes = result.getMappedRange().slice(0); result.unmap(); return bytes;
  } finally { result.destroy(); }
}
async function pixels(blob: Blob) {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0); return context.getImageData(0, 0, bitmap.width, bitmap.height).data;
  } finally { bitmap.close(); }
}
// Selection and content changes briefly own the automatic transform pivot query.
// The query is scheduled once other owners settle, so require a stable idle window.
async function pivotIdle() {
  let idleSince: number | undefined;
  for (const start = performance.now(); performance.now() - start < 10_000;) {
    const state = useApp.getState(), now = performance.now();
    if (state.busy || state.transformPivotPending) idleSince = undefined;
    else if ((idleSince ??= now) <= now - 50) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
function compare(a: Uint8ClampedArray, b: Uint8ClampedArray) {
  if (a.length !== b.length) throw new Error('Capture dimensions changed.');
  let maxError = 0, totalError = 0, changedChannels = 0, nonblackPixels = 0;
  for (let i = 0; i < a.length; i++) {
    if (i % 4 === 3) continue;
    const error = Math.abs(a[i] - b[i]); maxError = Math.max(maxError, error); totalError += error;
    if (error) changedChannels++;
    if (i % 4 === 0 && a[i] + a[i + 1] + a[i + 2] > 0) nonblackPixels++;
  }
  return { maxError, totalError, changedChannels, nonblackPixels };
}

export async function createHarness() {
  const canvas = document.querySelector<HTMLCanvasElement>('#scene')!;
  const [renderer, camera] = await Promise.all([GaussianRenderer.create(canvas), CameraController.create()]);
  const errors: string[] = []; renderer.onLost = message => errors.push(message);
  const fixedCamera = () => camera.set([0, 0, 0, 0, 0, 3, 1, 45, 0, 0, canvas.width / canvas.height]);
  return {
    async colorViewportReadiness() {
      const target = document.createElement('canvas'); target.style.width = '320px'; target.style.height = '200px'; document.body.append(target);
      const controller = new AppController(), originalObserver = window.ResizeObserver;
      let firstDelivery!: () => void, nextDelivery: (() => void) | undefined;
      const firstObserved = new Promise<void>(resolve => { firstDelivery = resolve; });
      let held: { callback: ResizeObserverCallback; entries: ResizeObserverEntry[]; observer: ResizeObserver } | undefined;
      let hold = true, observed = 0, resizeCallbacks = 0, invalidations = 0, picks = 0;
      const invalidate = controller.invalidate.bind(controller);
      controller.invalidate = () => { invalidations++; invalidate(); };
      controller.onViewportResize = () => { resizeCallbacks++; };
      const viewport = () => ({ width: target.width, height: target.height, aspect: controller.camera!.state[10],
        cameraRevision: controller.camera!.revision, resizeCallbacks, invalidations });
      const readiness: { atReady?: ReturnType<typeof viewport> & { observed: number } } = {};
      const unsubscribe = useApp.subscribe((state, previous) => {
        if (state.ready && !previous.ready) readiness.atReady = { ...viewport(), observed };
      });
      // Hold delivery of the actual browser observer callback, keeping native
      // selection, worker replies and GPU publication on their original paths.
      window.ResizeObserver = class extends originalObserver {
        constructor(callback: ResizeObserverCallback) {
          super((entries, observer) => {
            observed++;
            if (hold) { held = { callback, entries, observer }; firstDelivery(); }
            else { callback(entries, observer); nextDelivery?.(); nextDelivery = undefined; }
          });
        }
      };
      try {
        try { await controller.initialize(target); }
        finally { window.ResizeObserver = originalObserver; unsubscribe(); }
        const atReady = readiness.atReady;
        if (!atReady) throw new Error(useApp.getState().error || 'Viewport readiness was not published.');
        await firstObserved;
        await controller.openFiles([new File([gaussianPly(0)], 'viewport-color.ply')]);
        useApp.setState({ tool: 'color', colorTolerance: .01, tolerance: .01, operation: 0 });
        const client = controller.client!, gpu = controller.renderer!, scene = requireGaussianScene(controller.scene);
        gpu.pick = async () => { picks++; return { index: 0, depth: 3, opacity: .8, contribution: .8, deviceEpoch: gpu.deviceEpoch }; };
        if (!await controller.selectColorPixel(160, 100, 0)) throw new Error('Initial Color pick was refused.');
        const snapshot = async () => {
          const output = Array.from(new Uint8Array(await admittedExport(client, 0, 1)));
          return { summary: await client.command({ command: 'summary' }), output,
            masks: Array.from(new Uint32Array(await readBuffer(gpu, scene.buffers.states, scene.count * 4))),
            viewport: viewport() };
        };
        const before = await snapshot(), beforeDelivery = viewport();
        hold = false; held!.callback(held!.entries, held!.observer);
        const afterDelivery = viewport();
        const internals = controller as unknown as { tolerance?: { session: { flush(): Promise<void> } }; toleranceCleanup: Promise<void> };
        await internals.toleranceCleanup;
        const after = await snapshot();
        controller.setSelectionTolerance(.5); await internals.tolerance?.session.flush();
        const expanded = useApp.getState().summary?.selected;
        controller.setSelectionTolerance(.01); await internals.tolerance?.session.flush();
        const shrunk = useApp.getState().summary?.selected;
        const resized = new Promise<void>(resolve => { nextDelivery = resolve; });
        target.style.width = '321px'; await resized; await internals.toleranceCleanup;
        const afterResize = { viewport: viewport(), summary: await client.command({ command: 'summary' }) };
        await controller.command({ command: 'undo' }); const undone = useApp.getState().summary;
        await controller.command({ command: 'redo' });
        return { atReady, dpr: Math.min(window.devicePixelRatio || 1, 2), before, beforeDelivery, afterDelivery, after,
          expanded, shrunk, afterResize, undone, redone: useApp.getState().summary, picks, observed, error: useApp.getState().error };
      } finally { window.ResizeObserver = originalObserver; unsubscribe(); controller.dispose(); target.remove(); }
    },
    async colorPublicationFailure(kind: 'pick' | 'amendment') {
      const target = document.createElement('canvas'); target.style.width = '320px'; target.style.height = '200px'; document.body.append(target);
      const controller = new AppController();
      const toleranceWork = () => (controller as unknown as { tolerance?: { session: { flush(): Promise<void> } } }).tolerance?.session.flush();
      try {
        await controller.initialize(target); await controller.openFiles([new File([gaussianPly(0)], 'color-failure.ply')]);
        useApp.setState({ tool: 'color', colorTolerance: .01, tolerance: .01, operation: 0 });
        const client = controller.client!, gpu = controller.renderer!, scene = requireGaussianScene(controller.scene);
        let index = 0, picks = 0;
        // Picking correctness has separate real-GPU tests. Fix the contributor
        // here to isolate the real native transaction and mask publication seam.
        gpu.pick = async () => { picks++; return { index, depth: 3, opacity: .8, contribution: .8, deviceEpoch: gpu.deviceEpoch }; };
        if (!await controller.selectColorPixel(160, 100, 0)) throw new Error('Initial Color pick was refused');
        const output = new Uint8Array(await admittedExport(client, 0, 1)), before = await client.command({ command: 'summary' });
        const states = new Uint32Array(await readBuffer(gpu, scene.buffers.states, scene.count * 4));
        const ledger = (controller as unknown as { ledger: ResourceLedger }).ledger, usage = ledger.usage;
        const stage = scene.stageMasks.bind(scene);
        scene.stageMasks = async () => { throw new Error(`Injected Color ${kind} publication refusal`); };
        let accepted: boolean | undefined;
        try {
          if (kind === 'pick') { index = 1; accepted = await controller.selectColorPixel(160, 100, 0); }
          else { controller.setSelectionTolerance(1); await toleranceWork(); }
        } finally { scene.stageMasks = stage; }
        const saved = new Uint8Array(await admittedExport(client, 0, 1)), after = await client.command({ command: 'summary' });
        const afterStates = new Uint32Array(await readBuffer(gpu, scene.buffers.states, scene.count * 4));
        const refusal = { accepted, before, after, error: useApp.getState().error, usageBefore: usage, usageAfter: ledger.usage,
          sameOutput: output.length === saved.length && output.every((value, i) => value === saved[i]),
          sameGpuMasks: states.every((value, i) => value === afterStates[i]), busy: useApp.getState().busy };
        controller.setSelectionTolerance(.5); await toleranceWork();
        const expanded = useApp.getState().summary?.selected;
        controller.setSelectionTolerance(.01); await toleranceWork();
        const shrunk = useApp.getState().summary?.selected;
        await controller.command({ command: 'undo' });
        const undone = useApp.getState().summary;
        await controller.command({ command: 'redo' });
        return { ...refusal, expanded, shrunk, undone, redone: useApp.getState().summary, picks };
      } finally { controller.dispose(); target.remove(); }
    },
    async colorExportBarrier(kind: 'pick' | 'amendment' | 'cancelled') {
      const target = document.createElement('canvas'); target.style.width = '320px'; target.style.height = '200px'; document.body.append(target);
      const controller = new AppController(); let resume: (() => void) | undefined;
      try {
        await controller.initialize(target); await controller.openFiles([new File([gaussianPly(0)], 'pending-color-export.ply')]);
        if (!controller.client || !controller.renderer || !controller.scene) throw new Error(useApp.getState().error || 'No scene opened for the Color export barrier.');
        if (kind !== 'amendment') { await controller.command({ command: 'selectAll' }); await pivotIdle(); }
        useApp.setState({ tool: 'color', colorTolerance: .01, tolerance: .01, operation: 0, selectionDragging: false });
        const client = controller.client!, gpu = controller.renderer!, scene = requireGaussianScene(controller.scene);
        controller.camera!.set([0, 0, 0, 0, 0, 3, 1, 45, 0, 0, target.width / target.height]);
        // The first fixture center projects here for this fixed camera. Hold
        // delivery of a real GPU contributor, then inspect native CSV output.
        const x = target.width / 2 - .4 / 3 * (target.height / 2 / Math.tan(Math.PI / 8)), y = target.height / 2;
        let picks = 0;
        const actualPick = gpu.pick.bind(gpu);
        gpu.pick = async (...args) => { picks++; return actualPick(...args); };
        if (kind === 'amendment' && !await controller.selectColorPixel(x, y, 0)) throw new Error('Initial Color pick was refused');
        await pivotIdle();
        let entered!: () => void;
        const waiting = new Promise<void>(resolve => { entered = resolve; }), release = new Promise<void>(resolve => { resume = resolve; });
        let picking: Promise<boolean> | undefined;
        if (kind === 'amendment') {
          const stage = scene.stageMasks.bind(scene);
          scene.stageMasks = async bytes => { entered(); await release; return stage(bytes); };
          controller.setSelectionTolerance(.5);
        } else {
          const pick = gpu.pick.bind(gpu);
          gpu.pick = async (...args) => { const result = await pick(...args); entered(); await release; return result; };
          picking = controller.selectColorPixel(x, y, 0);
        }
        await Promise.race([waiting, ...(picking ? [picking.then(() => { throw new Error('Color pick ended before the held readback'); })] : [])]);
        let exported: string | undefined, exportCalls = 0;
        const output = client.exportOwned.bind(client);
        client.exportOwned = async (...args) => {
          exportCalls++; const owned = await output(...args); exported = new TextDecoder().decode(owned.bytes); return owned;
        };
        const exporting = controller.exportScene(5, 1);
        await new Promise(resolve => setTimeout(resolve, 20));
        const blocked = exportCalls === 0, beforeSelected = useApp.getState().summary?.selected;
        if (kind === 'cancelled') controller.endToleranceSelection();
        resume!(); const accepted = await picking; await exporting;
        const after = await client.command({ command: 'summary' });
        let masks!: number[]; await client.readMasks(bytes => { masks = Array.from(new Uint8Array(bytes)); });
        const rows = exported?.trim().split(/\r?\n/).slice(1).map(row => row.split(',').slice(0, 3).map(Number));
        const result = { kind, blocked, beforeSelected, accepted, after, masks, rows, picks, exportCalls,
          receipt: useApp.getState().outputPending, busy: useApp.getState().busy, error: useApp.getState().error };
        await controller.command({ command: 'undo' });
        return { ...result, undone: useApp.getState().summary };
      } finally { resume?.(); controller.dispose(); target.remove(); }
    },
    async colorPendingTolerance(empty: boolean) {
      const target = document.createElement('canvas'); target.style.width = '320px'; target.style.height = '200px'; document.body.append(target);
      const controller = new AppController(); let resume: (() => void) | undefined;
      const flushTolerance = () => (controller as unknown as { tolerance?: { session: { flush(): Promise<void> } } }).tolerance?.session.flush();
      try {
        await controller.initialize(target); await controller.openFiles([new File([gaussianPly(0)], 'pending-color-tolerance.ply')]);
        if (!controller.client || !controller.renderer || !controller.scene) throw new Error(useApp.getState().error || 'No scene opened for the pending Color tolerance.');
        useApp.setState({ tool: 'color', colorTolerance: .01, tolerance: .01, operation: 0, selectionDragging: false });
        const client = controller.client, gpu = controller.renderer;
        controller.camera!.set([0, 0, 0, 0, 0, 3, 1, 45, 0, 0, target.width / target.height]);
        const offset = .4 / 3 * (target.height / 2 / Math.tan(Math.PI / 8)), y = target.height / 2;
        if (!await controller.selectColorPixel(target.width / 2 - offset, y, 0)) throw new Error('The preceding Color pick was refused.');
        await pivotIdle();
        const before = await client.command({ command: 'summary' });
        let entered!: () => void;
        const waiting = new Promise<void>(resolve => { entered = resolve; }), release = new Promise<void>(resolve => { resume = resolve; });
        const pick = gpu.pick.bind(gpu);
        gpu.pick = async (...args) => { const hit = await pick(...args); entered(); await release; return hit; };
        const picking = controller.selectColorPixel(empty ? 0 : target.width / 2 + offset, empty ? 0 : y, 0);
        await Promise.race([waiting, picking.then(() => { throw new Error('The replacement ended before the held contributor.'); })]);
        controller.setSelectionTolerance(.5); await flushTolerance();
        const whilePending = await client.command({ command: 'summary' }), remembered = useApp.getState().colorTolerance;
        let outputRows: number | undefined, exportCalls = 0;
        const output = client.exportOwned.bind(client);
        client.exportOwned = async (...args) => {
          exportCalls++; const owned = await output(...args);
          outputRows = new TextDecoder().decode(owned.bytes).trim().split(/\r?\n/).length - 1; return owned;
        };
        const exporting = controller.exportScene(5, 1);
        await new Promise(resolve => setTimeout(resolve, 20)); const exportBlocked = exportCalls === 0;
        resume!(); const accepted = await picking; await exporting;
        const after = await client.command({ command: 'summary' });
        let expanded: number | undefined, shrunk: number | undefined;
        if (empty) {
          controller.setSelectionTolerance(.5); await flushTolerance(); expanded = useApp.getState().summary?.selected;
          controller.setSelectionTolerance(.01); await flushTolerance(); shrunk = useApp.getState().summary?.selected;
        }
        await controller.command({ command: 'undo' }); const undone = useApp.getState().summary;
        if (!empty) await controller.command({ command: 'undo' });
        return { empty, before, whilePending, remembered, exportBlocked, exportCalls, outputRows, accepted, after, expanded, shrunk,
          undone, final: useApp.getState().summary, busy: useApp.getState().busy, error: useApp.getState().error };
      } finally { resume?.(); controller.dispose(); target.remove(); }
    },
    async singleQueryCancellation() {
      const target = document.createElement('canvas'); target.style.width = '320px'; target.style.height = '200px'; document.body.append(target);
      const controller = new AppController(); let resume: (() => void) | undefined;
      try {
        await controller.initialize(target); await controller.openFiles([new File([gaussianPly()], 'pending-single.ply')]);
        await controller.command({ command: 'single', index: 1 });
        await controller.command({ command: 'delete' }); await controller.command({ command: 'undo' });
        const client = controller.client!, gpu = controller.renderer!;
        const output = new Uint8Array(await admittedExport(client, 0, 0)), before = await client.command({ command: 'summary' });
        const ledger = (controller as unknown as { ledger: ResourceLedger }).ledger, usage = ledger.usage.bytes;
        const pick = gpu.pick.bind(gpu); let entered!: () => void;
        const waiting = new Promise<void>(resolve => { entered = resolve; }), release = new Promise<void>(resolve => { resume = resolve; });
        gpu.pick = async (...args) => { const result = await pick(...args); entered(); await release; return result; };
        useApp.setState({ tool: 'single' });
        if (!controller.beginSelectionGesture()) throw new Error('Selection gesture was refused');
        controller.previewSinglePixel(160, 100, 0); await waiting;
        const cancelled = controller.cancelSelectionGesture();
        const cannotRestart = !controller.beginSelectionGesture(); resume!(); await cancelled;
        gpu.pick = pick;
        const saved = new Uint8Array(await admittedExport(client, 0, 0)), after = await client.command({ command: 'summary' });
        let mask!: number[]; await client.readMasks(bytes => { mask = Array.from(new Uint8Array(bytes)); });
        return { before, after, mask, cannotRestart, active: controller.selectionActive,
          unchangedOutput: output.length === saved.length && output.every((value, i) => value === saved[i]),
          usageBefore: usage, usageAfter: ledger.usage.bytes, error: useApp.getState().error };
      } finally { resume?.(); controller.dispose(); target.remove(); }
    },
    async deviceRecovery(kind: 'ready' | 'draft' | 'edit' | 'refused' | 'cancel') {
      const target = document.createElement('canvas'); target.style.width = '320px'; target.style.height = '200px'; document.body.append(target);
      const controller = new AppController(); const create = GaussianRenderer.create;
      const diagnostic: RecoveryReadinessDiagnostic = { kind, events: [] }; window.gpuRecoveryDiagnostic = diagnostic;
      const record = (event: string, value: unknown) => {
        if (diagnostic.events.length < 128) diagnostic.events.push({ at: performance.now(), event, value });
      };
      const snapshot = () => {
        const state = useApp.getState(), owner = controller as unknown as {
          selection?: { session: SelectionSession; cameraRevision: number; optionsRevision: number; operationRevision: number; cancel: AbortController };
          editOperation?: { committing: boolean; cancel: AbortController };
        }, selection = owner.selection, session = selection?.session;
        return { busy: state.busy, selected: state.summary?.selected, revision: state.summary?.revision,
          contentRevision: state.summary?.contentRevision, transaction: state.summary?.transaction,
          selectionDraft: state.summary?.selectionDraft, error: state.error, recovery: state.selectionRecovery,
          clientRevision: controller.client && { ...controller.client.revision }, cameraRevision: controller.camera?.revision,
          edit: owner.editOperation && { committing: owner.editOperation.committing, aborted: owner.editOperation.cancel.signal.aborted },
          selection: selection && { cameraRevision: selection.cameraRevision, optionsRevision: selection.optionsRevision,
            operationRevision: selection.operationRevision, aborted: selection.cancel.signal.aborted },
          session: session && { pending: session.pending, restoring: session.restoring, failed: session.hasFailed,
            deferred: session.computationFailed, restorationFailed: session.restorationFailed, cleanupNeeded: session.cleanupNeeded,
            requested: session.requestedRevision, published: session.publishedRevision, complete: session.complete,
            applied: session.appliedCommand?.command, closed: session.closed } };
      };
      let stopObserving = () => {};
      const wait = async (condition: () => boolean) => {
        const start = performance.now();
        while (!condition()) {
          if (performance.now() - start > 10_000) { record('readiness-timeout', snapshot()); throw new Error('Recovery test timed out'); }
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      };
      try {
        await controller.initialize(target); await controller.openFiles([new File([gaussianPly()], 'recover-sh3.ply')]);
        const client = controller.client!, gpu = controller.renderer!;
        await controller.command({ command: 'single', index: 1 });
        // A selection change briefly owns the automatic pivot query.
        await wait(() => controller.colorControlsEnabled);
        await controller.command({ command: 'grade', values: [1.5, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], selectedOnly: true });
        await controller.command({ command: 'delete' }); await controller.command({ command: 'undo' });
        const output = new Uint8Array(await admittedExport(client, 0, 0)), image = await pixels(await controller.capture('image/png'));
        const before = await client.command({ command: 'summary' });
        const view = controller.camera!.state, documentId = client.revision.documentId;
        const ledger = (controller as unknown as { ledger: ResourceLedger }).ledger, usage = ledger.usage;
        if (kind === 'draft') {
          const command = client.command.bind(client), preview = client.livePreview.bind(client), scene = requireGaussianScene(controller.scene), masks = scene.stageMasks.bind(scene);
          const observe = <T>(event: string, task: Promise<T>) => {
            // Observe the original admitted promise without replacing its result,
            // delivery timing, selected-count oracle or fixture timeout.
            void task.then(result => record(event + ':fulfilled', { result, state: snapshot() }),
              error => record(event + ':rejected', { error: String(error), state: snapshot() }));
            return task;
          };
          client.command = request => { record('command:' + request.command, snapshot()); return observe('command:' + request.command, command(request)); };
          client.livePreview = request => { record('live-preview:' + request.command, snapshot()); return observe('live-preview:' + request.command, preview(request)); };
          scene.stageMasks = bytes => { record('gpu-stage-masks', { bytes: bytes.byteLength, state: snapshot() }); return observe('gpu-stage-masks', masks(bytes)); };
          let last = ''; const unsubscribe = useApp.subscribe(() => {
            const state = snapshot(), key = JSON.stringify(state); if (key !== last) { last = key; record('store', state); }
          });
          stopObserving = () => { unsubscribe(); client.command = command; client.livePreview = preview; scene.stageMasks = masks; };
          record('begin-return', { accepted: controller.beginSelectionGesture(0), state: snapshot() });
          controller.previewSelection({ command: 'rectangle', camera: view,
            width: target.width, height: target.height, rectangle: [0, 0, target.width, target.height] });
          record('preview-return', snapshot());
          await wait(() => !useApp.getState().busy && useApp.getState().summary?.selected === 3);
          record('draft-ready', snapshot()); stopObserving();
        }
        if (kind === 'refused') GaussianRenderer.create = async () => { throw new Error('Injected recreation refusal'); };
        let release!: () => void, entered!: () => void;
        const creation = new Promise<void>(resolve => { entered = resolve; });
        if (kind === 'cancel') GaussianRenderer.create = async canvas => {
          const result = await create(canvas); entered(); await new Promise<void>(resolve => { release = resolve; }); return result;
        };
        let accepted: boolean | undefined;
        if (kind === 'edit') {
          const allocate = gpu.allocateScene.bind(gpu);
          gpu.allocateScene = async (count, degree) => {
            const scene = await allocate(count, degree), upload = scene.upload.bind(scene);
            scene.upload = async (first, count, bytes) => { await upload(first, count, bytes); gpu.device.destroy(); await gpu.device.lost; };
            return scene;
          };
          accepted = await controller.command({ command: 'transform', matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 0, 1] });
        } else { gpu.device.destroy(); await gpu.device.lost; }
        if (kind === 'cancel') { await creation; controller.cancelOperation(); release(); }
        const first = await controller.retryRenderer();
        const failedOutput = new Uint8Array(await admittedExport(client, 0, 0));
        const failed = { state: useApp.getState().rendererState, error: useApp.getState().error,
          usage: ledger.usage, exported: failedOutput.every((v, i) => v === output[i]) };
        GaussianRenderer.create = create;
        const recovered = first || await controller.retryRenderer();
        const afterOutput = new Uint8Array(await admittedExport(client, 0, 0)), afterImage = await pixels(await controller.capture('image/png'));
        const after = await client.command({ command: 'summary' });
        const result = { kind, accepted, first, recovered, failed, before, after,
          sameDocument: controller.client === client && client.revision.documentId === documentId,
          sameView: controller.camera!.state.every((v, i) => v === view[i]),
          sameOutput: output.length === afterOutput.length && output.every((v, i) => v === afterOutput[i]),
          image: compare(image, afterImage), usage: { before: usage, after: ledger.usage },
          epochs: [gpu.deviceEpoch, controller.renderer!.deviceEpoch], dirty: useApp.getState().dirty,
          state: useApp.getState().rendererState, busy: useApp.getState().busy, active: controller.selectionActive };
        const redone = await controller.command({ command: 'redo' });
        return { ...result, redone, redoneVisible: useApp.getState().summary?.visible };
      } finally { record('fixture-finally', snapshot()); stopObserving(); GaussianRenderer.create = create; controller.dispose(); target.remove(); }
    },
    async staleQueries() {
      const target = document.createElement('canvas'); target.width = 320; target.height = 200; document.body.append(target);
      let old: GaussianRenderer | undefined, replacement: GaussianRenderer | undefined, scene: GpuScene | undefined, next: GpuScene | undefined;
      const rejected = async (promise: Promise<unknown>) => { try { await promise; return false; } catch (error) { return error instanceof StaleGpuQueryError; } };
      try {
        fixedCamera(); old = await GaussianRenderer.create(target); scene = old.scene(1, 0);
        await scene.upload(0, 1, pack([{ z: 0, opacity: .8 }])); scene.masks(new Uint8Array(1).buffer); old.render(scene, camera);
        const queued = old.pick(scene, 160, 100); camera.orbit(.1, 0); old.render(scene, camera);
        const queuedRejected = await rejected(queued);
        const reading = old.pick(scene, 160, 100); await Promise.resolve(); camera.orbit(.1, 0); old.render(scene, camera);
        const readingRejected = await rejected(reading);
        const unchanged = old.pick(scene, 160, 100); old.render(scene, camera);
        const unchangedHit = await unchanged;
        const resized = old.pick(scene, 160, 100); target.width++;
        const resizedRejected = await rejected(resized); target.width--;
        old.render(scene, camera);
        const masked = old.pick(scene, 160, 100); scene.masks(new Uint8Array([1]).buffer);
        const maskedRejected = await rejected(masked);
        old.render(scene, camera);
        const staged = old.scene(1, 0);
        let sceneRejected: boolean;
        try {
          await staged.upload(0, 1, pack([{ z: 0, opacity: .8 }])); staged.masks(new Uint8Array(1).buffer);
          const changedScene = old.pick(scene, 160, 100); old.render(staged, camera);
          sceneRejected = await rejected(changedScene);
        } finally { await staged.dispose(); }
        old.render(scene, camera);
        const graded = old.pick(scene, 160, 100); old.render(scene, camera, [2, ...NEUTRAL_COLOR.slice(1)]);
        const previewRejected = await rejected(graded);
        replacement = await GaussianRenderer.create(target);
        const wrongDevice = await rejected(replacement.pick(scene, 160, 100));
        const epochs = [old.deviceEpoch, replacement.deviceEpoch]; await scene.dispose(); old.dispose();
        next = replacement.scene(1, 0); await next.upload(0, 1, pack([{ z: 0, opacity: .8 }])); next.masks(new Uint8Array(1).buffer);
        replacement.render(next, camera); const capture = await pixels(await replacement.capture(next, camera));
        return { queuedRejected, readingRejected, resizedRejected, maskedRejected, sceneRejected, previewRejected,
          unchangedIndex: unchangedHit.index, wrongDevice, epochs, nonblackPixels: compare(capture, capture).nonblackPixels };
      } finally { await scene?.dispose(); old?.dispose(); await next?.dispose(); replacement?.dispose(); target.remove(); }
    },
    async allocationFailure() {
      let failure = '';
      try {
        await renderer.checkedAllocation(() => renderer.device.createBuffer({ size: 16, usage: 0 }), buffer => buffer.destroy());
      } catch (error) { failure = error instanceof Error ? error.message : String(error); }
      return { failure, errors };
    },
    async editFailure(kind: 'geometry' | 'mask' | 'history' | 'cancel') {
      const target = document.createElement('canvas'); target.style.width = '320px'; target.style.height = '200px'; document.body.append(target);
      const controller = new AppController();
      try {
        await controller.initialize(target);
        await controller.openFiles([new File([gaussianPly()], 'transaction-sh3.ply')]);
        if (!controller.client || !controller.scene || !controller.renderer) throw new Error(useApp.getState().error || 'No scene opened.');
        await controller.command({ command: 'single', index: 1 });
        await controller.command({ command: 'delete' }); await controller.command({ command: 'undo' });
        const client = controller.client, gpu = controller.renderer, originalScene = requireGaussianScene(controller.scene);
        const ledger = (controller as unknown as { ledger: ResourceLedger }).ledger;
        const beforeOutput = new Uint8Array(await admittedExport(client, 0, 0));
        const beforeImage = await pixels(await controller.capture('image/png'));
        const before = await client.command({ command: 'summary' }), usage = ledger.usage;
        const allocation = gpu.allocateScene.bind(gpu), stageMasks = originalScene.stageMasks.bind(originalScene);
        const transfer = ledger.transferRetainedNativeCoverage.bind(ledger);
        let historyPublicationRefused = false;
        if (kind === 'geometry') gpu.allocateScene = async () => { throw new Error('Injected GPU allocation refusal'); };
        if (kind === 'mask') originalScene.stageMasks = async () => { throw new Error('Injected mask allocation refusal'); };
        if (kind === 'history') ledger.transferRetainedNativeCoverage = (remainder, bytes, updates) => {
          // Response telemetry uses rebalance before publication. Refuse only
          // the retained history/work redistribution after the GPU is staged.
          if (updates.some(update => ledger.owns(update.lease, 'history')) &&
              updates.some(update => ledger.owns(update.lease, 'work'))) {
            ledger.transferRetainedNativeCoverage = transfer;
            historyPublicationRefused = true;
            throw new AdmissionError('Injected history reservation refusal');
          }
          return transfer(remainder, bytes, updates);
        };
        if (kind === 'cancel') gpu.allocateScene = async (count, degree) => {
          const candidate = await allocation(count, degree), upload = candidate.upload.bind(candidate);
          candidate.upload = async (first, size, bytes) => { await upload(first, size, bytes); controller.cancelEdit(); };
          return candidate;
        };
        let accepted: boolean;
        try {
          accepted = await controller.command(kind === 'mask' ? { command: 'selectAll' } :
            kind === 'geometry' || kind === 'cancel' ?
              { command: 'transform', matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, .25, 0, 0, 1], selectedOnly: true } :
              { command: 'grade', values: [2, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], selectedOnly: true });
        } finally { gpu.allocateScene = allocation; originalScene.stageMasks = stageMasks; ledger.transferRetainedNativeCoverage = transfer; }
        const afterOutput = new Uint8Array(await admittedExport(client, 0, 0));
        const afterImage = await pixels(await controller.capture('image/png'));
        const after = await client.command({ command: 'summary' });
        const retained = ledger.usage, displayed = useApp.getState();
        const report = { accepted, before, after, historyPublicationRefused, sameScene: controller.scene === originalScene,
          sameOutput: beforeOutput.length === afterOutput.length && beforeOutput.every((value, i) => value === afterOutput[i]),
          image: compare(beforeImage, afterImage), usage: { before: usage.bytes, after: retained.bytes,
            beforeAllocations: usage.allocations, afterAllocations: retained.allocations },
          dirty: displayed.dirty, busy: displayed.busy, error: displayed.error };
        // Rollback must retain the original redo stack, not synthesize another
        // Undo/Redo pair that changes what the user's next command means.
        const redone = await controller.command({ command: 'redo' });
        return { ...report, redone, redoneVisible: useApp.getState().summary?.visible };
      } finally { controller.dispose(); target.remove(); }
    },
    async maskTransfer() {
      const client = new CoreClient(), ledger = new ResourceLedger(128 * 1024 * 1024);
      let closed = false;
      try {
        await client.load(new File([gaussianPly()], 'mask-sh3.ply'), 1000, 128 * 1024 * 1024, {
          admit: bytes => ledger.reserve('work', bytes),
          current() { if (closed) throw new Error('The mask fixture source was closed.'); },
        });
        await client.command({ command: 'single', index: 1 });
        const messages: { type: string; bytes: number }[] = [];
        const worker = (client as unknown as { worker: Worker }).worker;
        worker.addEventListener('message', event => {
          if (event.data.bytes) messages.push({ type: event.data.type, bytes: event.data.bytes.byteLength });
        });
        let mask: number[] = [];
        const summary = await client.readMasks(bytes => { mask = Array.from(new Uint8Array(bytes)); });
        return { messages, mask, selected: summary.selected };
      } finally { closed = true; client.dispose(); }
    },
    async gestureFailure(boundary: 'preview' | 'confirm') {
      const target = document.createElement('canvas'); target.style.width = '320px'; target.style.height = '200px'; document.body.append(target);
      const controller = new AppController();
      try {
        await controller.initialize(target); await controller.openFiles([new File([gaussianPly()], 'gesture-failure.ply')]);
        const client = controller.client!, scene = requireGaussianScene(controller.scene);
        await controller.command({ command: 'single', index: 1 });
        await controller.command({ command: 'delete' }); await controller.command({ command: 'undo' });
        const before = await client.command({ command: 'summary' });
        const command = client.command.bind(client), preview = client.livePreview.bind(client), masks = scene.stageMasks.bind(scene);
        let armed = false;
        client.command = request => {
          if (request.command === (boundary === 'preview' ? 'rectangle' : 'confirmSelection')) armed = true;
          return command(request);
        };
        client.livePreview = request => { if (boundary === 'preview') armed = true; return preview(request); };
        scene.stageMasks = async bytes => {
          if (armed) { armed = false; throw new Error('Injected gesture publication refusal'); }
          return masks(bytes);
        };
        await pivotIdle();
        if (!controller.beginSelectionGesture()) throw new Error('Could not start gesture');
        let accepted: boolean;
        try { accepted = await controller.finishSelectionGesture({ command: 'rectangle', camera: controller.camera!.state,
          width: target.width, height: target.height, rectangle: [0, 0, target.width, target.height] }); }
        finally { client.command = command; client.livePreview = preview; scene.stageMasks = masks; }
        const after = await client.command({ command: 'summary' }); let mask: number[] = [];
        await client.readMasks(bytes => { mask = Array.from(new Uint8Array(bytes)); });
        return { accepted, before, after, mask, error: useApp.getState().error, busy: useApp.getState().busy,
          active: controller.selectionActive, redone: (await controller.command({ command: 'redo' })) && useApp.getState().summary?.visible === 2 };
      } finally { controller.dispose(); target.remove(); }
    },
    async overlap() {
      fixedCamera(); const scene = renderer.scene(2, 0);
      try {
        await scene.upload(0, 2, pack([{ z: 0, opacity: .2 }, { z: 1, opacity: .9 }]));
        scene.masks(new Uint8Array(2).buffer); renderer.render(scene, camera, NEUTRAL_COLOR, false);
        const center = await renderer.pick(scene, canvas.width / 2, canvas.height / 2);
        const empty = await renderer.pick(scene, 0, 0);
        scene.masks(new Uint8Array([2, 0]).buffer); renderer.render(scene, camera, NEUTRAL_COLOR, false);
        const deletedFront = await renderer.pick(scene, canvas.width / 2, canvas.height / 2);
        return { center, empty, deletedFront, errors };
      } finally { await scene.dispose(); }
    },
    async boundedPick() {
      fixedCamera(); const scene = renderer.scene(3, 0);
      try {
        // Foreground centers sit outside an eight-pixel cursor ring, while
        // broad, nearly opaque footprints cover the centered rear candidate.
        await scene.upload(0, 3, pack([
          { x: -.3, z: 0, opacity: 1, covariance: [100, 0, 0, 100, 0, 100] },
          { x: -.3, z: .1, opacity: 1, covariance: [100, 0, 0, 100, 0, 100] },
          { z: 1, opacity: .9 },
        ]));
        scene.masks(new Uint8Array(3).buffer); renderer.render(scene, camera, NEUTRAL_COLOR, false);
        const unbounded = await renderer.pick(scene, 160, 100);
        const obscured = await renderer.pick(scene, 160, 100, 8);
        scene.masks(new Uint8Array([2, 2, 0]).buffer); renderer.render(scene, camera, NEUTRAL_COLOR, false);
        const revealed = await renderer.pick(scene, 160, 100, 8);
        const invalid = await Promise.all([renderer.pick(scene, -1, 100), renderer.pick(scene, 320, 100),
          renderer.pick(scene, 160, 200), renderer.pick(scene, NaN, 100), renderer.pick(scene, 160, 100, -1)]);
        return { unbounded, obscured, revealed, invalid, errors };
      } finally { await scene.dispose(); }
    },
    async footprints() {
      fixedCamera(); const scene = renderer.scene(1, 0);
      const sample = async (layer: Layer, x = 160, y = 100) => {
        await scene.upload(0, 1, pack([layer])); scene.masks(new Uint8Array(1).buffer);
        renderer.render(scene, camera, NEUTRAL_COLOR, false);
        const hit = await renderer.pick(scene, x, y);
        const projected = new Float32Array(await readBuffer(renderer, scene.buffers.projected, 48));
        const image = await pixels(await renderer.capture(scene, camera));
        return { ...hit, projected: projected[3] !== 0, rgb: Array.from(image.subarray((y * canvas.width + x) * 4, (y * canvas.width + x) * 4 + 3)) };
      };
      try {
        const anisotropic = await sample({ z: 0, opacity: .8, covariance: [.04, .012, 0, .01, 0, .01] }, 168, 105);
        const edgeInside = await sample({ z: 0, opacity: .9 }, 183, 100);
        const edgeOutside = await sample({ z: 0, opacity: .9 }, 184, 100);
        const faint = await sample({ z: 0, opacity: .00391 });
        const offscreen = await sample({ x: -4, z: 0, opacity: .9, covariance: [4, 0, 0, 4, 0, 4] });
        const behind = await sample({ z: -4, opacity: .9 });
        const far = await sample({ z: 1e6, opacity: .9 });
        camera.set([0, 0, 0, 0, 0, 3, 100, 45, 0, 0, canvas.width / canvas.height]);
        const near = await sample({ z: -2.995, opacity: .9 });
        return { anisotropic, edgeInside, edgeOutside, faint, offscreen, behind, far, near, errors };
      } finally { await scene.dispose(); }
    },
    async globalOrder() {
      fixedCamera(); const count = 65_777;
      const layers = Array.from({ length: count }, (_, i) => ({ z: (((i * 1664525 + 1013904223) >>> 0) % 4096 - 2048) / 256, opacity: .0001 }));
      const scene = renderer.scene(count, 0);
      try {
        await scene.upload(0, count, pack(layers)); scene.masks(new Uint8Array(count).buffer);
        renderer.render(scene, camera, NEUTRAL_COLOR, false);
        const pairs = new Uint32Array(await readBuffer(renderer, scene.buffers.pairsA, count * 8));
        const expected = layers.map((layer, index) => ({ z: layer.z, index })).sort((a, b) => b.z - a.z || a.index - b.index);
        let mismatch = -1;
        for (let i = 0; i < count; i++) if (pairs[i * 2 + 1] !== expected[i].index) { mismatch = i; break; }
        return { count, mismatch, actual: mismatch < 0 ? null : pairs[mismatch * 2 + 1],
          expected: mismatch < 0 ? null : expected[mismatch].index, errors };
      } finally { await scene.dispose(); }
    },
    async preview(kind: 'grade' | 'transform') {
      const client = new CoreClient(), ledger = new ResourceLedger(128 * 1024 * 1024);
      let scene: GpuScene | undefined, closed = false;
      try {
        const { summary } = await client.load(new File([gaussianPly()], 'preview-sh3.ply'), 1000, 128 * 1024 * 1024, {
          admit: bytes => ledger.reserve('work', bytes),
          current() { if (closed || renderer.lost) throw new Error('The preview fixture source was closed.'); },
        });
        camera.set(summary.camera); camera.aspect(canvas.width / canvas.height);
        await client.command({ command: 'single', index: 1 });
        scene = renderer.scene(summary.count, summary.shDegree);
        await client.stream((first, count, bytes) => scene!.upload(first, count, bytes), bytes => scene!.masks(bytes));
        const before = await pixels(await renderer.capture(scene, camera));
        const grade = kind === 'grade' ? [1.3, 1.12, .85, 1.2, 1.1, .2, -.15, .1, -.12, .06, 25, .12, -32, .08, 18] : NEUTRAL_COLOR;
        const matrix = kind === 'transform' ? [1.3, .15, 0, 0, .2, .8, 0, 0, 0, .1, 1.1, 0, .15, -.08, .04, 1] : IDENTITY_MATRIX;
        const preview = await pixels(await renderer.capture(scene, camera, 'image/png', grade, matrix, true));
        const command = kind === 'grade' ? { command: 'grade', values: grade, selectedOnly: true } : { command: 'transform', matrix, selectedOnly: true };
        const committed = await client.command(command);
        await client.stream((first, count, bytes) => scene!.upload(first, count, bytes), bytes => scene!.masks(bytes));
        const baked = await pixels(await renderer.capture(scene, camera));
        return { comparison: compare(preview, baked), effect: compare(before, preview), contentRevision: committed.contentRevision, errors };
      } finally { closed = true; if (scene) await scene.dispose(); client.dispose(); }
    },
  };
}
export type GpuHarness = Awaited<ReturnType<typeof createHarness>>;
declare global { interface Window { gpuHarness: GpuHarness; gpuHarnessError?: string; gpuRecoveryDiagnostic?: RecoveryReadinessDiagnostic } }
try { window.gpuHarness = await createHarness(); }
catch (error) { window.gpuHarnessError = error instanceof Error ? error.message : String(error); }
