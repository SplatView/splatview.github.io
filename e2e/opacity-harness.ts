// Test-only observations of the mounted App, actual native worker and GPU.
// Snapshot never exports or settles the opacity owner. Fixtures and expected
// alpha calculations in the spec are independent of production operations.
import './geometry-viewer-harness';
import { useApp } from '../src/app/store';
import { IDENTITY_MATRIX, type SceneCommand } from '../src/document/types';
import { requireGaussianScene } from './gaussian-harness-scene';

const controller = () => window.geometryViewer.controllerForSourceNavigation();
const positions = [[-.65, .25, 0], [0, .25, 0], [.65, .25, 0], [-.65, -.25, 0], [0, -.25, 0], [.65, -.25, 0]];
const logits = [-1000, -5.6, -Math.log(3), 0, Math.log(3), Math.log(9)];
function fixture() {
  const names = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3',
    ...Array.from({ length: 45 }, (_, index) => `f_rest_${index}`)];
  const rows = positions.map((point, id) => [point[0], -point[1], -point[2], .8, .2, -.2, logits[id],
    ...[.04, .05, .03].map(size => Math.log(size * (1 + id * .03))), 1, 0, 0, 0,
    ...Array.from({ length: 45 }, (_, field) => (id + 1) * (field % 5 - 2) * .001)].join(' '));
  return new TextEncoder().encode(['ply', 'format ascii 1.0', `element vertex ${positions.length}`,
    ...names.map(name => `property float ${name}`), 'end_header', ...rows, ''].join('\n'));
}
function state() {
  const value = useApp.getState(), app = controller();
  return { busy: value.busy, error: value.error, summary: value.summary, mode: value.mode, toolsOpen: value.toolsOpen,
    scale: value.opacityScale, opacity: value.opacity ? structuredClone(value.opacity) : null,
    preview: value.opacityPreview ? structuredClone(value.opacityPreview) : null, pending: app.opacityPending, active: app.opacityActive,
    controlsEnabled: app.opacityControlsEnabled, applyEnabled: app.opacityApplyEnabled, cancelEnabled: app.opacityCancelEnabled,
    grade: [...value.grade], appliedGrade: [...value.appliedGrade], colorSession: value.colorSession ? structuredClone(value.colorSession) : null,
    colorResetEnabled: app.colorResetPreviewEnabled, rendererState: value.rendererState, selectionRecovery: value.selectionRecovery,
    tool: value.tool, autoOrbit: value.autoOrbit, fly: value.fly,
    sourceName: value.sourceName, sourceFingerprint: app.sourceFingerprint, camera: app.camera!.state,
    document: app.client ? { ...app.client.revision } : null, deviceEpoch: app.renderer?.deviceEpoch ?? null };
}
async function gpuBytes(buffer: GPUBuffer, size: number) {
  const renderer = controller().renderer!, readback = renderer.device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  try {
    const encoder = renderer.device.createCommandEncoder(); encoder.copyBufferToBuffer(buffer, 0, readback, 0, size);
    renderer.device.queue.submit([encoder.finish()]); await readback.mapAsync(GPUMapMode.READ);
    const bytes = readback.getMappedRange().slice(0); readback.unmap(); return bytes;
  } finally { readback.destroy(); }
}
async function snapshot() {
  const app = controller(), client = app.client!, scene = requireGaussianScene(app.scene), chunks: Uint8Array[] = [];
  const summary = await client.command({ command: 'summary' }); let masks: number[] = [];
  await client.stream(async (_first, _count, bytes) => { chunks.push(new Uint8Array(bytes)); }, bytes => { masks = Array.from(new Uint8Array(bytes)); });
  const native = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let at = 0; for (const chunk of chunks) { native.set(chunk, at); at += chunk.byteLength; }
  const records = (bytes: ArrayBufferLike) => {
    const view = new DataView(bytes), raw = new Uint8Array(bytes);
    return Array.from({ length: scene.count }, (_, id) => ({
      alpha: view.getFloat32(id * scene.stride + 12, true),
      alphaBytes: Array.from(raw.subarray(id * scene.stride + 12, id * scene.stride + 16)),
      // Exact position, covariance and all directional SH bits, excluding only alpha.
      otherBytes: [...raw.subarray(id * scene.stride, id * scene.stride + 12), ...raw.subarray(id * scene.stride + 16, (id + 1) * scene.stride)],
    }));
  };
  return { ...state(), summary, records: records(native.buffer), gpuRecords: records(await gpuBytes(scene.buffers.splats, scene.count * scene.stride)), masks,
    gpuMasks: Array.from(new Uint32Array(await gpuBytes(scene.buffers.states, scene.count * 4))) };
}
async function capture() {
  const app = controller(), value = useApp.getState(), scene = requireGaussianScene(app.scene), camera = app.camera!;
  const blob = await app.renderer!.capture(scene, camera, 'image/png', value.grade, value.transformPreview?.matrix ?? IDENTITY_MATRIX,
    value.colorSelectedOnly, value.transformPreview?.selectedOnly ?? false, value.opacityPreview?.scale ?? 1, value.opacityPreview?.selectedOnly ?? false);
  const bitmap = await createImageBitmap(blob);
  try {
    const output = new OffscreenCanvas(bitmap.width, bitmap.height), context = output.getContext('2d')!;
    context.drawImage(bitmap, 0, 0); const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    // Test-only independent clip projection of known literal fixture positions.
    const multiply = (matrix: ArrayLike<number>, point: number[]) => Array.from({ length: 4 }, (_, row) =>
      matrix[row] * point[0] + matrix[4 + row] * point[1] + matrix[8 + row] * point[2] + matrix[12 + row] * point[3]);
    const samples = positions.map(point => {
      const clip = multiply(camera.projection, multiply(camera.view, [...point, 1]));
      const x = Math.round((clip[0] / clip[3] * .5 + .5) * bitmap.width), y = Math.round((.5 - clip[1] / clip[3] * .5) * bitmap.height);
      if (x < 0 || x >= bitmap.width || y < 0 || y >= bitmap.height) throw new Error('Literal opacity sample is outside the actual viewport.');
      return { x, y, rgba: Array.from(pixels.subarray((y * bitmap.width + x) * 4, (y * bitmap.width + x) * 4 + 4)) };
    });
    return { width: bitmap.width, height: bitmap.height, background: Array.from(pixels.subarray(0, 4)), samples };
  } finally { bitmap.close(); }
}
let commands: string[] = [], restore: (() => void) | undefined;
let releaseBegin: (() => void) | undefined, beginEntered = false;
let releaseEnd: (() => void) | undefined, endEntered = false;
const harness = {
  ready: () => window.geometryViewer.ready(), state, snapshot, capture,
  async load(name = 'opacity-literals-sh3.ply') {
    const app = controller(); await app.openFiles([new File([fixture()], name)]);
    if (useApp.getState().navigationPrompt) await app.discardAndContinue();
    if (useApp.getState().summary?.count !== 6 || useApp.getState().summary?.shDegree !== 3) throw new Error(useApp.getState().error ?? 'Actual opacity fixture was not published.');
    const canvas = app.renderer!.canvas; app.camera!.set([0, 0, 0, 0, 0, 3, 1, 45, 0, 0, canvas.width / canvas.height]);
    app.camera!.background = 'black'; app.invalidate();
  },
  command: (command: SceneCommand) => controller().command(command),
  end: () => controller().endOpacitySession(),
  export: () => controller().exportScene(0, 0),
  async openBytes(bytes: number[]) {
    const app = controller(); await app.openFiles([new File([new Uint8Array(bytes)], 'accepted-opacity.ply')]);
    if (useApp.getState().navigationPrompt) await app.discardAndContinue();
  },
  async selectedFixture() {
    for (const command of [{ command: 'single', index: 5, operation: 0 }, { command: 'delete' },
      { command: 'single', index: 2, operation: 0 }] as SceneCommand[])
      if (!await controller().command(command)) throw new Error('Actual opacity selection setup refused.');
  },
  observe() {
    restore?.(); commands = []; const client = controller().client!, original = client.command;
    client.command = async function(...args) { commands.push(args[0].command); return original.apply(this, args); };
    restore = () => { client.command = original; restore = undefined; };
  },
  holdBegin() {
    restore?.(); commands = []; beginEntered = false;
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); releaseBegin = release;
    const client = controller().client!, original = client.command;
    client.command = async function(...args) {
      commands.push(args[0].command); const result = await original.apply(this, args);
      if (args[0].command === 'beginOpacity') { beginEntered = true; await held; }
      return result;
    };
    restore = () => { release(); releaseBegin = undefined; client.command = original; restore = undefined; };
  },
  beginEntered: () => beginEntered,
  releaseBegin() { releaseBegin?.(); releaseBegin = undefined; },
  holdEnd() {
    restore?.(); commands = []; endEntered = false;
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); releaseEnd = release;
    const client = controller().client!, original = client.command;
    client.command = async function(...args) {
      commands.push(args[0].command); const result = await original.apply(this, args);
      if (args[0].command === 'endOpacity') { endEntered = true; await held; }
      return result;
    };
    restore = () => { release(); releaseEnd = undefined; client.command = original; restore = undefined; };
  },
  endEntered: () => endEntered,
  releaseEnd() { releaseEnd?.(); releaseEnd = undefined; },
  commands: () => [...commands], stop: () => restore?.(),
  async recover() {
    const app = controller(), oldRenderer = app.renderer!, oldScene = app.scene!, client = app.client!, oldEpoch = oldRenderer.deviceEpoch;
    oldRenderer.device.destroy(); await oldRenderer.device.lost;
    // Device-loss notification can already start automatic restoration. This
    // public Retry path joins that exact owner; it never substitutes a device
    // factory, native result, stream, GPU buffer or alpha preview.
    const accepted = await app.retryRenderer();
    return { accepted, oldEpoch, sameClient: app.client === client, replacedRenderer: app.renderer !== oldRenderer,
      replacedScene: app.scene !== oldScene, oldRetired: oldScene.retired, after: await snapshot() };
  },
};
declare global { interface Window { opacityHarness: typeof harness } }
window.opacityHarness = harness;
