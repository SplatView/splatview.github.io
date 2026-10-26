import { requireWebGpuRenderer } from './gaussian-harness-scene';
import { admittedExport, exportWorkObservation } from './admitted-export';
import './geometry-viewer-harness';
import { setApp, useApp } from '../src/app/store';
import { NEUTRAL_COLOR } from '../src/renderer/defaults';
import { type SceneCommand } from '../src/document/types';
import type { AutoColorMethod } from '../src/document/colorProtocol';
import type { ResourceLedger } from '../src/document/resources';
import { gaussianPly } from '../tests/fixtures/gaussians';

const controller = () => window.geometryViewer.controllerForSourceNavigation();
const ledger = () => (controller() as unknown as { ledger: ResourceLedger }).ledger;
async function digest(bytes: BufferSource) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
}
function state() {
  const value = useApp.getState(), app = controller();
  return { busy: value.busy, error: value.error, sourceName: value.sourceName, grade: [...value.grade], appliedGrade: [...value.appliedGrade],
    colorSession: value.colorSession, colorSelectedOnly: value.colorSelectedOnly, colorPending: app.colorPending,
    controlsEnabled: app.colorControlsEnabled, previewEnabled: app.colorPreviewEnabled, dirty: value.dirty,
    selected: value.summary?.selected, visible: value.summary?.visible, rendererState: value.rendererState };
}
async function snapshot() {
  const app = controller();
  const csv = new TextDecoder().decode(await admittedExport(app.client!, 5, 0)).trim().split(/\r?\n/);
  const header = csv.shift()!.split(','), records = csv.map(row => row.split(',').map(Number));
  const rendered = await window.geometryViewer.snapshot();
  const exported = await digest(await admittedExport(app.client!, 0, 0)), summary = await app.client!.command({ command: 'summary' });
  const workOwnership = exportWorkObservation(app.client!, ledger());
  return { ...state(), summary, header, records, exported,
    capture: rendered.capture, sourceFingerprint: app.sourceFingerprint, camera: [...app.camera!.state], background: app.camera!.background,
    workBytes: workOwnership.transient.bytes, workOwnership };
}
async function command(value: SceneCommand) {
  if (!await controller().command(value)) throw new Error(useApp.getState().error ?? `Color fixture refused ${value.command}.`);
}
async function load(name = 'auto-color.ply', bytes = gaussianPly(0)) {
  const app = controller(); await app.openFiles([new File([bytes], name)]);
  if (useApp.getState().navigationPrompt) await app.discardAndContinue();
  if (useApp.getState().sourceName !== name || useApp.getState().summary?.kind !== 0)
    throw new Error(useApp.getState().error ?? 'The actual App color source was not published.');
  setApp({ toolsOpen: true });
}
async function seed(ids: number[]) {
  if (!ids.length) { await command({ command: 'selectNone' }); return; }
  for (let index = 0; index < ids.length; index++) await command({ command: 'single', index: ids[index], operation: index ? 1 : 0 });
}
function preview(values: number[]) { controller().setGrade(values); }
async function admissionRefusal(method: AutoColorMethod) {
  const before = await snapshot(), budget = ledger() as unknown as { limit: number }, previous = budget.limit;
  let accepted: boolean, error: string | null;
  try { budget.limit = ledger().usage.bytes + 1024; accepted = await controller().autoColor(method); error = useApp.getState().error; }
  finally { budget.limit = previous; }
  return { before, after: await snapshot(), accepted, error };
}
async function publicationRefusal() {
  const app = controller(), before = await snapshot(), client = app.client!, queue = requireWebGpuRenderer(app.renderer).device.queue;
  const originalCommand = client.command.bind(client), originalCompletion = queue.onSubmittedWorkDone.bind(queue);
  let decoded = false, failed = false;
  client.command = async (...args) => {
    const result = await originalCommand(...args);
    if (args[0].command === 'autoColor') decoded = true;
    return result;
  };
  queue.onSubmittedWorkDone = async () => {
    await originalCompletion();
    if (decoded && !failed) { failed = true; throw new Error('Color fixture refused publication after actual GPU completion.'); }
  };
  let accepted: boolean, error: string | null;
  try { accepted = await app.autoColor('contrast'); error = useApp.getState().error; }
  finally { client.command = originalCommand; queue.onSubmittedWorkDone = originalCompletion; }
  return { before, after: await snapshot(), accepted, decoded, failed, error };
}
function largePly(count = 100_000) {
  const names = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  const header = new TextEncoder().encode(['ply', 'format binary_little_endian 1.0', `element vertex ${count}`,
    ...names.map(name => `property float ${name}`), 'end_header', ''].join('\n'));
  const bytes = new Uint8Array(header.byteLength + count * 56); bytes.set(header);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < count; index++) {
    const fields = [index % 100 * .18, Math.floor(index / 100) % 100 * .18, Math.floor(index / 10_000) * .18,
      .3 + index % 7 * .01, .2, .1, Math.log(.8 / .2), Math.log(.1), Math.log(.1), Math.log(.1), 1, 0, 0, 0];
    fields.forEach((value, field) => view.setFloat32(header.byteLength + index * 56 + field * 4, value, true));
  }
  return bytes;
}
async function cancelPending() {
  await load('auto-color-100k.ply', largePly());
  const app = controller(), client = app.client!, before = await snapshot(), original = client.onProgress;
  const progress: number[] = []; let cancelled = false;
  client.onProgress = (stage, fraction) => {
    original?.(stage, fraction);
    if (stage === 'Applying edit') {
      progress.push(fraction);
      if (!cancelled && fraction < 1) { cancelled = true; app.cancelEdit(); }
    }
  };
  let accepted: boolean;
  try { accepted = await app.autoColor('enhance'); }
  finally { client.onProgress = original; }
  return { before, after: await snapshot(), accepted, cancelled, progress, error: useApp.getState().error };
}
async function recover() {
  const app = controller(), before = await snapshot(), device = requireWebGpuRenderer(app.renderer).device;
  device.destroy(); await device.lost;
  if (!await app.retryRenderer()) throw new Error(useApp.getState().error ?? 'Actual color device recovery failed.');
  return { before, after: await snapshot() };
}
let held: { release(): void; entered: Promise<void>; pending: Promise<boolean>; restore(): void } | undefined;
async function holdManualBake() {
  const app = controller(), client = app.client!, original = client.command.bind(client);
  let release!: () => void, enter!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { enter = resolve; });
  client.command = async (...args) => {
    const result = await original(...args);
    if (args[0].command === 'grade') { enter(); await blocked; }
    return result;
  };
  const pending = app.commitGrade();
  held = { release, entered, pending, restore: () => { client.command = original; } };
  await entered;
}
async function releaseManualBake() {
  const owner = held; held = undefined;
  if (!owner) throw new Error('No actual manual color bake is held.');
  owner.release();
  try { return await owner.pending; } finally { owner.restore(); }
}
const harness = { ready: () => window.geometryViewer.ready(), state, snapshot, load, seed, preview, command,
  admissionRefusal, publicationRefusal, cancelPending, recover, holdManualBake, releaseManualBake,
  neutral: () => [...NEUTRAL_COLOR] };
declare global { interface Window { autoColorHarness: typeof harness } }
window.autoColorHarness = harness;
