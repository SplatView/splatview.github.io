import { requireWebGpuController } from './gaussian-harness-scene';
// Test-only real native/WebGPU entry. No replacement renderer or histogram is used.
import { AppController } from '../src/app/controller';
import { useApp } from '../src/app/store';
import { IDENTITY_MATRIX, NEUTRAL_COLOR } from '../src/renderer/defaults';
import type { GaussianRenderer, RenderableScene } from '../src/renderer/webgpu/renderer';
import type { RenderedHistogram } from '../src/renderer/histogram';
import { requireGaussianScene } from './gaussian-harness-scene';

function layers() {
  // Independently specified SH0 input: .4 red drawn before .6 blue.
  const names = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  return new TextEncoder().encode(['ply', 'format ascii 1.0', 'element vertex 2', ...names.map(name => `property float ${name}`), 'end_header',
    ...[[.8, .2, .1, .4], [.1, .4, .8, .6]].map(([r, g, b, a]) => [0, 0, 0, ...[r, g, b].map(value => (value - .5) / .2820947918),
      Math.log(a / (1 - a)), ...Array(3).fill(Math.log(.1)), 1, 0, 0, 0].join(' ')), ''].join('\n'));
}
function pause(controller: AppController) {
  const scheduling = controller as unknown as { frame: number; dirtyFrame: boolean };
  cancelAnimationFrame(scheduling.frame); scheduling.frame = 0; scheduling.dirtyFrame = false;
}
async function setup(width: number, height: number) {
  const canvas = document.createElement('canvas'); canvas.style.width = `${width}px`; canvas.style.height = `${height}px`; document.body.append(canvas);
  const controller = new AppController(); await controller.initialize(canvas);
  await controller.openFiles([new File([layers()], 'rendered-histogram-sh0.ply')]);
  if (!controller.client || !controller.scene || !controller.renderer || !controller.camera) throw new Error(useApp.getState().error ?? 'Histogram fixture did not load.');
  const { renderer } = requireWebGpuController(controller), { camera  } = controller;
  camera.set([0, 0, 0, 0, 0, 3, 1, 45, 0, 0, width / height]);
  // COPY_SRC is an independent test observation capability, never a production requirement.
  const context = canvas.getContext('webgpu')!;
  context.configure({ device: renderer.device, format: renderer.format, alphaMode: 'opaque',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
  await renderer.device.queue.onSubmittedWorkDone(); pause(controller);
  useApp.setState({ toolsOpen: true });
  controller.setHistogramVisible(true);
  const sample = async (highlight = true) => {
    pause(controller); renderer.resetHistogram(); renderer.setHistogramEnabled(true);
    const original = renderer.onHistogram, unavailable = renderer.onHistogramUnavailable, frameNeeded = renderer.onFrameNeeded;
    const render = () => {
      const state = useApp.getState();
      const selectedOnly = state.colorSession?.active || controller.colorPending ? state.colorSelectedOnly : (state.summary?.selected ?? 0) > 0;
      renderer.render(requireGaussianScene(controller.scene), camera, state.grade, highlight, IDENTITY_MATRIX, selectedOnly);
    };
    // Allocation retirement and the 5 Hz throttle may request a later frame.
    // Keep that genuine display pass on this test's exact source/background.
    renderer.onFrameNeeded = render;
    let resolve!: (value: RenderedHistogram) => void, reject!: (error: Error) => void;
    const result = new Promise<RenderedHistogram>((yes, no) => { resolve = yes; reject = no; });
    const expectedFrame = renderer.frames + 1;
    renderer.onHistogram = (value, source) => { original?.(value, source); if (value.frame >= expectedFrame) resolve(value); };
    renderer.onHistogramUnavailable = () => { unavailable?.(); reject(new Error('The genuine GPU histogram became unavailable.')); };
    const timeout = setTimeout(() => reject(new Error('The genuine GPU histogram did not publish.')), 10_000);
    const stride = Math.ceil(width * 4 / 256) * 256;
    const read = renderer.device.createBuffer({ label: 'Independent displayed framebuffer oracle', size: stride * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      const texture = context.getCurrentTexture();
      render();
      const encoder = renderer.device.createCommandEncoder(); encoder.copyTextureToBuffer({ texture }, { buffer: read, bytesPerRow: stride }, [width, height]);
      renderer.device.queue.submit([encoder.finish()]); await read.mapAsync(GPUMapMode.READ);
      const bytes = new Uint8Array(read.getMappedRange().slice(0)); read.unmap();
      const rgb = (x: number, y: number) => {
        const offset = y * stride + x * 4;
        return renderer.format.startsWith('bgra') ? [bytes[offset + 2], bytes[offset + 1], bytes[offset]] : Array.from(bytes.subarray(offset, offset + 3));
      };
      // Independent CPU sampling of actual composed framebuffer bytes. No production helper is shared.
      const gridWidth = Math.min(width, 256), gridHeight = Math.min(height, 144), oracle = Array(768).fill(0) as number[];
      for (let y = 0; y < gridHeight; y++) for (let x = 0; x < gridWidth; x++) {
        const color = rgb(Math.floor((x + .5) * width / gridWidth), Math.floor((y + .5) * height / gridHeight));
        color.forEach((channel, index) => oracle[index * 256 + channel]++);
      }
      const histogram = await result; pause(controller);
      return { bins: Array.from(histogram.bins), oracle, gridWidth, gridHeight, width: histogram.width, height: histogram.height,
        frame: histogram.frame, deviceEpoch: histogram.deviceEpoch, center: rgb(Math.floor(width / 2), Math.floor(height / 2)) };
    } finally { clearTimeout(timeout); read.destroy(); renderer.onHistogram = original; renderer.onHistogramUnavailable = unavailable; renderer.onFrameNeeded = frameNeeded; }
  };
  return { controller, renderer, camera, get scene() { return requireGaussianScene(controller.scene); }, sample,
    dispose: () => { controller.dispose(); canvas.remove(); } };
}

/** Delay settlement of one genuine GPU mapping while retaining its real bytes. */
export function holdNextHistogram(renderer: GaussianRenderer, source?: RenderableScene) {
  const map = GPUBuffer.prototype.mapAsync, create = renderer.device.createBuffer.bind(renderer.device), published = renderer.onHistogram;
  const owned = new Set<GPUBuffer>();
  const current = (renderer as unknown as { histogram: { resources?: { readback: GPUBuffer } } }).histogram.resources?.readback;
  if (current) owned.add(current);
  let enter!: () => void, release!: () => void, active = 0, maximum = 0, maps = 0, stalePublications = 0;
  const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  renderer.device.createBuffer = descriptor => {
    const buffer = create(descriptor); if (descriptor.label === 'Rendered RGB readback') owned.add(buffer); return buffer;
  };
  renderer.onHistogram = (result, scene) => { if (scene === source) stalePublications++; published?.(result, scene); };
  GPUBuffer.prototype.mapAsync = async function (...args) {
    if (!owned.has(this)) return map.apply(this, args);
    maps++; active++; maximum = Math.max(maximum, active);
    try { await map.apply(this, args); enter(); await held; } finally { active--; }
  };
  return { entered, release, counts: () => ({ active, maximum, maps, stalePublications }), restore: () => {
    release(); GPUBuffer.prototype.mapAsync = map; renderer.device.createBuffer = create; renderer.onHistogram = published;
  } };
}

const harness = {
  async solids(width: number, height: number) {
    const h = await setup(width, height);
    try {
      if (!await h.controller.command({ command: 'selectAll' }) || !await h.controller.command({ command: 'delete' })) throw new Error('The genuine all-background scene was refused.');
      const results = [];
      for (const background of ['black', 'gray', 'white'] as const) { h.camera.background = background; results.push({ background, ...await h.sample() }); }
      return results;
    } finally { h.dispose(); }
  },
  async composition(width: number, height: number) {
    const h = await setup(width, height);
    try {
      h.camera.background = 'gray'; const plain = await h.sample();
      if (!await h.controller.command({ command: 'single', index: 0 })) throw new Error('The real native selection was refused.');
      const selected = await h.sample();
      const grade = [...NEUTRAL_COLOR]; grade[0] = 1.8; h.controller.setGrade(grade); const graded = await h.sample();
      const beforeCapture = useApp.getState().histogram;
      // The actual offscreen capture disables highlight. Its image is not the display oracle.
      await h.renderer.capture(h.scene, h.camera, 'image/png', grade, IDENTITY_MATRIX, true);
      const capturePreserved = useApp.getState().histogram === beforeCapture;
      if (!await h.controller.command({ command: 'delete' })) throw new Error('The real native deletion was refused.');
      const deleted = await h.sample();
      return { plain, selected, graded, deleted, capturePreserved, error: useApp.getState().error };
    } finally { h.dispose(); }
  },
  async throttle() {
    const h = await setup(321, 241);
    const encode = h.renderer.device.createCommandEncoder.bind(h.renderer.device), map = GPUBuffer.prototype.mapAsync;
    const starts: number[] = []; let active = 0, maximum = 0;
    try {
      await h.sample();
      h.renderer.device.createCommandEncoder = descriptor => {
        if (descriptor?.label === 'Rendered RGB histogram') starts.push(performance.now());
        return encode(descriptor);
      };
      GPUBuffer.prototype.mapAsync = async function (...args) {
        if (this.label !== 'Rendered RGB readback') return map.apply(this, args);
        active++; maximum = Math.max(maximum, active);
        try { return await map.apply(this, args); } finally { active--; }
      };
      for (let i = 0; i < 24; i++) {
        h.camera.background = (['black', 'gray', 'white'] as const)[i % 3]; h.controller.invalidate();
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      // Allow the single deferred dirty tail, then observe a stationary display.
      await new Promise(resolve => setTimeout(resolve, 350));
      const final = useApp.getState().histogram;
      const frames = h.renderer.frames;
      await new Promise(resolve => setTimeout(resolve, 450));
      const framesAfterIdle = h.renderer.frames;
      h.renderer.device.createCommandEncoder = encode; GPUBuffer.prototype.mapAsync = map;
      const oracle = await h.sample();
      return { starts, maximum, active, frames, framesAfterIdle, finalBins: final ? Array.from(final.bins) : null, oracleBins: oracle.oracle };
    } finally { h.renderer.device.createCommandEncoder = encode; GPUBuffer.prototype.mapAsync = map; h.dispose(); }
  },
};
window.histogramHarness = harness;
declare global {
  interface Window {
    histogramHarness: typeof harness;
    histogramGate?: ReturnType<typeof holdNextHistogram>;
  }
}
