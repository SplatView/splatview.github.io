import { createVerifiedRenderCompute } from '../src/app/renderCompute';
import './geometry-viewer-harness';
import { GlRenderer } from '../src/renderer/webgl2/renderer';
import { ResourceLedger } from '../src/document/resources';
import { planGlScene } from '../src/renderer/webgl2/sceneLayout';
import { DEFAULT_STEADY_SETTINGS } from '../src/renderer/steadySettings';
import { IDENTITY_MATRIX } from '../src/renderer/defaults';
import { setApp, useApp } from '../src/app/store';
import { gaussianPly } from '../tests/fixtures/gaussians';
import type { CameraController } from '../src/input/camera';

function gate() {
  let enter!: () => void, release!: () => void;
  return { entered: new Promise<void>(resolve => { enter = resolve; }), held: new Promise<void>(resolve => { release = resolve; }), enter: () => enter(), release: () => release() };
}
async function until(predicate: () => boolean) {
  const deadline = performance.now() + 10000;
  while (!predicate()) { if (performance.now() > deadline) throw new Error('The actual GL lifecycle boundary did not settle.'); await new Promise(requestAnimationFrame); }
}
async function setup() {
  const canvas = document.createElement('canvas'); canvas.width = 65; canvas.height = 49; document.body.append(canvas);
  const renderer = await GlRenderer.create(canvas, createVerifiedRenderCompute), ledger = new ResourceLedger(128 * 1024 ** 2), credit = ledger.reserve('render', planGlScene(2, 0, renderer.capabilities.maxTextureSize).bytes);
  renderer.admitWork = bytes => ledger.reserve('work', bytes); renderer.admitSteady = bytes => ledger.reserve('render', bytes);
  const scene = await renderer.allocateScene(2, 0), bytes = new ArrayBuffer(96), values = new Float32Array(bytes), half = new DataView(bytes);
  for (let i = 0; i < 2; i++) { values.set([i * .1, .1, -2 - i, .6, .16, 0, 0, .16, 0, .16], i * 12); half.setUint16(i * 48 + 40, 0x3c00, true); }
  await scene.upload(0, 2, bytes); scene.masks(new Uint8Array(2).buffer);
  const camera = { view: new Float32Array(IDENTITY_MATRIX), eye: new Float32Array(3), revision: 0, background: 'black',
    projection: new Float32Array([49/65,0,0,0,0,1,0,0,0,0,-100/99.9,-1,0,0,-10/99.9,0]) } as unknown as CameraController;
  await renderer.render(scene, camera); await renderer.finish();
  return { canvas, renderer, ledger, scene, camera, dispose: async () => { await scene.dispose(); await renderer.finish(); credit(); renderer.dispose(); canvas.remove(); } };
}
async function pendingInitialization() {
  const h = await setup(), held = gate(), fence = h.renderer.fence.bind(h.renderer); let first = true, retired = false;
  h.renderer.fence = async () => { await fence(); if (first) { first = false; held.enter(); await held.held; } };
  try {
    h.renderer.setRenderSettings({ ...DEFAULT_STEADY_SETTINGS, mode: 'steady' });
    const draw = h.renderer.render(h.scene, h.camera); await held.entered; await draw;
    const admitted = { memory: h.ledger.usage, steady: h.renderer.steadySnapshot };
    h.canvas.width = 81; h.canvas.height = 63;
    await h.renderer.render(h.scene, h.camera);
    h.renderer.setRenderSettings(DEFAULT_STEADY_SETTINGS);
    const retiring = h.scene.dispose().then(() => { retired = true; }); await new Promise(requestAnimationFrame);
    const whileHeld = { retired, memory: h.ledger.usage, steady: h.renderer.steadySnapshot };
    held.release(); await retiring; await h.renderer.finish();
    const after = h.renderer.steadySnapshot;
    await h.dispose(); return { admitted, whileHeld, after, final: h.ledger.usage };
  } finally { held.release(); h.renderer.fence = fence; await h.dispose(); }
}
async function workerCancellation() {
  const h = await setup(), held = gate(), abort = new AbortController();
  const worker = (h.renderer.compute as unknown as { worker: Worker }).worker, receive = worker.onmessage!;
  let terminal: MessageEvent | undefined, settled = false, published = false;
  worker.onmessage = event => { if (event.data.ok && event.data.surface && !terminal) { terminal = event; held.enter(); } else receive.call(worker, event); };
  try {
    const baseline = h.ledger.usage.bytes;
    const pending = h.renderer.surface(h.scene, { colors: true, visible: true, signal: abort.signal, admit: bytes => h.ledger.reserve('work', bytes) })
      .then(map => { published = true; map.dispose(); return 'published'; }, error => error instanceof DOMException ? error.name : String(error)).finally(() => { settled = true; });
    await held.entered; abort.abort(); await new Promise(requestAnimationFrame);
    const whileHeld = { settled, published, memory: h.ledger.usage, baseline };
    worker.onmessage = receive; receive.call(worker, terminal!); terminal = undefined;
    const result = await pending; await h.renderer.finish();
    const after = { settled, published, memory: h.ledger.usage };
    let resizeCalls = 0, refused = false;
    try {
      await h.renderer.surface(h.scene, { colors: true, admit: bytes => {
        const lease = h.ledger.reserve('work', bytes), resize = lease.resize.bind(lease);
        lease.resize = next => { resizeCalls++; if (next > bytes) throw new Error('The actual candidate admission was refused.'); resize(next); };
        return lease;
      } });
    } catch (error) { refused = error instanceof Error && error.message.includes('candidate admission'); }
    await h.dispose(); return { whileHeld, result, after, resizeCalls, refused, final: h.ledger.usage };
  } finally { worker.onmessage = receive; if (terminal) receive.call(worker, terminal); await h.dispose(); }
}
const controller = () => window.geometryViewer.controllerForRendererNavigation();
async function open() {
  const app = controller(); await app.openFiles([new File([gaussianPly(3)], 'gl-lifetime-sh3.ply')]);
  await until(() => !useApp.getState().busy && !useApp.getState().transformPivotPending);
  if (!(app.renderer instanceof GlRenderer) || app.scene?.kind !== 'gaussian') throw new Error('The real GL editor did not load.');
  app.camera!.background = 'gray'; setApp({ background: 'gray' }); await app.renderer.finish(); return app;
}
async function digest(blob: Blob) {
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0); const bytes = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    return { width: bitmap.width, height: bitmap.height, sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('') };
  } finally { bitmap.close(); }
}
async function captureLifetime(mode: 'freeze' | 'close') {
  const app = await open(), renderer = app.renderer as GlRenderer, ledger = (app as unknown as { ledger: ResourceLedger }).ledger;
  const baseline = await digest(await app.capture('image/png')), initialImage = ledger.categorySnapshot.image;
  const held = gate(), fence = renderer.fence.bind(renderer); let first = true, closed = false, settled = false;
  renderer.fence = async () => { await fence(); if (first) { first = false; held.enter(); await held.held; } };
  const capturing = app.capture('image/png').then(async blob => ({ image: await digest(blob), error: null }), error => ({ image: null, error: error instanceof Error ? error.name : String(error) })).finally(() => { settled = true; });
  try {
    await held.entered;
    app.camera!.orbit(40, -20); app.camera!.background = 'white'; setApp({ background: 'white' }); app.invalidate();
    const close = mode === 'close' ? app.closeScene().then(() => { closed = true; }) : Promise.resolve();
    await new Promise(requestAnimationFrame);
    const whileHeld = { closed, settled, image: ledger.categorySnapshot.image };
    held.release(); const result = await capturing; await close; await renderer.finish();
    return { mode, baseline, initialImage, whileHeld, result, closed, finalImage: ledger.categorySnapshot.image,
      hasScene: !!app.scene, hasClient: !!app.client, error: useApp.getState().error };
  } finally { held.release(); renderer.fence = fence; }
}
async function acceptedPreviewRecovery() {
  const app = await open(); await app.command({ command: 'single', index: 0, operation: 0 });
  await until(() => !useApp.getState().busy && !useApp.getState().transformPivotPending);
  setApp({ toolsOpen: true }); await until(() => app.transformControlsEnabled);
  app.setTransformFlip(0, true);
  await until(() => app.transformApplyEnabled);
  if (!await app.applyTransform()) throw new Error('The accepted Basic transform was refused.');
  await until(() => !useApp.getState().busy && !useApp.getState().transformPivotPending);
  const before = { image: await digest(await app.capture('image/png')), summary: await app.client!.command({ command: 'summary' }), camera: app.camera!.state };
  const renderer = app.renderer as GlRenderer, extension = renderer.gl.getExtension('WEBGL_lose_context');
  if (!extension) throw new Error('The real GL context-loss extension is unavailable.');
  const lost = new Promise<void>(resolve => renderer.canvas.addEventListener('webglcontextlost', () => resolve(), { once: true })); extension.loseContext(); await lost;
  if (!await app.retryRenderer()) throw new Error(useApp.getState().error ?? 'The real accepted-preview restoration failed.');
  const after = { image: await digest(await app.capture('image/png')), summary: await app.client!.command({ command: 'summary' }), camera: app.camera!.state };
  await app.endTransformSession(); await app.command({ command: 'undo' });
  return { before, after, backend: app.renderer!.backend, oldEpoch: renderer.deviceEpoch, newEpoch: app.renderer!.deviceEpoch,
    undone: await app.client!.command({ command: 'summary' }), error: useApp.getState().error };
}
async function failedRecovery() {
  const app = await open();
  for (const command of [{ command: 'single', index: 1, operation: 0 }, { command: 'delete' }, { command: 'undo' }])
    if (!await app.command(command)) throw new Error('The actual recovery history fixture was refused.');
  await until(() => !useApp.getState().busy && !useApp.getState().transformPivotPending);
  const client = app.client!, before = await client.command({ command: 'summary' }), renderer = app.renderer as GlRenderer;
  const getContext = HTMLCanvasElement.prototype.getContext, extension = renderer.gl.getExtension('WEBGL_lose_context');
  if (!extension) throw new Error('The real GL context-loss extension is unavailable.');
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...args: unknown[]) {
    if (kind === 'webgl2' && this !== renderer.canvas) return null;
    return Reflect.apply(getContext, this, [kind, ...args]);
  } as typeof getContext;
  let refused: boolean, unavailable: { rendererState: string; sameClient: boolean; summary: typeof before; error: string | null };
  try {
    const lost = new Promise<void>(resolve => renderer.canvas.addEventListener('webglcontextlost', () => resolve(), { once: true }));
    extension.loseContext(); await lost; refused = !await app.retryRenderer();
    unavailable = { rendererState: useApp.getState().rendererState, sameClient: app.client === client, summary: await client.command({ command: 'summary' }), error: useApp.getState().error };
  } finally { HTMLCanvasElement.prototype.getContext = getContext; }
  const restored = await app.retryRenderer(), redone = await app.command({ command: 'redo' });
  const afterRedo = await client.command({ command: 'summary' });
  const undone = await app.command({ command: 'undo' }), afterUndo = await client.command({ command: 'summary' });
  return { before, refused, unavailable, restored, redone, afterRedo, undone, afterUndo, backend: app.renderer!.backend, error: useApp.getState().error };
}
const harness = { ready: () => window.geometryViewer.ready(), pendingInitialization, workerCancellation, captureLifetime, acceptedPreviewRecovery, failedRecovery };
declare global { interface Window { webglLifetime: typeof harness } }
window.webglLifetime = harness;
