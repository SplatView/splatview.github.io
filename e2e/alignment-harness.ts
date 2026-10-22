import { admittedExport, exportWorkObservation } from './admitted-export';
// Observes actual App/controller/worker/native/WebGPU owners. Fixtures never supply pick results or summaries.
import './geometry-viewer-harness';
import { setApp, useApp } from '../src/app/store';
import type { NativeSummary, SceneCommand } from '../src/document/types';
import type { ResourceLedger } from '../src/document/resources';
import { SAVED_VIEW_DATABASE } from '../src/io/savedViewStorage';
import { validateSavedViewRecord } from '../src/io/savedView';
import { requireGaussianScene } from './gaussian-harness-scene';
import { queuePly, queuePositions } from './queue-fixture';
import type { AlignmentViewCheckpoints } from '../src/document/alignmentViews';

const controller = () => window.geometryViewer.controllerForSourceNavigation();
const ledger = () => (controller() as unknown as { ledger: ResourceLedger }).ledger;
let fixturePositions: readonly (readonly number[])[] = queuePositions;
const planePositions = [[-.75, 0, 0], [-.25, 0, 0], [.25, 0, 0], [.75, 0, 0], [0, .85, .25]];
// Retain the queue's recognizable source positions/colors/opacity and add nonzero directional SH3.
function fixture() {
  const text = new TextDecoder().decode(queuePly()), [header, body] = text.split('end_header\n');
  const names = Array.from({ length: 45 }, (_, field) => `property float f_rest_${field}`).join('\n');
  const rows = body.trim().split('\n').map((row, id) => `${row} ${Array.from({ length: 45 }, (_, field) =>
    ((id + 1) * (field % 5 - 2) * .001).toString()).join(' ')}`);
  return new TextEncoder().encode(`${header}${names}\nend_header\n${rows.join('\n')}\n`);
}
function planeFixture() {
  const [header, body] = new TextDecoder().decode(fixture()).split('end_header\n');
  const rows = body.trim().split('\n').map((row, id) => {
    const values = row.split(' ').map(Number);
    values.splice(0, 3, ...planePositions[id]);
    // Distinct covariance axes make a nontrivial plane rotation observable.
    values.splice(7, 3, ...[.04, .065, .09].map(Math.log));
    return values.join(' ');
  });
  return new TextEncoder().encode(`${header}end_header\n${rows.join('\n')}\n`);
}
async function digest(bytes: BufferSource) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
}
async function gpuBytes(buffer: GPUBuffer, size: number) {
  const renderer = controller().renderer!, readback = renderer.device.createBuffer({ size,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  try {
    const encoder = renderer.device.createCommandEncoder(); encoder.copyBufferToBuffer(buffer, 0, readback, 0, size);
    renderer.device.queue.submit([encoder.finish()]); await readback.mapAsync(GPUMapMode.READ);
    const bytes = readback.getMappedRange().slice(0); readback.unmap(); return bytes;
  } finally { readback.destroy(); }
}
function state() {
  const value = useApp.getState(), app = controller();
  return { busy: value.busy, error: value.error, sourceName: value.sourceName, mode: value.mode,
    alignmentTool: value.alignmentTool, alignmentPoint: value.alignmentPoint ? [...value.alignmentPoint] : null,
    alignmentSecondPoint: value.alignmentSecondPoint ? [...value.alignmentSecondPoint] : null,
    alignmentThirdPoint: value.alignmentThirdPoint ? [...value.alignmentThirdPoint] : null,
    alignmentNormal: value.alignmentNormal ? [...value.alignmentNormal] : null, alignmentFlip: value.alignmentFlip,
    alignmentTargetDistance: value.alignmentTargetDistance,
    alignmentPicking: value.alignmentPicking, alignment: value.summary?.alignment, enabled: app.alignmentControlsEnabled,
    planeEnabled: app.alignmentPlaneControlsEnabled,
    alignmentFloor: value.alignmentFloor ? structuredClone(value.alignmentFloor) : null,
    floor: value.summary?.floor ?? null, floorEnabled: app.floorDetectionEnabled,
    floorCandidateReady: app.floorCandidateReady, cameraNavigationEnabled: app.cameraNavigationEnabled,
    rendererState: value.rendererState, dirty: value.dirty, savedViewAvailable: value.savedViewAvailable,
    viewStatus: value.viewStatus, thumbnailPending: value.thumbnailPending,
    colorPending: app.colorPending, grade: [...value.grade], appliedGrade: [...value.appliedGrade], colorSession: value.colorSession };
}
async function snapshot() {
  const app = controller(), client = app.client!, scene = requireGaussianScene(app.scene);
  const chunks: Uint8Array[] = [];
  let nativeMasks = new Uint8Array();
  await client.stream(async (_first, _count, bytes) => { chunks.push(new Uint8Array(bytes)); }, bytes => { nativeMasks = new Uint8Array(bytes); });
  const native = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0; for (const chunk of chunks) { native.set(chunk, offset); offset += chunk.byteLength; }
  const gpu = await gpuBytes(scene.buffers.splats, scene.count * scene.stride);
  const records = (bytes: ArrayBuffer) => {
    const view = new DataView(bytes);
    return Array.from({ length: scene.count }, (_, id) => ({
      position: [0, 4, 8].map(axis => view.getFloat32(id * scene.stride + axis, true)),
      // All bytes beyond XYZ include covariance, opacity and every retained SH band.
      attributes: Array.from(new Uint8Array(bytes, id * scene.stride + 12, scene.stride - 12)),
      covariance: [16, 20, 24, 28, 32, 36].map(axis => view.getFloat32(id * scene.stride + axis, true)),
      opacity: Array.from(new Uint8Array(bytes, id * scene.stride + 12, 4)),
      appearance: Array.from(new Uint8Array(bytes, id * scene.stride + 40, scene.stride - 40)),
    }));
  };
  const exported = await admittedExport(client, 0, 0), csv = new TextDecoder().decode(await admittedExport(client, 5, 0)).trim().split(/\r?\n/);
  const summary = await client.command({ command: 'summary' });
  const csvHeader = csv.shift()!.split(','), csvRows = csv.map(row => row.split(',').map(Number));
  const workOwnership = exportWorkObservation(client, ledger());
  // Detached observations of actual controller owners, never replacement metadata.
  const owners = app as unknown as { alignmentViews: AlignmentViewCheckpoints; defaultAlignmentCamera(): number[] };
  return { ...state(), summary, records: records(native.buffer), gpuRecords: records(gpu),
    nativeRecordHash: await digest(native), gpuRecordHash: await digest(gpu), masks: Array.from(nativeMasks),
    gpuMasks: Array.from(new Uint32Array(await gpuBytes(scene.buffers.states, scene.count * 4))),
    exported: await digest(exported), exportedBytes: Array.from(new Uint8Array(exported)), csvHeader, csvRows,
    camera: [...app.camera!.state], cameraRevision: app.camera!.revision, background: app.camera!.background,
    defaultCamera: [...owners.defaultAlignmentCamera()], checkpoints: [...owners.alignmentViews.values()].map(entry => ({
      branchId: entry.branchId, frame: [...entry.frame], activeRoll: entry.activeRoll, defaultRoll: entry.defaultRoll, corrected: entry.corrected })),
    sourceFingerprint: app.sourceFingerprint, deviceEpoch: app.renderer!.deviceEpoch,
    work: workOwnership.transient, workOwnership };
}
function view() {
  const app = controller(), frame = useApp.getState().summary?.alignment?.frame;
  if (!frame) throw new Error('The native Center fixture did not publish alignment metadata.');
  const aspect = app.renderer!.canvas.width / app.renderer!.canvas.height;
  app.camera!.set([frame[12], Math.fround(frame[13] - .3), frame[14], 0, 0, 4, 1, 45, 1, .125, aspect]);
  app.invalidate();
}
async function load(name = 'alignment-sh3.ply', bytes = fixture()) {
  const app = controller(); await app.openFiles([new File([bytes], name)]);
  if (useApp.getState().navigationPrompt) await app.discardAndContinue();
  if (useApp.getState().sourceName !== name || useApp.getState().summary?.shDegree !== 3)
    throw new Error(useApp.getState().error ?? 'The actual SH3 alignment source was not published.');
  fixturePositions = queuePositions;
  setApp({ toolsOpen: true }); view();
}
async function loadPlane(name = 'alignment-plane-sh3.ply') {
  await load(name, planeFixture()); fixturePositions = planePositions;
}
async function loadFloor() { await loadPlane('alignment-floor-sh3.ply'); }
async function detectFloor() {
  if (!await controller().startFloorDetection()) throw new Error(useApp.getState().error ?? 'Actual floor detection was refused.');
  return state();
}
async function confirmFloor() {
  if (!await controller().confirmAlignment()) throw new Error(useApp.getState().error ?? 'Actual floor confirmation was refused.');
  return snapshot();
}
let floorCommands: { client: NonNullable<ReturnType<typeof controller>['client']>; original: NonNullable<ReturnType<typeof controller>['client']>['command']; calls: SceneCommand[] } | undefined;
function beginFloorCommandObservation() {
  if (floorCommands) throw new Error('Floor command observation is already active.');
  const client = controller().client!, original = client.command.bind(client), calls: SceneCommand[] = [];
  floorCommands = { client, original, calls };
  client.command = async (...args) => { calls.push(structuredClone(args[0])); return original(...args); };
}
function finishFloorCommandObservation() {
  const owner = floorCommands;
  if (!owner) throw new Error('No Floor command observation is active.');
  owner.client.command = owner.original; floorCommands = undefined; return owner.calls;
}
let floorHold: { release(): void; finished: Promise<boolean> } | undefined;
async function beginFloorDetectionHold() {
  if (floorHold) throw new Error('An actual Floor detection terminal is already held.');
  const app = controller(), client = app.client!, original = client.command.bind(client);
  let release!: () => void, enter!: () => void, terminal: NativeSummary | undefined;
  const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  client.command = async (...args) => {
    const actual = await original(...args);
    if (args[0].command === 'detectFloor') { terminal = actual; enter(); await held; }
    return actual;
  };
  const finished = app.startFloorDetection().finally(() => { client.command = original; });
  floorHold = { release, finished };
  try {
    await Promise.race([entered, finished.then(() => { if (!terminal) throw new Error('The actual detector did not produce a terminal response.'); })]);
    return { state: state(), terminal, qualification: 'Actual native response held before controller publication; native fitting has already completed.' };
  } catch (error) { release(); floorHold = undefined; throw error; }
}
async function finishFloorDetectionHold() {
  const owner = floorHold;
  if (!owner) throw new Error('No actual Floor terminal is held.');
  try { owner.release(); return { accepted: await owner.finished, state: state() }; }
  finally { floorHold = undefined; }
}
async function loadPrecision(kind: 'third-center' | 'default-undo') {
  const points = (kind === 'third-center' ? [.1, .2, .3] : [-.9998, 1]).map(x => [Math.fround(x), 0, 0]);
  const fields = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  const scale = Math.log(kind === 'third-center' ? .003 : .02);
  const rows = points.map(point => [...point, .7, .4, .2, Math.log(.9 / .1), scale, scale, scale, 1, 0, 0, 0].join(' '));
  const bytes = new TextEncoder().encode(['ply', 'format ascii 1.0', `element vertex ${points.length}`,
    ...fields.map(field => `property float ${field}`), 'end_header', ...rows, ''].join('\n'));
  const app = controller(), name = `alignment-precision-${kind}.ply`;
  await app.openFiles([new File([bytes], name)]);
  if (useApp.getState().navigationPrompt) await app.discardAndContinue();
  if (useApp.getState().sourceName !== name || useApp.getState().summary?.count !== points.length || useApp.getState().summary?.shDegree !== 0)
    throw new Error(useApp.getState().error ?? 'The actual isolated precision source was not published.');
  fixturePositions = Object.freeze(points.map(point => Object.freeze(point)));
  // Use the real default-camera owner fitted from the native source bounds.
  setApp({ toolsOpen: true }); app.resetCamera(); app.invalidate();
  return snapshot();
}
async function command(value: SceneCommand) {
  if (!await controller().command(value)) throw new Error(useApp.getState().error ?? `The alignment fixture refused ${value.command}.`);
}
async function seed(ids: number[]) {
  if (!ids.length) { await command({ command: 'selectNone' }); return; }
  for (let index = 0; index < ids.length; index++) await command({ command: 'single', index: ids[index], operation: index ? 1 : 0 });
}
function pixel(index: number) {
  const app = controller(), canvas = app.renderer!.canvas, frame = useApp.getState().summary!.alignment!.frame;
  const [sx, sy, sz] = fixturePositions[index], source = [Math.fround(sx), Math.fround(-sy), Math.fround(-sz)];
  const point = [0, 1, 2].map(column => Math.fround(frame[12 + column] +
    source[0] * frame[column] + source[1] * frame[4 + column] + source[2] * frame[8 + column]));
  point.push(1);
  const multiply = (vector: number[], matrix: Float32Array) => Array.from({ length: 4 }, (_, column) =>
    vector.reduce((sum, value, row) => sum + value * matrix[row * 4 + column], 0));
  const clip = multiply(multiply(point, app.camera!.view), app.camera!.projection), rect = canvas.getBoundingClientRect();
  const x = Math.floor((clip[0] / clip[3] + 1) * canvas.width / 2), y = Math.floor((1 - clip[1] / clip[3]) * canvas.height / 2);
  if (clip[3] <= 0 || x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) throw new Error('The current alignment fixture camera does not show the transformed source.');
  return { x, y, clientX: rect.left + (x + .5) * rect.width / canvas.width, clientY: rect.top + (y + .5) * rect.height / canvas.height };
}
// A selection change starts a brief automatic pivot query that holds busy;
// alignment tools start only once the app is idle again.
async function idle(timeout = 5000) {
  const started = performance.now();
  while (useApp.getState().busy && performance.now() - started < timeout) await new Promise(resolve => setTimeout(resolve, 10));
}
async function pick(index = 3) {
  await idle();
  if (!await controller().startCenterAlignment()) throw new Error('The actual Center tool could not start.');
  const point = pixel(index);
  if (!await controller().pickAlignmentPoint(point.x, point.y)) throw new Error(useApp.getState().error ?? 'The actual GPU contributor pick did not accept a point.');
  return state();
}
async function center(index = 3) {
  await pick(index);
  if (!await controller().confirmAlignment()) throw new Error(useApp.getState().error ?? 'The real Center confirmation was refused.');
  return snapshot();
}
async function pickScale(first = 3, second = 4) {
  const app = controller(); await idle();
  if (!await app.startScaleAlignment()) throw new Error('The actual Scale tool could not start.');
  for (const index of [first, second]) {
    const point = pixel(index);
    if (!await app.pickAlignmentPoint(point.x, point.y)) throw new Error(useApp.getState().error ?? `The actual Scale contributor ${index} pick was refused.`);
  }
  return state();
}
async function scale(factor = 2, first = 3, second = 4) {
  const selected = await pickScale(first, second), app = controller();
  if (!selected.alignmentTargetDistance) throw new Error('The measured Scale target is missing.');
  app.setAlignmentTargetDistance(Math.fround(selected.alignmentTargetDistance * factor));
  if (!await app.confirmAlignment()) throw new Error(useApp.getState().error ?? 'The real Scale confirmation was refused.');
  return snapshot();
}
async function pickPlane(indices = [3, 4, 0]) {
  const app = controller(); await idle();
  if (!await app.startPlaneAlignment()) throw new Error('The actual 3-point Align tool could not start.');
  for (const index of indices) {
    const point = pixel(index);
    if (!await app.pickAlignmentPoint(point.x, point.y)) throw new Error(useApp.getState().error ?? `The actual plane contributor ${index} pick was refused.`);
  }
  return state();
}
async function plane(flip = false, indices = [3, 4, 0]) {
  await pickPlane(indices); controller().setAlignmentFlip(flip);
  if (!await controller().confirmAlignment()) throw new Error(useApp.getState().error ?? 'The real plane confirmation was refused.');
  return snapshot();
}
function flip(value: boolean) {
  const app = controller(), client = app.client!, original = client.command.bind(client), calls: string[] = [], revision = app.camera!.revision;
  client.command = async (...args) => { calls.push(args[0].command); return original(...args); };
  try { app.setAlignmentFlip(value); return { calls, cameraRevisionBefore: revision, cameraRevisionAfter: app.camera!.revision, state: state() }; }
  finally { client.command = original; }
}
function setRoll(value: number) {
  const app = controller(), values = app.camera!.state; values[9] = Math.fround(value); app.camera!.set(values); app.invalidate();
  return app.camera!.state;
}
function commitState() {
  const app = controller(), value = useApp.getState();
  const owners = app as unknown as { alignmentViews: AlignmentViewCheckpoints; defaultAlignmentCamera(): number[] };
  return { busy: value.busy, autoOrbit: value.autoOrbit, fly: value.fly, camera: app.camera!.state, cameraRevision: app.camera!.revision,
    defaultCamera: [...owners.defaultAlignmentCamera()], checkpoints: [...owners.alignmentViews.values()].map(entry => ({
      ...entry, frame: [...entry.frame] })), alignment: value.summary!.alignment };
}
let commitHold: { release(): void; finished: Promise<boolean> } | undefined;
async function beginPlaneCommitHold() {
  if (commitHold) throw new Error('The plane commit acknowledgement is already held.');
  await pickPlane();
  const app = controller(), before = await snapshot(), client = app.client!, original = client.commitOperation;
  const commit = original.bind(client);
  let release!: () => void, enter!: () => void, committed: NativeSummary | undefined;
  const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  client.commitOperation = async owner => {
    const actual = await commit(owner);
    committed = actual; enter(); await held;
    return actual;
  };
  const finished = app.confirmAlignment().finally(() => { client.commitOperation = original; });
  commitHold = { release, finished };
  // A refusal before commit must not strand the browser test waiting on a hook.
  try { await Promise.race([entered, finished.then(() => { if (!committed) throw new Error('The actual plane edit did not reach native commit.'); })]); }
  catch (error) { release(); commitHold = undefined; throw error; }
  return { before, held: commitState(), committed };
}
async function finishPlaneCommitHold() {
  const held = commitHold;
  if (!held) throw new Error('No plane commit acknowledgement is held.');
  try { held.release(); return { accepted: await held.finished, after: await snapshot() }; }
  finally { commitHold = undefined; }
}
function queueHeldCameraInput() {
  if (!commitHold || !useApp.getState().busy) throw new Error('Camera input requires the actual held commit.');
  const app = controller(); app.camera!.queueScroll(.25, false); app.invalidate(); return app.camera!.active;
}
function expectedFrameCamera(state: readonly number[], oldFrame: readonly number[], newFrame: readonly number[], policy: 0 | 1 = 0) {
  const camera = controller().camera!, revision = camera.revision, before = camera.state;
  const result = camera.transformState(state, camera.frameChange(oldFrame, newFrame), policy);
  if (revision !== camera.revision || before.some((value, index) => value !== camera.state[index]))
    throw new Error('The native frame/camera observer mutated the actual camera owner.');
  return result;
}
function navigate() {
  const app = controller(); app.camera!.orbit(11, -7); app.camera!.pan(8, -4); app.camera!.zoom(.8); app.camera!.lens(10); app.invalidate();
  return [...app.camera!.state];
}
// Observe the native pure ABI2 operation separately from controller frame preparation.
// The fixture computes its own Center delta and never publishes the expected camera.
function expectedCamera(state: readonly number[], oldFrame: readonly number[], newFrame: readonly number[]) {
  const delta = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (let axis = 0; axis < 3; axis++) delta[12 + axis] = Math.fround(newFrame[12 + axis] - oldFrame[12 + axis]);
  const app = controller(), revision = app.camera!.revision, before = app.camera!.state;
  const result = app.camera!.transformState(state, delta);
  if (revision !== app.camera!.revision || before.some((value, index) => value !== app.camera!.state[index]))
    throw new Error('The pure native camera expectation mutated the actual viewport owner.');
  return result;
}
async function redoBaseline() { await seed([0]); await seed([1]); await command({ command: 'undo' }); }
async function refusal(kind: 'admission' | 'gpu' | 'cancel', tool: 'center' | 'scale' | 'align' = 'center') {
  await redoBaseline();
  if (tool === 'align') { await pickPlane(); controller().setAlignmentFlip(true); }
  else if (tool === 'scale') { const points = await pickScale(); controller().setAlignmentTargetDistance(Math.fround(points.alignmentTargetDistance! * 2)); }
  else await pick();
  const app = controller(), before = await snapshot(), client = app.client!, queue = app.renderer!.device.queue;
  const budget = ledger() as unknown as { limit: number }, previousLimit = budget.limit;
  const originalCommand = client.command.bind(client), originalStream = client.stream.bind(client), originalCompletion = queue.onSubmittedWorkDone.bind(queue);
  let decoded = false, streamed = false, failed = false, active = true, release!: () => void, enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  client.command = async (...args) => { const result = await originalCommand(...args); if (args[0].command === (tool === 'align' ? 'alignPlane' : tool === 'scale' ? 'alignScale' : 'alignCenter')) decoded = true; return result; };
  client.stream = async (...args) => { const result = await originalStream(...args); if (decoded) streamed = true; return result; };
  queue.onSubmittedWorkDone = async () => {
    await originalCompletion();
    // A renderer fence can overlap the candidate upload. Keep the failure/hold
    // active through confirmation so an unrelated fence cannot consume it.
    if (active && streamed && kind !== 'admission') {
      failed = true;
      if (kind === 'gpu') throw new Error(`${tool} fixture refused publication after actual GPU completion.`);
      enter(); await held;
    }
  };
  let accepted: boolean, error: string | null;
  try {
    if (kind === 'admission') budget.limit = ledger().usage.bytes + 1024;
    const pending = app.confirmAlignment();
    if (kind === 'cancel') { await entered; app.cancelEdit(); release(); }
    accepted = await pending; error = useApp.getState().error;
  } finally { active = false; release?.(); budget.limit = previousLimit; client.command = originalCommand; client.stream = originalStream; queue.onSubmittedWorkDone = originalCompletion; }
  const after = await snapshot(), redone = await app.command({ command: 'redo' });
  return { before, after, accepted, decoded, failed, error, redone, afterRedo: await snapshot() };
}
async function stalePick(kind: 'camera' | 'edit' | 'source' | 'device') {
  const app = controller();
  if (!await app.startCenterAlignment()) throw new Error('The stale-pick Center tool did not start.');
  const before = await snapshot(), renderer = app.renderer!, original = renderer.pick.bind(renderer);
  let release!: () => void, enter!: () => void, first = true, picked: number | null = null;
  const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  renderer.pick = async (...args) => {
    const actual = await original(...args);
    if (first) { first = false; picked = actual.index; enter(); await held; }
    return actual;
  };
  const point = pixel(3), pending = app.pickAlignmentPoint(point.x, point.y);
  try {
    await entered;
    if (kind === 'camera') navigate();
    else if (kind === 'edit') await seed([2]);
    else if (kind === 'source') await load('alignment-replaced.ply');
    else {
      renderer.device.destroy(); await renderer.device.lost;
      if (!await app.retryRenderer()) throw new Error(useApp.getState().error ?? 'The actual stale-pick device recovery failed.');
    }
    release(); return { before, after: await snapshot(), accepted: await pending, picked };
  } finally { release(); renderer.pick = original; }
}
async function stalePlaneNormal(kind: 'camera' | 'edit' | 'source' | 'device' | 'clear') {
  const app = controller(); await pickPlane([3, 4]);
  const before = await snapshot(), client = app.client!, original = client.command.bind(client), renderer = app.renderer!;
  let release!: () => void, enter!: () => void, normal: number[] | null = null;
  const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  client.command = async (...args) => {
    const actual = await original(...args);
    if (args[0].command === 'planeNormal') { normal = actual.point ? [...actual.point] : null; enter(); await held; }
    return actual;
  };
  const point = pixel(0), pending = app.pickAlignmentPoint(point.x, point.y);
  try {
    await entered;
    if (kind === 'camera') navigate();
    else if (kind === 'edit') await seed([1]);
    else if (kind === 'source') await loadPlane('alignment-plane-replaced.ply');
    else if (kind === 'clear') app.clearAlignmentPoint();
    else {
      renderer.device.destroy(); await renderer.device.lost;
      if (!await app.retryRenderer()) throw new Error(useApp.getState().error ?? 'The actual stale plane device recovery failed.');
    }
    release(); const accepted = await pending;
    return { before, after: await snapshot(), accepted, normal };
  } finally { release(); client.command = original; }
}
async function stored() {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(SAVED_VIEW_DATABASE, 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  try {
    const data = await new Promise<{ records: { meta: Blob }[]; images: { image: Blob }[] }>((resolve, reject) => {
      const transaction = database.transaction(['views', 'thumbnails']), views = transaction.objectStore('views').getAll(), images = transaction.objectStore('thumbnails').getAll();
      transaction.oncomplete = () => resolve({ records: views.result, images: images.result }); transaction.onabort = () => reject(transaction.error);
    });
    return { records: await Promise.all(data.records.map(async record => validateSavedViewRecord(JSON.parse(await record.meta.text())))),
      imageHashes: await Promise.all(data.images.map(async image => digest(await image.image.arrayBuffer()))) };
  } finally { database.close(); }
}
async function savedRoundtrip(tool: 'center' | 'scale' | 'align' = 'center') {
  const app = controller(); if (tool === 'align') await plane(); else if (tool === 'scale') await scale(); else await center(); navigate(); const aligned = await snapshot();
  if (!await app.updateThumbnail()) throw new Error(useApp.getState().viewStatus ?? 'The actual aligned thumbnail did not save.');
  const saved = await stored();
  navigate(); app.resetCamera(); const resetEdited = await snapshot();
  // Reopen exact original bytes; persistence is bound to the original source fingerprint.
  await app.openFiles([new File([tool === 'align' ? planeFixture() : fixture()], 'alignment-source-reopened.ply')]);
  if (useApp.getState().navigationPrompt) await app.discardAndContinue();
  return { aligned, saved, resetEdited, reopened: await snapshot(), afterStorage: await stored() };
}
async function resetCamera() { controller().resetCamera(); return snapshot(); }
async function savedDefaultCarry() {
  const app = controller(); await center(); navigate(); const captured = await snapshot();
  if (!await app.updateThumbnail()) throw new Error(useApp.getState().viewStatus ?? 'The actual default-owner thumbnail did not save.');
  const saved = await stored(), second = await center(4);
  navigate(); await command({ command: 'undo' }); const undone = await snapshot();
  const reset = await resetCamera();
  return { captured, second, undone, reset, saved, afterStorage: await stored() };
}
async function reopenExport() {
  const app = controller(), bytes = await admittedExport(app.client!, 0, 0), before = await snapshot();
  await load('alignment-export-reopened.ply', new Uint8Array(bytes));
  return { before, after: await snapshot() };
}

const harness = { ready: () => window.geometryViewer.ready(), state, snapshot, load, loadPlane, loadFloor, detectFloor, confirmFloor,
  beginFloorCommandObservation, finishFloorCommandObservation, beginFloorDetectionHold, finishFloorDetectionHold, loadPrecision, view, pixel, pick, center, pickScale, scale,
  pickPlane, plane, flip, setRoll, seed, command, navigate, expectedCamera, expectedFrameCamera, refusal, stalePick, stalePlaneNormal,
  beginPlaneCommitHold, commitState, queueHeldCameraInput, finishPlaneCommitHold, savedRoundtrip, savedDefaultCarry, resetCamera, reopenExport };
declare global { interface Window { alignmentHarness: typeof harness } }
window.alignmentHarness = harness;
