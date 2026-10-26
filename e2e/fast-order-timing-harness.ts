import { GaussianRenderer } from '../src/renderer/webgpu/renderer';
import { ResourceLedger, estimateSceneBytes } from '../src/document/resources';
import { IDENTITY_MATRIX } from '../src/renderer/defaults';
import type { RenderCamera } from '../src/renderer/frame';

/** Agent/test-only device feature request and GPU pass clocks. */
async function measure(count: number, visibility: .25 | 1 = .25) {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter?.features.has('timestamp-query')) return { timestampAvailable: false as const };
  const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 400; document.body.append(canvas);
  const requestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
  navigator.gpu.requestAdapter = async options => {
    const value = await requestAdapter(options); if (!value) return null;
    const requestDevice = value.requestDevice.bind(value);
    value.requestDevice = descriptor => requestDevice({ ...descriptor, requiredFeatures: [...new Set([...(descriptor?.requiredFeatures ?? []), 'timestamp-query' as const])] });
    return value;
  };
  let renderer: GaussianRenderer;
  try { renderer = await GaussianRenderer.create(canvas); } finally { navigator.gpu.requestAdapter = requestAdapter; }
  const r = renderer, ledger = new ResourceLedger(1024 * 1024 ** 2), errors:string[]=[];
  r.onLost=message=>{errors.push(message);};
  r.admitWork = bytes => ledger.reserve('work', bytes);
  const credits = [ledger.reserve('render', estimateSceneBytes(count, 0)), ledger.reserve('render', estimateSceneBytes(count, 0)), ledger.reserve('work', 3 * 2048 * 8 + 16384)];
  const baseline = await r.allocateScene(count, 0);
  r.admitSortScratch = bytes => ledger.reserve('render', bytes); const fast = await r.allocateScene(count, 0);
  const device = r.device, queries = device.createQuerySet({ type: 'timestamp', count: 2048 });
  const resolved = device.createBuffer({ size: 2048 * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
  const readback = device.createBuffer({ size: 2048 * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const createEncoder = device.createCommandEncoder.bind(device);
  const records: { mode: string; warm: boolean; label: string; slot: number }[] = [];
  let mode = '', warm = true, slot = 0;
  device.createCommandEncoder = descriptor => {
    const encoder = createEncoder(descriptor), first = slot, finish = encoder.finish.bind(encoder), begin = encoder.beginComputePass.bind(encoder), render = encoder.beginRenderPass.bind(encoder);
    const timestamps = (label: string) => {
      if (slot + 2 > 2048) throw new Error('The bounded timestamp fixture is full.');
      const result = { querySet: queries, beginningOfPassWriteIndex: slot, endOfPassWriteIndex: slot + 1 };
      records.push({ mode, warm, label, slot }); slot += 2; return result;
    };
    encoder.beginComputePass = descriptor => begin({ ...descriptor, timestampWrites: timestamps(String(descriptor?.label ?? 'compute')) });
    encoder.beginRenderPass = descriptor => render({ ...descriptor, timestampWrites: timestamps(String(descriptor.label ?? 'raster')) });
    encoder.finish = descriptor => {
      if (slot > first) { encoder.resolveQuerySet(queries, first, slot - first, resolved, 0); encoder.copyBufferToBuffer(resolved, 0, readback, first * 8, (slot - first) * 8); }
      return finish(descriptor);
    };
    return encoder;
  };
  const camera: RenderCamera = { view: new Float32Array(IDENTITY_MATRIX), eye: new Float32Array(3), revision: 0, background: 'black',
    projection: new Float32Array([.625,0,0,0,0,1,0,0,0,0,-100/99.9,-1,0,0,-10/99.9,0]) };
  try {
    const bytes = new ArrayBuffer(count * 48), floats = new Float32Array(bytes);
    for (let i = 0; i < count; i++) floats.set([visibility===.25&&i%4 ? 100 : ((i % 512) - 256) / 128, ((Math.floor(i / 512) % 512) - 256) / 128, -2 - (i % 101) / 50, .2, .00001, 0, 0, .00001, 0, .00001], i * 12);
    await baseline.upload(0, count, bytes.slice(0)); await fast.upload(0, count, bytes); await r.finish();
    for (let frame = 0; frame < 40; frame++) {
      const angle = Math.sin(frame * .13) * .15, cs = Math.cos(angle), sn = Math.sin(angle);
      camera.view.set([cs,0,-sn,0,0,1,0,0,sn,0,cs,0,0,0,0,1]);
      for (const variant of ['baseline32', 'compact32', 'compact24']) {
        mode = variant; warm = frame < 8; const scene = variant === 'baseline32' ? baseline : fast;
        scene.residentOrder = undefined; scene.residentCompactOrder = undefined; scene.residentProjection = undefined; scene.sortDirty = true;
        r.displaySortPrecision = variant === 'compact24' ? 24 : 32; r.render(scene, camera); await r.displayCompletion()!.done;
      }
    }
    await readback.mapAsync(GPUMapMode.READ); const values = new DataView(readback.getMappedRange());
    const samples: Record<string, Record<string, number[]>> = {};
    for (const item of records) if (!item.warm) {
      const duration = Number(values.getBigUint64((item.slot + 1) * 8, true) - values.getBigUint64(item.slot * 8, true)) / 1e6;
      (samples[item.mode] ??= {})[item.label] ??= []; samples[item.mode][item.label].push(duration);
    }
    readback.unmap(); device.createCommandEncoder = createEncoder;
    const fastAvailable = !!fast.fastOrder; await baseline.dispose(); await fast.dispose(); await r.close();
    queries.destroy(); resolved.destroy(); readback.destroy(); credits.forEach(release => release());
    return { timestampAvailable: true as const, fastAvailable, count, visibility, samples, errors, memory: ledger.usage,
      environment: { userAgent: navigator.userAgent, secureContext: isSecureContext, crossOriginIsolated, features: [...device.features] },
      scope: 'Opt-in fixture GPU pass timestamps, interleaved 32 measured frames after eight warm-up frames; visibility reports the fraction of source centers placed in the view region. No presentation FPS claim.' };
  } finally {
    device.createCommandEncoder = createEncoder; await baseline.dispose(); await fast.dispose(); await r.close();
    readback.unmap(); queries.destroy(); resolved.destroy(); readback.destroy(); credits.forEach(release => release()); canvas.remove();
  }
}
const harness = { measure };
declare global { interface Window { fastOrderTiming: typeof harness } }
window.fastOrderTiming = harness;
