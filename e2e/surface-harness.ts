// Test-only independent fixtures. Vite's production entry excludes this page.
import { GaussianRenderer, StaleGpuQueryError, type GpuScene, type PreviewMaskChannel } from '../src/renderer/webgpu/renderer';
import { compositedSurface } from '../src/renderer/webgpu/surface';
import { SurfaceCapacityError, type SurfaceMap } from '../src/renderer/webgpu/surfaceQuery';
import { AdmissionError, MiB, ResourceLedger } from '../src/document/resources';
import { CameraController } from '../src/input/camera';
import { IDENTITY_MATRIX, NEUTRAL_COLOR } from '../src/renderer/defaults';
import frameSource from '../src/renderer/webgpu/frame.wgsl?raw';
import surfaceSource from '../src/renderer/webgpu/surface.wgsl?raw';

type Layer = { z: number; opacity: number; x?: number; y?: number; covariance?: [number, number, number, number, number, number]; coefficients?: number[] };
type Fixture = { layers: Layer[]; width?: number; height?: number; masks?: number[]; radius?: number;
  initial?: number; maximum?: number; samples?: [number, number][]; degree?: number; colors?: boolean; visible?: boolean;
  grade?: number[]; geometry?: number[]; selectedOnly?: boolean; cssWidth?: number; cssHeight?: number;
  opacityScale?: number; opacitySelectedOnly?: boolean };
function half(value: number) {
  // Fixtures use exactly representable binary16 coefficients, independently
  // packed here rather than passing through a production scene exporter.
  if (value === 0) return 0;
  const sign = value < 0 ? 0x8000 : 0, magnitude = Math.abs(value), exponent = Math.floor(Math.log2(magnitude));
  const fraction = (magnitude / 2 ** exponent - 1) * 1024;
  if (!Number.isInteger(fraction) || exponent < -14 || exponent > 15) throw new Error('Fixture coefficient is not exactly binary16.');
  return sign | ((exponent + 15) << 10) | fraction;
}
function pack(layers: Layer[], degree = 0) {
  const stride = 40 + Math.ceil(3 * (degree + 1) ** 2 / 2) * 4;
  const bytes = new ArrayBuffer(layers.length * stride), floats = new Float32Array(bytes), view = new DataView(bytes);
  layers.forEach((layer, i) => {
    floats.set([layer.x ?? 0, layer.y ?? 0, layer.z, layer.opacity,
      ...(layer.covariance ?? [.01, 0, 0, .01, 0, .01])], i * stride / 4);
    layer.coefficients?.forEach((coefficient, j) => view.setUint16(i * stride + 40 + j * 2, half(coefficient), true));
  });
  return bytes;
}

