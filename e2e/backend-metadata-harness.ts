import { createVerifiedRenderCompute } from '../src/app/renderCompute';
import { GaussianRenderer, GpuScene } from '../src/renderer/webgpu/renderer';
import { GlRenderer } from '../src/renderer/webgl2/renderer';
import { ResourceLedger } from '../src/document/resources';
import { IDENTITY_MATRIX, NEUTRAL_COLOR } from '../src/renderer/defaults';
import { DEFAULT_STEADY_SETTINGS } from '../src/renderer/steadySettings';
import type { CameraController } from '../src/input/camera';

async function compare() {
  const width = 65, height = 49, canvases = Array.from({ length: 2 }, () => {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; document.body.append(canvas); return canvas;
  });
  const gpu = await GaussianRenderer.create(canvases[0]), gl = await GlRenderer.create(canvases[1], createVerifiedRenderCompute), ledger = new ResourceLedger(256 * 1024 ** 2);
  for (const renderer of [gpu, gl]) { renderer.admitWork = bytes => ledger.reserve('work', bytes); renderer.admitSteady = bytes => ledger.reserve('render', bytes); }
  const camera = { view: new Float32Array(IDENTITY_MATRIX), eye: new Float32Array(3), revision: 0, background: 'black',
    projection: new Float32Array([49/65,0,0,0,0,1,0,0,0,0,-100/99.9,-1,0,0,-10/99.9,0]) } as unknown as CameraController;
  const bytes = new ArrayBuffer(96), source = new Float32Array(bytes), half = new DataView(bytes);
  for (let i = 0; i < 2; i++) { source.set([0, 0, -2, i ? .73456789 : .1234567, .04, 0, 0, .09, 0, .01], i * 12); half.setUint16(i * 48 + 40, 0x3c00, true); }
  const scenes = [await gpu.allocateScene(2, 0), await gl.allocateScene(2, 0)];
  for (const scene of scenes) { await scene.upload(0, 2, bytes.slice(0)); scene.masks(new Uint8Array([1, 0]).buffer); }
  const settings = { ...DEFAULT_STEADY_SETTINGS, mode: 'steady' as const, historyWeight: 0, convergence: false };
  const draw = async () => {
    gpu.render(scenes[0], camera, NEUTRAL_COLOR, false, IDENTITY_MATRIX, false, false, 1.4, true);
    await gl.render(scenes[1], camera, NEUTRAL_COLOR, false, IDENTITY_MATRIX, false, false, 1.4, true);
    await Promise.all([gpu.finish(), gl.finish()]);
  };
  let output: GPUBuffer | undefined, readback: GPUBuffer | undefined;
  try {
    gpu.setRenderSettings(settings); gl.setRenderSettings(settings); await draw();
    for (const start = performance.now(); gpu.steadySnapshot.status === 'preparing' || gl.steadySnapshot.status === 'preparing';) {
      if (performance.now() - start > 10000) throw new Error('The actual sample metadata targets did not initialize.'); await new Promise(requestAnimationFrame);
    }
    if (gpu.steadySnapshot.status !== 'steady' || gl.steadySnapshot.status !== 'steady') throw new Error('Both actual SteadySplats backends are required.');
    const sample = (gpu as unknown as { steady: { resources: { samples: GPUTexture } } }).steady.resources.samples;
    const glTarget = (gl as unknown as { steady: { resources: { sampleTarget: WebGLFramebuffer } } }).steady.resources.sampleTarget;
    const shader = gpu.device.createShaderModule({ code: `
      struct Gaussian { center:vec4<f32>, axes:vec4<f32>, color:vec4<f32> }
      @group(0) @binding(0) var samples:texture_2d<u32>;
      @group(0) @binding(1) var<storage,read> projected:array<Gaussian>;
      @group(0) @binding(2) var<storage,read_write> result:array<vec4<u32>>;
      @compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) p:vec3<u32>) {
        if(p.x>=65u || p.y>=49u) {return;}
        let s=textureLoad(samples,vec2<i32>(p.xy),0); let g=projected[max(1u,s.x)-1u]; let at=(p.y*65u+p.x)*3u;
        result[at]=vec4(s.xy,bitcast<vec2<u32>>(g.center.xy)); result[at+1u]=bitcast<vec4<u32>>(g.axes); result[at+2u]=bitcast<vec4<u32>>(g.color);
      }` });
    const info = await shader.getCompilationInfo(); if (info.messages.some(message => message.type === 'error')) throw new Error(info.messages.map(message => message.message).join('\n'));
    const pipeline = gpu.device.createComputePipeline({ layout: 'auto', compute: { module: shader, entryPoint: 'main' } }), size = width * height * 48;
    const credit = ledger.reserve('image', size * 4);
    output = gpu.device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    readback = gpu.device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const bind = gpu.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: sample.createView() }, { binding: 1, resource: { buffer: (scenes[0] as GpuScene).buffers.projected } }, { binding: 2, resource: { buffer: output } },
    ] });
    gpu.resetRenderHistory(); gl.resetRenderHistory(); const steps = [];
    const expectedAxes = [0, 3 * Math.sqrt(Math.fround(.09) * (24.5 / 2) ** 2 + .3), -3 * Math.sqrt(Math.fround(.04) * (24.5 / 2) ** 2 + .3), 0];
    for (let phase = 0; phase <= 64; phase++) {
      await draw(); if (![0, 63, 64].includes(phase)) continue;
      const encoder = gpu.device.createCommandEncoder(), pass = encoder.beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(9, 7); pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, size); gpu.device.queue.submit([encoder.finish()]); await readback.mapAsync(GPUMapMode.READ);
      const observed = new Uint32Array(readback.getMappedRange().slice(0)); readback.unmap(); const floats = new Float32Array(observed.buffer);
      const ids = new Uint32Array(width * height * 4), axes = new Float32Array(ids.length), opacity = new Float32Array(ids.length);
      gl.gl.bindFramebuffer(gl.gl.READ_FRAMEBUFFER, glTarget);
      gl.gl.readBuffer(gl.gl.COLOR_ATTACHMENT1); gl.gl.readPixels(0, 0, width, height, gl.gl.RGBA_INTEGER, gl.gl.UNSIGNED_INT, ids);
      gl.gl.readBuffer(gl.gl.COLOR_ATTACHMENT2); gl.gl.readPixels(0, 0, width, height, gl.gl.RGBA, gl.gl.FLOAT, axes);
      gl.gl.readBuffer(gl.gl.COLOR_ATTACHMENT3); gl.gl.readPixels(0, 0, width, height, gl.gl.RGBA, gl.gl.FLOAT, opacity);
      gl.gl.bindFramebuffer(gl.gl.READ_FRAMEBUFFER, null);
      const idFloats = new Float32Array(ids.buffer);
      const row = { phase, hits: [0, 0, 0], idMismatches: 0, depthMax: 0, centerMax: 0, axesMax: 0, analyticAxesMax: 0, opacityMax: 0, analyticOpacityMax: 0 };
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const a = (y * width + x) * 12, b = ((height - 1 - y) * width + x) * 4, id = observed[a];
        if (id !== ids[b]) { row.idMismatches++; continue; } row.hits[id]++;
        if (!id) continue;
        row.depthMax = Math.max(row.depthMax, Math.abs(floats[a + 1] - idFloats[b + 1]));
        row.centerMax = Math.max(row.centerMax, ...[2, 3].map(i => Math.abs(floats[a + i] - idFloats[b + i])));
        row.axesMax = Math.max(row.axesMax, ...[0, 1, 2, 3].map(i => Math.abs(floats[a + 4 + i] - axes[b + i])));
        row.analyticAxesMax = Math.max(row.analyticAxesMax, ...expectedAxes.map((value, i) => Math.abs(axes[b + i] - value)));
        row.opacityMax = Math.max(row.opacityMax, Math.abs(floats[a + 11] - opacity[b]));
        const expected = id === 1 ? source[3] + (1 - source[3]) * (Math.fround(1.4) - 1) / 2 : source[15];
        row.analyticOpacityMax = Math.max(row.analyticOpacityMax, Math.abs(opacity[b] - expected));
      }
      if (gl.gl.getError() !== gl.gl.NO_ERROR) throw new Error('The actual mixed GL sample metadata readback failed.'); steps.push(row);
    }
    output.destroy(); readback.destroy(); output = undefined; readback = undefined; credit();
    for (const renderer of [gpu, gl]) renderer.setRenderSettings(DEFAULT_STEADY_SETTINGS);
    await draw(); await Promise.all(scenes.map(scene => scene.dispose())); await Promise.all([gpu.finish(), gl.finish()]);
    return { steps, expectedAxes, memory: ledger.usage };
  } finally {
    output?.destroy(); readback?.destroy(); await Promise.all(scenes.map(scene => scene.dispose())); gpu.dispose(); gl.dispose(); canvases.forEach(canvas => canvas.remove());
  }
}
declare global { interface Window { compareSteadyMetadata: typeof compare } }
window.compareSteadyMetadata = compare;
