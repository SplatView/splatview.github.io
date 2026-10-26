import type { ImageOperation } from '../../io/image';
import { captureDepthOrderKey,depthOrderMatches,type DepthOrderKey } from '../orderKey';
import { captureCompactOrderKey, compactOrderMatches, type CompactOrderKey } from '../compactOrderKey';
import { validateSortPrecision, type SortPrecision } from '../sortPrecision';
import { allocateFastOrder, type FastOrder } from './fastOrder';
import frameSource from './frame.wgsl?raw';
import splatSource from './splats.wgsl?raw';
import sortSource from './sort.wgsl?raw';
import scanSource from './scan.wgsl?raw';
import geometrySource from './geometry.wgsl?raw';
import { GpuGeometryScene } from './geometry';
import { HistogramSampler } from './histogram';
import type { RenderedHistogram } from '../histogram';
import type { GeometryDescriptor } from '../geometryLayout';
import { IDENTITY_MATRIX, NEUTRAL_COLOR } from '../defaults';
import { checkedBytes, MiB, packedStride } from '../../document/resources';
import { encodeRgba, ownRgbaImage, rgbaImageBytes, type OwnedRgbaImage } from '../../io/image';

import { RendererNegotiation, type RendererNegotiationObserver, type RendererNegotiationSnapshot } from './diagnostics';
import { sameDuplicateRange, validateDuplicateRange, type DuplicateRange } from '../../document/duplicateProtocol';
import { forgetSurfacePipelines } from './surfacePipelines';
import { SurfaceScratchPool } from './surfaceScratchPool';
import { SteadySplats } from './steady';
import { supportsSteadyProjection } from '../steadyState';
import type { SteadySettings, SteadyStatus } from '../steadySettings';
import { nextRendererEpoch,recordCanvasBackend } from '../backend';
import { StaleRenderQueryError, type SceneRenderer, type RenderScene, type GaussianScene } from '../contracts';
import { allocatePickCandidates,preparePickCandidates } from './pickCandidates';
import { compositedSurface } from './surface';
import { prepareSurfacePipelines } from './surfacePipelines';
import type { SurfaceOptions } from './surfaceQuery';

import { encodeGaussianFrame, type RenderCamera } from '../frame';
import { backgroundShade } from '../../input/background';

type Pipelines = Record<'project' | 'generate' | 'rank' | 'scatter' | 'local' | 'blocks' | 'bins' | 'pick', GPUComputePipeline>;
type Buffers = Record<'splats' | 'states' | 'projected' | 'pairsA' | 'pairsB' | 'ranks' | 'counts' |
  'groupOffsets' | 'groupSums' | 'blockOffsets' | 'binTotals' | 'binOffsets', GPUBuffer>;
type SortStage = { pipeline: GPUComputePipeline; group: GPUBindGroup; x: number; y?: number };
export type PreviewMaskChannel = 'colorBase' | 'transformBase' | 'opacityBase';
export type PreviewMasks = Partial<Record<PreviewMaskChannel, ArrayBuffer | null>>;
export type GpuMaskUpdate = { allocationBytes: number; retirementBytes?: number; retirementBuffers?: GPUBuffer[];
  publish(): GPUBuffer; dispose(): void | Promise<void> };
export type GpuPreviewMaskUpdate = { allocationBytes: number; retirementBytes: number; retirementBuffers: GPUBuffer[];
  publish(): GPUBuffer | undefined; dispose(): void | Promise<void> };
const previewMaskChannels: readonly PreviewMaskChannel[] = ['colorBase', 'transformBase', 'opacityBase'];
export type GpuPick = { index: number | null; depth: number; opacity: number; contribution: number; deviceEpoch: number };
export class StaleGpuQueryError extends StaleRenderQueryError {}
const canvasOwners = new WeakMap<HTMLCanvasElement, GaussianRenderer>();
export { GpuGeometryScene } from './geometry';
export type RenderableScene = GpuScene | GpuGeometryScene;
type GeometryDepth = { texture: GPUTexture; width: number; height: number; bytes: number;
  release?: () => void; retirement?: Promise<void> };

