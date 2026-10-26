// Test-only: fixed clip-space vertices make depth and pixel expectations
// independent of the production PLY decoder, native camera and Gaussian packer.
import { GaussianRenderer, type GpuGeometryScene, type GpuScene } from '../src/renderer/webgpu/renderer';
import type { GeometryDescriptor } from '../src/renderer/geometryLayout';
import type { CameraController } from '../src/input/camera';
import { IDENTITY_MATRIX } from '../src/renderer/defaults';
import { ResourceLedger } from '../src/document/resources';
import type { BackgroundColor } from '../src/input/background';

type Vertex = [number, number, number, number, number, number, number];
function vertices(records: Vertex[]) {
  const bytes = new ArrayBuffer(records.length * 16), view = new DataView(bytes);
  records.forEach((record, i) => {
    for (let coordinate = 0; coordinate < 3; coordinate++) view.setFloat32(i * 16 + coordinate * 4, record[coordinate], true);
    for (let channel = 0; channel < 4; channel++) view.setUint8(i * 16 + 12 + channel, record[channel + 3]);
  });
  return bytes;
}
function descriptor(kind: 1 | 2, vertexCount: number, triangleCount = 0): GeometryDescriptor {
  return { layoutVersion: 1, kind, vertexCount, triangleCount, vertexStride: 16, indexStride: 4,
    vertexBytes: vertexCount * 16, indexBytes: triangleCount * 12, revision: 7, contentRevision: 3 };
}
async function image(source: Blob | HTMLCanvasElement) {
  const bitmap = await createImageBitmap(source);
  try {
    const output = new OffscreenCanvas(bitmap.width, bitmap.height), context = output.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    return { width: bitmap.width, height: bitmap.height, pixels: context.getImageData(0, 0, bitmap.width, bitmap.height).data };
  } finally { bitmap.close(); }
}
function samples(data: Awaited<ReturnType<typeof image>>) {
  const centerX = Math.floor(data.width / 2), centerY = Math.floor(data.height / 2);
  const pixel = (x: number, y: number) => Array.from(data.pixels.subarray((y * data.width + x) * 4, (y * data.width + x) * 4 + 4));
  const offsets = [[0, 0], [1, 0], [1, 1], [2, 0], [2, 1], [2, 2], [3, 1], [3, 3]];
  return { width: data.width, height: data.height, center: pixel(centerX, centerY), background: pixel(0, 0),
    offsets: offsets.map(([x, y]) => pixel(centerX + x, centerY + y)) };
}
async function createHarness() {
  const canvas = document.querySelector<HTMLCanvasElement>('#scene')!, renderer = await GaussianRenderer.create(canvas);
  const errors: string[] = []; renderer.onLost = message => errors.push(message);
  const ledger = new ResourceLedger(128 * 1024 * 1024);
  renderer.admitGeometryDepth = bytes => ledger.reserve('render', bytes);
  const camera = { view: new Float32Array(IDENTITY_MATRIX), projection: new Float32Array(IDENTITY_MATRIX),
    eye: new Float32Array([0, 0, -1]), revision: 0, background: 'black' } as unknown as CameraController;
  let current: GpuGeometryScene | undefined;
  async function make(kind: 1 | 2, records: Vertex[], indices?: number[]) {
    const scene = await renderer.allocateGeometry(descriptor(kind, records.length, (indices?.length ?? 0) / 3));
    try {
      await scene.uploadVertices(0, records.length, vertices(records));
      if (indices) await scene.uploadIndices(0, indices.length, new Uint32Array(indices).buffer);
      const old = current; current = scene; await old?.dispose(); return scene;
    } catch (error) { await scene.dispose(); throw error; }
  }
  async function finish(scene: GpuGeometryScene) {
    renderer.render(scene, camera);
    const display = samples(await image(canvas));
    return { ...samples(await image(await renderer.capture(scene, camera))), display, errors: [...errors],
      allocationBytes: scene.allocationBytes, depthBytes: renderer.geometryDepthAllocationBytes,
      leaseBytes: ledger.usage.bytes, kind: scene.kind, descriptor: scene.descriptor,
      noGaussianBuffers: !('buffers' in scene) && !('sortStages' in scene) && !('stageMasks' in scene) };
  }
  return {
    async depth(kind: 'points' | 'mesh', nearFirst: boolean, reverseWinding: boolean) {
      canvas.width = canvas.height = 321; camera.background = 'black';
      const records: Vertex[] = [], indices: number[] = [];
      for (const near of nearFirst ? [true, false] : [false, true]) {
        const z = near ? .2 : .8, red = near ? 255 : 0, green = near ? 0 : 255;
        if (kind === 'points') records.push([0, 0, z, red, green, 0, 0]);
        else {
          const first = records.length;
          records.push([-.75, -.75, z, red, green, 0, 0], [.75, -.75, z, red, green, 0, 0], [0, .75, z, red, green, 0, 0]);
          indices.push(...(reverseWinding ? [first + 2, first + 1, first] : [first, first + 1, first + 2]));
        }
      }
      return finish(await make(kind === 'points' ? 1 : 2, records, kind === 'mesh' ? indices : undefined));
    },
    async meshOrientation(axis: 'x' | 'y' | 'z') {
      canvas.width = canvas.height = 321; camera.background = 'black';
      const records: Vertex[] = axis === 'z' ? [[-.75, -.75, .5, 255, 255, 255, 0], [.75, -.75, .5, 255, 255, 255, 0], [0, .75, .5, 255, 255, 255, 0]] :
        axis === 'x' ? [[.5, -.75, -.75, 255, 255, 255, 0], [.5, .75, -.75, 255, 255, 255, 0], [.5, 0, .75, 255, 255, 255, 0]] :
          [[-.75, .5, -.75, 255, 255, 255, 0], [.75, .5, -.75, 255, 255, 255, 0], [0, .5, .75, 255, 255, 255, 0]];
      camera.view.set(axis === 'z' ? IDENTITY_MATRIX : axis === 'x' ?
        [0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1] :
        [1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1]);
      try { return await finish(await make(2, records, [0, 1, 2])); }
      finally { camera.view.set(IDENTITY_MATRIX); }
    },
    async pointSize(size: number, background: BackgroundColor) {
      canvas.width = canvas.height = size; camera.background = background;
      return finish(await make(1, [[0, 0, .5, 37, 129, 211, 0]]));
    },
    async viewportImage(bytes: number[]) { return samples(await image(new Blob([new Uint8Array(bytes)], { type: 'image/png' }))); },
    async renderCurrent() {
      if (!current) throw new Error('No geometry fixture is active.');
      renderer.render(current, camera); await renderer.device.queue.onSubmittedWorkDone();
    },
    async allocationAndRetirement() {
      canvas.width = canvas.height = 161;
      const scene = await make(2, [[-.5, -.5, .5, 255, 255, 255, 255], [.5, -.5, .5, 255, 255, 255, 255],
        [0, .5, .5, 255, 255, 255, 255]], [0, 1, 2]);
      const failures: string[] = [];
      for (const upload of [
        () => scene.uploadVertices(-1, 1, new ArrayBuffer(16)),
        () => scene.uploadVertices(0, 1, new ArrayBuffer(15)),
        () => scene.uploadVertices(2, 2, new ArrayBuffer(32)),
        () => scene.uploadVertices(.5, 1, new ArrayBuffer(16)),
        () => scene.uploadIndices(0, 3, new Uint32Array([0, 1, 3]).buffer),
        () => scene.uploadIndices(2, 2, new Uint32Array([0, 1]).buffer),
      ]) {
        try { await upload(); failures.push('unexpected acceptance'); } catch (error) { failures.push(String(error)); }
      }
      for (const query of [() => renderer.pick(scene as unknown as GpuScene, 0, 0),
        () => renderer.querySnapshot(scene as unknown as GpuScene), () => renderer.surfaceSnapshot(scene as unknown as GpuScene)]) {
        try { await query(); failures.push('unexpected query acceptance'); } catch (error) { failures.push(String(error)); }
      }
      // Hold the actual queue completion promise to prove old + new target
      // reservations coexist until the GPU retirement boundary is released.
      const actualFence = renderer.device.queue.onSubmittedWorkDone.bind(renderer.device.queue);
      let resume!: () => void; const held = new Promise<undefined>(resolve => { resume = () => resolve(undefined); });
      renderer.device.queue.onSubmittedWorkDone = () => held;
      let duringResize: number, duringDispose: number;
      try {
        canvas.width = canvas.height = 321; renderer.render(scene, camera); duringResize = ledger.usage.bytes;
        const retirement = scene.dispose(); current = undefined; duringDispose = ledger.usage.bytes;
        await actualFence(); resume(); await retirement;
      } finally { resume(); renderer.device.queue.onSubmittedWorkDone = actualFence; }
      let retiredUpload = '';
      try { await scene.uploadVertices(0, 1, new ArrayBuffer(16)); } catch (error) { retiredUpload = String(error); }
      return { failures, duringResize, duringDispose, after: ledger.usage.bytes,
        depthAfter: renderer.geometryDepthAllocationBytes, retired: scene.retired, retiredUpload, errors };
    },
    async refusedDepth() {
      canvas.width = canvas.height = 161; camera.background = 'black';
      const scene = await make(1, [[0, 0, .5, 100, 150, 200, 255]]), before = ledger.usage.bytes;
      renderer.admitGeometryDepth = () => { throw new Error('Injected target admission refusal'); };
      let refusal = '';
      try { await renderer.prepareGeometryTarget(321, 321); } catch (error) { refusal = String(error); }
      renderer.admitGeometryDepth = bytes => ledger.reserve('render', bytes);
      const retained = await finish(scene); await scene.dispose(); current = undefined;
      return { before, refusal, retained, after: ledger.usage.bytes, errors };
    },
    async rejectedResize() {
      canvas.width = canvas.height = 161; camera.background = 'black';
      const scene = await make(1, [[0, 0, .5, 100, 150, 200, 255]]), before = ledger.usage.bytes;
      const actualTexture = renderer.device.createTexture.bind(renderer.device), reported: string[] = [];
      let allocations = 0, requestedFrames = 0;
      renderer.onLost = message => reported.push(message); renderer.onFrameNeeded = () => { requestedFrames++; };
      renderer.device.createTexture = specification => {
        if (specification.label === 'Readonly PLY viewport depth') {
          allocations++;
          // Real GPU validation rejects usage 0 asynchronously. No fake
          // checkedAllocation result or production failure command is involved.
          return actualTexture({ ...specification, usage: 0 });
        }
        return actualTexture(specification);
      };
      let failure = '';
      try {
        canvas.width = canvas.height = 321; renderer.render(scene, camera);
        try { await renderer.prepareGeometryTarget(); } catch (error) { failure = String(error); }
        await Promise.resolve(); renderer.render(scene, camera);
      } finally { renderer.device.createTexture = actualTexture; }
      const failedBytes = ledger.usage.bytes, failedDepthBytes = renderer.geometryDepthAllocationBytes;
      canvas.width = canvas.height = 161;
      const retained = await finish(scene);
      // An explicit checked preparation is a retry; render alone must not
      // repeatedly allocate the same rejected size on every animation frame.
      canvas.width = canvas.height = 321; await renderer.prepareGeometryTarget();
      const recovered = await finish(scene);
      canvas.width = canvas.height = 481; renderer.render(scene, camera);
      await renderer.prepareGeometryTarget(); await Promise.resolve();
      const resized = await finish(scene); await scene.dispose(); current = undefined;
      return { before, failure, allocations, requestedFrames, reported, failedBytes, failedDepthBytes,
        retained, recovered, resized, after: ledger.usage.bytes, depthAfter: renderer.geometryDepthAllocationBytes, errors };
    },
    async supersededResize() {
      canvas.width = canvas.height = 161; camera.background = 'black';
      const scene = await make(1, [[0, 0, .5, 100, 150, 200, 255]]);
      const actualPop = renderer.device.popErrorScope.bind(renderer.device);
      let resume!: () => void; const held = new Promise<void>(resolve => { resume = resolve; });
      let requestedFrames = 0; renderer.onFrameNeeded = () => { requestedFrames++; };
      renderer.device.popErrorScope = async () => { const result = await actualPop(); await held; return result; };
      let during = 0;
      try {
        canvas.width = canvas.height = 321; renderer.render(scene, camera);
        const obsolete = renderer.prepareGeometryTarget();
        canvas.width = canvas.height = 161; renderer.render(scene, camera);
        during = ledger.usage.bytes; resume(); await obsolete;
      } finally { resume(); renderer.device.popErrorScope = actualPop; }
      const retained = await finish(scene); await scene.dispose(); current = undefined;
      return { during, requestedFrames, retained, after: ledger.usage.bytes,
        depthAfter: renderer.geometryDepthAllocationBytes, errors };
    },
  };
}
declare global {
  interface Window { geometryRender: Awaited<ReturnType<typeof createHarness>>; geometryRenderError?: string }
}
void createHarness().then(harness => { window.geometryRender = harness; }).catch(error => { window.geometryRenderError = String(error); });
