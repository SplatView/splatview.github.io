import { requireWebGpuRenderer } from './gaussian-harness-scene';
import { exportWorkObservation } from './admitted-export';
// Scheduling gates wrap real controller/native/GPU operations. No shipping
// test hooks, fabricated scene masks, or production browser entry points.
import { AppController } from '../src/app/controller';
import { requireGaussianScene } from './gaussian-harness-scene';
import { setSelectionPreferences, switchToolsMode, useApp } from '../src/app/store';
import { sameRevision, type LivePreviewOutcome, type Revision, type SceneCommand } from '../src/document/types';
import type { SelectionRunResult } from '../src/input/selectionSession';
import type { ResourceLedger } from '../src/document/resources';
import { polygonPly, polygonPositions, polygonWorldOutline } from './polygon-fixture';

type StoreAccess = { get: typeof useApp.getState; preferences: typeof setSelectionPreferences; mode: typeof switchToolsMode };
type ControllerInternals = {
  selection?: { session: { draining?: Promise<unknown>; finishing?: Promise<unknown>; started?: Promise<unknown>;
    readonly computationFailed: boolean; readonly hasFailed: boolean; readonly cleanupNeeded: boolean } };
  polygon?: { [key: string]: unknown };
  editOperation?: { finished: Promise<void> };
  morphologyRangeOwner?: { finished: Promise<void> };
  morphologyRangeFailure?: { client: AppController['client']; generation: number; revision: Revision };
  generation: number;
  selectionCleanup?: Promise<void>; toleranceCleanup?: Promise<void>; releasedDrain?: Promise<void>;
  selectionMaps: { invalidate(): Promise<void> };
  ledger: ResourceLedger;
  runSelectionCommand(selection: unknown, command: SceneCommand, livePreview?: boolean): Promise<SelectionRunResult>;
  settleSelectionPublication(selection: unknown, generation: number): Promise<void>;
};
function gate() {
  let release!: () => void;
  return { held: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
export async function polygonGpu(controller: AppController) {
  const renderer = requireWebGpuRenderer(controller.renderer), scene = requireGaussianScene(controller.scene), size = scene.count * 4;
  const read = renderer.device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = renderer.device.createCommandEncoder(); encoder.copyBufferToBuffer(scene.buffers.states, 0, read, 0, size);
    renderer.device.queue.submit([encoder.finish()]); await read.mapAsync(GPUMapMode.READ);
    const result = Array.from(new Uint32Array(read.getMappedRange().slice(0))); read.unmap(); return result;
  } finally { read.destroy(); }
}
export function polygonCsvIds(data: ArrayBuffer) {
  return new TextDecoder().decode(data).trim().split(/\r?\n/).slice(1).map(row => {
    const point = row.split(',').slice(0, 3).map(Number);
    return polygonPositions.findIndex(source => source.every((value, axis) => Math.abs(value - point[axis]) < 1e-5));
  }).sort((a, b) => a - b);
}
export function polygonProjection(controller: AppController, points = polygonWorldOutline, css = false) {
  const canvas = requireWebGpuRenderer(controller.renderer).canvas, bounds = canvas.getBoundingClientRect();
  return points.map(([x, y, z]) => {
    const multiply = (point: number[], matrix: Float32Array) => Array.from({ length: 4 }, (_, column) =>
      point.reduce((sum, value, row) => sum + value * matrix[row * 4 + column], 0));
    const clip = multiply(multiply([x, -y, -z, 1], controller.camera!.view), controller.camera!.projection);
    return css ? [bounds.x + (clip[0] / clip[3] + 1) * bounds.width / 2, bounds.y + (1 - clip[1] / clip[3]) * bounds.height / 2]
      : [Math.round((clip[0] / clip[3] + 1) * canvas.width / 2), Math.round((1 - clip[1] / clip[3]) * canvas.height / 2)];
  });
}
export function installPolygonProbe(controller: AppController, store: StoreAccess = { get: useApp.getState, preferences: setSelectionPreferences, mode: switchToolsMode }) {
  const client = controller.client!, scene = requireGaussianScene(controller.scene), internals = controller as unknown as ControllerInternals;
  const traffic: SceneCommand[] = [], candidates: { command: SceneCommand; mask: number[] }[] = [];
  const command = client.command.bind(client), preview = client.livePreview.bind(client), stage = scene.stageMasks.bind(scene);
  const begin = client.beginOperation.bind(client), commit = client.commitOperation.bind(client), rollback = client.rollbackOperation.bind(client);
  // Keep lifecycle observations in the existing ordered traffic without
  // changing `last`, which owns the semantic candidate/publication gates.
  client.beginOperation = owner => { traffic.push({ command: 'beginTransaction', operationOwner: structuredClone(owner) }); return begin(owner); };
  client.commitOperation = owner => { traffic.push({ command: 'commitTransaction', operationOwner: structuredClone(owner) }); return commit(owner); };
  client.rollbackOperation = owner => { traffic.push({ command: 'rollbackTransaction', operationOwner: structuredClone(owner) }); return rollback(owner); };
  const admitted = new Set<Promise<unknown>>();
  const observe = <T>(operation: Promise<T>) => {
    admitted.add(operation);
    void operation.then(() => { admitted.delete(operation); }, () => { admitted.delete(operation); });
    return operation;
  };
  const submit = controller.command.bind(controller), update = controller.updatePolygon.bind(controller);
  const finish = controller.finishPolygonGesture.bind(controller), cancel = controller.cancelSelectionGesture.bind(controller);
  controller.command = (...args) => observe(submit(...args));
  controller.updatePolygon = (...args) => observe(update(...args));
  controller.finishPolygonGesture = (...args) => observe(finish(...args));
  controller.cancelSelectionGesture = (...args) => observe(cancel(...args));
  const settle = internals.settleSelectionPublication.bind(controller);
  internals.settleSelectionPublication = (...args) => observe(settle(...args));
  const previewResults: { command: SceneCommand; actual: LivePreviewOutcome; injected: boolean }[] = [];
  let nextTypedFailure: { command: string; held: ReturnType<typeof gate> } | undefined, activeTypedFailure: ReturnType<typeof gate> | undefined;
  let nextRestore: { held: ReturnType<typeof gate>; refuse: boolean } | undefined;
  let activeRestore: ReturnType<typeof gate> | undefined, restoreEntered = gate();
  const typedControl = { entered: false, released: false }, restoreControl = { entered: false, released: false };
  let last: SceneCommand = { command: '' }, nextGate: { kind: 'computation' | 'publication'; fail: boolean; held: ReturnType<typeof gate> } | undefined;
  let nativeRefusal = false;
  const control = { entered: false, released: false };
  client.command = async (...args) => {
    const request = args[0], owner = client.operationOwner;
    traffic.push({ ...request, ...(Array.isArray(request.points) ? { points: structuredClone(request.points) } : {}),
      ...(owner ? { operationOwner: structuredClone(owner) } : {}) }); last = request;
    if (request.command === 'polygon' && nativeRefusal) { nativeRefusal = false; throw new Error('Injected native Polygon command refusal.'); }
    if (request.command === 'cancelSelection' && nextRestore) {
      const restore = nextRestore; nextRestore = undefined; restoreControl.entered = true;
      restoreEntered.release();
      await restore.held.held;
      if (restore.refuse) throw new Error('Injected first baseline restoration refusal.');
    }
    return command(...args);
  };
  client.livePreview = async request => {
    const owner = client.operationOwner;
    traffic.push({ ...request, ...(Array.isArray(request.points) ? { points: structuredClone(request.points) } : {}),
      ...(owner ? { operationOwner: structuredClone(owner) } : {}) }); last = request;
    if (request.command === 'polygon' && nativeRefusal) { nativeRefusal = false; throw new Error('Injected native Polygon command refusal.'); }
    const injected = request.command === nextTypedFailure?.command ? nextTypedFailure.held : undefined;
    if (injected) nextTypedFailure = undefined;
    const actual = await preview(request);
    previewResults.push({ command: structuredClone(request), actual, injected: !!injected });
    if (!injected) return actual;
    // Test-only client-result replacement AFTER the real native call. This
    // proves rollback/session routing, not native nonpublication; the native
    // evaluator seam has separate tests for that computation-only guarantee.
    typedControl.entered = true; await injected.held;
    return { kind: 'computation-failed', version: 1 };
  };
  scene.stageMasks = async data => {
    if (last.command === 'polygon') candidates.push({ command: { ...last }, mask: Array.from(new Uint8Array(data)) });
    const held = nextGate;
    if (last.command === 'polygon' && held?.kind === 'publication') {
      nextGate = undefined; control.entered = true; await held.held.held;
      if (held.fail) throw new Error('Injected polygon publication refusal.');
    }
    return stage(data);
  };
  const run = internals.runSelectionCommand.bind(controller);
  internals.runSelectionCommand = async (owner, request, livePreview) => {
    const held = nextGate;
    if (request.command === 'polygon' && held?.kind === 'computation') {
      nextGate = undefined; control.entered = true; await held.held.held;
      if (held.fail) nativeRefusal = true;
    }
    return run(owner, request, livePreview);
  };
  let activeGate: ReturnType<typeof gate> | undefined;
  const flush = async () => {
    const joined = new Set<Promise<unknown>>();
    for (;;) {
      const session = internals.selection?.session;
      const pending = [session?.started, session?.draining, session?.finishing, internals.editOperation?.finished,
        internals.morphologyRangeOwner?.finished,
        internals.selectionCleanup, internals.toleranceCleanup, internals.releasedDrain, ...admitted]
        .filter((promise): promise is Promise<unknown> => Boolean(promise) && !joined.has(promise!));
      if (!pending.length) break;
      for (const promise of pending) joined.add(promise);
      await Promise.all(pending);
    }
  };
  const work = () => exportWorkObservation(client, internals.ledger).transient.bytes;
  return {
    controller, traffic, candidates, control, typedControl, restoreControl, previewResults, flush, work,
    failNextLivePreview(hold = false, command = 'polygon') {
      activeTypedFailure = gate(); nextTypedFailure = { command, held: activeTypedFailure };
      typedControl.entered = false; typedControl.released = !hold;
      if (!hold) activeTypedFailure.release();
    },
    releaseLivePreview() { typedControl.released = true; activeTypedFailure?.release(); },
    holdBaselineRestore(refuse = false) {
      activeRestore = gate(); nextRestore = { held: activeRestore, refuse };
      restoreEntered = gate();
      restoreControl.entered = restoreControl.released = false;
    },
    waitForBaselineRestore() { return restoreEntered.held; },
    releaseBaselineRestore() { restoreControl.released = true; activeRestore?.release(); },
    state() {
      const state = store.get();
      return { busy: state.busy, error: state.error, selectionRecovery: state.selectionRecovery,
        active: controller.selectionActive, polygon: controller.polygonSelectionState,
        mode: state.mode, live: state.live, overlap: state.overlap, operation: state.operation,
        dragging: state.selectionDragging, captured: state.selectionOperation, work: work() };
    },
    async inspect() {
      await flush();
      return { summary: await client.command({ command: 'summary' }), gpu: await polygonGpu(controller) };
    },
    async invalidateMaps() { await flush(); await internals.selectionMaps.invalidate(); },
    outline: () => polygonProjection(controller, polygonWorldOutline, true).map(point => point.map(Math.round)),
    physicalOutline: () => polygonProjection(controller), gpu: () => polygonGpu(controller),
    hold(kind: 'computation' | 'publication', fail = false) {
      activeGate = gate(); control.entered = control.released = false; nextGate = { kind, fail, held: activeGate };
    },
    release() { control.released = true; activeGate?.release(); },
    profiles(from: 'basic' | 'pro', live: boolean, overlap: boolean, otherLive = !live, otherOverlap = !overlap) {
      const other = from === 'basic' ? 'pro' : 'basic';
      store.mode(other); store.preferences({ operation: 2, live: otherLive, overlap: otherOverlap, visibleOnly: false });
      store.mode(from); store.preferences({ operation: 0, live, overlap, visibleOnly: false });
    },
    options: (patch: Parameters<typeof setSelectionPreferences>[0]) => store.preferences(patch),
    mode: (target: 'basic' | 'pro') => store.mode(target),
    async baseline(redo = true) {
      await controller.command({ command: 'single', index: 0, operation: 0 });
      await controller.command({ command: 'single', index: 2, operation: 1 });
      if (redo) { await controller.command({ command: 'single', index: 3, operation: 1 }); await controller.command({ command: 'undo' }); }
    },
    async snapshot() {
      await flush();
      // The mounted App admits passive metadata work from a React effect.
      // Let the completed edit render, then join that real owner before
      // observing readiness for the next physical history-control press.
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      for (;;) {
        await flush();
        const current = store.get(), failure = internals.morphologyRangeFailure;
        const failedCurrentQuery = failure?.client === client && failure.generation === internals.generation &&
          sameRevision(failure.revision, client.revision);
        // A presented, eligible Pro control requests this statistic itself.
        // Observe either result; never initiate it or require success.
        if (!document.querySelector('.selection-morphology') || current.mode !== 'pro' ||
            current.selectionMorphologyMethod !== 'volume' || !controller.selectionMorphologyControlsEnabled ||
            controller.selectionMorphologyRange || failedCurrentQuery) break;
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      }
      const scene = requireGaussianScene(controller.scene), count = polygonPositions.length, stride = scene.stride;
      if (scene.count !== count || controller.client !== client) throw new Error('The polygon native record owner changed.');
      const native = new Uint8Array(count * stride); let next = 0, nativeMasks = new Uint8Array();
      const streamed = await client.stream(async (first, length, bytes) => {
        if (controller.client !== client || controller.scene !== scene || first !== next || length <= 0 ||
            first + length > count || bytes.byteLength !== length * stride)
          throw new Error('The polygon native stream changed its owner or record range.');
        native.set(new Uint8Array(bytes), first * stride); next += length;
      }, bytes => { nativeMasks = new Uint8Array(bytes); });
      if (controller.client !== client || controller.scene !== scene || next !== count || nativeMasks.length !== count ||
          streamed.count !== count || stride !== 40 + 4 * Math.ceil(3 * (Math.min(streamed.shDegree, 3) + 1) ** 2 / 2))
        throw new Error('The polygon native stream omitted records/masks or changed its packed layout.');
      const ids: number[] = [], sourceIds = new Set<number>(), view = new DataView(native.buffer);
      for (let index = 0; index < count; index++) {
        // Native RUB -> the independent fixture's RDF source coordinates.
        // Membership comes from actual positions and canonical masks; no
        // output writer, admitted export or fabricated export error is used.
        const point = [view.getFloat32(index * stride, true), -view.getFloat32(index * stride + 4, true), -view.getFloat32(index * stride + 8, true)];
        const sourceId = polygonPositions.findIndex(source => source.every((value, axis) => Math.abs(value - point[axis]) < 1e-5));
        if (sourceId < 0 || sourceIds.has(sourceId)) throw new Error('The polygon stream has an unknown or repeated source position.');
        sourceIds.add(sourceId);
        if ((nativeMasks[index] & 1) && !(nativeMasks[index] & 2)) ids.push(sourceId);
      }
      ids.sort((a, b) => a - b);
      const summary = await client.command({ command: 'summary' }), gpu = await polygonGpu(controller);
      // The passive reach query can start during these asynchronous readbacks.
      // It changes no records, masks or history; join its real owner before
      // reading terminal UI/work state, without requiring optional metadata.
      while (internals.morphologyRangeOwner) await internals.morphologyRangeOwner.finished;
      const state = store.get();
      return { summary, gpu, ids, nativeMasks: Array.from(nativeMasks), nativeRecordBytes: Array.from(native), recordStride: stride,
        byteOracle: 'Actual native _sv_pack active records and canonical masks; IDs from independently declared source positions, not serialized export files.',
        work: work(), workOwnership: exportWorkObservation(client, internals.ledger), mode: state.mode, pendingMode: state.pendingMode,
        operation: state.operation, captured: state.selectionOperation, dragging: state.selectionDragging, live: state.live,
        overlap: state.overlap, tool: state.tool, active: controller.selectionActive, error: state.error };
    },
    dispose() { activeGate?.release(); activeTypedFailure?.release(); activeRestore?.release(); controller.dispose(); },
  };
}
async function setup() {
  const canvas = document.createElement('canvas'); canvas.style.width = '480px'; canvas.style.height = '300px'; document.body.append(canvas);
  const controller = new AppController(); await controller.initialize(canvas); await controller.openFiles([new File([polygonPly()], 'polygon-sh0.ply')]);
  if (!controller.client || !controller.scene || !controller.renderer || !controller.camera) throw new Error(useApp.getState().error || 'Polygon fixture unavailable.');
  controller.camera.set([0, 0, 0, 0, 0, 3, 1, 45, 0, 0, canvas.width / canvas.height]);
  useApp.setState({ tool: 'polygon', operation: 0, visibleOnly: false, overlap: false, live: false, selectionDragging: false });
  const probe = installPolygonProbe(controller), dispose = probe.dispose;
  probe.dispose = () => { dispose(); canvas.remove(); }; return probe;
}
export function createPolygonHarness() {
  return {
    async supersededPublication(tool: 'rectangle' | 'volume', mode: 'basic' | 'pro') {
      const h = await setup(); let release: (() => void) | undefined;
      try {
        h.profiles(mode, true, false); await h.baseline(); const before = await h.snapshot();
        useApp.setState({ tool, live: true, visibleOnly: false, overlap: false });
        const renderer = requireWebGpuRenderer(h.controller.renderer), points = h.physicalOutline();
        const command: SceneCommand = { command: tool, camera: h.controller.camera!.state,
          width: renderer.canvas.width, height: renderer.canvas.height, operation: 0, overlap: false,
          visibleOnly: false, radius: 24, points: polygonProjection(h.controller, [polygonPositions[1]]),
          rectangle: [...points[0], ...points[2]] };
        if (!h.controller.beginSelectionGesture(0)) throw new Error('The geometric draft did not begin.');
        await h.flush();
        const stage = requireGaussianScene(h.controller.scene).stageMasks.bind(requireGaussianScene(h.controller.scene));
        const entered = gate(), held = gate(); release = held.release;
        let candidate: number[] | undefined, first = true;
        requireGaussianScene(h.controller.scene).stageMasks = async bytes => {
          const staged = await stage(bytes);
          if (!first) return staged;
          first = false; candidate = Array.from(new Uint8Array(bytes)); entered.release();
          await held.held; staged.dispose();
          throw new Error(`Injected ${tool} physical publication refusal after Combine.`);
        };
        h.controller.previewSelection(command); await entered.held;
        h.controller.setSelectionOperation(1); held.release();
        await h.flush();
        const accepted = await h.controller.finishSelectionGesture(command), after = await h.snapshot();
        await h.controller.command({ command: 'redo' }); const redone = await h.snapshot();
        await h.invalidateMaps(); const settled = await h.snapshot();
        return { before, after, redone, settled, accepted, candidate,
          previewResults: h.previewResults, traffic: h.traffic, work: h.work() };
      } finally { release?.(); h.dispose(); }
    },
    async geometricRestoreRefusal(tool: 'rectangle' | 'volume', mode: 'basic' | 'pro') {
      const h = await setup();
      try {
        h.profiles(mode, true, false); await h.baseline();
        // The baseline selection starts an automatic pivot query that briefly owns the editor.
        for (const started = performance.now(); useApp.getState().busy || useApp.getState().transformPivotPending;) {
          if (performance.now() - started > 5000) throw new Error('The editor did not become idle.');
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        useApp.setState({ tool, live: true, visibleOnly: false, overlap: false });
        const renderer = requireWebGpuRenderer(h.controller.renderer), points = h.physicalOutline();
        const command: SceneCommand = { command: tool, camera: h.controller.camera!.state,
          width: renderer.canvas.width, height: renderer.canvas.height, operation: 0, overlap: false,
          visibleOnly: false, radius: 24, points: polygonProjection(h.controller, [polygonPositions[1]]),
          rectangle: [...points[0], ...points[2]] };
        if (!h.controller.beginSelectionGesture(0)) throw new Error('The geometric draft did not begin.');
        await h.flush(); h.failNextLivePreview(false, tool); h.holdBaselineRestore(true);
        h.controller.previewSelection(command); await h.waitForBaselineRestore(); h.releaseBaselineRestore();
        await h.flush();
        const required = { ...(await h.inspect()), state: h.state(), editing: h.controller.editingAvailable,
          cancellations: h.traffic.filter(request => request.command === 'cancelSelection').length };
        const restored = await h.controller.retrySelectionCleanup(), after = await h.snapshot();
        await h.controller.command({ command: 'redo' }); const redone = await h.snapshot();
        await h.invalidateMaps();
        return { required, restored, after, redone, traffic: h.traffic, previewResults: h.previewResults, work: h.work() };
      } finally { h.dispose(); }
    },
    async geometricDeferred(tool: 'rectangle' | 'brush' | 'visible-brush' | 'volume', mode: 'basic' | 'pro',
      priorPreview: boolean, terminal: 'finish' | 'cancel') {
      const h = await setup();
      try {
        h.profiles(mode, true, false); await h.baseline(); const before = await h.snapshot();
        const nativeTool = tool === 'visible-brush' ? 'brush' : tool, visibleOnly = tool === 'visible-brush';
        useApp.setState({ tool: nativeTool, live: true, visibleOnly, overlap: false });
        const renderer = requireWebGpuRenderer(h.controller.renderer), outline = h.physicalOutline();
        // Independent source islands: the first brush center is ID1, the last
        // is ID3. ID2's center is outside a 0.3-world-unit brush but its 3-sigma
        // radius (0.24) touches it. ID0 is separated from the entire path.
        const stroke = polygonProjection(h.controller, [polygonPositions[1], [-.25, .325, 0], polygonPositions[3]]);
        const radiusPoints = polygonProjection(h.controller, [[.2, 0, 0], [.5, 0, 0]]);
        const command: SceneCommand = { command: nativeTool, camera: h.controller.camera!.state,
          width: renderer.canvas.width, height: renderer.canvas.height, operation: 0,
          overlap: false, visibleOnly, radius: Math.max(1, Math.round(Math.abs(radiusPoints[1][0] - radiusPoints[0][0]))),
          points: stroke.slice(0, 1), rectangle: [...outline[0], ...outline[2]] };
        const full: SceneCommand = { ...command, points: structuredClone(stroke) };
        if (!h.controller.beginSelectionGesture(0)) throw new Error('The geometric draft did not begin.');
        await h.flush();
        let published: Awaited<ReturnType<typeof h.snapshot>> | undefined;
        if (priorPreview) {
          h.controller.previewSelection(command); await h.flush(); published = await h.snapshot();
        }
        h.failNextLivePreview(false, nativeTool);
        h.controller.previewSelection({ ...command, points: stroke.slice(0, 2) }); await h.flush();
        const failed = await h.snapshot(), session = (h.controller as unknown as ControllerInternals).selection?.session;
        const deferred = { state: h.state(), computationFailed: session?.computationFailed,
          hasFailed: session?.hasFailed, cleanupNeeded: session?.cleanupNeeded };
        const previewsBefore = h.previewResults.length, callsBefore = h.traffic.filter(request => request.command === nativeTool).length;
        // Full path movement and changed Combine must not revive the stopped
        // computation. Restore Replace for an independent touched final mask.
        h.controller.previewSelection(full); await h.flush();
        h.controller.setSelectionOperation(1); await h.flush();
        h.controller.setSelectionOperation(0); await h.flush();
        const suppressed = await h.snapshot(), suppressedCalls = {
          previews: h.previewResults.length - previewsBefore,
          commands: h.traffic.filter(request => request.command === nativeTool).length - callsBefore,
        };
        // Supply the current release options through the controller boundary.
        // This controller harness does not claim physical profile switching.
        useApp.setState({ overlap: true });
        const final = { ...full, overlap: useApp.getState().overlap, operation: useApp.getState().operation };
        const accepted = terminal === 'finish' ? await h.controller.finishSelectionGesture(final) : await h.controller.cancelSelectionGesture();
        const after = await h.snapshot();
        let undone: Awaited<ReturnType<typeof h.snapshot>> | undefined;
        if (terminal === 'finish') { await h.controller.command({ command: 'undo' }); undone = await h.snapshot(); }
        await h.controller.command({ command: 'redo' }); const redone = await h.snapshot();
        await h.invalidateMaps(); const settled = await h.snapshot();
        const evaluations = h.traffic.filter(request => request.command === nativeTool);
        return { tool, mode, terminal, priorPreview, before, published, failed, deferred, suppressed, suppressedCalls,
          accepted, after, undone, redone, settled, fullPath: stroke, final,
          finalEvaluations: evaluations.length - h.previewResults.length,
          finalRequest: terminal === 'finish' ? evaluations.at(-1) : undefined,
          traffic: h.traffic, previewResults: h.previewResults, work: h.work() };
      } finally { h.dispose(); }
    },
    async geometry(overlap: boolean) {
      const h = await setup();
      try {
        await h.baseline(); const before = await h.snapshot();
        await h.controller.command({ command: 'polygon', points: h.physicalOutline(), camera: h.controller.camera!.state,
          width: requireWebGpuRenderer(h.controller.renderer).canvas.width, height: requireWebGpuRenderer(h.controller.renderer).canvas.height, operation: 0, overlap });
        const after = await h.snapshot(); await h.controller.command({ command: 'undo' }); const undone = await h.snapshot();
        return { before, after, undone, traffic: h.traffic, work: h.work() };
      } finally { h.dispose(); }
    },
    async unusable(mode: 'basic' | 'pro') {
      const h = await setup();
      try {
        h.profiles(mode, true, false); await h.baseline(); const before = await h.snapshot();
        const renderer = requireWebGpuRenderer(h.controller.renderer), command = { command: 'polygon', points: h.physicalOutline(),
          camera: h.controller.camera!.state, width: renderer.canvas.width, height: renderer.canvas.height, operation: 0, overlap: false };
        if (!h.controller.beginPolygonGesture(0)) throw new Error('The real Polygon did not begin.');
        await h.controller.updatePolygon({ ...command, points: command.points.slice(0, 2) }, true);
        const requested = h.controller.polygonSelectionState, publishedBeforeFinal = await h.snapshot(), callsBeforeFinal = h.traffic.filter(request => request.command === 'polygon').length;
        h.mode(mode === 'basic' ? 'pro' : 'basic');
        const accepted = await h.controller.finishPolygonGesture({ ...command, overlap: true }), after = await h.snapshot();
        await h.controller.command({ command: 'undo' }); const undone = await h.snapshot();
        await h.controller.command({ command: 'redo' }); const redone = await h.snapshot();
        return { before, requested, publishedBeforeFinal, callsBeforeFinal, accepted, after, undone, redone, traffic: h.traffic, work: h.work() };
      } finally { h.dispose(); }
    },
  };
}
declare global { interface Window { polygonApp: ReturnType<typeof installPolygonProbe>; polygonHarness: ReturnType<typeof createPolygonHarness>; polygonHarnessError?: string } }
if (location.pathname.endsWith('polygon-harness.html')) {
  try { window.polygonHarness = createPolygonHarness(); } catch (error) { window.polygonHarnessError = String(error); }
}