export class GpuScene {
  readonly kind = 'gaussian' as const;
  readonly stride: number;
  readonly buffers: Buffers;
  readonly params: GPUBuffer[] = [];
  readonly sortStages: SortStage[] = [];
  projectGroup: GPUBindGroup;
  readonly drawGroup: GPUBindGroup;
  readonly pickGroup: GPUBindGroup;
  readonly ordered: GPUBuffer;
  lastCameraRevision = -1;
  residentOrder?: DepthOrderKey;
  residentSortPrecision:SortPrecision=32;
  residentCompactOrder?:CompactOrderKey;
  fastOrder?:FastOrder;
  residentProjection?: {revision:number;words:Uint32Array};
  sortDirty = true;
  lastGeometry = '';
  private uploadBytes = 0;
  retired = false;
  revision = 0;
  // Raw surface queries depend on source attributes and deletion, and on the
  // selected mask while a selected geometry or opacity preview changes its surface.
  sourceRevision = 0;
  selectedRevision = 0;
  private stateBytes: Uint8Array;
  private duplicateRange: DuplicateRange = null;
  private duplicateSelected = false;
  get duplicateSelectionGuarded() { return this.duplicateSelected; }
  /** Metadata comes from the acknowledged native owner, never a GPU revision.
   * Recompute only when the marker changes; normal mask publication already
   * scans membership and keeps this result current without per-frame work. */
  setDuplicateRange(value: DuplicateRange) {
    const range = validateDuplicateRange(value, this.count);
    if (sameDuplicateRange(this.duplicateRange, range)) return;
    this.duplicateRange = range;
    this.duplicateSelected = this.exactDuplicateSelection(this.stateBytes);
  }
  private exactDuplicateSelection(states: Uint8Array): boolean {
    const range = this.duplicateRange;
    if (!range) return false;
    let selected = 0, copies = 0;
    for (let index = 0; index < states.length; index++) if (states[index] === 1) {
      selected++; if (index >= range.first) copies++;
    }
    return selected === range.count && copies === range.count;
  }
  private readonly previewBuffers: Partial<Record<PreviewMaskChannel, GPUBuffer>> = {};
  private readonly previewRevisions: Record<PreviewMaskChannel, number> = { colorBase: 0, transformBase: 0, opacityBase: 0 };
  private maskBindingRevision = 0;
  get deviceEpoch() { return this.renderer.deviceEpoch; }
  constructor(readonly renderer: GaussianRenderer, readonly count: number, readonly degree: number) {
    this.stride = packedStride(degree);
    const size = checkedBytes(count, this.stride);
    if (!count || count > 3_000_000) throw new Error('This scene exceeds the current loaded-splat limit.');
    if (size > renderer.device.limits.maxStorageBufferBindingSize || size > renderer.device.limits.maxBufferSize)
      throw new Error('This scene exceeds the graphics device limit. Load fewer splats.');
    const device = renderer.device;
    const allocations: GPUBuffer[] = [];
    this.stateBytes = new Uint8Array(count);
    const storage = (label: string, bytes: number) => {
      const buffer = device.createBuffer({ label, size: Math.max(4, bytes),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
      allocations.push(buffer); return buffer;
    };
    const groups = Math.ceil(count / 256), blocks = Math.ceil(groups / 256);
    try {
    this.buffers = {
      splats: storage('Packed native covariance and SH', size), states: storage('Source ID states', count * 4),
      projected: storage('Projected Gaussians', count * 48), pairsA: storage('Radix A', count * 8),
      pairsB: storage('Radix B', count * 8), ranks: storage('Local radix rank', count * 4),
      counts: storage('Radix group counts', groups * 16 * 4), groupOffsets: storage('Group offsets', groups * 16 * 4),
      groupSums: storage('Group sums', blocks * 16 * 4), blockOffsets: storage('Block offsets', blocks * 16 * 4),
      binTotals: storage('Bin totals', 16 * 4), binOffsets: storage('Bin offsets', 16 * 4),
    };
    const b = this.buffers, p = renderer.pipelines;
    for (let digit = 0; digit < 32; digit += 4) {
      const params = device.createBuffer({ label: `Radix ${digit}`, size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(params, 0, new Uint32Array([count, groups, blocks, digit])); this.params.push(params);
    }
    const bind = (pipeline: GPUComputePipeline | GPURenderPipeline, entries: [number, GPUBuffer][]) => renderer.bind(pipeline, entries);
    this.sortStages.push({ pipeline: p.generate, group: bind(p.generate, [[0, this.params[0]], [3, b.pairsA], [8, b.splats], [9, b.states], [10, renderer.frame], [11, b.states]]), x: groups });
    let input = b.pairsA, output = b.pairsB;
    for (const params of this.params) {
      this.sortStages.push(
        { pipeline: p.rank, group: bind(p.rank, [[0, params], [1, input], [2, b.ranks], [4, b.counts]]), x: groups },
        { pipeline: p.local, group: bind(p.local, [[0, params], [1, b.counts], [2, b.groupOffsets], [3, b.groupSums]]), x: blocks, y: 16 },
        { pipeline: p.blocks, group: bind(p.blocks, [[0, params], [1, b.groupSums], [2, b.blockOffsets], [3, b.binTotals]]), x: 16 },
        { pipeline: p.bins, group: bind(p.bins, [[1, b.binTotals], [2, b.binOffsets]]), x: 1 },
        { pipeline: p.scatter, group: bind(p.scatter, [[0, params], [1, input], [2, b.ranks], [3, output],
          [5, b.groupOffsets], [6, b.blockOffsets], [7, b.binOffsets]]), x: groups },
      );
      [input, output] = [output, input];
    }
    this.ordered = input;
    this.projectGroup = bind(p.project, [[0, renderer.frame], [1, b.splats], [2, b.states], [3, b.projected],
      [8, b.states], [9, b.states], [10, b.states]]);
    this.drawGroup = bind(renderer.raster, [[0, renderer.frame], [4, input], [7, b.projected]]);
    this.pickGroup = bind(p.pick, [[0, renderer.frame], [4, input], [5, renderer.query], [6, renderer.queryOutput], [7, b.projected]]);
    } catch (error) {
      for (const buffer of allocations) buffer.destroy();
      for (const buffer of this.params) buffer.destroy();
      throw error;
    }
  }
  // Base mirror coverage excludes optional storage with its own admission.
  get allocationBytes() { return this.stateBytes.byteLength + [...Object.values(this.buffers), ...this.params,
    ...Object.values(this.previewBuffers)].reduce((total, buffer) => total + buffer.size, 0); }
  previewMask(channel: PreviewMaskChannel): GPUBuffer { return this.previewBuffers[channel] ?? this.buffers.states; }
  hasPreviewMask(channel: PreviewMaskChannel) { return this.previewBuffers[channel] !== undefined; }
  previewMaskRevision(channel: PreviewMaskChannel): number { return this.previewRevisions[channel]; }
  async upload(first: number, count: number, bytes: ArrayBuffer) {
    if (bytes.byteLength !== count * this.stride || first + count > this.count) throw new Error('Invalid scene upload.');
    this.revision++; this.sourceRevision++; this.sortDirty = true;
    this.renderer.device.queue.writeBuffer(this.buffers.splats, first * this.stride, bytes);
    this.uploadBytes += bytes.byteLength;
    if (this.uploadBytes >= 16 * MiB) { await this.renderer.device.queue.onSubmittedWorkDone(); this.uploadBytes = 0; }
    this.sortDirty = true;
  }
  masks(bytes: ArrayBuffer) {
    const source = this.maskBytes(bytes), expanded = Uint32Array.from(source);
    this.publishStateRevision(source);
    this.maskBindingRevision++; this.revision++;
    this.renderer.device.queue.writeBuffer(this.buffers.states, 0, expanded); this.sortDirty = true;
  }
  private maskBytes(bytes: ArrayBuffer, retain = true): Uint8Array<ArrayBuffer> {
    if (bytes.byteLength !== this.count) throw new Error('Invalid scene state mask.');
    const source = new Uint8Array(bytes);
    if (source.some(state => state > 3)) throw new Error('Invalid scene state mask.');
    return retain ? source.slice() : source;
  }
  private publishStateRevision(source: Uint8Array) {
    let membershipChanged = false, selectionChanged = false;
    let selected = 0, copies = 0;
    for (let i = 0; i < source.length; i++) {
      const changed = source[i] ^ this.stateBytes[i];
      membershipChanged ||= !!(changed & 2); selectionChanged ||= !!(changed & 1);
      if (this.duplicateRange && source[i] === 1) { selected++; if (i >= this.duplicateRange.first) copies++; }
    }
    if (membershipChanged) this.sourceRevision++;
    if (selectionChanged) this.selectedRevision++;
    this.stateBytes = source;
    this.duplicateSelected = !!this.duplicateRange && selected === this.duplicateRange.count && copies === this.duplicateRange.count;
  }
  async stageMasks(bytes: ArrayBuffer, targets: PreviewMasks = {}): Promise<GpuMaskUpdate> {
    return this.stageStateBindings(bytes, targets) as Promise<GpuMaskUpdate>;
  }
  async stagePreviewMasks(bytes: ArrayBuffer | null, channel: PreviewMaskChannel): Promise<GpuPreviewMaskUpdate> {
    if (!previewMaskChannels.includes(channel)) throw new Error('Invalid preview mask channel.');
    return this.stageStateBindings(undefined, { [channel]: bytes });
  }
  /** All groups are built from one candidate so clipping and preview eligibility publish together. */
  private async stageStateBindings(bytes: ArrayBuffer | undefined, targets: PreviewMasks): Promise<GpuPreviewMaskUpdate> {
    if (this.retired) throw new StaleGpuQueryError('The scene was retired before staging its masks.');
    const source = bytes === undefined ? undefined : this.maskBytes(bytes);
    const channels = Object.keys(targets) as PreviewMaskChannel[];
    if (channels.some(channel => !previewMaskChannels.includes(channel) || targets[channel] === undefined))
      throw new Error('Invalid preview mask channel.');
    // Validate every borrowed payload before creating any buffers. Uploads copy
    // synchronously; target bytes are not retained on the CPU.
    for (const channel of channels) if (targets[channel] !== null) this.maskBytes(targets[channel]!, false);
    const bindingRevision = this.maskBindingRevision;
    const device = this.renderer.device, allocated: GPUBuffer[] = [];
    let published = false, disposed = false, submitted = false, retirement: Promise<void> | undefined;
    const retire = () => {
      if (published) return;
      disposed = true;
      return retirement ??= (async () => {
        // writeBuffer is queued work even without a command-buffer submission.
        // Refusal cannot release its admission before those uploads retire.
        if (submitted) try { await device.queue.onSubmittedWorkDone(); } catch { /* Device loss retires work. */ }
        for (const buffer of allocated) buffer.destroy();
      })();
    };
    try { return await this.renderer.checkedAllocation(() => {
      const b = this.buffers, p = this.renderer.pipelines;
      const upload = (label: string, value: Uint8Array) => {
        const buffer = device.createBuffer({ label, size: this.count * 4,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
        allocated.push(buffer); submitted = true;
        device.queue.writeBuffer(buffer, 0, Uint32Array.from(value)); return buffer;
      };
        const states = source ? upload('Candidate source states', source) : b.states;
        const next = { ...this.previewBuffers };
        const retirementBuffers = source ? [b.states] : [];
        for (const channel of channels) {
          const old = next[channel]; if (old) retirementBuffers.push(old);
          const value = targets[channel];
          if (value === null) delete next[channel];
          else next[channel] = upload(`Candidate ${channel} targets`, this.maskBytes(value!, false));
        }
        const target = (channel: PreviewMaskChannel) => next[channel] ?? states;
        const project = this.renderer.bind(p.project, [[0, this.renderer.frame], [1, b.splats], [2, states], [3, b.projected],
          [8, target('colorBase')], [9, target('transformBase')], [10, target('opacityBase')]]);
        const generate = this.renderer.bind(p.generate, [[0, this.params[0]], [3, b.pairsA], [8, b.splats], [9, states],
          [10, this.renderer.frame], [11, target('transformBase')]]);
        const sortStage = { ...this.sortStages[0], group: generate };
        return { allocationBytes: allocated.reduce((total, buffer) => total + buffer.size, source?.byteLength ?? 0),
          retirementBytes: retirementBuffers.reduce((total, buffer) => total + buffer.size, source ? this.stateBytes.byteLength : 0),
          retirementBuffers,
          publish: () => {
            if (published || disposed || this.retired || bindingRevision !== this.maskBindingRevision)
              throw new StaleGpuQueryError('The scene masks changed before the candidate was published.');
            b.states = states; this.projectGroup = project;
            this.sortStages[0] = sortStage;
            if (source) this.publishStateRevision(source);
            for (const channel of channels) {
              this.previewRevisions[channel]++;
              if (next[channel]) this.previewBuffers[channel] = next[channel];
              else delete this.previewBuffers[channel];
            }
            this.maskBindingRevision++; this.revision++;
            if (source || channels.includes('transformBase')) this.sortDirty = true;
            published = true; return retirementBuffers[0];
          },
          dispose: retire,
        };
    }, update => update.dispose()); }
    catch (error) { await retire(); throw error; }
  }
  async dispose() {
    if (this.retired) return;
    this.retired = true;
    this.renderer.trimSurfaceResources?.();
    try { await this.renderer.finish(); } catch { /* Device already lost. */ }
    this.fastOrder?.dispose(); this.fastOrder=undefined;
    for (const buffer of Object.values(this.buffers)) buffer.destroy();
    for (const buffer of Object.values(this.previewBuffers)) buffer.destroy();
    for (const channel of previewMaskChannels) delete this.previewBuffers[channel];
    for (const buffer of this.params) buffer.destroy();
    this.stateBytes = new Uint8Array(0);
  }
}

export class GaussianRenderer implements SceneRenderer {
  readonly backend = 'webgpu' as const;
  admitSortScratch?: (bytes:number)=>()=>void;
  admitWork?: (bytes: number) => () => void;
  readonly deviceEpoch = nextRendererEpoch();
  readonly surfaceScratch: SurfaceScratchPool;
  readonly frame: GPUBuffer;
  readonly query: GPUBuffer;
  readonly queryOutput: GPUBuffer;
  private readonly quadIndices: GPUBuffer;
  private displayCheckpoint?:import('../contracts').DisplayCompletion;
  private context: GPUCanvasContext;
  private queryQueue: Promise<unknown> = Promise.resolve();
  private readonly scenePreparations = new Set<Promise<GpuScene>>();
  private disposed = false;
  private frameRevision = 0;
  private opacityScale = 1;
  private opacitySelectedOnly = false;
  private opacityRevision = 0;
  private preparedOpacityRevision = 0;
  private preparedScene?: GpuScene;
  private preparedSceneRevision = -1;
  private preparedWidth = 0;
  private preparedHeight = 0;
  private preparedUniform?: Uint32Array;
  private preparedCameraRevision = -1;
  private geometryDepth?: GeometryDepth;
  private readonly geometryDepthAllocations = new Set<GeometryDepth>();
  private readonly retiringGeometryDepth = new Set<GeometryDepth>();
  private readonly geometryScenes = new Set<GpuGeometryScene>();
  private geometryTargetGeneration = 0;
  private geometryTargetPreparation?: { width: number; height: number; task: Promise<void> };
  private readonly geometryTargetTasks = new Set<Promise<void>>();
  private geometryTargetFailure?: { width: number; height: number };
  private readonly histogram: HistogramSampler;
  private readonly steady: SteadySplats;
  private histogramDisplay?: { scene: GpuScene; revision: number; cameraRevision: number; width: number; height: number;
    uniform: Uint32Array; shade: number; steadyFrame?: number; identity: object };
  admitGeometryDepth?: (bytes: number) => () => void;
  admitHistogram?: (bytes: number) => () => void;
  admitSteady?: (bytes: number) => () => void;
  onRenderStatus?: (status: SteadyStatus) => void;
  onHistogram?: (result: RenderedHistogram, scene: RenderScene) => void;
  onHistogramUnavailable?: () => void;
  onFrameNeeded?: () => void;
  frames = 0;
  private submittedDisplayFrames = 0;
  /** Actual render() submissions only; geometry preparation, picks and captures do not advance this identity. */
  get frameSubmissionSequence() { return this.submittedDisplayFrames; }
  get negotiationSnapshot(): RendererNegotiationSnapshot { return this.negotiation.snapshot; }
  lost = false;
  onLost?: (message: string) => void;
  onDeviceLost?: (message: string) => void;
  private constructor(readonly canvas: HTMLCanvasElement, readonly device: GPUDevice,
    readonly format: GPUTextureFormat, readonly pipelines: Pipelines, readonly raster: GPURenderPipeline,
    readonly geometryPoints: GPURenderPipeline, readonly geometryMesh: GPURenderPipeline,
    private readonly negotiation: RendererNegotiation) {
    this.context = canvas.getContext('webgpu')!;
    if (!this.context) throw new Error('The WebGPU presentation context is unavailable.');
    recordCanvasBackend(canvas,'webgpu');
    this.context.configure({ device, format, alphaMode: 'opaque',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.surfaceScratch = new SurfaceScratchPool(device);
    this.histogram = new HistogramSampler(device, this.deviceEpoch, {
      admit: bytes => this.admitHistogram?.(bytes), invalidate: () => this.onFrameNeeded?.(),
      publish: (result, scene) => this.onHistogram?.(result, scene),
      unavailable: () => this.onHistogramUnavailable?.(),
    });
    canvasOwners.set(canvas, this);
    this.frame = device.createBuffer({ size: 320, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.query = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.queryOutput = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    this.quadIndices=device.createBuffer({size:12,usage:GPUBufferUsage.INDEX|GPUBufferUsage.COPY_DST});
    device.queue.writeBuffer(this.quadIndices,0,new Uint16Array([0,1,2,2,1,3]));
    this.steady = new SteadySplats(device, format, this.frame, {
      admit: bytes => this.admitSteady?.(bytes), invalidate: () => this.onFrameNeeded?.(),
      status: status => this.onRenderStatus?.(status),
    });
    void device.lost.then(info => {
      this.lost = true;
      this.steady.dispose();
      this.histogram.dispose();
      forgetSurfacePipelines(this); this.surfaceScratch.dispose();
      if (!this.disposed) (this.onDeviceLost ?? this.onLost)?.(info.message || 'The graphics device was lost. Your edits are retained.');
    });
    device.addEventListener('uncapturederror', event => { if (!this.disposed && !this.lost) this.onLost?.(event.error.message); });
  }
  static async create(canvas: HTMLCanvasElement, observer?: RendererNegotiationObserver) {
    const negotiation = new RendererNegotiation(observer);
    try {
    if (!navigator.gpu) throw new Error('WebGPU is required for editing. Use Safari on macOS Tahoe 26 or later, or a compatible current Chrome.');
    negotiation.advance('adapter-request');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No compatible graphics device is available.');
    negotiation.observeAdapter(adapter);
    const maxBufferSize = Math.min(adapter.limits.maxBufferSize, 512 * MiB);
    const descriptor = { requiredLimits: {
      maxBufferSize, maxStorageBufferBindingSize: Math.min(adapter.limits.maxStorageBufferBindingSize, maxBufferSize),
    } };
    negotiation.observeRequest(descriptor);
    const device = await adapter.requestDevice(descriptor);
    negotiation.observeDevice(device);
    device.pushErrorScope('out-of-memory'); device.pushErrorScope('validation'); device.pushErrorScope('internal');
    let scopesPopped = false, created: GaussianRenderer | undefined;
    try {
    negotiation.advance('shader-compilation');
    const format = navigator.gpu.getPreferredCanvasFormat();
    const modules = {
      splat: device.createShaderModule({ label: 'SplatView native projection and shading', code: frameSource + splatSource }),
      sort: device.createShaderModule({ label: 'SplatView stable radix', code: frameSource + sortSource }),
      scan: device.createShaderModule({ label: 'SplatView radix prefix scans', code: scanSource }),
      geometry: device.createShaderModule({ label: 'SplatView readonly PLY geometry', code: geometrySource }),
    };
    for (const module of Object.values(modules)) {
      const info = await module.getCompilationInfo();
      const errors = info.messages.filter(message => message.type === 'error');
      if (errors.length) throw new Error(errors.map(error => `Shader ${error.lineNum}: ${error.message}`).join('\n'));
    }
    negotiation.advance('pipeline-creation');
    const entries: [keyof Pipelines, GPUShaderModule][] = [
      ['project', modules.splat], ['generate', modules.sort], ['rank', modules.sort], ['scatter', modules.sort],
      ['local', modules.scan], ['blocks', modules.scan], ['bins', modules.scan], ['pick', modules.splat],
    ];
    const pipelineEntries = await Promise.all(entries.map(async ([name, module]) => [name,
      await device.createComputePipelineAsync({ label: name, layout: 'auto', compute: { module, entryPoint: name } })]));
    const raster = await device.createRenderPipelineAsync({ label: 'Native Gaussian composition', layout: 'auto',
      vertex: { module: modules.splat, entryPoint: 'vertex' }, primitive: { topology: 'triangle-list' },
      fragment: { module: modules.splat, entryPoint: 'fragment', targets: [{ format, blend: {
        color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
      } }] } });
    const geometryPipeline = (mesh: boolean) => device.createRenderPipelineAsync({
      label: mesh ? 'Native readonly PLY mesh' : 'Native readonly PLY points', layout: 'auto',
      vertex: { module: modules.geometry, entryPoint: mesh ? 'meshVertex' : 'pointVertex', buffers: [{
        arrayStride: 16, stepMode: mesh ? 'vertex' : 'instance', attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' },
          { shaderLocation: 1, offset: 12, format: 'unorm8x4' },
        ],
      }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
      fragment: { module: modules.geometry, entryPoint: mesh ? 'meshFragment' : 'pointFragment', targets: [{ format }] },
    });
    const [geometryPoints, geometryMesh] = await Promise.all([geometryPipeline(false), geometryPipeline(true)]);
    negotiation.advance('renderer-creation');
    created = new GaussianRenderer(canvas, device, format, Object.fromEntries(pipelineEntries) as Pipelines,
      raster, geometryPoints, geometryMesh, negotiation);
    negotiation.advance('validation');
    const scopes = [device.popErrorScope(), device.popErrorScope(), device.popErrorScope()]; scopesPopped = true;
    const failure = (await Promise.all(scopes)).find(error => error !== null);
    if (failure) throw new Error(failure.message);
    if (created.lost) throw new Error('The graphics device was lost during initialization.');
    negotiation.advance('ready');
    return created;
    } catch (error) {
      negotiation.fail(error);
      if (!scopesPopped) await Promise.allSettled([device.popErrorScope(), device.popErrorScope(), device.popErrorScope()]);
      created?.dispose(); device.destroy(); throw error;
    }
    } catch (error) { negotiation.fail(error); throw error; }
  }
  bind(pipeline: GPUComputePipeline | GPURenderPipeline, entries: [number, GPUBuffer][]) {
    return this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0),
      entries: entries.map(([binding, buffer]) => ({ binding, resource: { buffer } })) });
  }
  setHistogramEnabled(enabled: boolean) { this.histogram.setEnabled(enabled); }
  displayCompletion() { return this.displayCheckpoint; }
  async finish() { await this.queryQueue; await this.device.queue.onSubmittedWorkDone(); }
  surface(scene: GaussianScene, options: SurfaceOptions) {
    this.requireScene(scene); this.surfaceSnapshot(scene);
    // Raw maps retain a complete, exact order. Display compaction has separate
    // pairs, so a same-view display cannot overwrite a map between its stages.
    if(scene.sortDirty || scene.residentSortPrecision<32 || !depthOrderMatches(scene.residentOrder,this.preparedUniform!,scene.sourceRevision)) {
      const encoder=this.device.createCommandEncoder();
      try { this.sort(encoder,scene,this.preparedCameraRevision); this.device.queue.submit([encoder.finish()]); }
      catch(error) { scene.residentOrder=undefined; scene.sortDirty=true; throw error; }
    }
    return compositedSurface(this, scene, options);
  }
  prepareSurfaceResources() { return Promise.all([prepareSurfacePipelines(this),preparePickCandidates(this).catch(()=>undefined)]).then(() => undefined); }
  setRenderSettings(settings: SteadySettings) { this.steady.configure(settings); }
  resetRenderHistory() { this.steady.resetHistory(); this.onFrameNeeded?.(); }
  get steadySnapshot() { return this.steady.snapshot; }
  resetHistogram() { this.histogramDisplay = undefined; this.histogram.reset(); }
  trimSurfaceResources(owner?: object) { this.surfaceScratch.trim(owner); }
  scene(count: number, degree: number) { return new GpuScene(this, count, Math.min(degree, 3)); }
  requireScene(scene?: RenderScene): asserts scene is RenderableScene | undefined {
    if (this.disposed || this.lost) throw new StaleGpuQueryError('The graphics device is unavailable. Your edits are retained.');
    if (scene && (scene.renderer !== this || scene.deviceEpoch !== this.deviceEpoch || scene.retired))
      throw new StaleGpuQueryError('The scene belongs to an obsolete graphics device or allocation.');
  }
  async allocateScene(count: number, degree: number) {
    const preparation=(async()=>{
      const scene=await this.checkedAllocation(() => this.scene(count, degree), scene => scene.dispose());
      try { scene.fastOrder=await allocateFastOrder(this,scene); this.requireScene(scene); return scene; }
      catch(error) { await scene.dispose(); throw error; }
    })();
    this.scenePreparations.add(preparation);
    try { return await preparation; } finally { this.scenePreparations.delete(preparation); }
  }
  async allocateGeometry(descriptor: GeometryDescriptor): Promise<GpuGeometryScene> {
    const scene = await this.checkedAllocation(() => new GpuGeometryScene(this, descriptor), value => value.dispose());
    this.geometryScenes.add(scene);
    try { await this.prepareGeometryTarget(); return scene; }
    catch (error) { await scene.dispose(); throw error; }
  }
  get geometryDepthAllocationBytes() {
    return [...this.geometryDepthAllocations].reduce((sum, depth) => sum + depth.bytes, 0);
  }
  private createGeometryDepth(width: number, height: number): GeometryDepth {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 ||
      width > this.device.limits.maxTextureDimension2D || height > this.device.limits.maxTextureDimension2D)
      throw new Error('The PLY preview target exceeds the graphics device limit.');
    const bytes = checkedBytes(checkedBytes(width, height), 4), release = this.admitGeometryDepth?.(bytes);
    try {
      const depth = { texture: this.device.createTexture({ label: 'Readonly PLY viewport depth', size: [width, height],
        format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT }), width, height, bytes, release };
      this.geometryDepthAllocations.add(depth); return depth;
    } catch (error) { release?.(); throw error; }
  }
  private retireGeometryDepth(depth: GeometryDepth): Promise<void> {
    if (depth.retirement) return depth.retirement;
    this.retiringGeometryDepth.add(depth);
    depth.retirement = (async () => {
      try { await this.device.queue.onSubmittedWorkDone(); } catch { /* Device already lost. */ }
      finally { depth.texture.destroy(); depth.release?.(); this.retiringGeometryDepth.delete(depth); this.geometryDepthAllocations.delete(depth); }
    })();
    return depth.retirement;
  }
  private publishGeometryDepth(depth: GeometryDepth) {
    const previous = this.geometryDepth; this.geometryDepth = depth;
    if (previous) void this.retireGeometryDepth(previous);
  }
  private retainGeometryTarget(width: number, height: number) {
    if (this.geometryTargetPreparation &&
      (this.geometryTargetPreparation.width !== width || this.geometryTargetPreparation.height !== height)) {
      // A rapid A -> B -> A resize keeps the already usable A attachment.
      // In-flight B still owns its reservation until its checked retirement.
      this.geometryTargetGeneration++; this.geometryTargetPreparation = undefined;
    }
    if (this.geometryTargetFailure && (this.geometryTargetFailure.width !== width || this.geometryTargetFailure.height !== height))
      this.geometryTargetFailure = undefined;
  }
  async prepareGeometryTarget(width = this.canvas.width, height = this.canvas.height) {
    this.requireScene();
    if (this.geometryDepth?.width === width && this.geometryDepth.height === height) { this.retainGeometryTarget(width, height); return; }
    if (this.geometryTargetPreparation?.width === width && this.geometryTargetPreparation.height === height)
      return this.geometryTargetPreparation.task;
    const generation = ++this.geometryTargetGeneration; this.geometryTargetFailure = undefined;
    const task = this.checkedAllocation(() => this.createGeometryDepth(width, height), value => this.retireGeometryDepth(value)).then(async depth => {
      if (generation !== this.geometryTargetGeneration || this.lost || this.disposed || !this.geometryScenes.size) {
        await this.retireGeometryDepth(depth); this.requireScene(); return;
      }
      // Another preparation can finish first. Keep exactly one active target.
      if (this.geometryDepth?.width === width && this.geometryDepth.height === height) await this.retireGeometryDepth(depth);
      else this.publishGeometryDepth(depth);
    }).finally(() => {
      this.geometryTargetTasks.delete(task);
      if (this.geometryTargetPreparation?.task === task) this.geometryTargetPreparation = undefined;
    });
    this.geometryTargetTasks.add(task);
    this.geometryTargetPreparation = { width, height, task }; return task;
  }
  private requestGeometryTarget(width: number, height: number) {
    if (this.geometryTargetFailure?.width === width && this.geometryTargetFailure.height === height ||
      this.geometryTargetPreparation?.width === width && this.geometryTargetPreparation.height === height) return;
    void this.prepareGeometryTarget(width, height).then(() => {
      if (!this.disposed && !this.lost && this.canvas.width === width && this.canvas.height === height &&
        this.geometryDepth?.width === width && this.geometryDepth.height === height)
        this.onFrameNeeded?.();
    }).catch(error => {
      if (!this.disposed && !this.lost && this.geometryScenes.size && this.canvas.width === width && this.canvas.height === height) {
        this.geometryTargetFailure = { width, height };
        this.onLost?.(error instanceof Error ? error.message : String(error));
      }
    });
  }
  async releaseGeometryScene(scene: GpuGeometryScene) {
    this.geometryScenes.delete(scene);
    const pending = !this.geometryScenes.size ? [...this.geometryTargetTasks] : [];
    if (!this.geometryScenes.size) { this.geometryTargetGeneration++; this.geometryTargetFailure = undefined; }
    if (!this.geometryScenes.size && this.geometryDepth) {
      const depth = this.geometryDepth; this.geometryDepth = undefined; await this.retireGeometryDepth(depth);
    }
    await Promise.allSettled(pending);
    if (!this.geometryScenes.size) await Promise.all([...this.retiringGeometryDepth].map(depth => depth.retirement));
  }
  async checkedAllocation<T>(create: () => T, release: (value: T) => void | Promise<void>): Promise<T> {
    this.requireScene();
    this.device.pushErrorScope('out-of-memory'); this.device.pushErrorScope('validation'); this.device.pushErrorScope('internal');
    let value: T | undefined, created = false, failure: unknown;
    try { value = create(); created = true; } catch (error) { failure = error; }
    const scopes = [this.device.popErrorScope(), this.device.popErrorScope(), this.device.popErrorScope()];
    try {
      const reports = await Promise.all(scopes);
      failure ??= reports.find(error => error !== null);
      if (this.lost) failure ??= new Error('The graphics device was lost while preparing the edit.');
    } catch (error) { failure ??= error; }
    if (failure) {
      if (created) await release(value!);
      throw new Error(failure && typeof failure === 'object' && 'message' in failure ? String(failure.message) : String(failure));
    }
    return value!;
  }
  /** Retire pending alpha queries synchronously, before the next display frame. */
  setOpacityPreview(scale: number, selectedOnly: boolean) {
    if (!Number.isFinite(scale) || scale < 0 || scale > 5) throw new RangeError('Opacity scale must be between 0 and 5.');
    scale = Math.fround(scale); selectedOnly = scale !== 1 && selectedOnly;
    if (scale === (this.opacityScale ?? 1) && selectedOnly === (this.opacitySelectedOnly ?? false)) return;
    this.opacityScale = scale; this.opacitySelectedOnly = selectedOnly;
    this.opacityRevision = (this.opacityRevision ?? 0) + 1; this.frameRevision++;
  }
  private uniform(scene: GpuScene, camera: RenderCamera, grade: number[], highlight: boolean,
    geometry: number[], selectedOnly: boolean, width = this.canvas.width, height = this.canvas.height,
    geometrySelectedOnly = selectedOnly, opacityScale = 1, opacitySelectedOnly = false, admitOpacity = true) {
    this.requireScene(scene);
    if (!Number.isFinite(opacityScale) || opacityScale < 0 || opacityScale > 5) throw new RangeError('Opacity scale must be between 0 and 5.');
    opacityScale = Math.fround(opacityScale); opacitySelectedOnly = opacityScale !== 1 && opacitySelectedOnly;
    if (admitOpacity) this.setOpacityPreview(opacityScale, opacitySelectedOnly);
    const { values, words: integers, geometryKey } = encodeGaussianFrame(scene, camera, grade, highlight,
      geometry, selectedOnly, width, height, geometrySelectedOnly, opacityScale, opacitySelectedOnly);
    if (geometryKey !== scene.lastGeometry) { scene.sortDirty = true; scene.lastGeometry = geometryKey; }
    if (this.preparedScene !== scene || this.preparedSceneRevision !== scene.revision || !this.preparedUniform ||
      integers.some((value, index) => value !== this.preparedUniform![index])) this.frameRevision++;
    this.preparedScene = scene; this.preparedSceneRevision = scene.revision; this.preparedWidth = width; this.preparedHeight = height;
    this.preparedCameraRevision = camera.revision;
    this.preparedUniform = integers;
    this.preparedOpacityRevision = opacityScale === (this.opacityScale ?? 1) &&
      opacitySelectedOnly === (this.opacitySelectedOnly ?? false) ? this.opacityRevision ?? 0 : -1;
    this.device.queue.writeBuffer(this.frame, 0, values);
  }
  private sortPrecision:SortPrecision=32;
  get displaySortPrecision() { return this.sortPrecision??32; }
  set displaySortPrecision(value:SortPrecision) {const next=validateSortPrecision(value);if(this.displaySortPrecision!==next){this.sortPrecision=next;this.onFrameNeeded?.();}}
  private prepare(encoder: GPUCommandEncoder, scene: GpuScene, camera: RenderCamera, sorted = true, precision:SortPrecision=32) {
    const words=this.preparedUniform!,resident=scene.residentProjection;
    if(!resident || resident.revision!==scene.revision || words.some((word,i)=>word!==resident.words[i])) {
      const pass = encoder.beginComputePass({ label: 'Project Gaussians' });
      pass.setPipeline(this.pipelines.project); pass.setBindGroup(0, scene.projectGroup); pass.dispatchWorkgroups(Math.ceil(scene.count / 256)); pass.end();
      scene.residentProjection={revision:scene.revision,words:words.slice()};
    }
    if (sorted) {
      this.sort(encoder,scene,camera.revision,precision);
      if(scene.fastOrder) {
        if(!compactOrderMatches(scene.residentCompactOrder,words,scene.revision,precision)) {
          scene.fastOrder.encode(encoder);
          scene.residentCompactOrder=captureCompactOrderKey(words,scene.revision,precision);
        }
      }
    }
  }
  private sort(encoder: GPUCommandEncoder, scene: GpuScene, cameraRevision: number,precision:SortPrecision=32) {
    if(scene.count<2048)precision=32;
    if (scene.sortDirty || (scene.residentSortPrecision??32)<precision || !depthOrderMatches(scene.residentOrder,this.preparedUniform!,scene.sourceRevision)) {
      const pass = encoder.beginComputePass({ label: 'Stable depth sort' });
      const firstDigitStage=1+(32-precision)/4*5;
      for (let i=0;i<scene.sortStages.length;i++) {
        if(i>0&&i<firstDigitStage)continue;
        const stage=scene.sortStages[i];pass.setPipeline(stage.pipeline);pass.setBindGroup(0,stage.group);pass.dispatchWorkgroups(stage.x,stage.y??1);
      }
      pass.end();
      scene.sortDirty = false; scene.lastCameraRevision = cameraRevision;
      scene.residentSortPrecision=precision;
      scene.residentOrder=captureDepthOrderKey(this.preparedUniform!,scene.sourceRevision);
    }
  }
  private draw(encoder: GPUCommandEncoder, scene: GpuScene, target: GPUTextureView, shade: number) {
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target, clearValue: [shade, shade, shade, 1], loadOp: 'clear', storeOp: 'store' }] });
    pass.setPipeline(this.raster); pass.setBindGroup(0, scene.fastOrder && scene.residentCompactOrder ? scene.fastOrder.drawGroup : scene.drawGroup); pass.setIndexBuffer(this.quadIndices,'uint16');
    if(scene.fastOrder && scene.residentCompactOrder) pass.drawIndexedIndirect(scene.fastOrder.indirect,0);
    else pass.drawIndexed(6, scene.count);
    pass.end();
  }
  private geometryUniform(scene: GpuGeometryScene, camera: RenderCamera, width: number, height: number) {
    this.requireScene(scene);
    // Retire the Gaussian frame identity: Gaussian-only queries cannot consume
    // uniforms left over from an earlier scene on this same graphics device.
    this.frameRevision++; this.preparedScene = undefined; this.preparedUniform = undefined;
    const values = new Float32Array(40);
    values.set(camera.view); values.set(camera.projection, 16);
    values.set([width, height, Math.max(1.3, Math.min(3, Math.min(width, height) / 160)), scene.descriptor.kind === 2 ? 1 : 0], 36);
    this.device.queue.writeBuffer(this.frame, 0, values);
  }
  private drawGeometry(encoder: GPUCommandEncoder, scene: GpuGeometryScene, target: GPUTextureView,
    depth: GPUTextureView, shade: number) {
    const pass = encoder.beginRenderPass({ label: 'Native readonly PLY composition',
      colorAttachments: [{ view: target, clearValue: [shade, shade, shade, 1], loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: depth, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
    });
    pass.setPipeline(scene.descriptor.kind === 2 ? this.geometryMesh : this.geometryPoints);
    pass.setBindGroup(0, scene.drawGroup); pass.setVertexBuffer(0, scene.vertices);
    if (scene.descriptor.kind === 2) {
      pass.setIndexBuffer(scene.indices!, 'uint32'); pass.drawIndexed(scene.descriptor.triangleCount * 3);
    } else pass.draw(6, scene.count);
    pass.end();
  }
  render(scene: RenderScene | undefined, camera: RenderCamera, grade = NEUTRAL_COLOR,
    highlight = true, geometry = IDENTITY_MATRIX, selectedOnly = false, geometrySelectedOnly = selectedOnly,
    opacityScale = 1, opacitySelectedOnly = false) {
    this.requireScene(scene);
    try {
    const encoder = this.device.createCommandEncoder();
    let texture: GPUTexture;
    const shade = backgroundShade(camera.background);
    if (scene?.kind === 'geometry') {
      this.steady.suspend('SteadySplats requires a Gaussian scene.');
      const width = this.canvas.width, height = this.canvas.height;
      if (this.geometryDepth?.width !== width || this.geometryDepth.height !== height) {
        // createTexture reports some failures asynchronously. Keep the usable
        // old target until checked preparation succeeds; never draw into an
        // unvalidated or differently sized depth attachment.
        this.requestGeometryTarget(width, height); return;
      }
      this.retainGeometryTarget(width, height);
      this.geometryUniform(scene, camera, width, height);
      texture = this.context.getCurrentTexture();
      this.drawGeometry(encoder, scene, texture.createView(), this.geometryDepth!.texture.createView(), shade);
    } else if (scene) {
      const supported = supportsSteadyProjection(camera.projection);
      if (!supported) this.steady.suspend('SteadySplats requires a supported perspective projection.');
      const steady = supported && this.steady.ready(this.canvas.width, this.canvas.height);
      this.uniform(scene, camera, grade, highlight, geometry, selectedOnly, this.canvas.width, this.canvas.height,
        geometrySelectedOnly, opacityScale, opacitySelectedOnly); this.prepare(encoder, scene, camera, !steady,this.displaySortPrecision);
      texture = this.context.getCurrentTexture();
      if (steady) {
        if (this.steady.encode(encoder, scene, this.preparedUniform!, shade, texture.createView())) this.onFrameNeeded?.();
      } else this.draw(encoder, scene, texture.createView(), shade);
    } else {
      this.steady.suspend('SteadySplats requires a Gaussian scene.');
      texture = this.context.getCurrentTexture();
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: texture.createView(),
        clearValue: [shade, shade, shade, 1], loadOp: 'clear', storeOp: 'store' }] }); pass.end();
    }
    this.device.queue.submit([encoder.finish()]); this.submittedDisplayFrames++;
    const done=this.device.queue.onSubmittedWorkDone(); void done.catch(()=>undefined);
    this.displayCheckpoint={deviceEpoch:this.deviceEpoch,submissionSequence:this.submittedDisplayFrames,done};
    this.canvas.dataset.frames = String(++this.frames);
    if (scene?.kind === 'gaussian') {
      // Query/capture preparation can overwrite preparedUniform. Only actual
      // display frames update this identity; unchanged views stop all polling.
      const width = this.canvas.width, height = this.canvas.height, uniform = this.preparedUniform!;
      const steadyFrame = this.steady.snapshot.status === 'steady' ? this.steady.snapshot.frame : undefined;
      const previous = this.histogramDisplay;
      if (!previous || previous.scene !== scene || previous.revision !== scene.revision ||
        previous.cameraRevision !== camera.revision || previous.width !== width || previous.height !== height || previous.shade !== shade || previous.steadyFrame !== steadyFrame ||
        uniform.some((value, index) => value !== previous.uniform[index])) {
        this.histogramDisplay = { scene, revision: scene.revision, cameraRevision: camera.revision,
          width, height, uniform, shade, steadyFrame, identity: {} };
      }
      this.histogram.observe(texture, { identity: this.histogramDisplay!.identity, scene, width, height, frame: this.frames });
    } else if (this.histogramDisplay) this.resetHistogram();
    } catch(error) {
      if(scene?.kind==='gaussian') { scene.residentOrder=undefined; scene.residentCompactOrder=undefined; scene.residentProjection=undefined; scene.sortDirty=true; }
      this.preparedScene=undefined; this.preparedUniform=undefined; this.frameRevision++;
      throw error;
    }
  }
  async pick(scene: GaussianScene, x: number, y: number, centerRadius = 0): Promise<GpuPick> {
    this.requireScene(scene);
    this.requireGaussian(scene);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(centerRadius) || centerRadius < 0 ||
      x < 0 || y < 0 || x >= this.canvas.width || y >= this.canvas.height)
      return Promise.resolve({ index: null, depth: 0, opacity: 0, contribution: 0, deviceEpoch: this.deviceEpoch });
    const sample = new Float32Array([Math.floor(x) + .5, Math.floor(y) + .5, centerRadius, 0]);
    const check = this.querySnapshot(scene);
    const execute = async () => {
      check();
      const readback = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      let compact:Awaited<ReturnType<typeof allocatePickCandidates>>,submitted:Promise<void>|undefined,didSubmit=false;
      try {
        compact=await allocatePickCandidates(this,scene); check();
        this.device.queue.writeBuffer(this.query, 0, sample);
        const encoder = this.device.createCommandEncoder();
        this.sort(encoder, scene, this.preparedCameraRevision);
        if(compact) compact.encode(encoder);
        else { const pass = encoder.beginComputePass();
          pass.setPipeline(this.pipelines.pick); pass.setBindGroup(0, scene.pickGroup); pass.dispatchWorkgroups(1); pass.end(); }
        encoder.copyBufferToBuffer(this.queryOutput, 0, readback, 0, 16); this.device.queue.submit([encoder.finish()]); didSubmit=true;
        if(compact) submitted=this.device.queue.onSubmittedWorkDone();
        await readback.mapAsync(GPUMapMode.READ);
        check();
        const data = readback.getMappedRange().slice(0), words = new Uint32Array(data), floats = new Float32Array(data);
        readback.unmap(); return { index: words[0] ? words[0] - 1 : null, depth: floats[1], opacity: floats[2], contribution: floats[3], deviceEpoch: this.deviceEpoch };
      } finally {
        if(!didSubmit) { scene.residentOrder=undefined; scene.sortDirty=true; }
        if(submitted) await submitted.catch(()=>undefined); compact?.dispose(); readback.destroy();
      }
    };
    const result = this.queryQueue.then(execute, execute); this.queryQueue = result.catch(() => undefined); return result;
  }
  querySnapshot(scene: GaussianScene): () => void {
    this.requireScene(scene);
    this.requireGaussian(scene);
    const revision = this.frameRevision;
    const check = () => {
      this.requireScene(scene);
      if (revision !== this.frameRevision || this.preparedScene !== scene || scene.revision !== this.preparedSceneRevision ||
        this.preparedOpacityRevision !== (this.opacityRevision ?? 0) ||
        this.canvas.width !== this.preparedWidth || this.canvas.height !== this.preparedHeight)
        throw new StaleGpuQueryError('The rendered view, viewport or scene changed before the query completed.');
    };
    check(); return check;
  }
  surfaceSnapshot(scene: GaussianScene): () => void {
    this.requireScene(scene);
    this.requireGaussian(scene);
    this.requireScene(scene);
    if (this.preparedScene !== scene || !this.preparedUniform || scene.revision !== this.preparedSceneRevision ||
      this.preparedOpacityRevision !== (this.opacityRevision ?? 0))
      throw new StaleGpuQueryError('Prepare the current scene before querying its surface.');
    const sourceRevision = scene.sourceRevision, selectedRevision = scene.selectedRevision;
    const width = this.preparedWidth, height = this.preparedHeight;
    // Raw SH maps exclude RGB grading/highlight, but their composited weights
    // depend on opacity, including alpha-zero revival and selected membership.
    const uniform = this.preparedUniform;
    const opacityRevision = this.opacityRevision ?? 0;
    const words = (value: Uint32Array) => [...value.subarray(0, 42), value[59], ...value.subarray(60, 77),
      value[76] ? value[77] : 0, value[79]];
    const signature = words(uniform);
    const selectedGeometry = uniform[76] !== 0 && uniform[77] !== 0, selectedOpacity = (uniform[79] & 3) === 3;
    const selectedSurface = selectedGeometry || selectedOpacity;
    const geometryTargets = scene.previewMaskRevision('transformBase'), opacityTargets = scene.previewMaskRevision('opacityBase');
    const check = () => {
      this.requireScene(scene);
      const current = this.preparedUniform;
      const currentSignature = current ? words(current) : [];
      if (this.preparedScene !== scene || !current || scene.sourceRevision !== sourceRevision ||
        opacityRevision !== (this.opacityRevision ?? 0) || this.preparedOpacityRevision !== opacityRevision ||
        (selectedSurface && scene.selectedRevision !== selectedRevision) ||
        (selectedGeometry && scene.previewMaskRevision('transformBase') !== geometryTargets) ||
        (selectedOpacity && scene.previewMaskRevision('opacityBase') !== opacityTargets) ||
        this.canvas.width !== width || this.canvas.height !== height ||
        signature.some((word, i) => word !== currentSignature[i]))
        throw new StaleGpuQueryError('The surface geometry, view, viewport or source membership changed.');
    };
    check(); return check;
  }
  private requireGaussian(scene: GpuScene) {
    this.requireScene(scene);
    if (scene.kind !== 'gaussian') throw new Error('Surface queries are available for Gaussian splats only.');
  }
  async captureRgba(scene: RenderScene, camera: RenderCamera, operation: ImageOperation, grade = NEUTRAL_COLOR,
    geometry = IDENTITY_MATRIX, selectedOnly = false, geometrySelectedOnly = selectedOnly,
    opacityScale = 1, opacitySelectedOnly = false): Promise<OwnedRgbaImage> {
    this.requireScene(scene);
    if (!Number.isFinite(opacityScale) || opacityScale < 0 || opacityScale > 5) throw new RangeError('Opacity scale must be between 0 and 5.');
    const capturedOpacity = Math.fround(opacityScale), capturedOpacityScope = capturedOpacity !== 1 && opacitySelectedOnly;
    const width = this.canvas.width, height = this.canvas.height, rowBytes = Math.ceil(width * 4 / 256) * 256;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      width > this.device.limits.maxTextureDimension2D || height > this.device.limits.maxTextureDimension2D)
      throw new RangeError('The capture dimensions exceed the graphics device limit.');
    // Error-scope settlement below yields. Capture all view/preview values now,
    // so later camera input, background cycling or resize cannot change this image.
    const captured: RenderCamera = { view: new Float32Array(camera.view), projection: new Float32Array(camera.projection),
      eye: new Float32Array(camera.eye), revision: camera.revision, background: camera.background };
    const capturedGrade = [...grade], capturedGeometry = [...geometry], revision = scene.revision;
    const pixelBytes = rgbaImageBytes(width, height), mappedBytes = checkedBytes(rowBytes, height);
    const scratchBytes = checkedBytes(mappedBytes + pixelBytes * (scene.kind === 'geometry' ? 2 : 1), 1);
    const check = () => {
      operation.signal?.throwIfAborted(); operation.current?.(); this.requireScene(scene);
      if (scene.revision !== revision) throw new StaleGpuQueryError('The scene changed before its captured image completed.');
    };
    check();
    let rawCredit: (() => void) | undefined = operation.admit(pixelBytes), scratchCredit: (() => void) | undefined;
    let texture: GPUTexture | undefined, readback: GPUBuffer | undefined, depth: GPUTexture | undefined;
    let pixels: Uint8ClampedArray<ArrayBuffer> | undefined, mapped = false, submitted = false, prepared = false;
    try {
      scratchCredit = operation.admit(scratchBytes); check();
      try {
        const allocated = await this.checkedAllocation(() => {
          let texture: GPUTexture | undefined, readback: GPUBuffer | undefined, depth: GPUTexture | undefined;
          try {
            texture = this.device.createTexture({ size: [width, height], format: this.format,
              usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
            readback = this.device.createBuffer({ label: 'Image capture readback', size: mappedBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
            if (scene.kind === 'geometry') depth = this.device.createTexture({ label: 'Readonly PLY capture depth',
              size: [width, height], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT });
            return { texture, readback, depth };
          } catch (error) { readback?.destroy(); texture?.destroy(); depth?.destroy(); throw error; }
        }, value => { value.readback.destroy(); value.texture.destroy(); value.depth?.destroy(); });
        ({ texture, readback, depth } = allocated); check();
        const encoder = this.device.createCommandEncoder();
        if (scene.kind === 'geometry') {
          this.geometryUniform(scene, captured, width, height);
          this.drawGeometry(encoder, scene, texture.createView(), depth!.createView(), backgroundShade(captured.background));
        } else {
          prepared=true;
          this.uniform(scene, captured, capturedGrade, false, capturedGeometry, selectedOnly, width, height,
            geometrySelectedOnly, capturedOpacity, capturedOpacityScope, false); this.prepare(encoder, scene, captured);
          this.draw(encoder, scene, texture.createView(), backgroundShade(captured.background));
        }
        encoder.copyTextureToBuffer({ texture }, { buffer: readback, bytesPerRow: rowBytes }, [width, height]);
        this.device.queue.submit([encoder.finish()]); submitted = true;
        await readback.mapAsync(GPUMapMode.READ); mapped = true; check();
        const source = new Uint8Array(readback.getMappedRange()); pixels = new Uint8ClampedArray(pixelBytes);
        for (let y = 0; y < height; y++) pixels.set(source.subarray(y * rowBytes, y * rowBytes + width * 4), y * width * 4);
        if (this.format.startsWith('bgra')) for (let i = 0; i < pixels.length; i += 4) [pixels[i], pixels[i + 2]] = [pixels[i + 2], pixels[i]];
      } finally {
        // Submitted capture work borrows the scene until this real GPU fence
        // settles. mapAsync also remains joined on abort or device loss before
        // readback, attachments and their admission can be retired.
        if(prepared && !submitted && scene.kind==='gaussian') {
          scene.residentProjection=undefined; scene.residentOrder=undefined; scene.residentCompactOrder=undefined; scene.sortDirty=true;
          this.preparedScene=undefined; this.preparedUniform=undefined; this.frameRevision++;
        }
        if (submitted) try { await this.device.queue.onSubmittedWorkDone(); } catch { /* Device already lost. */ }
        try { if (mapped) readback?.unmap(); }
        finally { readback?.destroy(); texture?.destroy(); depth?.destroy(); scratchCredit?.(); scratchCredit = undefined; }
      }
      check();
      const image = ownRgbaImage(width, height, pixels!, rawCredit); rawCredit = undefined; return image;
    } finally {
      scratchCredit?.();
      if (rawCredit) {
        try { if (pixels?.byteLength) structuredClone(pixels.buffer, { transfer: [pixels.buffer] }); }
        finally { rawCredit(); }
      }
    }
  }
  async capture(scene: RenderScene, camera: RenderCamera, type = 'image/png', grade = NEUTRAL_COLOR,
    geometry = IDENTITY_MATRIX, selectedOnly = false, geometrySelectedOnly = selectedOnly,
    opacityScale = 1, opacitySelectedOnly = false): Promise<Blob> {
    if (type !== 'image/png' && type !== 'image/jpeg') throw new Error('Unsupported capture image type.');
    const operation: ImageOperation = { admit: () => () => undefined };
    const raw = await this.captureRgba(scene, camera, operation, grade, geometry, selectedOnly, geometrySelectedOnly, opacityScale, opacitySelectedOnly);
    try {
      const output = await encodeRgba(raw, type, operation);
      try { return output.blob; } finally { output.dispose(); }
    } finally { raw.dispose(); }
  }
  async close() {
    this.dispose();
    await Promise.allSettled([this.queryQueue, this.steady.finish(), this.histogram.finish(),
      ...this.scenePreparations,
      ...[...this.retiringGeometryDepth].map(depth => depth.retirement)]);
  }
  dispose() {
    if (this.disposed) return; this.disposed = true;
    this.histogram.dispose();
    this.steady.dispose();
    this.geometryTargetGeneration++;
    if (this.geometryDepth) { const depth = this.geometryDepth; this.geometryDepth = undefined; void this.retireGeometryDepth(depth); }
    this.frame.destroy(); this.query.destroy(); this.queryOutput.destroy(); this.quadIndices.destroy();
    // Recreated renderers share the same canvas context. Retiring the old one
    // must not unconfigure the replacement's presentation.
    if (canvasOwners.get(this.canvas) === this) { this.context.unconfigure(); canvasOwners.delete(this.canvas); }
    this.device.destroy();
    forgetSurfacePipelines(this); this.surfaceScratch.dispose();
  }
}
