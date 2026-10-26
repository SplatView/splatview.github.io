// Test-only detached observations of the actual App/controller/native worker
// and GPU. Pointer targets come from the portable native geometry adapter.
import './geometry-viewer-harness';
import { useApp } from '../src/app/store';
import { UI_SIZES, useUiPreferences } from '../src/app/uiPreferences';
import type { TransformGizmoPrimitive } from '../src/document/transformGizmo';
import type { SceneCommand } from '../src/document/types';
import { gaussianStorage } from './gaussian-storage';

const controller = () => window.geometryViewer.controllerForRendererNavigation();
const positions = [[.2, .1, .3], [.5, 0, 0], [0, .5, 0], [0, 0, -2], [-.4, -.2, .1]];
function fixture() {
  const names = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3',
    ...Array.from({ length: 45 }, (_, index) => `f_rest_${index}`)];
  const rows = positions.map((point, id) => [point[0], -point[1], -point[2], .5, .2, .1, 2,
    ...[.07, .09, .05].map(size => Math.log(size * (id + 1))), 1, 0, 0, 0,
    ...Array.from({ length: 45 }, (_, field) => (id + 1) * (field % 5 - 2) * .001)].join(' '));
  return new TextEncoder().encode(['ply', 'format ascii 1.0', `element vertex ${positions.length}`,
    ...names.map(name => `property float ${name}`), 'end_header', ...rows, ''].join('\n'));
}
function state() {
  const value = useApp.getState(), app = controller();
  return { busy: value.busy, error: value.error, summary: value.summary, mode: value.mode, toolsOpen: value.toolsOpen,
    transform: value.transform ? structuredClone(value.transform) : null, parameters: structuredClone(value.transformParameters),
    preview: value.transformPreview ? structuredClone(value.transformPreview) : null, gizmoMode: value.transformGizmoMode,
    dragging: value.transformGizmoDragging, pending: app.transformPending, local: value.filterLocalAxes, snap: value.filterSnap,
    controlsEnabled: app.transformControlsEnabled, gizmoEnabled: app.transformGizmoControlsEnabled,
    rendererState: value.rendererState, selectionRecovery: value.selectionRecovery,
    camera: app.camera!.state, cameraRevision: app.camera!.revision };
}
async function snapshot() {
  const app = controller(), client = app.client!, scene = app.scene!, chunks: Uint8Array[] = [];
  if (scene.kind !== 'gaussian') throw new Error('The actual Gaussian fixture is missing.');
  const summary = await client.command({ command: 'summary' }); let masks: number[] = [];
  await client.stream(async (_first, _count, bytes) => { chunks.push(new Uint8Array(bytes)); }, bytes => { masks = Array.from(new Uint8Array(bytes)); });
  const native = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let at = 0; for (const chunk of chunks) { native.set(chunk, at); at += chunk.byteLength; }
  const { source: gpu, masks: gpuMasks } = await gaussianStorage(app);
  const records = (bytes: ArrayBufferLike) => {
    const view = new DataView(bytes);
    return Array.from({ length: scene.count }, (_, id) => ({
      position: [0, 4, 8].map(offset => view.getFloat32(id * scene.stride + offset, true)),
      covariance: [16, 20, 24, 28, 32, 36].map(offset => view.getFloat32(id * scene.stride + offset, true)),
      appearance: Array.from(new Uint8Array(bytes, id * scene.stride + 40, scene.stride - 40)),
      opacity: Array.from(new Uint8Array(bytes, id * scene.stride + 12, 4)),
    }));
  };
  return { ...state(), summary, records: records(native.buffer), gpuRecords: records(gpu), masks,
    gpuMasks: Array.from(gpuMasks), sourceFingerprint: app.sourceFingerprint };
}
function frame(pointer: readonly [number, number] = [-1, -1]) {
  const value = useApp.getState(), app = controller(), widgetMatrix = app.transformGizmoWidgetMatrix;
  if (!app.camera || !value.transformGizmoMode || !widgetMatrix || value.transformPreview?.kind !== 'gizmo') throw new Error('No actual transform widget is ready.');
  const bounds = document.querySelector('canvas')!.getBoundingClientRect(), preference = useUiPreferences.getState();
  return app.camera.transformGizmoFrame({ mode: value.transformGizmoMode, widgetMatrix, pivot: value.transformPreview.pivot,
    viewport: { x: 0, y: 0, width: bounds.width, height: bounds.height }, pointer,
    panelScale: UI_SIZES.find(size => size.size === (preference.previewSize ?? preference.size))!.panelScale,
    local: value.mode === 'pro' && value.filterLocalAxes, snap: value.filterSnap });
}
function samples(primitive: TransformGizmoPrimitive): [number, number][] {
  const p = primitive.points;
  if (primitive.type === 0) return [.35, .55, .8].map(t => [p[0] + (p[2] - p[0]) * t, p[1] + (p[3] - p[1]) * t]);
  if (primitive.type === 1 || primitive.type === 2) return [[p[0], p[1]]];
  return [[(p[0] + p[2] + p[4] + p[6]) / 4, (p[1] + p[3] + p[5] + p[7]) / 4]];
}
function target(handle: number) {
  const value = frame(); if (!value) throw new Error('Actual native widget frame refused.');
  const bounds = document.querySelector('canvas')!.getBoundingClientRect();
  for (const primitive of value.primitives.filter(candidate => candidate.handle === handle)) for (const point of samples(primitive)) {
    if (frame(point)?.hitHandle !== handle) continue;
    const dx = primitive.points[2] - primitive.points[0], dy = primitive.points[3] - primitive.points[1], length = primitive.type === 0 ? Math.hypot(dx, dy) : 0;
    return { x: bounds.left + point[0], y: bounds.top + point[1], endX: bounds.left + point[0] + (length ? 36 * dx / length : 36),
      endY: bounds.top + point[1] + (length ? 36 * dy / length : 0), handle };
  }
  throw new Error(`No actual hittable native transform handle ${handle}.`);
}
let commands: string[] = [], restore: (() => void) | undefined, capturedPointer: number | undefined;
document.addEventListener('gotpointercapture', event => { capturedPointer = event.pointerId; }, true);
document.addEventListener('lostpointercapture', event => { if (capturedPointer === event.pointerId) capturedPointer = undefined; }, true);
const harness = {
  ready: () => window.geometryViewer.ready(), state, snapshot, frame, target,
  async load() { const app = controller(); await app.openFiles([new File([fixture()], 'transform-literals-sh3.ply')]);
    if (useApp.getState().navigationPrompt) await app.discardAndContinue();
    if (useApp.getState().summary?.count !== 5 || useApp.getState().summary?.shDegree !== 3) throw new Error(useApp.getState().error ?? 'Actual transform fixture was not published.'); },
  command: (command: SceneCommand) => controller().command(command),
  end: () => controller().endTransformSession(),
  async selectedFixture() { for (const command of [{ command: 'single', index: 4, operation: 0 }, { command: 'delete' },
    { command: 'single', index: 1, operation: 0 }] as SceneCommand[]) if (!await controller().command(command)) throw new Error('Actual selection setup refused.'); },
  oblique() { const app = controller(); app.camera!.orbit(130, -90); app.invalidate(); },
  observe() { restore?.(); commands = []; const client = controller().client!, original = client.command;
    client.command = async function(...args) { commands.push(args[0].command); return original.apply(this, args); };
    restore = () => { client.command = original; restore = undefined; }; },
  commands: () => [...commands], stop: () => restore?.(),
  loseCapture() { const canvas = document.querySelector('canvas')!; if (capturedPointer !== undefined && canvas.hasPointerCapture(capturedPointer)) canvas.releasePointerCapture(capturedPointer); },
};
declare global { interface Window { transformHarness: typeof harness } }
window.transformHarness = harness;
