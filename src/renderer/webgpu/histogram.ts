import source from './histogram.wgsl?raw';
import type { RenderedHistogram } from '../histogram';
import type { RenderableScene } from './renderer';

const BIN_BYTES = 3 * 256 * Uint32Array.BYTES_PER_ELEMENT;
// GPU bins, staging and uniforms, plus both CPU snapshots during publication.
export const HISTOGRAM_ALLOCATION_BYTES = BIN_BYTES * 4 + 16;
export const HISTOGRAM_INTERVAL_MS = 200;

type HistogramFrame = {
  identity: object; scene: RenderableScene; width: number; height: number; frame: number;
};
type Resources = {
  pipeline: GPUComputePipeline; bins: GPUBuffer; readback: GPUBuffer; params: GPUBuffer;
  release?: () => void; retirement?: Promise<void>;
};
type HistogramCallbacks = {
  admit(bytes: number): (() => void) | undefined;
  invalidate(): void;
  publish(result: RenderedHistogram, scene: RenderableScene): void;
  unavailable(): void;
};

/** Optional display sampling. It never retains a canvas texture across a yield. */
export class HistogramSampler {
  private enabled = false;
  private disposed = false;
  private failed = false;
  private reportedFailureGeneration = -1;
  private generation = 0;
  private desired?: HistogramFrame;
  private sampled?: object;
  private resources?: Resources;
  private preparation?: Promise<void>;
  private pending?: { resources: Resources; task: Promise<void> };
  private readonly retiring = new Set<Promise<void>>();
  private retirementWait?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private lastStarted = -Infinity;

  constructor(private readonly device: GPUDevice, private readonly deviceEpoch: number,
    private readonly callbacks: HistogramCallbacks) {}

  setEnabled(enabled: boolean) {
    if (this.disposed || enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) this.reset();
    else if (this.failed) this.reportUnavailable();
  }

  reset() {
    this.generation++; this.desired = undefined; this.sampled = undefined;
    this.cancelTimer();
    if (this.resources) {
      const resources = this.resources; this.resources = undefined;
      void this.retire(resources);
    }
  }

