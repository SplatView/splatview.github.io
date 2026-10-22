import { AdmissionError, checkedBytes, type ResourceLease } from '../../document/resources';
import { GaussianRenderer, type GpuScene } from './renderer';
import { planSurfaceBuffers } from './surfaceBuffers';
import { planSurfaceTiles } from './surfaceLayout';
import { prepareSurfacePipelines } from './surfacePipelines';
import type { SurfaceScratch } from './surfaceScratchPool';
import { encodeSurfaceParameters, resolveSurfaceRegion, surfaceChannelFlags, surfaceDimensions, SurfaceCapacityError,
  SURFACE_PARAMETERS_BYTES, type SurfaceMap, type SurfaceOptions, type SurfaceProfile } from './surfaceQuery';
function capacity(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > 65_536 || (value & (value - 1)))
    throw new AdmissionError('Surface tile capacity must be a power of two between 1 and 65536.');
  return value;
}

/**
 * Bounded FP32 surface map of the most recently prepared renderer frame.
 * Uses compute storage rather than float blend targets, and needs no optional
 * WebGPU features. Count once, admit compact per-tile spans, then fill once;
 * never publish a partial candidate list. Call render before requesting a map.
 */
export async function compositedSurface(renderer: GaussianRenderer, scene: GpuScene, options: SurfaceOptions): Promise<SurfaceMap> {
  const startedAt = performance.now();
  const profile: SurfaceProfile = { pipelineMs: 0, countMs: 0, planMs: 0, allocationMs: 0,
    compositeReadbackMs: 0, copyMs: 0, retireMs: 0, totalMs: 0, readbackBytes: 0, reusedBuffers: 0, createdBuffers: 0 };
  const checkSnapshot = renderer.surfaceSnapshot(scene);
  const check = () => { options.signal?.throwIfAborted(); checkSnapshot(); };
  const fullWidth = renderer.canvas.width, fullHeight = renderer.canvas.height;
  if (fullWidth > renderer.device.limits.maxTextureDimension2D || fullHeight > renderer.device.limits.maxTextureDimension2D)
    throw new AdmissionError('The surface viewport exceeds the graphics device texture limit.');
  const { width, height, scale } = surfaceDimensions(fullWidth, fullHeight);
  const region = resolveSurfaceRegion(options, width, height);
  const downsampled = width !== fullWidth || height !== fullHeight;
  const channelFlags = surfaceChannelFlags(options, downsampled);
  const { pixels, tilesX, tilesY, countBytes, layoutBytes, outputBytes, readbackBytes,
    auxiliaryBytes, projectionBytes, colorBytes, visibilityBytes, hostScratchBytes, physicalScratchBytes, retainedCpuBytes } =
    planSurfaceBuffers({ width, height, sourceCount: scene.count, downsampled, colors: options.colors, visible: options.visible, region });
  profile.readbackBytes = readbackBytes;
  const dispatchWidth = Math.min(scene.count, renderer.device.limits.maxComputeWorkgroupsPerDimension);
  const dispatchHeight = Math.ceil(scene.count / dispatchWidth);
  if (dispatchHeight > renderer.device.limits.maxComputeWorkgroupsPerDimension || checkedBytes(fullWidth, fullHeight) > 0xffffffff)
    throw new AdmissionError('The full-resolution visibility query exceeds the graphics device dispatch limit.');
  const initial = options.initialTileCapacity === undefined ? undefined : capacity(options.initialTileCapacity);
  const maximum = options.maxTileCapacity === undefined ? undefined : capacity(options.maxTileCapacity);
  if (initial !== undefined && maximum !== undefined && initial > maximum)
    throw new AdmissionError('Initial surface tile capacity exceeds its explicit query limit.');
  const maximumBufferBytes = Math.min(renderer.device.limits.maxBufferSize, renderer.device.limits.maxStorageBufferBindingSize);
  for (const bytes of [countBytes, layoutBytes, outputBytes, auxiliaryBytes, projectionBytes, colorBytes, visibilityBytes])
    if (bytes > maximumBufferBytes) throw new AdmissionError('The surface map exceeds the graphics device buffer limit.');
  const pooled = options.reuseBuffers === true;
  // Pooled physical buffers each hold their own lease. Only host views/plans
  // and queued uploads belong to their aggregate scratch reservation. Fresh
  // queries admit both; candidate credit still grows only after counting.
  const scratchBytes = pooled ? hostScratchBytes : checkedBytes(hostScratchBytes + physicalScratchBytes, 1);
  let lease: ResourceLease;
  try { lease = options.admit(checkedBytes(retainedCpuBytes + scratchBytes, 1)); }
  catch (error) {
    if (!pooled || !(error instanceof AdmissionError)) throw error;
    renderer.trimSurfaceResources();
    lease = options.admit(checkedBytes(retainedCpuBytes + scratchBytes, 1));
  }
  const buffers: GPUBuffer[] = [];
  const pooledBuffers = new Map<GPUBuffer, SurfaceScratch>();
  const reused = new Set<GPUBuffer>();
  const create = (label: string, size: number, usage: GPUBufferUsageFlags) => {
    if (pooled) {
      const scratch = renderer.surfaceScratch.acquire(options.poolOwner ?? scene, label, size,
        usage | (usage & GPUBufferUsage.STORAGE ? GPUBufferUsage.COPY_DST : 0), options.admit);
      buffers.push(scratch.buffer); pooledBuffers.set(scratch.buffer, scratch);
      if (scratch.reused) { reused.add(scratch.buffer); profile.reusedBuffers++; }
      else profile.createdBuffers++;
      return scratch.buffer;
    }
    const buffer = renderer.device.createBuffer({ label, size, usage }); buffers.push(buffer); return buffer;
  };
  let submitted = false, published = false, retainScratch = false;
  const retire = async () => {
    if (submitted) try { await renderer.device.queue.onSubmittedWorkDone(); } catch { /* Device loss retires queued work. */ }
    submitted = false;
    for (const buffer of buffers) {
      const scratch = pooledBuffers.get(buffer);
      if (scratch) scratch.release(retainScratch); else buffer.destroy();
    }
    buffers.length = 0; pooledBuffers.clear();
  };
  try {
    check(); let stageAt = performance.now();
    const p = await prepareSurfacePipelines(renderer, { visible: options.visible }); check();
    profile.pipelineMs = performance.now() - stageAt; stageAt = performance.now();
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC;
    const countStage = await renderer.checkedAllocation(() => {
      const params = create('Surface dimensions and capacity', SURFACE_PARAMETERS_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      const counts = create('Surface tile counts', countBytes, storage | GPUBufferUsage.COPY_DST);
      const statRead = create('Surface capacity readback', countBytes, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
      const auxiliary = create('Surface raw color and covariance margin', auxiliaryBytes, storage);
      const mapProjection = projectionBytes ? create('Surface native bounded-map projection', projectionBytes, storage) : undefined;
      const projected = downsampled ? mapProjection! : scene.buffers.projected;
      // A failed bind/allocation after writeBuffer must still retire the upload.
      submitted = true;
      const dimensions = encodeSurfaceParameters({ fullWidth, fullHeight, width, height,
        sourceCount: scene.count, channelFlags, dispatchWidth, scale, region });
      renderer.device.queue.writeBuffer(params, 0, dimensions);
      return { params, counts, statRead, auxiliary, projected,
        bin: renderer.bind(p.bin, [[0, params], [1, projected], [2, scene.ordered], [3, counts]]),
        prepare: channelFlags ? renderer.bind(p.prepareAuxiliary, [[0, params], [7, renderer.frame], [8, scene.buffers.splats],
          [9, scene.buffers.states], [10, auxiliary], [13, mapProjection!], [14, scene.previewMask('transformBase')],
          [15, scene.previewMask('opacityBase')]]) : undefined };
    }, retire);
    check();
    await renderer.checkedAllocation(() => {
      const encoder = renderer.device.createCommandEncoder({ label: 'Surface compact candidate counting' });
      if (reused.has(countStage.counts)) encoder.clearBuffer(countStage.counts);
      const pass = encoder.beginComputePass();
      if (countStage.prepare) {
        pass.setPipeline(p.prepareAuxiliary); pass.setBindGroup(0, countStage.prepare); pass.dispatchWorkgroups(Math.ceil(scene.count / 256));
      }
      pass.setPipeline(p.bin); pass.setBindGroup(0, countStage.bin);
      pass.dispatchWorkgroups(Math.ceil(scene.count / 256)); pass.end();
      encoder.copyBufferToBuffer(countStage.counts, 0, countStage.statRead, 0, countBytes);
      renderer.device.queue.submit([encoder.finish()]); submitted = true;
    }, () => undefined);
    check();
    await countStage.statRead.mapAsync(GPUMapMode.READ); check();
    profile.countMs = performance.now() - stageAt; stageAt = performance.now();
    const tileCounts = new Uint32Array(countStage.statRead.getMappedRange());
    if (maximum !== undefined) {
      let required = 0;
      for (const count of tileCounts) required = Math.max(required, count);
      if (required > maximum) throw new SurfaceCapacityError(required, maximum);
    }
    const plan = planSurfaceTiles(tileCounts, maximumBufferBytes);
    countStage.statRead.unmap();
    await renderer.device.queue.onSubmittedWorkDone(); submitted = false; check();
    profile.planMs = performance.now() - stageAt; stageAt = performance.now();
    if (!pooled) lease.resize(checkedBytes(retainedCpuBytes + scratchBytes + plan.candidateBytes, 1));
    const mapStage = await renderer.checkedAllocation(() => {
      const candidates = create('Surface tile global ranks', plan.candidateBytes, storage);
      const spans = create('Surface compact tile spans', layoutBytes, storage | GPUBufferUsage.COPY_DST);
      const output = create('Surface FP32 depth and opacity', outputBytes, storage);
      const mapRead = create('Surface depth and opacity readback', readbackBytes, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
      const colorOutput = create('Surface raw RGB', colorBytes, storage);
      const colorRead = options.colors ? create('Surface raw RGB readback', colorBytes, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ) : undefined;
      const bits = options.visible ? create('Surface full-frame visibility bits', visibilityBytes, storage) : undefined;
      const bitRead = options.visible ? create('Surface visibility readback', visibilityBytes, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ) : undefined;
      submitted = true;
      renderer.device.queue.writeBuffer(spans, 0, plan.spans);
      return { output, mapRead, colorOutput, colorRead, bits, bitRead, candidates,
        scatter: renderer.bind(p.scatter, [[0, countStage.params], [1, countStage.projected], [2, scene.ordered],
          [3, countStage.counts], [4, candidates], [5, spans]]),
        sort: renderer.bind(p.sortTile, [[0, countStage.params], [4, candidates], [5, spans]]),
        composite: renderer.bind(p.composite, [[0, countStage.params], [1, countStage.projected], [2, scene.ordered],
          [3, countStage.counts], [4, candidates], [5, spans], [6, output], [10, countStage.auxiliary], [12, colorOutput]]),
        visibility: bits ? renderer.bind(p.markVisible!, [[0, countStage.params], [1, scene.buffers.projected],
          [6, output], [10, countStage.auxiliary], [11, bits]]) : undefined };
    }, retire);
    check();
    profile.allocationMs = performance.now() - stageAt; stageAt = performance.now();
    await renderer.checkedAllocation(() => {
      const encoder = renderer.device.createCommandEncoder({ label: 'FP32 native compact composited surface' });
      // The immutable count plan was captured above. Reuse counts as scatter
      // cursors; count and scatter share exactly the same footprint function.
      encoder.clearBuffer(countStage.counts);
      if (reused.has(mapStage.candidates)) encoder.clearBuffer(mapStage.candidates);
      if (region && reused.has(mapStage.output)) encoder.clearBuffer(mapStage.output);
      if (mapStage.bits && reused.has(mapStage.bits)) encoder.clearBuffer(mapStage.bits);
      const scatter = encoder.beginComputePass(); scatter.setPipeline(p.scatter); scatter.setBindGroup(0, mapStage.scatter);
      scatter.dispatchWorkgroups(Math.ceil(scene.count / 256)); scatter.end();
      const sort = encoder.beginComputePass(); sort.setPipeline(p.sortTile); sort.setBindGroup(0, mapStage.sort);
      sort.dispatchWorkgroups(tilesX, tilesY); sort.end();
      const composite = encoder.beginComputePass(); composite.setPipeline(p.composite); composite.setBindGroup(0, mapStage.composite);
      composite.dispatchWorkgroups(tilesX, tilesY); composite.end();
      if (mapStage.visibility) {
        const visibility = encoder.beginComputePass({ label: 'Full framebuffer contributing-layer visibility' });
        visibility.setPipeline(p.markVisible!); visibility.setBindGroup(0, mapStage.visibility);
        visibility.dispatchWorkgroups(dispatchWidth, dispatchHeight); visibility.end();
      }
      if (!region) encoder.copyBufferToBuffer(mapStage.output, 0, mapStage.mapRead, 0, outputBytes);
      else if (region.width && region.height) {
        if (region.width === width) encoder.copyBufferToBuffer(mapStage.output, region.y * width * 8, mapStage.mapRead, 0, readbackBytes);
        else for (let row = 0; row < region.height; row++) encoder.copyBufferToBuffer(mapStage.output,
          ((region.y + row) * width + region.x) * 8, mapStage.mapRead, row * region.width * 8, region.width * 8);
      }
      if (mapStage.colorRead) encoder.copyBufferToBuffer(mapStage.colorOutput, 0, mapStage.colorRead, 0, colorBytes);
      if (mapStage.bitRead) encoder.copyBufferToBuffer(mapStage.bits!, 0, mapStage.bitRead, 0, visibilityBytes);
      renderer.device.queue.submit([encoder.finish()]); submitted = true;
    }, () => undefined);
    check();
    await Promise.all([mapStage.mapRead, mapStage.colorRead, mapStage.bitRead].filter((buffer): buffer is GPUBuffer => Boolean(buffer))
      .map(buffer => buffer.mapAsync(GPUMapMode.READ))); check();
    profile.compositeReadbackMs = performance.now() - stageAt; stageAt = performance.now();
    const source = new Float32Array(mapStage.mapRead.getMappedRange());
    const depths = new Float32Array(pixels), opacities = new Float32Array(pixels);
    if (!region) for (let i = 0; i < pixels; i++) { depths[i] = source[i * 2]; opacities[i] = source[i * 2 + 1]; }
    else for (let row = 0; row < region.height; row++) for (let column = 0; column < region.width; column++) {
      const input = (row * region.width + column) * 2, output = (region.y + row) * width + region.x + column;
      depths[output] = source[input]; opacities[output] = source[input + 1];
    }
    mapStage.mapRead.unmap();
    let colors: Float32Array | undefined, visible: Uint32Array | undefined;
    if (mapStage.colorRead) {
      const rgba = new Float32Array(mapStage.colorRead.getMappedRange()); colors = new Float32Array(pixels * 3);
      for (let i = 0; i < pixels; i++) {
        colors[i * 3] = rgba[i * 4]; colors[i * 3 + 1] = rgba[i * 4 + 1]; colors[i * 3 + 2] = rgba[i * 4 + 2];
      }
      mapStage.colorRead.unmap();
    }
    if (mapStage.bitRead) { visible = new Uint32Array(mapStage.bitRead.getMappedRange()).slice(); mapStage.bitRead.unmap(); }
    profile.copyMs = performance.now() - stageAt; stageAt = performance.now();
    retainScratch = true;
    await retire(); check();
    profile.retireMs = performance.now() - stageAt; profile.totalMs = performance.now() - startedAt;
    lease.resize(retainedCpuBytes); let disposed = false; published = true;
    return { width, height, fullWidth, fullHeight, depths, opacities, colors, visible, region, profile, deviceEpoch: renderer.deviceEpoch,
      attempts: 1, tileCapacity: plan.tileCapacity, allocationBytes: retainedCpuBytes, candidateBytes: plan.candidateBytes,
      candidateEntries: plan.candidateEntries, tileCount: plan.tileCount, occupiedTiles: plan.occupiedTiles, sortComparisons: plan.sortComparisons,
      assertCurrent: () => { if (disposed) throw new Error('The surface map was released.'); check(); },
      dispose: () => { if (!disposed) { disposed = true; lease(); } } };
  } finally {
    if (submitted || buffers.length) await retire();
    if (!published) {
      // A view/cancellation change can arrive during the final retirement
      // fence, after valid buffers were returned. Failed queries retain none
      // of their owner's idle credit; busy buffers retire under their caller.
      if (pooled) renderer.trimSurfaceResources(options.poolOwner ?? scene);
      lease();
    }
  }
}
