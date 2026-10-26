import { createVerifiedRenderCompute } from '../src/app/renderCompute';
import { GlRenderer } from '../src/renderer/webgl2/renderer';
import { GaussianRenderer, type GpuScene } from '../src/renderer/webgpu/renderer';
import { IDENTITY_MATRIX, NEUTRAL_COLOR } from '../src/renderer/defaults';
import { ResourceLedger, packedStride } from '../src/document/resources';
import type { SceneRenderer } from '../src/renderer/contracts';
import type { CameraController } from '../src/input/camera';
import { profileRenderer } from './render-profile';

const camera = () => ({ view: new Float32Array(IDENTITY_MATRIX),
  projection: new Float32Array([49 / 65, 0, 0, 0, 0, 1, 0, 0, 0, 0, -100 / 99.9, -1, 0, 0, -10 / 99.9, 0]),
  eye: new Float32Array(3), background: 'black', revision: 0 } as unknown as CameraController);
async function fixture(backend: 'webgpu' | 'webgl2', count = 5, degree = 0) {
  const canvas = document.createElement('canvas'); canvas.width = 65; canvas.height = 49; document.body.append(canvas);
  const renderer: SceneRenderer = backend === 'webgl2' ? await GlRenderer.create(canvas, createVerifiedRenderCompute) : await GaussianRenderer.create(canvas);
  const ledger = new ResourceLedger(128 * 1024 ** 2), errors: string[] = [];
  renderer.admitWork = bytes => ledger.reserve('work', bytes); renderer.onLost = message => errors.push(message);
  const scene = await renderer.allocateScene(count, degree), stride = packedStride(degree), input = new Float32Array(count * stride / 4);
  const depths = [-2, -4, -2, -1, -4];
  for (let i = 0; i < count; i++) input.set([(i % 7 - 3) * .15, (i % 5 - 2) * .1, depths[i % 5], .08,
    .02, .003, 0, .03, 0, .01], i * stride / 4);
  await scene.upload(0, count, input.buffer); scene.masks(new Uint8Array(count).buffer);
  const view = camera(), profile = profileRenderer(renderer);
  const draw = async (grade = NEUTRAL_COLOR, geometry = IDENTITY_MATRIX, scoped = false) => {
    const pending = renderer.render(scene, view, grade, true, geometry, false, scoped); if (pending) await pending;
    await (renderer.displayCompletion?.()?.done ?? renderer.finish());
  };
  const order = async () => {
    if (renderer instanceof GlRenderer) {
      const gl = renderer.gl, target = gl.createFramebuffer()!, data = new Uint32Array(count);
      try { gl.bindFramebuffer(gl.FRAMEBUFFER, target); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, (scene as import('../src/renderer/webgl2/scene').GlScene).order, 0);
        gl.readPixels(0, 0, count, 1, gl.RED_INTEGER, gl.UNSIGNED_INT, data);
        if (gl.getError() !== gl.NO_ERROR) throw new Error('Order texture readback failed.'); return [...data];
      } finally { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(target); }
    }
    const gpu = renderer as GaussianRenderer, buffer = gpu.device.createBuffer({ size: count * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try { const encoder = gpu.device.createCommandEncoder(); encoder.copyBufferToBuffer((scene as GpuScene).ordered, 0, buffer, 0, count * 8);
      gpu.device.queue.submit([encoder.finish()]); await buffer.mapAsync(GPUMapMode.READ);
      const data = new Uint32Array(buffer.getMappedRange().slice(0)); buffer.unmap(); return Array.from({ length: count }, (_, i) => data[i * 2 + 1] & 0xffffff);
    } finally { buffer.destroy(); }
  };
  const dispose = async () => { await scene.dispose(); await renderer.finish(); profile.dispose(); renderer.dispose(); canvas.remove(); };
  return { renderer, scene, ledger, errors, view, draw, order, profile, dispose };
}
async function reuse(backend: 'webgpu' | 'webgl2') {
  const f = await fixture(backend), rows: { kind: string; order: number[]; sorts: number; uploads: number; projections: number }[] = [];
  const take = async (kind: string) => {
    const order = await f.order(), p = f.profile.take();
    rows.push({ kind, order, sorts: backend === 'webgl2' ? p.work.filter(value => (value as {action:string}).action === 'sort').length : p.counts['Stable depth sort'] ?? 0,
      uploads: p.counts.texSubImage2D ?? 0, projections: p.counts['Project Gaussians'] ?? 0 });
  };
  try {
    await f.draw(); await take('first');
    f.view.revision++; await f.draw(); await take('revision-only');
    f.view.projection[0] *= 1.1; f.view.background = 'white'; await f.draw(); await take('projection-background');
    const grade = [...NEUTRAL_COLOR]; grade[0] = .6; await f.draw(grade); await take('grade');
    const image = await f.renderer.captureRgba(f.scene, f.view, { admit: bytes => f.ledger.reserve('image', bytes) }); image.dispose(); await take('same-view-capture');
    const captured = camera(); captured.view[0] = -1; captured.view[10] = -1; captured.view[14] = -8;
    const pending = f.renderer.captureRgba(f.scene, captured, { admit: bytes => f.ledger.reserve('image', bytes) });
    captured.view.set(IDENTITY_MATRIX); captured.revision++;
    const frozen = await pending; frozen.dispose(); await take('captured-view-overwrite');
    await f.draw(); await take('live-view-restored');
    const geometry = [...IDENTITY_MATRIX]; geometry[14] = -4; f.scene.masks(new Uint8Array([0, 0, 1, 0, 0]).buffer);
    await f.draw(NEUTRAL_COLOR, geometry, true); await take('scoped-transform');
    await f.dispose(); return { backend, rows, memory: f.ledger.usage, errors: f.errors };
  } catch (error) { await f.dispose(); throw error; }
}
async function picks(degree: number) {
  const f = await fixture('webgpu', 2049, degree);
  try {
    await f.draw(); f.profile.take(); const rows = [];
    for (const [x, y, radius] of [[32, 24, 0], [32, 24, 2], [1, 1, 4], [16, 30, 0], [64, 48, 0]]) {
      const fast = await f.renderer.pick(f.scene, x, y, radius), profile = f.profile.take(), admit = f.renderer.admitWork;
      f.renderer.admitWork = undefined;
      let baseline; try { baseline = await f.renderer.pick(f.scene, x, y, radius); } finally { f.renderer.admitWork = admit; }
      rows.push({ x, y, radius, fast, baseline, compact: profile.counts['Pick countCandidates'] ?? 0 });
    }
    await f.dispose(); return { degree, rows, errors: f.errors, memory: f.ledger.usage };
  } catch (error) { await f.dispose(); throw error; }
}
const gate = () => { let release!: () => void; return { held: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; };
async function glQueryInterleave() {
  const f = await fixture('webgl2', 4097), renderer = f.renderer as GlRenderer;
  await f.draw(); await renderer.finish();
  const worker = (renderer.compute as unknown as { worker: Worker }).worker, original = worker.onmessage!;
  const admission = gate(), terminal = gate(); let id: number | undefined, heldTerminal: MessageEvent | undefined;
  worker.onmessage = event => {
    if (event.data.phase === 'admit') { id = event.data.id; admission.release(); return; }
    if (event.data.id === id) { heldTerminal = event; terminal.release(); return; }
    original.call(worker, event);
  };
  try {
    const before = f.ledger.usage.bytes, cancellation = new AbortController();
    const query = renderer.surface(f.scene, { signal: cancellation.signal, admit: bytes => f.ledger.reserve('work', bytes) });
    void query.catch(() => undefined); await admission.held;
    const heldBytes = f.ledger.usage.bytes;
    f.view.projection[0] *= 1.01; f.view.revision++;
    await f.draw(); await terminal.held;
    const displayedWhileTerminalHeld = renderer.frameSubmissionSequence;
    let finished = false; const finish = renderer.finish().then(() => { finished = true; });
    await Promise.resolve(); const finishedBeforeTerminal = finished;
    original.call(worker, heldTerminal!);
    const result = await Promise.allSettled([query, finish]);
    const afterBytes = f.ledger.usage.bytes;
    worker.onmessage = original; await f.dispose();
    return { before, heldBytes, afterBytes, displayedWhileTerminalHeld, finishedBeforeTerminal, queryStatus: result[0].status, memory: f.ledger.usage };
  } finally { worker.onmessage = original; await f.dispose(); }
}
async function gpuPickRetirement() {
  const f = await fixture('webgpu', 4097), renderer = f.renderer as GaussianRenderer;
  await f.draw(); await renderer.prepareSurfaceResources();
  const device = renderer.device, original = device.popErrorScope.bind(device), entered = gate(), terminal = gate(); let held = false;
  device.popErrorScope = () => original().then(async value => { if (!held) { held = true; entered.release(); await terminal.held; } return value; });
  try {
    const query = renderer.pick(f.scene, 32, 24); void query.catch(() => undefined); await entered.held;
    const heldBytes = f.ledger.usage.bytes; let disposed = false;
    const closing = f.scene.dispose().then(() => { disposed = true; }); await Promise.resolve();
    const disposedBeforeValidation = disposed; terminal.release();
    const result = await Promise.allSettled([query, closing]);
    device.popErrorScope = original; await f.dispose();
    return { heldBytes, disposedBeforeValidation, queryStatus: result[0].status, memory: f.ledger.usage, errors: f.errors };
  } finally { terminal.release(); device.popErrorScope = original; await f.dispose(); }
}
async function failedPublication(backend: 'webgpu' | 'webgl2') {
  const f = await fixture(backend); await f.draw();
  f.view.view[0] = -1; f.view.view[10] = -1; f.view.view[14] = -8; f.view.revision++;
  let failed = false, restore: () => void;
  if (f.renderer instanceof GaussianRenderer) {
    const queue = f.renderer.device.queue, submit = queue.submit;
    queue.submit = () => { throw new Error('injected rejected submission'); }; restore = () => { queue.submit = submit; };
  } else {
    const gl = (f.renderer as GlRenderer).gl, upload = gl.texSubImage2D;
    gl.texSubImage2D = ((...args: never[]) => { (upload as (...args:never[])=>void).apply(gl, args); throw new Error('injected post-upload failure'); }) as typeof upload;
    restore = () => { gl.texSubImage2D = upload; };
  }
  try { try { await f.draw(); } catch { failed = true; } } finally { restore(); }
  if (backend === 'webgl2') f.view.view.set(IDENTITY_MATRIX);
  await f.draw(); const order = await f.order(); await f.dispose();
  return { backend, failed, order, memory: f.ledger.usage, errors: f.errors };
}
window.renderOrder = { reuse, picks, glQueryInterleave, gpuPickRetirement, failedPublication };
declare global { interface Window { renderOrder: { reuse: typeof reuse; picks: typeof picks; glQueryInterleave: typeof glQueryInterleave; gpuPickRetirement: typeof gpuPickRetirement; failedPublication: typeof failedPublication } } }
