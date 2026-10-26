import frameSource from './frame.wgsl?raw';
import splatSource from './splats.wgsl?raw';
import steadySource from './steady.wgsl?raw';
import { spatiotemporalBlueNoiseData } from '../steadyNoise';
import { DEFAULT_STEADY_SETTINGS, validateSteadySettings, type SteadySettings, type SteadyStatus } from '../steadySettings';
import { invertMatrix, multiplyMatrices, SteadyFrameState } from '../steadyState';
import { planSteadyResources, STEADY_HISTORY_BYTES, STEADY_UNIFORM_BYTES } from './steadyState';

type Scene = { revision: number; count: number; buffers: { projected: GPUBuffer; states: GPUBuffer } };
type Pipelines = { sample: GPURenderPipeline; history: GPUComputePipeline; resolve: GPUComputePipeline; composite: GPURenderPipeline };
type Stripe = { start: number; rows: number; params: GPUBuffer; history: GPUBuffer; rest: GPUBuffer };
type Resources = {
  width: number; height: number; noise: GPUTexture; raw: GPUTexture; samples: GPUTexture; depth: GPUTexture;
  weights: GPUTexture; colors: [GPUTexture, GPUTexture]; stripes: Stripe[]; textures: GPUTexture[]; buffers: GPUBuffer[];
  release(): void; retirement?: Promise<void>;
};
type Callbacks = { admit(bytes: number): (() => void) | undefined; invalidate(): void; status(status: SteadyStatus): void };

/** Optional display resources. GaussianRenderer owns all command submission. */
export class SteadySplats {
  private settings = DEFAULT_STEADY_SETTINGS;
  private disposed = false;
  private generation = 0;
  private desired?: { width: number; height: number };
  private failed = false;
  private preparation?: Promise<void>;
  private readonly retiring = new Set<Promise<void>>();
  private pipelines?: Pipelines;
  private resources?: Resources;
  private state = new SteadyFrameState();
  private previousViewProjection?: Float32Array;
  private writeIndex = 0;
  private status: SteadyStatus = 'sorted';
  private reason: string | null = null;
  private allocatedBytes = 0;
  constructor(private readonly device: GPUDevice, private readonly format: GPUTextureFormat,
    private readonly frame: GPUBuffer, private readonly callbacks: Callbacks) {}