async function createHarness() {
  const canvas = document.querySelector<HTMLCanvasElement>('#scene')!;
  const renderer = await GaussianRenderer.create(canvas), camera = await CameraController.create();
  const errors: string[] = []; renderer.onLost = message => errors.push(message);
  async function fixture(input: Fixture) {
    canvas.width = input.width ?? 65; canvas.height = input.height ?? 49;
    canvas.style.width = `${input.cssWidth ?? canvas.width}px`; canvas.style.height = `${input.cssHeight ?? canvas.height}px`;
    camera.set([0, 0, 0, 0, 0, 3, input.radius ?? 1, 45, 0, 0, canvas.width / canvas.height]);
    const scene = await renderer.allocateScene(input.layers.length, input.degree ?? 0);
    await scene.upload(0, input.layers.length, pack(input.layers, input.degree));
    scene.masks(Uint8Array.from(input.masks ?? input.layers.map(() => 0)).buffer);
    renderer.render(scene, camera, input.grade ?? NEUTRAL_COLOR, true, input.geometry ?? IDENTITY_MATRIX,
      input.selectedOnly ?? false, input.selectedOnly ?? false, input.opacityScale ?? 1, input.opacitySelectedOnly ?? false); return scene;
  }
  return {
    async frozenPreviewTargets(channel: PreviewMaskChannel, downsampled: boolean) {
      // The oracle uses an ordinary canonical source mask. Its independent
      // effective membership is literal, with no current-view predicate or
      // production state-mask helper shared with the candidate.
      const layers: Layer[] = [{ x: -.13, z: 0, opacity: .65, coefficients: [.5, -.25, .25] },
        { x: .13, z: -.4, opacity: .45, coefficients: [-.5, .5, 0] },
        { x: 0, z: -.8, opacity: .7, coefficients: [0, -.5, .5] }, { x: 0, z: .5, opacity: 1 }];
      const canonical = [1, 1, 0, 2], effective = [1, 0, 0, 2];
      const actual = await fixture({ layers, masks: canonical, width: downsampled ? 1025 : 65, height: downsampled ? 769 : 49 });
      const oracle = await fixture({ layers, masks: effective, width: canvas.width, height: canvas.height });
      const control = await fixture({ layers, masks: canonical, width: canvas.width, height: canvas.height });
      const ledger = new ResourceLedger(128 * MiB), before = actual.allocationBytes;
      const grade = [...NEUTRAL_COLOR]; if (channel === 'colorBase') grade[0] = 1.5;
      const geometry = [...IDENTITY_MATRIX]; if (channel === 'transformBase') { geometry[12] = .2; geometry[14] = -1; }
      const alpha = channel === 'opacityBase' ? 2 : 1;
      const read = async (source: GPUBuffer) => {
        const output = renderer.device.createBuffer({ size: source.size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        try {
          const encoder = renderer.device.createCommandEncoder(); encoder.copyBufferToBuffer(source, 0, output, 0, source.size);
          renderer.device.queue.submit([encoder.finish()]); await output.mapAsync(GPUMapMode.READ);
          const bytes = output.getMappedRange().slice(0); output.unmap(); return bytes;
        } finally { output.destroy(); }
      };
      const sample = async (scene: GpuScene) => {
        renderer.render(scene, camera, grade, false, geometry, true, true, alpha, true);
        const projection = Array.from(new Float32Array(await read(scene.buffers.projected)));
        const order = Array.from(new Uint32Array(await read(scene.ordered)));
        const map = await compositedSurface(renderer, scene, { admit: bytes => ledger.reserve('work', bytes), colors: true, visible: true });
        let surface: number[], visible: number[];
        try { surface = [...map.depths, ...map.opacities, ...map.colors!]; visible = Array.from(map.visible!); }
        finally { map.dispose(); }
        const pick = await renderer.pick(scene, canvas.width / 2, canvas.height / 2);
        const image = await renderer.captureRgba(scene, camera, { admit: bytes => ledger.reserve('work', bytes) },
          grade, geometry, true, true, alpha, true);
        try { return { projection, order, surface, visible, pick, pixels: image.pixels.slice() }; }
        finally { image.dispose(); }
      };
      const maxError = (left: ArrayLike<number>, right: ArrayLike<number>) => {
        if (left.length !== right.length) throw new Error('Mismatched independent GPU oracle length');
        let result = 0; for (let i = 0; i < left.length; i++) {
          if (!Number.isFinite(left[i]) || !Number.isFinite(right[i])) throw new Error('Nonfinite GPU oracle output');
          result = Math.max(result, Math.abs(left[i] - right[i]));
        } return result;
      };
      try {
        const staged = await actual.stagePreviewMasks(Uint8Array.from(effective).buffer, channel); staged.publish();
        const frames = [];
        for (const [yaw, pitch] of [[0, 0], [.35, .12]]) {
          camera.set([0, 0, 0, yaw, pitch, 3, 1, 45, 0, 0, canvas.width / canvas.height]);
          const a = await sample(actual), b = await sample(oracle), c = await sample(control);
          // Sorting must use frozen transform targets while its packed state
          // bits remain the canonical selection used for desktop highlighting.
          const packedStates = Array.from({ length: 4 }, () => -1);
          for (let i = 1; i < a.order.length; i += 2) packedStates[a.order[i] & 0xffffff] = a.order[i] >>> 24;
          const depthOrder = (words: number[]) => words.map((word, i) => i % 2 ? word & 0xffffff : word);
          frames.push({ projectionError: maxError(a.projection, b.projection), orderError: maxError(depthOrder(a.order), depthOrder(b.order)),
            surfaceError: maxError(a.surface, b.surface), visibleError: maxError(a.visible, b.visible), imageError: maxError(a.pixels, b.pixels),
            controlImageDifference: maxError(a.pixels, c.pixels), packedStates, pick: a.pick, oraclePick: b.pick });
        }
        const clear = await actual.stagePreviewMasks(null, channel); clear.publish();
        await renderer.device.queue.onSubmittedWorkDone(); for (const buffer of clear.retirementBuffers) buffer.destroy();
        const a = await sample(actual), c = await sample(control);
        return { frames, clearImageError: maxError(a.pixels, c.pixels), before, after: actual.allocationBytes,
          retirementBytes: clear.retirementBytes, retiredBuffers: clear.retirementBuffers.length, usage: ledger.usage, errors };
      } finally { await actual.dispose(); await oracle.dispose(); await control.dispose(); }
    },
    async opacitySeries(selectedOnly = false) {
      // Scramble source IDs; the transparent near source must already be ranked.
      const scene = await fixture({ layers: [{ z: -1, opacity: .6 }, { z: -2, opacity: 0 },
        { z: -2.5, opacity: 1 }], masks: [0, 1, 2] });
      const ledger = new ResourceLedger(128 * MiB), sortPipelines = new Set(scene.sortStages.map(stage => stage.pipeline));
      const original = GPUComputePassEncoder.prototype.setPipeline;
      let sortCalls = 0;
      GPUComputePassEncoder.prototype.setPipeline = function (pipeline) {
        if (sortPipelines.has(pipeline)) sortCalls++;
        return original.call(this, pipeline);
      };
      const frames = [];
      try {
        for (const scale of [1, 2, 0, 1]) {
          renderer.render(scene, camera, NEUTRAL_COLOR, false, IDENTITY_MATRIX, false, false, scale, selectedOnly);
          const map = await compositedSurface(renderer, scene, { admit: bytes => ledger.reserve('work', bytes), colors: true, visible: true });
          try {
            const index = Math.floor(map.height / 2) * map.width + Math.floor(map.width / 2);
            const pick = await renderer.pick(scene, Math.floor(canvas.width / 2), Math.floor(canvas.height / 2));
            frames.push({ scale, depth: map.depths[index], opacity: map.opacities[index],
              color: Array.from(map.colors!.subarray(index * 3, index * 3 + 3)), visible: Array.from(map.visible!), pick });
          } finally { map.dispose(); }
        }
        return { frames, sortCalls, released: ledger.usage, errors };
      } finally { GPUComputePassEncoder.prototype.setPipeline = original; await scene.dispose(); }
    },
    async sample(input: Fixture) {
      const scene = await fixture(input), ledger = new ResourceLedger(256 * MiB);
      let map: SurfaceMap | undefined;
      const originalCreate = renderer.device.createBuffer, candidateAllocations: number[] = [];
      renderer.device.createBuffer = function (descriptor) {
        if (descriptor.label === 'Surface tile global ranks') candidateAllocations.push(descriptor.size);
        return originalCreate.call(this, descriptor);
      };
      try {
        const started = performance.now();
        map = await compositedSurface(renderer, scene, { admit: bytes => ledger.reserve('work', bytes),
          initialTileCapacity: input.initial, maxTileCapacity: input.maximum, colors: input.colors, visible: input.visible });
        const elapsedMs = performance.now() - started;
        map.assertCurrent();
        const coordinates = input.samples ?? [[Math.floor(map.width / 2), Math.floor(map.height / 2)] as [number, number]];
        const result = { width: map.width, height: map.height, fullWidth: map.fullWidth, fullHeight: map.fullHeight,
          attempts: map.attempts, capacity: map.tileCapacity, epoch: map.deviceEpoch,
          candidateBytes: map.candidateBytes, candidateEntries: map.candidateEntries,
          tileCount: map.tileCount, occupiedTiles: map.occupiedTiles, sortComparisons: map.sortComparisons,
          candidateAllocations, elapsedMs,
          retained: ledger.usage, allocationBytes: map.allocationBytes,
          samples: coordinates.map(([x, y]) => ({ x, y, depth: map!.depths[y * map!.width + x], opacity: map!.opacities[y * map!.width + x],
            color: map!.colors ? Array.from(map!.colors.subarray((y * map!.width + x) * 3, (y * map!.width + x) * 3 + 3)) : undefined })),
          visible: map.visible ? Array.from(map.visible) : undefined,
          allFinite: map.depths.every(value => Number.isFinite(value) && value >= 0) && map.opacities.every(value => Number.isFinite(value) && value >= 0 && value <= 1) &&
            (!map.colors || map.colors.every(value => Number.isFinite(value) && value >= 0 && value <= 1)),
          nonempty: map.depths.reduce((count, depth) => count + Number(depth > 0), 0),
          features: Array.from(renderer.device.features), errors };
        map.dispose(); map.dispose();
        let disposedRejected = false; try { map.assertCurrent(); } catch { disposedRejected = true; }
        return { ...result, released: ledger.usage, disposedRejected };
      } finally { renderer.device.createBuffer = originalCreate; map?.dispose(); await scene.dispose(); }
    },
    async failure(kind: 'overflow' | 'admission' | 'retry-admission' | 'camera' | 'viewport' | 'mask' | 'loss' | 'cancel' | 'allocation' | 'color-readback' | 'visibility-readback' | 'opacity' | 'opacity-color' | 'opacity-visibility', channels = false) {
      const scene = await fixture({ layers: Array.from({ length: 17 }, (_, i) => ({ z: i * .01, opacity: .3 })) });
      const ledger = new ResourceLedger(128 * MiB), before = ledger.usage;
      const originalMap = GPUBuffer.prototype.mapAsync, originalCreate = renderer.device.createBuffer;
      let entered!: () => void, release!: () => void;
      const mapped = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      let peakAtGate = 0, resizeDenied = false, allocations = 0, destroyed = 0;
      const abort = new AbortController();
      if (['camera', 'viewport', 'mask', 'loss', 'cancel', 'color-readback', 'visibility-readback', 'opacity', 'opacity-color', 'opacity-visibility'].includes(kind)) {
        GPUBuffer.prototype.mapAsync = function (mode, offset, size) {
          const pending = originalMap.call(this, mode, offset, size);
          const target = kind === 'color-readback' || kind === 'opacity-color' ? 'Surface raw RGB readback' :
            kind === 'visibility-readback' || kind === 'opacity-visibility' ? 'Surface visibility readback' : 'Surface capacity readback';
          if (this.label === target) return pending.then(async () => {
            peakAtGate = ledger.usage.bytes; entered(); await gate; return undefined;
          });
          return pending;
        };
      }
      renderer.device.createBuffer = function (descriptor) {
        if (descriptor.label?.startsWith('Surface')) {
          allocations++;
          const buffer = originalCreate.call(this, kind === 'allocation' && allocations === 4 ? { ...descriptor, usage: 0 } : descriptor);
          const destroy = buffer.destroy.bind(buffer);
          let retired = false; buffer.destroy = () => { if (!retired) { retired = true; destroyed++; } destroy(); }; return buffer;
        }
        return originalCreate.call(this, descriptor);
      };
      let failure: unknown, accepted = false;
      try {
        const work = compositedSurface(renderer, scene, { signal: abort.signal, initialTileCapacity: 1, colors: channels, visible: channels,
          maxTileCapacity: kind === 'overflow' ? 8 : 32,
          admit: bytes => {
            if (kind === 'admission') throw new AdmissionError('Injected surface admission refusal');
            const lease = ledger.reserve('work', bytes), resize = lease.resize;
            // Retain the old fixture key for opacity callers. The resize now
            // admits compact candidates after the count-only phase.
            if (kind === 'retry-admission') lease.resize = _bytes => { resizeDenied = true; throw new AdmissionError('Injected compact candidate admission refusal'); };
            else lease.resize = bytes => resize(bytes);
            return lease;
          } });
        // Attach the rejection before yielding to an external mutation.
        const result = work.then(map => { accepted = true; map.dispose(); }, error => { failure = error; });
        if (['camera', 'viewport', 'mask', 'loss', 'cancel', 'color-readback', 'visibility-readback', 'opacity', 'opacity-color', 'opacity-visibility'].includes(kind)) {
          await mapped;
          if (kind === 'camera') { camera.orbit(.2, .1); renderer.render(scene, camera); }
          if (kind === 'viewport') canvas.width++;
          if (kind === 'mask') scene.masks(new Uint8Array(scene.count).fill(2).buffer);
          if (kind === 'loss') { renderer.device.destroy(); await renderer.device.lost; }
          if (kind === 'cancel') abort.abort(new DOMException('Surface cancelled', 'AbortError'));
          if (kind === 'color-readback' || kind === 'visibility-readback') scene.masks(new Uint8Array(scene.count).fill(2).buffer);
          if (kind.startsWith('opacity')) renderer.setOpacityPreview(2, false);
          release();
        }
        await result;
        return { accepted, before, after: ledger.usage, peakAtGate, resizeDenied, allocations, destroyed,
          message: failure instanceof Error ? failure.message : String(failure),
          stale: failure instanceof StaleGpuQueryError, overflow: failure instanceof SurfaceCapacityError,
          required: failure instanceof SurfaceCapacityError ? failure.required : null,
          admittedCapacity: failure instanceof SurfaceCapacityError ? failure.capacity : null,
          aborted: failure instanceof DOMException && failure.name === 'AbortError', errors };
      } finally {
        release?.(); GPUBuffer.prototype.mapAsync = originalMap; renderer.device.createBuffer = originalCreate;
        await scene.dispose();
      }
    },
    async retainedStale(channels = false) {
      const scene = await fixture({ layers: [{ z: 0, opacity: .8 }] }), ledger = new ResourceLedger(128 * MiB);
      let map: SurfaceMap | undefined;
      try {
        map = await compositedSurface(renderer, scene, { admit: bytes => ledger.reserve('work', bytes), colors: channels, visible: channels });
        const retained = ledger.usage; map.assertCurrent(); scene.masks(new Uint8Array([2]).buffer);
        let rejected = false; try { map.assertCurrent(); } catch (error) { rejected = error instanceof StaleGpuQueryError; }
        map.dispose(); return { rejected, retained, expected: map.width * map.height * (channels ? 20 : 8) + (channels ? 4 : 0), released: ledger.usage, errors };
      } finally { map?.dispose(); await scene.dispose(); }
    },
    async selectedReuse(channels: boolean, selectedGeometry: boolean) {
      const geometry = [...IDENTITY_MATRIX]; if (selectedGeometry) geometry[12] = .1;
      const scene = await fixture({ layers: [{ z: 0, opacity: .8 }, { z: .1, opacity: .7 }], geometry, selectedOnly: true });
      const ledger = new ResourceLedger(128 * MiB), original = GPUBuffer.prototype.mapAsync;
      let entered!: () => void, release!: () => void, map: SurfaceMap | undefined;
      const pending = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
      GPUBuffer.prototype.mapAsync = function(mode, offset, size) {
        const work = original.call(this, mode, offset, size);
        return this.label === 'Surface capacity readback' ? work.then(async () => { entered(); await gate; return undefined; }) : work;
      };
      try {
        let failure: unknown;
        const work = compositedSurface(renderer, scene, { colors: channels, visible: channels, admit: bytes => ledger.reserve('work', bytes) })
          .then(value => { map = value; }, error => { failure = error; });
        await pending;
        scene.masks(new Uint8Array([1, 0]).buffer);
        const grade = [...NEUTRAL_COLOR]; grade[0] = 1.7; grade[5] = -.4;
        renderer.render(scene, camera, grade, true, geometry, true);
        release(); await work;
        let retainedValid = false;
        if (map) {
          map.assertCurrent();
          scene.masks(new Uint8Array([1, 1]).buffer);
          renderer.render(scene, camera, grade, false, geometry, true);
          map.assertCurrent(); retainedValid = true;
        }
        const retained = ledger.usage; map?.dispose();
        return { accepted: !!map, retainedValid, stale: failure instanceof StaleGpuQueryError, retained, released: ledger.usage, errors };
      } finally { release?.(); GPUBuffer.prototype.mapAsync = original; map?.dispose(); await scene.dispose(); }
    },
    async visibilityEdges() {
      // Direct production shader stage fixture: only one chosen pixel is
      // background; every other pixel occludes the candidate. Exact edges
      // therefore determine its bit, independently of surface composition.
      const width = 65, height = 49, allocations: GPUBuffer[] = [];
      const create = (bytes: ArrayBuffer | Uint32Array | Float32Array) => {
        const buffer = renderer.device.createBuffer({ size: bytes.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
        allocations.push(buffer); renderer.device.queue.writeBuffer(buffer, 0, bytes); return buffer;
      };
      const module = renderer.device.createShaderModule({ code: frameSource + surfaceSource });
      const pipeline = await renderer.device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'markVisible' } });
      const params = create(new Uint32Array([width, height, width, height, 5, 4, 1, 1, 2, 1, 0, 0]));
      const projected = create(new Float32Array([0, 0, 3, 1, 3, 0, 0, 3, .5, .5, .5, 1]));
      const auxiliary = create(new Float32Array(4));
      const bits = create(new Uint32Array(1));
      const surface = create(new Float32Array(width * height * 2));
      const readback = renderer.device.createBuffer({ size: 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      allocations.push(readback);
      const group = renderer.bind(pipeline, [[0, params], [1, projected], [6, surface], [10, auxiliary], [11, bits]]);
      const results: Record<string, number> = {};
      try {
        for (const [name, x, y] of [['left', 29, 24], ['right', 35, 24], ['top', 32, 21], ['bottom', 32, 27], ['inside', 32, 24]] as const) {
          const map = new Float32Array(width * height * 2);
          for (let i = 0; i < width * height; i++) { map[i * 2] = 1; map[i * 2 + 1] = 1; }
          map[(y * width + x) * 2] = 0; map[(y * width + x) * 2 + 1] = 0;
          renderer.device.queue.writeBuffer(surface, 0, map); renderer.device.queue.writeBuffer(bits, 0, new Uint32Array(1));
          const encoder = renderer.device.createCommandEncoder(), pass = encoder.beginComputePass();
          pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(1); pass.end();
          encoder.copyBufferToBuffer(bits, 0, readback, 0, 4); renderer.device.queue.submit([encoder.finish()]);
          await readback.mapAsync(GPUMapMode.READ); results[name] = new Uint32Array(readback.getMappedRange())[0]; readback.unmap();
        }
        return { results, errors };
      } finally { await renderer.device.queue.onSubmittedWorkDone(); for (const buffer of allocations) buffer.destroy(); }
    },
  };
}
export type SurfaceHarness = Awaited<ReturnType<typeof createHarness>>;
declare global { interface Window { surfaceHarness: SurfaceHarness; surfaceHarnessError?: string } }
try { window.surfaceHarness = await createHarness(); }
catch (error) { window.surfaceHarnessError = error instanceof Error ? error.message : String(error); }
