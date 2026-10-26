import { createVerifiedRenderCompute } from '../src/app/renderCompute';
import './geometry-viewer-harness';
import { profileRenderer } from './render-profile';
import { CameraController } from '../src/input/camera';
import { ResourceLedger } from '../src/document/resources';
import { GlRenderer } from '../src/renderer/webgl2/renderer';
import { GaussianRenderer } from '../src/renderer/webgpu/renderer';
import { planGlScene } from '../src/renderer/webgl2/sceneLayout';
import { packedStride, estimateSceneBytes } from '../src/document/resources';
import { DEFAULT_STEADY_SETTINGS } from '../src/renderer/steadySettings';
import type { GaussianScene, SceneRenderer } from '../src/renderer/contracts';
import { surfaceDimensions } from '../src/renderer/webgpu/surfaceQuery';

const mse = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
  let sum = 0; for (let i = 0; i < a.length; i++) if (i % 4 !== 3) sum += (a[i] - b[i]) ** 2;
  return sum / (a.length / 4 * 3);
};
const summarize = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: values, median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))] };
};
async function measure(multiplier: 1 | 2 | 4, dpr: 1 | 2, warm?: {frames:number;width:number;height:number;degree?:0|1|2|3;stages?:boolean;sortPrecision?:16|24|32;quality?:boolean}) {
  const app = window.geometryViewer.controllerForRendererNavigation();
  const source = app.scene;
  if (!source || source.kind !== 'gaussian' || source.count !== 262556 || source.degree !== 3) throw new Error('Load the actual bundled Bench SH3 scene first.');
  const cssWidth = warm?.width ?? (multiplier === 4 ? 640 : 320), cssHeight = warm?.height ?? (multiplier === 4 ? 400 : 200);
  const canvas = document.createElement('canvas'); canvas.width = cssWidth * dpr; canvas.height = cssHeight * dpr;
  canvas.style.cssText = `width:${cssWidth}px;height:${cssHeight}px;position:fixed;left:0;top:0;z-index:100`; document.body.append(canvas);
  const backend = app.renderer!.backend, ledger = new ResourceLedger(768 * 1024 ** 2);
  const coldStart = performance.now();
  const renderer: SceneRenderer = backend === 'webgl2' ? await GlRenderer.create(canvas, createVerifiedRenderCompute) : await GaussianRenderer.create(canvas);
  const coldCreateMs=performance.now()-coldStart, profile=warm?profileRenderer(renderer,warm.stages):undefined;
  let submissionMs:number[]=[], completionMs:number[]=[];
  const errors: string[] = []; renderer.onLost = message => errors.push(message);
  renderer.admitWork = bytes => ledger.reserve('work', bytes); renderer.admitSteady = bytes => ledger.reserve('render', bytes);
  renderer.admitSortScratch = bytes => ledger.reserve('render', bytes);
  renderer.displaySortPrecision=warm?.sortPrecision??32;
  renderer.admitHistogram = bytes => ledger.reserve('render', bytes); renderer.admitGeometryDepth = bytes => ledger.reserve('render', bytes);
  const camera = await CameraController.create(); camera.set(app.camera!.state); camera.background = app.camera!.background;
  const count = source.count * multiplier, degree=warm?.degree ?? 3;
  const sceneCredit = ledger.reserve('render', backend === 'webgl2' ? planGlScene(count, degree, (renderer as GlRenderer).capabilities.maxTextureSize).bytes : estimateSceneBytes(count, degree));
  const comparisonCredit = ledger.reserve('image', canvas.width * canvas.height * 16);
  let scene: GaussianScene | undefined;
  let sortJobs = 0, sortMs = 0;
  if (renderer instanceof GlRenderer) {
    const request = renderer.compute.request.bind(renderer.compute);
    renderer.compute.request = (...args: Parameters<typeof request>) => {
      const start = performance.now(), result = request(...args);
      if (args[0].action !== 'sort') return result;
      sortJobs++; return result.finally(() => { sortMs += performance.now() - start; });
    };
  } else {
    const context = canvas.getContext('webgpu')!;
    context.configure({ device: (renderer as GaussianRenderer).device, format: (renderer as GaussianRenderer).format, alphaMode: 'opaque',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
  }
  let lastPixels = new Uint8ClampedArray();
  const draw = async (snapshot = false) => {
    const submitted=performance.now();
    const pending = renderer.render(scene, camera); if (pending) await pending;
    if(warm) submissionMs.push(performance.now()-submitted);
    if (snapshot) {
      const credit = ledger.reserve('image', canvas.width * canvas.height * 8 + 256 * canvas.height);
      try {
        lastPixels = new Uint8ClampedArray(canvas.width * canvas.height * 4);
        if (renderer instanceof GlRenderer) {
          const gl = renderer.gl, bytes = new Uint8Array(lastPixels.length); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
          for (let y = 0; y < canvas.height; y++) lastPixels.set(bytes.subarray(y * canvas.width * 4, (y + 1) * canvas.width * 4), (canvas.height - 1 - y) * canvas.width * 4);
          if (gl.getError() !== gl.NO_ERROR) throw new Error('The measured GL display readback failed.');
        } else {
          const gpu = renderer as GaussianRenderer, stride = Math.ceil(canvas.width * 4 / 256) * 256;
          const buffer = gpu.device.createBuffer({ size: stride * canvas.height, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
          try {
            const encoder = gpu.device.createCommandEncoder();
            encoder.copyTextureToBuffer({ texture: canvas.getContext('webgpu')!.getCurrentTexture() }, { buffer, bytesPerRow: stride }, [canvas.width, canvas.height]);
            gpu.device.queue.submit([encoder.finish()]); await buffer.mapAsync(GPUMapMode.READ);
            const bytes = new Uint8Array(buffer.getMappedRange());
            for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
              const i = y * stride + x * 4, target = (y * canvas.width + x) * 4;
              lastPixels.set(gpu.format === 'bgra8unorm' ? [bytes[i + 2], bytes[i + 1], bytes[i], bytes[i + 3]] : bytes.subarray(i, i + 4), target);
            }
            buffer.unmap();
          } finally { buffer.destroy(); }
        }
      } finally { credit(); }
    }
    const completion=performance.now(); await renderer.finish();
    if(warm) completionMs.push(performance.now()-completion);
  };
  try {
    const loadStart = performance.now(); scene = await renderer.allocateScene(count, degree);
    await app.client!.stream(async (first, amount, bytes) => {
      const credit = ledger.reserve('work', bytes.byteLength);
      try {
        let input=bytes;
        if(degree!==3) { const stride=packedStride(degree), fullStride=packedStride(3), src=new Uint8Array(bytes), reduced=new Uint8Array(amount*stride);
          for(let i=0;i<amount;i++) reduced.set(src.subarray(i*fullStride,i*fullStride+stride),i*stride); input=reduced.buffer; }
        for (let copy = 0; copy < multiplier; copy++) await scene!.upload(copy * source.count + first, amount, input.slice(0));
      }
      finally { credit(); }
    }, bytes => {
      const masks = new Uint8Array(count), input = new Uint8Array(bytes);
      for (let copy = 0; copy < multiplier; copy++) masks.set(input, copy * source.count);
      scene!.masks(masks.buffer);
    });
    await renderer.finish(); const uploadMs = performance.now() - loadStart;
    const initial = camera.state, path = Array.from({ length: warm?.frames ?? 8 }, (_, i) => { camera.set(initial); camera.orbit((i % 8) * 7, (i % 8) * -3); return camera.state; });
    const displayQuality: { pose: number; actualBits: number; psnr: number; meanAbsoluteRgb: number; maxRgb: number }[] = [];
    if(warm?.quality) for(let pose=0;pose<Math.min(8,path.length);pose++) {
      camera.set(path[pose]); renderer.displaySortPrecision=warm.sortPrecision??24; await draw(true); const approximate=lastPixels;
      const bits=backend==='webgl2'?(scene as import('../src/renderer/webgl2/scene').GlScene).residentSortPrecision:
        (scene as import('../src/renderer/webgpu/renderer').GpuScene).residentCompactOrder?.precision??32;
      renderer.displaySortPrecision=32; await draw(true); const exact=lastPixels;
      let square=0,absolute=0,max=0,samples=0;
      for(let i=0;i<exact.length;i++) if(i%4!==3) { const delta=Math.abs(exact[i]-approximate[i])/255; square+=delta*delta;absolute+=delta;max=Math.max(max,delta);samples++; }
      displayQuality.push({pose,actualBits:bits,psnr:square===0?999:-10*Math.log10(square/samples),meanAbsoluteRgb:absolute/samples,maxRgb:max});
    }
    renderer.displaySortPrecision=warm?.sortPrecision??32;
    const modes = [];
    for (const mode of ['sorted', 'steady'] as const) {
      renderer.setRenderSettings({ ...DEFAULT_STEADY_SETTINGS, mode, convergenceFrames: 64 });
      camera.set(initial); const firstStart=performance.now(); await draw(); const firstDrawMs=performance.now()-firstStart;
      for (const start = performance.now(); mode === 'steady' && renderer.steadySnapshot.status === 'preparing';) {
        if (performance.now() - start > 10000) throw new Error('The measured SteadySplats allocation did not settle.');
        await new Promise(requestAnimationFrame);
      }
      if(warm) { for(let i=0;i<8;i++) { camera.set(path[i]); await draw(); } }
      profile?.take(); submissionMs=[]; completionMs=[];
      const jobsBefore = sortJobs, sortBefore = sortMs, times = [];
      for (const state of path) { camera.set(state); const start = performance.now(); await draw(); times.push(performance.now() - start); }
      const motionProfile=profile?.take(), motionSubmissionMs=submissionMs, motionCompletionMs=completionMs;
      submissionMs=[]; completionMs=[]; const fixedTimes:number[]=[];
      if(warm) for(let i=0;i<warm.frames;i++) { const start=performance.now(); await draw(); fixedTimes.push(performance.now()-start); }
      const fixedProfile=profile?.take(), fixedSubmissionMs=submissionMs, fixedCompletionMs=completionMs;
      const beforeQueries = renderer.steadySnapshot, displaySequence = renderer.frameSubmissionSequence;
      const displaySortJobs = sortJobs - jobsBefore, displaySortMs = sortMs - sortBefore, jobsBeforeQueries = sortJobs, timeBeforeQueries = sortMs;
      const pickStart = performance.now(); const pick = await renderer.pick(scene, canvas.width / 2, canvas.height / 2);
      const pickMs = performance.now() - pickStart, mapStart = performance.now();
      const grid = surfaceDimensions(canvas.width, canvas.height);
      const map = await renderer.surface(scene, { region: { x: Math.floor(grid.width / 2) - 16, y: Math.floor(grid.height / 2) - 16, width: 32, height: 32 },
        admit: bytes => ledger.reserve('work', bytes) });
      const surfaceMs = performance.now() - mapStart, surface = { width: map.width, height: map.height, region: map.region, candidateEntries: map.candidateEntries,
        candidateBytes: map.candidateBytes, allocationBytes: map.allocationBytes }; map.dispose();
      const captureStart = performance.now(), image = await renderer.captureRgba(scene, camera, { admit: bytes => ledger.reserve('image', bytes) });
      const captureMs = performance.now() - captureStart, baseline = image.pixels.slice(); image.dispose();
      const afterQueries = renderer.steadySnapshot,queryProfile=profile?.take();
      let quality: { firstMse: number; refinedMse: number; frames: number; restFrames: number } | null = null;
      if (mode === 'steady') {
        renderer.resetRenderHistory(); await draw(true); const firstMse = mse(lastPixels, baseline);
        for (let i = 0; i < 64; i++) await draw(i === 63);
        quality = { firstMse, refinedMse: mse(lastPixels, baseline), frames: renderer.steadySnapshot.frame, restFrames: renderer.steadySnapshot.restFrames };
      }
      modes.push({ mode, queryProfile, firstDrawMs, motionProfile, fixedProfile, motionSubmissionMs, motionCompletionMs, fixedSubmissionMs, fixedCompletionMs, fixedFrameCompletionMs: warm?summarize(fixedTimes):undefined, frameCompletionMs: summarize(times), workerSort: backend === 'webgl2' ? { displayJobs: displaySortJobs, displayWallMs: displaySortMs,
        queryJobs: sortJobs - jobsBeforeQueries, queryWallMs: sortMs - timeBeforeQueries } : null,
        pickMs, pick, surfaceMs, surface, captureMs, beforeQueries, afterQueries, displaySequence, afterQueryDisplaySequence: renderer.frameSubmissionSequence - (quality ? 65 : 0), quality,
        retained: ledger.usage, categories: ledger.categorySnapshot });
    }
    renderer.setRenderSettings(DEFAULT_STEADY_SETTINGS); await draw(); await renderer.finish(); await scene.dispose(); scene = undefined;
    sceneCredit(); comparisonCredit(); await renderer.finish();
    return { backend, source: 'bundled Bench example.sog', multiplier, overlap: multiplier > 1 ? `${multiplier} coincident copies with distinct source IDs` : 'original',
      count, coldCreateMs, shDegree: degree, sortPrecision:renderer.displaySortPrecision, displayQuality, cssViewport: [cssWidth, cssHeight], dpr, framebuffer: [canvas.width, canvas.height], path, uploadMs, modes,
      memory: ledger.usage, memoryScope: 'logical renderer/worker/readback reservations; excludes the separately owned App/native source and physical driver memory',
      timingScope: 'wall time through actual queue/fence completion; worker sorting reported separately on GL, GPU sorting remains within frame time',
      environment: { userAgent: navigator.userAgent, devicePixelRatio, secureContext: isSecureContext, crossOriginIsolated, negotiation: renderer.negotiationSnapshot }, errors };
  } finally {
    if (scene) { renderer.setRenderSettings(DEFAULT_STEADY_SETTINGS); await renderer.finish(); await scene.dispose(); sceneCredit(); }
    comparisonCredit();
    profile?.dispose(); renderer.dispose(); camera.dispose(); canvas.remove();
  }
}
const harness = { ready: () => window.geometryViewer.ready(), measure };
declare global { interface Window { backendBench: typeof harness } }
window.backendBench = harness;