  get snapshot() { return { status: this.status, reason: this.reason, allocationBytes: this.allocatedBytes,
    frame: this.state.frame, restFrames: this.state.restFrames, valid: this.state.valid }; }
  configure(value: SteadySettings) {
    const next = validateSteadySettings(value);
    if (Object.keys(next).every(key => next[key as keyof SteadySettings] === this.settings[key as keyof SteadySettings])) return;
    this.settings = next; this.failed = false; this.resetHistory();
    if (next.mode === 'sorted') this.suspend();
    else { this.generation++; this.report(this.resources ? 'steady' : 'preparing'); }
  }
  resetHistory() { this.state.reset(); this.previousViewProjection = undefined; this.writeIndex = 0; }
  private report(status: SteadyStatus, reason: string | null = null) {
    this.reason = reason;
    if (status === this.status) return;
    this.status = status;
    if (!this.disposed) this.callbacks.status(status);
  }
  /** Non-Gaussian/unsupported views retain their normal renderer and release optional memory. */
  suspend(reason?: string) {
    if (this.desired || this.resources) {
      this.generation++; this.desired = undefined; this.failed = false; this.resetHistory();
      if (this.resources) { const resources = this.resources; this.resources = undefined; void this.retire(resources); }
    }
    this.report(reason && this.settings.mode === 'steady' ? 'unavailable' : 'sorted', reason ?? null);
  }
  ready(width: number, height: number) {
    if (this.disposed || this.settings.mode !== 'steady') return false;
    if (this.resources?.width === width && this.resources.height === height) return true;
    if (this.desired?.width !== width || this.desired.height !== height) {
      this.desired = { width, height }; this.generation++; this.failed = false; this.resetHistory();
      if (this.resources) { const resources = this.resources; this.resources = undefined; void this.retire(resources); }
    }
    this.prepare(); return false;
  }
  private prepare() {
    if (this.preparation || this.disposed || this.failed || !this.desired || this.settings.mode !== 'steady') return;
    const generation = this.generation, { width, height } = this.desired;
    this.report('preparing');
    const task = this.createResources(width, height).then(async resources => {
      if (this.disposed || generation !== this.generation || this.settings.mode !== 'steady') { await this.retire(resources); return; }
      this.resources = resources; this.resetHistory(); this.report('steady');
    }).catch(error => {
      if (!this.disposed && generation === this.generation) {
        this.failed = true; this.report('unavailable', error instanceof Error ? error.message : String(error));
      }
    }).finally(() => {
      if (this.preparation === task) this.preparation = undefined;
      if (!this.disposed) this.callbacks.invalidate();
    });
    this.preparation = task;
  }
  private async createResources(width: number, height: number): Promise<Resources> {
    const plan = planSteadyResources(width, height, this.device.limits);
    const credit = this.callbacks.admit(plan.bytes);
    this.allocatedBytes += plan.bytes;
    let released = false;
    const release = () => { if (!released) { released = true; this.allocatedBytes -= plan.bytes; credit?.(); } };
    const device = this.device, textures: GPUTexture[] = [], buffers: GPUBuffer[] = [];
    let result: Resources | undefined, failure: unknown;
    device.pushErrorScope('out-of-memory'); device.pushErrorScope('validation'); device.pushErrorScope('internal');
    try {
      if (!this.pipelines) {
        const module = device.createShaderModule({ label: 'SplatView SteadySplats', code: frameSource + splatSource + steadySource });
        const compute = (entryPoint: string) => device.createComputePipeline({ label: entryPoint, layout: 'auto', compute: { module, entryPoint } });
        this.pipelines = {
          sample: device.createRenderPipeline({ label: 'SteadySplats stochastic visibility', layout: 'auto',
            vertex: { module, entryPoint: 'steadyVertex' }, primitive: { topology: 'triangle-list' },
            depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less-equal' },
            fragment: { module, entryPoint: 'steadyFragment', targets: [{ format: 'rgba16float' }, { format: 'rg32uint' }] } }),
          history: compute('steadyHistoryPass'), resolve: compute('steadyResolvePass'),
          composite: device.createRenderPipeline({ label: 'SteadySplats display', layout: 'auto',
            vertex: { module, entryPoint: 'steadyCompositeVertex' }, primitive: { topology: 'triangle-list' },
            fragment: { module, entryPoint: 'steadyCompositeFragment', targets: [{ format: this.format }] } }),
        };
      }
      const texture = (label: string, format: GPUTextureFormat, usage: GPUTextureUsageFlags) => {
        const value = device.createTexture({ label, size: [width, height], format, usage }); textures.push(value); return value;
      };
      const buffer = (label: string, size: number, usage: GPUBufferUsageFlags) => {
        const value = device.createBuffer({ label, size, usage }); buffers.push(value); return value;
      };
      const sampleUsage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
      const storageUsage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
      const noise = device.createTexture({ label: 'SteadySplats 32x32x64 STBN', size: [32,32,64], dimension: '3d',
        format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }); textures.push(noise);
      device.queue.writeTexture({ texture: noise }, spatiotemporalBlueNoiseData(), { bytesPerRow: 32, rowsPerImage: 32 }, [32,32,64]);
      result = { width, height, noise,
        raw: texture('SteadySplats visibility color', 'rgba16float', sampleUsage),
        samples: texture('SteadySplats source ID and linear depth', 'rg32uint', sampleUsage),
        depth: texture('SteadySplats visibility depth', 'depth32float', GPUTextureUsage.RENDER_ATTACHMENT),
        weights: texture('SteadySplats outward PDF ratios', 'rgba32float', storageUsage),
        colors: [texture('SteadySplats reconstruction A', 'rgba16float', storageUsage), texture('SteadySplats reconstruction B', 'rgba16float', storageUsage)],
        stripes: plan.stripes.map(stripe => ({ ...stripe,
          params: buffer('SteadySplats frame parameters', STEADY_UNIFORM_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
          history: buffer('SteadySplats four occluder FIFO', width * stripe.rows * STEADY_HISTORY_BYTES, GPUBufferUsage.STORAGE),
          rest: buffer('SteadySplats stationary FP32 average', width * stripe.rows * 16, GPUBufferUsage.STORAGE),
        })), textures, buffers, release };
    } catch (error) { failure = error; }
    const scopes = [device.popErrorScope(), device.popErrorScope(), device.popErrorScope()];
    try { failure ??= (await Promise.all(scopes)).find(error => error !== null); }
    catch (error) { failure ??= error; }
    if (failure || !result) {
      this.pipelines = undefined;
      try { await device.queue.onSubmittedWorkDone(); } catch { /* Device loss retires uploads. */ }
      finally { for (const texture of textures) texture.destroy(); for (const buffer of buffers) buffer.destroy(); release(); }
      throw failure ?? new Error('SteadySplats initialization failed.');
    }
    return result;
  }
  private retire(resources: Resources) {
    if (resources.retirement) return resources.retirement;
    const task = (async () => {
      try { await this.device.queue.onSubmittedWorkDone(); } catch { /* Device already lost. */ }
      finally { for (const texture of resources.textures) texture.destroy(); for (const buffer of resources.buffers) buffer.destroy(); resources.release(); }
    })().finally(() => { this.retiring.delete(task); });
    resources.retirement = task; this.retiring.add(task); return task;
  }
  async finish() {
    await this.preparation;
    await Promise.allSettled([...this.retiring]);
  }
  private group(pipeline: GPURenderPipeline | GPUComputePipeline, index: number, entries: [number, GPUBindingResource][]) {
    return this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(index), entries: entries.map(([binding, resource]) => ({ binding, resource })) });
  }
  /** Returns whether the controller should request another refinement frame. */
  encode(encoder: GPUCommandEncoder, scene: Scene, uniform: Uint32Array, shade: number, target: GPUTextureView) {
    const resources = this.resources!, pipelines = this.pipelines!;
    const state = this.state.observe({ scene, revision: scene.revision, uniform, shade }, this.settings);
    const floats = new Float32Array(uniform.buffer, uniform.byteOffset, uniform.length);
    const view = floats.subarray(0,16), projection = floats.subarray(16,32);
    const viewProjection = multiplyMatrices(projection, view);
    if (state.reconstruct) {
      const inverseProjection = invertMatrix(projection), inverseView = invertMatrix(view);
      for (const stripe of resources.stripes) {
        const values = new Float32Array(STEADY_UNIFORM_BYTES / 4), words = new Uint32Array(values.buffer);
        values.set(inverseProjection); values.set(inverseView,16); values.set(this.previousViewProjection ?? viewProjection,32);
        words.set([state.sampleFrame, Number(state.valid), Number(state.still), state.restFrames],48);
        values.set([resources.width,resources.height,this.settings.historyWeight,shade],52);
        words.set([stripe.start,stripe.rows,Math.imul(Math.floor(state.sampleFrame / 64),0x9e3779b9) >>> 0,0],56);
        this.device.queue.writeBuffer(stripe.params,0,values);
      }
      const sample = encoder.beginRenderPass({ label: 'SteadySplats unsorted visibility',
        colorAttachments: [resources.raw,resources.samples].map(texture => ({ view: texture.createView(), clearValue: [0,0,0,0], loadOp: 'clear', storeOp: 'store' })),
        depthStencilAttachment: { view: resources.depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } });
      sample.setPipeline(pipelines.sample);
      sample.setBindGroup(0,this.group(pipelines.sample,0,[[0,{ buffer: this.frame }],[2,{ buffer: scene.buffers.states }],[7,{ buffer: scene.buffers.projected }]]));
      sample.setBindGroup(1,this.group(pipelines.sample,1,[[0,{ buffer: resources.stripes[0].params }],[1,resources.noise.createView()]]));
      sample.draw(6,scene.count); sample.end();
      // Every outward weight must exist before any stripe gathers adjacent rows.
      const history = encoder.beginComputePass({ label: 'SteadySplats occluder history' });
      history.setPipeline(pipelines.history);
      history.setBindGroup(0,this.group(pipelines.history,0,[[7,{ buffer: scene.buffers.projected }]]));
      for (const stripe of resources.stripes) {
        history.setBindGroup(1,this.group(pipelines.history,1,[[0,{ buffer: stripe.params }],[3,resources.samples.createView()],
          [5,resources.weights.createView()],[8,{ buffer: stripe.history }]]));
        history.dispatchWorkgroups(Math.ceil(resources.width/8),Math.ceil(stripe.rows/8));
      }
      history.end();
      const resolve = encoder.beginComputePass({ label: 'SteadySplats spatial and temporal reconstruction' });
      resolve.setPipeline(pipelines.resolve); resolve.setBindGroup(0,this.group(pipelines.resolve,0,[]));
      for (const stripe of resources.stripes) {
        resolve.setBindGroup(1,this.group(pipelines.resolve,1,[[0,{ buffer: stripe.params }],[2,resources.raw.createView()],
          [3,resources.samples.createView()],[4,resources.weights.createView()],[6,resources.colors[1-this.writeIndex].createView()],
          [7,resources.colors[this.writeIndex].createView()],[9,{ buffer: stripe.rest }]]));
        resolve.dispatchWorkgroups(Math.ceil(resources.width/8),Math.ceil(stripe.rows/8));
      }
      resolve.end();
      this.previousViewProjection = viewProjection; this.writeIndex = 1-this.writeIndex;
    }
    const composite = encoder.beginRenderPass({ label: 'SteadySplats reconstructed display',
      colorAttachments: [{ view: target, clearValue: [shade,shade,shade,1], loadOp: 'clear', storeOp: 'store' }] });
    composite.setPipeline(pipelines.composite); composite.setBindGroup(0,this.group(pipelines.composite,0,[]));
    composite.setBindGroup(1,this.group(pipelines.composite,1,[[0,{ buffer: resources.stripes[0].params }],
      [6,resources.colors[1-this.writeIndex].createView()]]));
    composite.draw(3); composite.end();
    return state.needsMore;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.suspend(); this.generation++;
  }
}