  private cancelTimer() {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private requestFrame() {
    if (this.disposed || !this.enabled || this.failed || !this.desired ||
      this.pending || this.desired.identity === this.sampled) return;
    const delay = Math.max(0, this.lastStarted + HISTOGRAM_INTERVAL_MS - performance.now());
    if (!delay) { this.cancelTimer(); this.callbacks.invalidate(); return; }
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.disposed && this.enabled && !this.failed && !this.pending &&
        this.desired && this.desired.identity !== this.sampled) this.callbacks.invalidate();
    }, delay);
  }

  private fail(generation: number) {
    if (this.disposed || !this.enabled || generation !== this.generation) return;
    this.failed = true; this.cancelTimer();
    if (this.resources) {
      const resources = this.resources; this.resources = undefined;
      void this.retire(resources);
    }
    this.reportUnavailable();
  }

  private reportUnavailable() {
    if (this.disposed || !this.enabled || this.reportedFailureGeneration === this.generation) return;
    this.reportedFailureGeneration = this.generation; this.callbacks.unavailable();
  }

  private retire(resources: Resources): Promise<void> {
    if (resources.retirement) return resources.retirement;
    const pending = this.pending?.resources === resources ? this.pending.task : undefined;
    const task = (async () => {
      if (pending) await pending;
      try { await this.device.queue.onSubmittedWorkDone(); } catch { /* Device already lost. */ }
      finally {
        resources.readback.unmap();
        resources.bins.destroy(); resources.readback.destroy(); resources.params.destroy();
        resources.release?.();
      }
    })().finally(() => { this.retiring.delete(task); });
    resources.retirement = task; this.retiring.add(task); return task;
  }

  private prepare() {
    if (this.preparation || this.disposed || !this.enabled || this.failed) return;
    if (this.retiring.size || this.pending) {
      if (!this.retirementWait) {
        const pending = this.pending?.task;
        const task = Promise.allSettled([...this.retiring, ...(pending ? [pending] : [])]).then(() => {
          if (this.retirementWait === task) this.retirementWait = undefined;
          this.requestFrame();
        });
        this.retirementWait = task;
      }
      return;
    }
    const generation = this.generation;
    const task = this.createResources().then(async resources => {
      if (this.disposed || !this.enabled || generation !== this.generation) {
        await this.retire(resources); return;
      }
      this.resources = resources; this.requestFrame();
    }).catch(() => { this.fail(generation); }).finally(() => {
      if (this.preparation === task) this.preparation = undefined;
      // A reset can replace the generation while allocation scopes settle.
      if (generation !== this.generation) this.requestFrame();
    });
    this.preparation = task;
  }

  private async createResources(): Promise<Resources> {
    const device = this.device, release = this.callbacks.admit(HISTOGRAM_ALLOCATION_BYTES);
    const allocated: GPUBuffer[] = [];
    let resources: Resources | undefined, failure: unknown;
    device.pushErrorScope('out-of-memory'); device.pushErrorScope('validation'); device.pushErrorScope('internal');
    try {
      const module = device.createShaderModule({ label: 'Rendered RGB histogram', code: source });
      const pipeline = device.createComputePipeline({ label: 'Rendered RGB histogram', layout: 'auto',
        compute: { module, entryPoint: 'histogramSample' } });
      const buffer = (label: string, size: number, usage: GPUBufferUsageFlags) => {
        const value = device.createBuffer({ label, size, usage }); allocated.push(value); return value;
      };
      resources = { pipeline,
        bins: buffer('Rendered RGB bins', BIN_BYTES, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST),
        readback: buffer('Rendered RGB readback', BIN_BYTES, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST),
        params: buffer('Rendered RGB sampling grid', 16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST), release };
    } catch (error) { failure = error; }
    const scopes = [device.popErrorScope(), device.popErrorScope(), device.popErrorScope()];
    try { failure ??= (await Promise.all(scopes)).find(error => error !== null); }
    catch (error) { failure ??= error; }
    if (failure || !resources) {
      try { await device.queue.onSubmittedWorkDone(); } catch { /* Device already lost. */ }
      finally { for (const buffer of allocated) buffer.destroy(); release?.(); }
      throw failure ?? new Error('Histogram allocation failed.');
    }
    return resources;
  }

  private async map(readback: GPUBuffer) {
    // mapAsync can report a GPU validation error as well as rejecting its
    // promise. Keep that optional error out of the renderer's fatal handler.
    const device = this.device;
    device.pushErrorScope('out-of-memory'); device.pushErrorScope('validation'); device.pushErrorScope('internal');
    let mapping: Promise<void> | undefined, failure: unknown;
    try { mapping = readback.mapAsync(GPUMapMode.READ); } catch (error) { failure = error; }
    const scopes = [device.popErrorScope(), device.popErrorScope(), device.popErrorScope()];
    const reports = await Promise.allSettled([mapping ?? Promise.resolve(), ...scopes]);
    for (const report of reports) {
      if (report.status === 'rejected') failure ??= report.reason;
      else if (report.value) failure ??= report.value;
    }
    if (failure) throw failure;
  }

  /** Called synchronously after the display submission, using that frame's texture. */
  observe(texture: GPUTexture, frame: HistogramFrame) {
    if (this.disposed || !this.enabled) return;
    if (this.failed) { this.reportUnavailable(); return; }
    this.desired = frame;
    if (frame.identity === this.sampled) { this.cancelTimer(); return; }
    if (!this.resources) { this.prepare(); return; }
    if (this.pending) return;
    if (performance.now() - this.lastStarted < HISTOGRAM_INTERVAL_MS) { this.requestFrame(); return; }
    this.cancelTimer();
    const resources = this.resources, generation = this.generation, device = this.device;
    const width = Math.min(frame.width, 256), height = Math.min(frame.height, 144);
    if (width < 1 || height < 1) return;
    let failure: unknown;
    device.pushErrorScope('out-of-memory'); device.pushErrorScope('validation'); device.pushErrorScope('internal');
    try {
      device.queue.writeBuffer(resources.params, 0, new Uint32Array([frame.width, frame.height, width, height]));
      const group = device.createBindGroup({ label: 'Rendered RGB frame', layout: resources.pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: texture.createView() },
          { binding: 1, resource: { buffer: resources.bins } }, { binding: 2, resource: { buffer: resources.params } }] });
      const encoder = device.createCommandEncoder({ label: 'Rendered RGB histogram' });
      encoder.clearBuffer(resources.bins);
      const pass = encoder.beginComputePass({ label: 'Rendered RGB histogram' });
      pass.setPipeline(resources.pipeline); pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(width / 16), Math.ceil(height / 16)); pass.end();
      encoder.copyBufferToBuffer(resources.bins, 0, resources.readback, 0, BIN_BYTES);
      device.queue.submit([encoder.finish()]);
    } catch (error) { failure = error; }
    const scopes = [device.popErrorScope(), device.popErrorScope(), device.popErrorScope()];
    this.lastStarted = performance.now(); this.sampled = frame.identity;
    const task = (async () => {
      try {
        const reports = await Promise.all(scopes);
        failure ??= reports.find(error => error !== null);
        if (failure) throw failure;
        // Never map or retain the presentation texture across an await.
        await this.map(resources.readback);
        if (!this.disposed && this.enabled && generation === this.generation &&
          this.resources === resources && this.desired?.identity === frame.identity && !frame.scene.retired) {
          const bins = new Uint32Array(resources.readback.getMappedRange().slice(0));
          this.callbacks.publish({ bins, width, height, frame: frame.frame, deviceEpoch: this.deviceEpoch }, frame.scene);
        }
      } catch { this.fail(generation); }
      finally { resources.readback.unmap(); }
    })().finally(() => {
      if (this.pending?.task === task) this.pending = undefined;
      this.requestFrame();
    });
    this.pending = { resources, task };
  }

  async finish() {
    await this.preparation;
    await Promise.allSettled([...this.retiring, ...(this.pending ? [this.pending.task] : [])]);
  }

  dispose() {
    if (this.disposed) return;
    this.enabled = false; this.disposed = true; this.reset();
  }
}
