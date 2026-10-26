import { requireWebGpuController } from './gaussian-harness-scene';
import { requireWebGpuRenderer } from './gaussian-harness-scene';
import { admittedExport } from './admitted-export';
// Test-only App exposure. Production entry and controller have no test hooks.
import { AppController } from '../src/app/controller';
import { useApp } from '../src/app/store';
import { GpuGeometryScene } from '../src/renderer/webgpu/renderer';
import { NEUTRAL_COLOR } from '../src/renderer/defaults';
import { type SceneCommand } from '../src/document/types';
import type { ResourceLedger } from '../src/document/resources';
import type { CoreClient } from '../src/document/coreClient';
import { gaussianPly } from '../tests/fixtures/gaussians';

// Literal independent PLY inputs; no production parser, triangulator or packer.
const points = `ply
format ascii 1.0
element vertex 3
property float x
property float y
property float z
property uchar red
property uchar green
property uchar blue
end_header
-.4 0 0 255 0 0
.4 0 0 0 255 0
0 .4 .1 0 0 255
`;
const mesh = `ply
format ascii 1.0
element vertex 6
property float x
property float y
property float z
property uchar red
property uchar green
property uchar blue
element face 1
property list uchar int vertex_indices
end_header
0 0 0 255 180 30
2 0 0 255 180 30
2 1 0 255 180 30
1 1 0 255 180 30
1 2 0 255 180 30
0 2 0 255 180 30
6 0 1 2 3 4 5
`;
const malformed = mesh.replace('6 0 1 2 3 4 5', '6 0 1 2 3 4 99');
type Source = 'points' | 'mesh' | 'gaussian';
let instance: AppController | undefined;
let traffic: { client: CoreClient; original: CoreClient['command']; calls: string[] } | undefined;
const initialize = AppController.prototype.initialize;
AppController.prototype.initialize = async function (...args) {
  instance = this;
  try { return await initialize.apply(this, args); }
  finally { AppController.prototype.initialize = initialize; }
};
function controller() { if (!instance) throw new Error('The actual App controller has not initialized.'); return requireWebGpuController(instance); }
function internals() {
  return controller() as unknown as { ledger: ResourceLedger; candidate?: { dispose(): void };
    files: readonly Readonly<{ name: string }>[]; currentFile: number };
}
function ledger() {
  if (!instance) throw new Error('The actual App controller has not initialized.');
  // Retirement assertions still own this ledger after dispose clears renderer.
  const value = (instance as unknown as { ledger: ResourceLedger }).ledger;
  const entries = [...(value as unknown as { entries: Map<symbol, { category: string; bytes: number }> }).entries.values()]
    .map(entry => ({ ...entry })).sort((a, b) => a.category.localeCompare(b.category) || a.bytes - b.bytes);
  return { bytes: value.usage.bytes, allocations: value.usage.allocations, entries };
}
function file(source: Source, name = `${source}.ply`) { return new File([source === 'gaussian' ? gaussianPly(0) : source === 'points' ? points : mesh], name); }
function gate() {
  let enter!: () => void, release!: () => void;
  return { entered: new Promise<void>(resolve => { enter = resolve; }), held: new Promise<void>(resolve => { release = resolve; }), enter: () => enter(), release: () => release() };
}
async function hash(bytes: BufferSource) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join(''); }
async function image(blob: Blob) {
  const bitmap = await createImageBitmap(blob);
  try {
    const output = new OffscreenCanvas(bitmap.width, bitmap.height), context = output.getContext('2d')!;
    context.drawImage(bitmap, 0, 0); const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const background = Array.from(pixels.subarray(0, 4)); let foreground = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] !== background[0] || pixels[i + 1] !== background[1] || pixels[i + 2] !== background[2]) foreground++;
    return { hash: await hash(pixels), width: bitmap.width, height: bitmap.height, background, foreground };
  } finally { bitmap.close(); }
}
async function gpuBytes(buffer: GPUBuffer, size: number) {
  const renderer = requireWebGpuRenderer(controller().renderer), readback = renderer.device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  try {
    const encoder = renderer.device.createCommandEncoder(); encoder.copyBufferToBuffer(buffer, 0, readback, 0, size);
    renderer.device.queue.submit([encoder.finish()]); await readback.mapAsync(GPUMapMode.READ);
    const bytes = readback.getMappedRange().slice(0); readback.unmap(); return bytes;
  } finally { readback.destroy(); }
}
async function snapshot() {
  const app = controller(), state = useApp.getState();
  const capture = await image(await app.capture('image/png'));
  const exported = app.scene?.kind === 'gaussian' ? await hash(await admittedExport(app.client!, 0, 0)) : null;
  const gpuMasks = app.scene?.kind === 'gaussian' ? Array.from(new Uint32Array(await gpuBytes(app.scene.buffers.states, app.scene.count * 4))) : null;
  const summary = await app.client!.command({ command: 'summary' });
  return { summary, capture, exported, gpuMasks, camera: app.camera!.state, cameraBackground: app.camera!.background,
    sourceFingerprint: app.sourceFingerprint,
    sourceName: state.sourceName, dirty: state.dirty, grade: state.grade, tool: state.tool, toolsOpen: state.toolsOpen,
    exportOpen: state.exportOpen, background: state.background, rendererState: state.rendererState,
    sourceIndex: internals().currentFile, sourceFiles: internals().files.map(source => source.name), ledger: ledger(),
    deviceEpoch: requireWebGpuRenderer(app.renderer).deviceEpoch, depthBytes: requireWebGpuRenderer(app.renderer).geometryDepthAllocationBytes };
}
async function load(source: Source) {
  const app = controller();
  await app.openFiles([file(source)]);
  // This helper explicitly resets the fixture, including an outstanding color preview.
  if (useApp.getState().navigationPrompt) await app.discardAndContinue();
  if (useApp.getState().summary?.kind !== (source === 'gaussian' ? 0 : source === 'points' ? 1 : 2))
    throw new Error(useApp.getState().error ?? 'Actual App source was not published.');
}
async function selectionSnapshot() {
  // Capture/export intentionally refuse a live manual draft. Read its fresh
  // native packed view and canonical masks without settling that operation.
  // Packed SH is quantized; settled PLY hashes remain the lossless byte oracle.
  const app = controller(), state = useApp.getState(), scene = app.scene, client = app.client, camera = app.camera;
  if (scene?.kind !== 'gaussian' || !client || !camera) throw new Error('Selection requires a Gaussian scene.');
  const current = () => {
    if (app.client !== client || app.scene !== scene || app.camera !== camera)
      throw new Error('The observed selection scene changed owners.');
  };
  const source = await client.command({ command: 'summary' });
  const held = source.selectionDraft || source.transaction || Boolean(client.operationOwner);
  const exported = source.visible && !held ? await hash(await admittedExport(client, 0, 0)) : null;
  const nativeViewBytes = new Uint8Array(scene.count * scene.stride);
  let next = 0, nativeMasks = new Uint8Array();
  const streamed = await client.stream(async (first, count, bytes) => {
    current();
    if (first !== next || count < 0 || first + count > scene.count || bytes.byteLength !== count * scene.stride)
      throw new Error('The native selection stream changed its record range.');
    nativeViewBytes.set(new Uint8Array(bytes), first * scene.stride); next += count;
  }, bytes => { current(); nativeMasks = new Uint8Array(bytes); });
  current();
  if (streamed.count !== scene.count || next !== scene.count || nativeMasks.length !== scene.count)
    throw new Error('The native selection stream omitted records or canonical masks.');
  const gpuViewBytes = Array.from(new Uint8Array(await gpuBytes(scene.buffers.splats, nativeViewBytes.byteLength)));
  const gpuMasks = Array.from(new Uint32Array(await gpuBytes(scene.buffers.states, scene.count * 4)));
  // Include the observation's own native pack/export allocations in its summary.
  const summary = await client.command({ command: 'summary' }); current();
  return { summary,
    gpuMasks, nativeMasks: Array.from(nativeMasks), nativeViewBytes: Array.from(nativeViewBytes), gpuViewBytes,
    exported, camera: camera.state,
    tool: state.tool, selectionActive: app.selectionActive };
}
async function inspect() {
  const app = controller(), scene = app.scene!;
  if (scene.kind !== 'geometry') throw new Error('A geometry source is required.');
  const vertices = await gpuBytes(scene.vertices, scene.descriptor.vertexBytes), data = new DataView(vertices);
  const records = Array.from({ length: scene.count }, (_, i) => ({ position: [0, 4, 8].map(offset => data.getFloat32(i * 16 + offset, true)),
    rgba: Array.from(new Uint8Array(vertices, i * 16 + 12, 4)) }));
  const indices = scene.indices ? Array.from(new Uint32Array(await gpuBytes(scene.indices, scene.descriptor.indexBytes))) : [];
  let area = 0; const centroids: number[][] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = indices.slice(i, i + 3).map(index => records[index].position);
    area += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
    centroids.push([(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3]);
  }
  return { ...(await snapshot()), descriptor: scene.descriptor, records, indices, area, centroids,
    noGaussianBuffers: !('buffers' in scene) && !('sortStages' in scene) && !('stageMasks' in scene),
    editingAvailable: app.editingAvailable };
}
// Selection and content changes briefly own the automatic transform pivot query.
async function colorIdle() {
  for (const start = performance.now(); !controller().colorControlsEnabled && performance.now() - start < 10_000;)
    await new Promise(resolve => setTimeout(resolve, 5));
}
async function editedGaussian() {
  const app = controller(); await app.openFiles([file('gaussian', 'a-old.ply'), file('gaussian', 'z-next.ply')]);
  await app.command({ command: 'selectAll' }); await colorIdle();
  const grade = [...NEUTRAL_COLOR]; grade[0] = 1.2; await app.command({ command: 'grade', values: grade }); await colorIdle();
  grade[0] = 1.5; await app.command({ command: 'grade', values: grade }); await colorIdle(); await app.command({ command: 'undo' }); await colorIdle();
  app.camera!.orbit(11, -7); app.cycleBackground(); app.invalidate();
}
async function attemptReplacement(candidate: File) {
  const app = controller(); await app.openFiles([candidate]);
  if (useApp.getState().navigationPrompt) await app.discardAndContinue();
}
const harness = {
  controllerForSourceNavigation: controller,
  controllerForRendererNavigation: () => { if (!instance) throw new Error('The App has not initialized.'); return instance; },
  observeSourceNavigation() {
    const app = controller(), originalFiles = app.openFiles, originalDrop = app.openDrop, operations: Promise<void>[] = [];
    const files: AppController['openFiles'] = function (this: AppController, ...args) {
      const operation = originalFiles.apply(this, args); operations.push(operation); return operation;
    };
    const drop: AppController['openDrop'] = function (this: AppController, ...args) {
      const operation = originalDrop.apply(this, args); operations.push(operation); return operation;
    };
    app.openFiles = files; app.openDrop = drop;
    return {
      async joined() {
        let count = 0;
        while (count < operations.length) {
          const pending = operations.slice(count); count = operations.length; await Promise.allSettled(pending);
        }
      },
      restore() {
        if (app.openFiles === files) app.openFiles = originalFiles;
        if (app.openDrop === drop) app.openDrop = originalDrop;
      },
    };
  },
  ready: () => !!instance && useApp.getState().ready,
  histogramState() {
    // Read the same statically imported store as App; raw URL imports can
    // create a second module identity after Vite adds an HMR timestamp.
    const state = useApp.getState();
    return { sourceName: state.sourceName, busy: state.busy,
      histogram: state.histogram ? { ...state.histogram, bins: Array.from(state.histogram.bins) } : null,
      unavailable: state.histogramUnavailable };
  },
  load, inspect, snapshot, selectionSnapshot,
  observeTutorial() {
    // Retain actual object identities for a read-only observation. The tour
    // must never replace a document, camera, renderer or packed GPU scene.
    const app = controller(), client = app.client, scene = app.scene, renderer = app.renderer, camera = app.camera;
    return () => {
      const state = useApp.getState();
      return { sameClient: app.client === client, sameScene: app.scene === scene,
        sameRenderer: app.renderer === renderer, sameCamera: app.camera === camera, originalSceneRetired: scene?.retired,
        hasClient: !!app.client, sceneKind: app.scene?.kind ?? null, revision: app.client ? { ...app.client.revision } : null,
        mode: state.mode, pendingMode: state.pendingMode, toolsOpen: state.toolsOpen, tool: state.tool,
        busy: state.busy, ready: state.ready, rendererState: state.rendererState, error: state.error,
        settingsOpen: state.settingsOpen, exportOpen: state.exportOpen, navigationPrompt: state.navigationPrompt,
        selectionRecovery: state.selectionRecovery, operationRecovery: state.operationRecovery,
        pendingSelectionCount: state.pendingSelectionCount, selectionDragging: state.selectionDragging,
        memoryOverageBytes: state.memoryOverageBytes, outputPending: state.outputPending,
        savedViewChoices: state.savedViewChoices.length, autoOrbit: state.autoOrbit,
        filter: state.filter, transform: state.transform, opacity: state.opacity, grade: [...state.grade],
        controls: { editing: app.editingAvailable, color: app.colorPreviewEnabled, opacity: app.opacityControlsEnabled,
          transform: app.transformControlsEnabled, filter: app.filterControlsEnabled, alignment: app.alignmentControlsEnabled,
          floor: app.floorDetectionEnabled, morphology: app.selectionMorphologyControlsEnabled },
        ledger: ledger(), depthBytes: app.renderer?.geometryDepthAllocationBytes ?? 0 };
    };
  },
  renderState() {
    const renderer = requireWebGpuRenderer(controller().renderer);
    return { width: renderer.canvas.width, height: renderer.canvas.height, frames: renderer.frames,
      depthBytes: renderer.geometryDepthAllocationBytes, ledger: ledger() };
  },
  async restrictions() {
    const app = controller(), client = app.client!, calls: string[] = [], exports: number[] = [], renderer = requireWebGpuRenderer(app.renderer);
    const command = client.command.bind(client), output = client.exportOwned.bind(client), pick = renderer.pick.bind(renderer), before = await snapshot();
    let gpuPicks = 0;
    client.command = async (...args) => { calls.push(args[0].command); return command(...args); };
    client.exportOwned = async (...args) => { exports.push(args[0]); return output(...args); };
    renderer.pick = async (...args) => { gpuPicks++; return pick(...args); };
    try {
      const edits = [];
      for (const value of ['selectAll', 'delete', 'undo', 'redo', 'transform', 'grade'] as const)
        edits.push(await app.command({ command: value, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1], values: [...NEUTRAL_COLOR] } as SceneCommand));
      const picks = { single: (await app.selectPixel(1, 1, 0)) ?? null, color: await app.selectColorPixel(1, 1, 0), fill: await app.fillPixel(1, 1, 0) };
      const gesture = app.beginSelectionGesture(); await app.focusPixel(1, 1);
      let mapError = ''; try { await app.selectionMap(); } catch (error) { mapError = String(error); }
      await app.exportScene(); app.setGrade(NEUTRAL_COLOR.map(value => value + .25));
      const forwarded = [...calls], exportCalls = exports.length;
      return { before, after: await snapshot(), edits, picks, gesture, mapError, forwarded, exportCalls, gpuPicks };
    } finally { client.command = command; client.exportOwned = output; renderer.pick = pick; }
  },
  async keyboardStart() {
    const initial = await snapshot(), client = controller().client!, calls: string[] = [], original = client.command.bind(client);
    client.command = async (...args) => { calls.push(args[0].command); return original(...args); };
    traffic = { client, original, calls }; return initial;
  },
  async keyboardFinish() {
    if (!traffic) throw new Error('Keyboard traffic was not started.');
    const { client, original, calls } = traffic; traffic = undefined; client.command = original;
    return { calls, after: await snapshot() };
  },
  async transitions() {
    const app = controller(); await load('gaussian');
    useApp.setState({ toolsOpen: true, tool: 'polygon', grade: NEUTRAL_COLOR.map(value => value + .1), exportOpen: true });
    await load('mesh'); const geometry = await inspect();
    await load('gaussian'); const gaussian = await snapshot();
    return { geometry, gaussian, editingAvailable: app.editingAvailable };
  },
  async replacementFailure(kind: 'malformed' | 'budget' | 'gpu' | 'cancel') {
    await editedGaussian(); const app = controller(), oldClient = app.client, oldScene = app.scene, oldRenderer = app.renderer;
    const before = await snapshot(), budget = internals().ledger as unknown as { limit: number }, limit = budget.limit;
    const upload = GpuGeometryScene.prototype.uploadVertices, device = requireWebGpuRenderer(app.renderer).device, createBuffer = device.createBuffer.bind(device);
    const held = gate(); let heldCandidate: ReturnType<typeof internals>['candidate'], uploadCalls = 0;
    let afterCancel: { settled: boolean; sameClient: boolean; sameScene: boolean; admitted: ReturnType<typeof ledger>;
      held: ReturnType<typeof ledger>; candidateDisposed: boolean } | null = null;
    let settled = false;
    try {
      if (kind === 'budget') budget.limit = before.ledger.bytes + 1024;
      if (kind === 'gpu') device.createBuffer = specification => createBuffer(specification.label === 'Readonly PLY vertices' ? { ...specification, usage: 0 } : specification);
      if (kind === 'cancel') GpuGeometryScene.prototype.uploadVertices = async function (...args) {
        uploadCalls++; heldCandidate = internals().candidate; held.enter(); await held.held; return upload.apply(this, args);
      };
      const candidate = new File([kind === 'malformed' ? malformed : mesh], 'replacement.ply');
      const replacing = attemptReplacement(candidate).finally(() => { settled = true; });
      if (kind === 'cancel') {
        await held.entered; const admitted = ledger(); app.cancelLoad(); await Promise.resolve();
        afterCancel = { settled, sameClient: app.client === oldClient, sameScene: app.scene === oldScene,
          admitted, held: ledger(), candidateDisposed: (heldCandidate as unknown as { disposed?: boolean })?.disposed === true };
        held.release();
      }
      await replacing;
    } finally {
      held.release(); budget.limit = limit; GpuGeometryScene.prototype.uploadVertices = upload; device.createBuffer = createBuffer;
    }
    const after = await snapshot(), error = useApp.getState().error;
    const sameClient = app.client === oldClient, sameScene = app.scene === oldScene, sameRenderer = app.renderer === oldRenderer;
    const redone = await app.command({ command: 'redo' });
    return { kind, before, after, error, sameClient, sameScene, sameRenderer, uploadCalls, afterCancel,
      redone, afterRedo: await snapshot(), settled };
  },
  async recover(source: 'points' | 'mesh') {
    const app = controller(); await load(source); app.camera!.orbit(17, -9); app.cycleBackground(); app.invalidate();
    const before = await snapshot(), client = app.client, scene = app.scene, renderer = requireWebGpuRenderer(app.renderer);
    const commands: string[] = [], original = client!.command.bind(client!);
    client!.command = async (...args) => { commands.push(args[0].command); return original(...args); };
    try {
      renderer.device.destroy(); await renderer.device.lost;
      if (!await app.retryRenderer()) throw new Error(useApp.getState().error ?? 'Actual geometry device recovery failed.');
      const after = await snapshot();
      return { before, after, sameClient: app.client === client, replacedScene: app.scene !== scene,
        replacedRenderer: app.renderer !== renderer, oldRetired: scene!.retired, commands, error: useApp.getState().error };
    } finally { client!.command = original; }
  },
  async resize(width: number) {
    const canvas = requireWebGpuRenderer(controller().renderer).canvas; canvas.style.width = `${width}px`; canvas.style.height = '361px';
  },
  async disposeRetirement() {
    const app = controller(); await load('mesh'); const before = await inspect(), scene = app.scene!, renderer = requireWebGpuRenderer(app.renderer), client = app.client!;
    const queue = renderer.device.queue, original = queue.onSubmittedWorkDone.bind(queue), actualCompletion = original(), held = gate();
    const originalRetirement = client.retireNativeMemory;
    let nativeRetirement: Promise<void> | undefined, nativeRetirementCalls = 0, enteredNativeRetirement!: () => void;
    const nativeRetirementEntered = new Promise<void>(resolve => { enteredNativeRetirement = resolve; });
    client.retireNativeMemory = () => {
      nativeRetirementCalls++;
      nativeRetirement = originalRetirement.call(client);
      enteredNativeRetirement();
      return nativeRetirement;
    };
    queue.onSubmittedWorkDone = async () => { await actualCompletion; held.enter(); await held.held; return undefined; };
    try {
      app.dispose(); const retired = scene.dispose(); await held.entered;
      const during = { ledger: ledger(), depthBytes: renderer.geometryDepthAllocationBytes, retired: scene.retired, nativeRetirementCalls };
      held.release(); await retired; await nativeRetirementEntered;
      if (!nativeRetirement) throw new Error('Controller native retirement was not observed.');
      // Return the exact controller-requested promise above. Its await is
      // registered before this observer joins, and its lease releases follow
      // synchronously; never start retirement independently from the fixture.
      await nativeRetirement;
      return { before, during, after: ledger(), depthAfter: renderer.geometryDepthAllocationBytes,
        nativeRetirementCalls, noGaussianBuffers: !('buffers' in scene) && !('sortStages' in scene) };
    } finally { held.release(); queue.onSubmittedWorkDone = original; client.retireNativeMemory = originalRetirement; }
  },
};
declare global { interface Window { geometryViewer: typeof harness; geometryViewerError?: string } }
window.geometryViewer = harness;
void import('../src/main').catch(error => { window.geometryViewerError = String(error); });
