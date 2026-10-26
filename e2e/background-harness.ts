import { requireWebGpuController } from './gaussian-harness-scene';
import { requireWebGpuRenderer } from './gaussian-harness-scene';
import { admittedExport } from './admitted-export';
// Real worker/native/WebGPU tests. This entry is excluded from production builds.
import { AppController } from '../src/app/controller';
import { requireGaussianScene } from './gaussian-harness-scene';
import { useApp } from '../src/app/store';
import { IDENTITY_MATRIX } from '../src/renderer/defaults';
import { BACKGROUND_COLORS, backgroundShade, type BackgroundColor } from '../src/input/background';
import { queuePly, queuePositions } from './queue-fixture';

function gate() {
  let release!: () => void, entered!: () => void;
  return { held: new Promise<void>(resolve => { release = resolve; }), waiting: new Promise<void>(resolve => { entered = resolve; }), release: () => release(), enter: () => entered() };
}
async function pixels(source: Blob | HTMLCanvasElement) {
  const bitmap = await createImageBitmap(source);
  try {
    const output = new OffscreenCanvas(bitmap.width, bitmap.height), context = output.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
    const at = (x: number, y: number) => Array.from(image.data.slice((y * bitmap.width + x) * 4, (y * bitmap.width + x) * 4 + 4));
    return { corner: at(0, 0), center: at(Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2)), width: bitmap.width, height: bitmap.height };
  } finally { bitmap.close(); }
}
function overlapPly() {
  // Two coincident SH0 layers. Stable source order draws the .4 red layer
  // first, followed by the .6 blue layer. An odd viewport makes its middle
  // pixel exactly the Gaussian center: no sampled falloff approximation.
  const colors = [[.8, .2, .1], [.1, .4, .8]], alpha = [.4, .6], scale = Math.log(.1);
  const names = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  return new TextEncoder().encode(['ply', 'format ascii 1.0', 'element vertex 2', ...names.map(name => `property float ${name}`), 'end_header',
    ...colors.map((rgb, i) => [0, 0, 0, ...rgb.map(value => (value - .5) / .2820947918), Math.log(alpha[i] / (1 - alpha[i])), scale, scale, scale, 1, 0, 0, 0].join(' ')), ''].join('\n'));
}
async function setup(overlap = false) {
  const canvas = document.createElement('canvas'); canvas.style.width = overlap ? '321px' : '480px'; canvas.style.height = overlap ? '241px' : '300px'; document.body.append(canvas);
  const controller = new AppController(); await controller.initialize(canvas);
  await controller.openFiles([new File([overlap ? overlapPly() : queuePly()], 'background-sh0.ply')]);
  if (!controller.client || !controller.scene || !controller.renderer || !controller.camera) throw new Error(useApp.getState().error || 'Background fixture did not load.');
  const { renderer } = requireWebGpuController(controller), { client, camera  } = controller;
  const scene = requireGaussianScene(controller.scene);
  camera.set([0, 0, 0, 0, 0, 3, 1, 45, 0, 0, canvas.width / canvas.height]);
  useApp.setState({ tool: null, operation: 0, connectedColor: false, colorTolerance: .01, fillTolerance: .01, tolerance: .01,
    visibleOnly: false, overlap: false, live: false, selectionDragging: false });
  const flush = () => (controller as unknown as { tolerance?: { session: { flush(): Promise<void> } } }).tolerance?.session.flush();
  const point = (id: number) => {
    const [x, y, z] = queuePositions[id], multiply = (value: number[], matrix: Float32Array) => Array.from({ length: 4 }, (_, column) => value.reduce((sum, v, row) => sum + v * matrix[row * 4 + column], 0));
    const clip = multiply(multiply([x, -y, -z, 1], camera.view), camera.projection);
    return [Math.floor((clip[0] / clip[3] + 1) * canvas.width / 2), Math.floor((1 - clip[1] / clip[3]) * canvas.height / 2)] as [number, number];
  };
  const gpuMasks = async () => {
    const active = requireWebGpuRenderer(controller.renderer), source = requireGaussianScene(controller.scene), size = source.count * 4;
    const read = active.device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      const encoder = active.device.createCommandEncoder(); encoder.copyBufferToBuffer(source.buffers.states, 0, read, 0, size); active.device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ); const result = Array.from(new Uint32Array(read.getMappedRange().slice(0))); read.unmap(); return result;
    } finally { read.destroy(); }
  };
  const snapshot = async () => {
    let ids: number[] = [], exportError: string | undefined;
    try {
      ids = new TextDecoder().decode(await admittedExport(controller.client!, 5, 1)).trim().split(/\r?\n/).slice(1).map(row => {
        const point = row.split(',').slice(0, 3).map(Number);
        return queuePositions.findIndex(source => source.every((value, axis) => Math.abs(value - point[axis]) < 1e-5));
      }).sort((a, b) => a - b);
    } catch (error) {
      const summary = await controller.client!.command({ command: 'summary' });
      if (summary.selected || !(error instanceof Error) || !error.message.includes('There are no visible Gaussians to save')) throw error;
      exportError = error.message;
    }
    const summary = await controller.client!.command({ command: 'summary' });
    return { summary, masks: await gpuMasks(), ids, exportError, dirty: useApp.getState().dirty,
      background: camera.background, storeBackground: useApp.getState().background, state: camera.state, cameraRevision: camera.revision };
  };
  // Match the controller's scheduled display pass so an intervening RAF does
  // not change selection/grade uniforms during a background-only query test.
  const renderCurrent = () => {
    const state = useApp.getState();
    renderer.render(scene, camera, state.grade, true, IDENTITY_MATRIX, (state.summary?.selected ?? 0) > 0);
  };
  return { controller, client, scene, renderer, camera, canvas, point, snapshot, flush, renderCurrent,
    dispose: () => { controller.dispose(); canvas.remove(); } };
}
function createHarness() {
  return {
    async tones() {
      const h = await setup(true);
      try {
        const state = h.camera.state, revision = h.camera.revision, tones = [];
        for (const color of BACKGROUND_COLORS) {
          h.camera.background = color;
          h.renderer.render(h.scene, h.camera, undefined, false);
          // A bitmap of the presented WebGPU canvas exercises the display pass.
          const display = await pixels(h.canvas), capture = await pixels(await h.controller.capture('image/png'));
          h.renderer.render(undefined, h.camera); const empty = await pixels(h.canvas);
          tones.push({ color, shade: backgroundShade(color), display, capture, empty });
        }
        return { tones, statePreserved: state.every((v, i) => v === h.camera.state[i]), revisionPreserved: revision === h.camera.revision };
      } finally { h.dispose(); }
    },
    async owner(tool: 'color' | 'fill') {
      const h = await setup();
      try {
        useApp.setState({ tool, connectedColor: tool === 'color' });
        const accepted = await (tool === 'color' ? h.controller.selectColorPixel(...h.point(0), 0) : h.controller.fillPixel(...h.point(0), 0));
        const channels = tool === 'color' ? { colors: true, visible: true } : {}, map = await h.controller.selectionMap(channels);
        h.renderCurrent();
        const queryCurrent = h.renderer.querySnapshot(h.scene), surfaceCurrent = h.renderer.surfaceSnapshot(h.scene), before = await h.snapshot();
        const nativeOutput = new Uint8Array(await admittedExport(h.client, 5, 1)), sortRevision = h.scene.lastCameraRevision, frameRevision = (h.renderer as unknown as { frameRevision: number }).frameRevision;
        const originalCreate = h.renderer.device.createBuffer.bind(h.renderer.device), originalPick = h.renderer.pick.bind(h.renderer);
        const originalEncoder = h.renderer.device.createCommandEncoder.bind(h.renderer.device), originalWrite = h.renderer.device.queue.writeBuffer.bind(h.renderer.device.queue);
        let readbacks = 0, picks = 0, sorts = 0, sourceWrites = 0;
        h.renderer.device.createBuffer = descriptor => { if (descriptor.usage & GPUBufferUsage.MAP_READ) readbacks++; return originalCreate(descriptor); };
        h.renderer.pick = async (...args) => { picks++; return originalPick(...args); };
        h.renderer.device.createCommandEncoder = descriptor => {
          const encoder = originalEncoder(descriptor), originalPass = encoder.beginComputePass.bind(encoder);
          encoder.beginComputePass = descriptor => {
            const pass = originalPass(descriptor), pipeline = pass.setPipeline.bind(pass);
            pass.setPipeline = value => { if (value === h.renderer.pipelines.generate) sorts++; pipeline(value); };
            return pass;
          };
          return encoder;
        };
        h.renderer.device.queue.writeBuffer = (buffer, offset, data, dataOffset, size) => {
          if (buffer === h.scene.buffers.splats || buffer === h.scene.buffers.states) sourceWrites++;
          originalWrite(buffer, offset, data, dataOffset, size);
        };
        const cycles: BackgroundColor[] = [];
        for (let i = 0; i < 3; i++) {
          h.controller.cycleBackground(); cycles.push(h.camera.background); h.renderCurrent();
          queryCurrent(); surfaceCurrent(); map.assertCurrent();
        }
        const frameRevisionPreserved = frameRevision === (h.renderer as unknown as { frameRevision: number }).frameRevision;
        h.renderer.device.createCommandEncoder = originalEncoder; h.renderer.device.queue.writeBuffer = originalWrite;
        const afterOutput = new Uint8Array(await admittedExport(h.client, 5, 1)), afterCycle = await h.client.command({ command: 'summary' });
        const reused = await h.controller.selectionMap(channels), sameMap = reused.mapId === map.mapId && reused.map === map.map;
        h.controller.setSelectionTolerance(tool === 'color' ? .35 : 1); await h.flush();
        const queryReadbacks = readbacks, queryPicks = picks;
        h.renderer.device.createBuffer = originalCreate; h.renderer.pick = originalPick;
        const amended = await h.snapshot(); await h.controller.command({ command: 'undo' }); const undone = await h.snapshot();
        await h.controller.command({ command: 'redo' }); const redone = await h.snapshot();
        return { accepted, cycles, before, afterCycle, sameMap, frameRevisionPreserved, sortRevisionPreserved: sortRevision === h.scene.lastCameraRevision,
          sameOutput: nativeOutput.length === afterOutput.length && nativeOutput.every((v, i) => v === afterOutput[i]), queryReadbacks, queryPicks, sorts, sourceWrites, amended, undone, redone, error: useApp.getState().error };
      } finally { h.dispose(); }
    },
    async pending(tool: 'color' | 'fill') {
      const h = await setup(), held = gate();
      try {
        useApp.setState({ tool, connectedColor: tool === 'color' });
        if (tool === 'color') {
          // Keep the genuine GPU pick queued until a background-only render
          // has occurred, so its own before/after query guards both run.
          (h.renderer as unknown as { queryQueue: Promise<void> }).queryQueue = held.held;
          const original = h.renderer.pick.bind(h.renderer);
          h.renderer.pick = (...args) => { const result = original(...args); held.enter(); return result; };
        } else {
          const original = h.controller.selectionMap.bind(h.controller);
          h.controller.selectionMap = async (...args) => { const result = await original(...args); held.enter(); await held.held; result.assertCurrent(); return result; };
        }
        const picking = tool === 'color' ? h.controller.selectColorPixel(...h.point(0), 0) : h.controller.fillPixel(...h.point(0), 0);
        await held.waiting; const revision = h.camera.revision;
        h.controller.cycleBackground(); h.renderCurrent(); const pending = useApp.getState().pendingSelectionCount;
        held.release(); const accepted = await picking, after = await h.snapshot();
        return { pending, accepted, revisionPreserved: revision === h.camera.revision, after, error: useApp.getState().error };
      } finally { held.release(); h.dispose(); }
    },
    async waitingConnected() {
      const h = await setup(), held = gate();
      try {
        useApp.setState({ tool: 'color', connectedColor: false });
        if (!await h.controller.selectColorPixel(...h.point(0), 0)) throw new Error('Ordinary Color owner was refused.');
        const before = await h.snapshot(), originalMap = h.controller.selectionMap.bind(h.controller); let requests = 0;
        h.controller.selectionMap = async (...args) => {
          requests++; const result = await originalMap(...args); held.enter(); await held.held; result.assertCurrent(); return result;
        };
        h.controller.setConnectedColor(true); await held.waiting;
        h.controller.cycleBackground(); h.controller.cycleBackground(); h.renderCurrent();
        const waiting = await h.snapshot(); held.release(); await h.flush(); const connected = await h.snapshot();
        h.controller.setSelectionTolerance(.35); await h.flush(); const amended = await h.snapshot();
        return { before, waiting, connected, amended, requests, preference: useApp.getState().connectedColor, error: useApp.getState().error };
      } finally { held.release(); h.dispose(); }
    },
    async replacement(failed: boolean) {
      const h = await setup();
      try {
        await h.controller.command({ command: 'single', index: 3 }); h.controller.cycleBackground(); h.controller.cycleBackground();
        const before = await h.snapshot();
        await h.controller.openFiles([new File([failed ? new TextEncoder().encode('invalid PLY') : queuePly()], 'replacement.ply')]);
        const after = await h.snapshot();
        return { before, after, sameClient: h.controller.client === h.client, sourceName: useApp.getState().sourceName, error: useApp.getState().error };
      } finally { h.dispose(); }
    },
    async reset() {
      const h = await setup();
      try {
        await h.controller.command({ command: 'single', index: 3 }); h.controller.cycleBackground(); h.controller.cycleBackground(); h.camera.orbit(.2, -.1);
        const before = await h.snapshot(); h.controller.resetCamera(); const after = await h.snapshot();
        return { before, after, error: useApp.getState().error };
      } finally { h.dispose(); }
    },
    async recovery() {
      const h = await setup();
      try {
        await h.controller.command({ command: 'single', index: 3 }); await h.controller.command({ command: 'delete' }); await h.controller.command({ command: 'undo' });
        h.controller.cycleBackground(); h.controller.cycleBackground();
        const before = await h.snapshot(), beforeImage = await pixels(await h.controller.capture('image/png')), epoch = h.renderer.deviceEpoch;
        h.renderer.device.destroy(); await h.renderer.device.lost; const recovered = await h.controller.retryRenderer();
        const after = await h.snapshot(), afterImage = await pixels(await h.controller.capture('image/png'));
        return { recovered, before, after, beforeImage, afterImage, changedEpoch: epoch !== requireWebGpuRenderer(h.controller.renderer).deviceEpoch, error: useApp.getState().error, busy: useApp.getState().busy };
      } finally { h.dispose(); }
    },
  };
}
window.backgroundHarness = createHarness();
declare global { interface Window { backgroundHarness: ReturnType<typeof createHarness> } }
