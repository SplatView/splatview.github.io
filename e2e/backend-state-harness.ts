import { createVerifiedRenderCompute } from '../src/app/renderCompute';
import './geometry-viewer-harness';
import { createSceneRenderer } from '../src/renderer/factory';
import type { GraphicsBackend } from '../src/renderer/backend';
import { ResourceLedger } from '../src/document/resources';
import { DEFAULT_STEADY_SETTINGS } from '../src/renderer/steadySettings';
import { IDENTITY_MATRIX, NEUTRAL_COLOR } from '../src/renderer/defaults';
import { DocumentSelectionMaps } from '../src/app/selectionMaps';
import { useApp, setApp } from '../src/app/store';
import { gaussianPly } from '../tests/fixtures/gaussians';
import type { CameraController } from '../src/input/camera';

async function until(predicate: () => boolean) {
  const deadline = performance.now() + 10000;
  while (!predicate()) { if (performance.now() > deadline) throw new Error('The actual renderer state did not settle.'); await new Promise(requestAnimationFrame); }
}
async function trace(backend: GraphicsBackend) {
  const canvas = document.createElement('canvas'); canvas.width = 65; canvas.height = 49; document.body.append(canvas);
  const renderer = await createSceneRenderer(canvas, {createCompute:createVerifiedRenderCompute, preference: backend, allowFallback: false }), ledger = new ResourceLedger(128 * 1024 ** 2);
  renderer.admitWork = bytes => ledger.reserve('work', bytes); renderer.admitSteady = bytes => ledger.reserve('render', bytes);
  const scene = await renderer.allocateScene(2, 0), bytes = new ArrayBuffer(96), values = new Float32Array(bytes), half = new DataView(bytes);
  for (let i = 0; i < 2; i++) { values.set([i * .1, .1, -2 - i, .6, .16, 0, 0, .16, 0, .16], i * 12); half.setUint16(i * 48 + 40, 0x3c00, true); }
  await scene.upload(0, 2, bytes); scene.masks(new Uint8Array([1, 0]).buffer);
  const camera = { view: new Float32Array(IDENTITY_MATRIX), eye: new Float32Array(3), revision: 0, background: 'black',
    projection: new Float32Array([49/65,0,0,0,0,1,0,0,0,0,-100/99.9,-1,0,0,-10/99.9,0]) } as unknown as CameraController;
  const settings = { ...DEFAULT_STEADY_SETTINGS, mode: 'steady' as const, convergenceFrames: 64 };
  let requests = 0, grade = [...NEUTRAL_COLOR]; renderer.onFrameNeeded = () => requests++;
  const draw = async () => { const pending = renderer.render(scene, camera, grade); if (pending) await pending; await renderer.finish(); };
  try {
    renderer.setRenderSettings(settings); await draw(); await until(() => renderer.steadySnapshot.status !== 'preparing');
    if (renderer.steadySnapshot.status !== 'steady') throw new Error(renderer.steadySnapshot.reason ?? 'The actual SteadySplats path is unavailable.');
    renderer.resetRenderHistory(); requests = 0; const sequence = renderer.frameSubmissionSequence;
    const rows: { kind: string; frame: number; restFrames: number; valid: boolean; status: string; requests: number; submissions: number }[] = [];
    const record = (kind: string) => { const { frame, restFrames, valid, status } = renderer.steadySnapshot;
      rows.push({ kind, frame, restFrames, valid, status, requests, submissions: renderer.frameSubmissionSequence - sequence }); };
    await draw(); record('initial');
    for (let i = 1; i <= 64; i++) { await draw(); if ([7, 8, 62, 63, 64].includes(i)) record(`rest-${i}`); }
    await draw(); record('cached');
    await renderer.pick(scene, 32, 24);
    const capture = await renderer.captureRgba(scene, camera, { admit: bytes => ledger.reserve('image', bytes) }); capture.dispose();
    const map = await renderer.surface(scene, { colors: true, visible: true, admit: bytes => ledger.reserve('work', bytes) }); map.dispose();
    record('queries');
    camera.view[12] = .01; camera.eye[0] = -.01; camera.revision++; await draw(); record('motion');
    camera.revision++; await draw(); record('revision-only');
    grade[0] = 1.25; await draw(); record('content');
    renderer.setRenderSettings(settings); await draw(); record('identical-settings');
    renderer.setRenderSettings({ ...settings, historyWeight: 0 }); const zeroRequests = requests;
    await draw(); await draw(); record('zero-weight'); const zeroExtraRequests = requests - zeroRequests;
    renderer.setRenderSettings({ ...settings, animate: false }); const fixedRequests = requests;
    await draw(); await draw(); record('fixed-samples'); const fixedExtraRequests = requests - fixedRequests;
    renderer.setRenderSettings(DEFAULT_STEADY_SETTINGS); await draw(); await scene.dispose(); await renderer.finish();
    return { backend, rows, zeroExtraRequests, fixedExtraRequests, memory: ledger.usage, negotiation: renderer.negotiationSnapshot };
  } finally { await scene.dispose(); renderer.dispose(); canvas.remove(); }
}
async function mapBoundary() {
  const app = window.geometryViewer.controllerForRendererNavigation();
  await app.openFiles([new File([gaussianPly(3)], 'state-query-sh3.ply')]);
  await until(() => !useApp.getState().busy && !useApp.getState().transformPivotPending);
  const renderer = app.renderer!, client = app.client!, ledger = (app as unknown as { ledger: ResourceLedger }).ledger;
  app.setRenderSettings({ ...DEFAULT_STEADY_SETTINGS, mode: 'steady', animate: false });
  await until(() => renderer.steadySnapshot.status === 'steady'); await new Promise(requestAnimationFrame); await renderer.finish();
  const maps = new DocumentSelectionMaps(), render = renderer.render, scene = app.scene!;
  if (scene.kind !== 'gaussian') throw new Error('The native query fixture did not load.');
  let calls = 0; renderer.render = function (...args) { calls++; return render.apply(this, args); };
  const observe = () => ({ calls, frame: renderer.steadySnapshot.frame, submissions: renderer.frameSubmissionSequence });
  const current = () => { if (app.client !== client || app.renderer !== renderer) throw new Error('The native query owner changed.'); };
  const context = { client, scene, renderer, camera: app.camera!, ledger, grade: [...NEUTRAL_COLOR], current };
  try {
    const before = observe(), first = await maps.request(context, { colors: true }); await renderer.finish(); const created = observe();
    const grade = [...NEUTRAL_COLOR]; grade[0] = 1.25;
    const cached = await maps.request({ ...context, grade }, { colors: true }); await renderer.finish(); const reused = observe();
    await renderer.pick(scene, 10, 10);
    const capture = await renderer.captureRgba(scene, app.camera!, { admit: bytes => ledger.reserve('image', bytes) }); capture.dispose();
    await renderer.finish(); const queries = observe();
    setApp({ toolsOpen: true }); await until(() => !useApp.getState().busy && !useApp.getState().transformPivotPending);
    if (!await app.command({ command: 'grade', values: grade })) throw new Error('The actual committed color fixture was refused.');
    await until(() => !useApp.getState().busy && !useApp.getState().transformPivotPending);
    let stale = false; try { first.assertCurrent(); } catch { stale = true; }
    // Return the fixture cache's native ownership before the controller settles
    // its accepted color session and adopts the next map through its own owner.
    await maps.invalidate();
    const replaced = await app.selectionMap({ colors: true });
    return { backend: renderer.backend, before, created, reused, queries, firstId: first.mapId, cachedId: cached.mapId, committedId: replaced.mapId, stale };
  } finally { renderer.render = render; await maps.invalidate(); }
}
const harness = { ready: () => window.geometryViewer.ready(), trace, mapBoundary };
declare global { interface Window { backendState: typeof harness } }
window.backendState = harness;
