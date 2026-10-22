import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureRendererCapabilities, RendererNegotiation, type RendererNegotiationSnapshot } from '../src/renderer/webgpu/diagnostics';
import { GaussianRenderer, type RenderableScene } from '../src/renderer/webgpu/renderer';
import type { CameraController } from '../src/input/camera';

afterEach(() => { vi.unstubAllGlobals(); });

function capabilities(bufferSize: number, featureNames = ['timestamp-query', 'shader-f16']) {
  const values = { maxBufferSize: bufferSize, maxStorageBufferBindingSize: bufferSize / 2, maxTextureDimension2D: 8192 };
  const limits = Object.create(Object.fromEntries(Object.keys(values).map(name => [name, undefined]))) as object;
  for (const name of Object.keys(values) as (keyof typeof values)[]) Object.defineProperty(Object.getPrototypeOf(limits), name,
    { configurable: true, get: () => values[name] });
  return { features: new Set(featureNames), limits, values };
}
function rendererFixture() {
  const advertised = capabilities(1024 ** 3), resulting = capabilities(512 * 1024 ** 2, []);
  const destroy = vi.fn(), context = { configure: vi.fn(), unconfigure: vi.fn() };
  const device = { ...resulting, pushErrorScope: vi.fn(), popErrorScope: vi.fn(async (): Promise<{ message: string } | null> => null), destroy,
    createShaderModule: vi.fn(() => ({ getCompilationInfo: vi.fn(async (): Promise<{ messages: { type: string; lineNum: number; message: string }[] }> => ({ messages: [] })) })),
    createComputePipelineAsync: vi.fn(async () => ({})), createRenderPipelineAsync: vi.fn(async () => ({})),
    createBuffer: vi.fn(() => ({ destroy: vi.fn() })), lost: new Promise<never>(() => undefined), addEventListener: vi.fn() };
  const adapter = { ...advertised, info: { vendor: 'observed vendor', architecture: 'observed family', device: 'observed type', description: '' },
    requestDevice: vi.fn(async (_descriptor: GPUDeviceDescriptor) => device) };
  const gpu = { requestAdapter: vi.fn(async () => adapter), getPreferredCanvasFormat: vi.fn(() => 'bgra8unorm') };
  vi.stubGlobal('navigator', { gpu });
  vi.stubGlobal('GPUBufferUsage', { UNIFORM: 1, COPY_DST: 2, STORAGE: 4, COPY_SRC: 8 });
  vi.stubGlobal('GPUTextureUsage', { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2 });
  const canvas = { getContext: vi.fn(() => context) } as unknown as HTMLCanvasElement;
  return { canvas, gpu, adapter, device, advertised, resulting, context, destroy };
}

describe('bounded renderer negotiation observations', () => {
  it('copies inherited GPU limits and feature sets without retaining mutable views', () => {
    const source = capabilities(1024), observed = captureRendererCapabilities(source);
    expect(Object.keys(source.limits)).toEqual([]);
    expect(observed.limits).toEqual({ maxBufferSize: 1024, maxStorageBufferBindingSize: 512, maxTextureDimension2D: 8192 });
    source.values.maxBufferSize = 2048; source.features.clear();
    expect(observed.limits!.maxBufferSize).toBe(1024); expect(observed.features).toEqual(['shader-f16', 'timestamp-query']);
    expect(Object.isFrozen(observed)).toBe(true); expect(Object.isFrozen(observed.features)).toBe(true);
    expect(Object.isFrozen(observed.limits)).toBe(true); expect(JSON.parse(JSON.stringify(observed))).toEqual(observed);
  });
  it('retains explicit unavailable reasons instead of invented feature/limit values', () => {
    const observed = captureRendererCapabilities({ get features() { throw new Error('feature access denied'); },
      get limits() { throw new Error('limit access denied'); } });
    expect(observed).toEqual({ features: null, limits: null, featuresUnavailableReason: 'feature access denied', limitsUnavailableReason: 'limit access denied' });
  });
  it.each([NaN, Infinity, -1, 1.5])('case %#: refuses an unrepresentable observed limit %s without affecting another channel', value => {
    const observed = captureRendererCapabilities({ features: new Set(['shader-f16']), limits: { maxBufferSize: value } });
    expect(observed.features).toEqual(['shader-f16']); expect(observed.limits).toBeNull(); expect(observed.limitsUnavailableReason).toContain('maxBufferSize');
  });
  it('bounds feature iteration without retaining an oversized observation', () => {
    const observed = captureRendererCapabilities({ features: Array.from({ length: 129 }, (_, id) => `feature-${id}`), limits: {} });
    expect(observed.features).toBeNull(); expect(observed.featuresUnavailableReason).toContain('bounded'); expect(observed.limits).toEqual({});
  });
  it('freezes adapter info, separate requested limits and actual resulting device capabilities', () => {
    let now = 10;
    const snapshots: RendererNegotiationSnapshot[] = [], negotiation = new RendererNegotiation(value => { snapshots.push(value); }, () => now++);
    const adapter = { ...capabilities(1024), info: { vendor: 'vendor', architecture: 'arch', device: 'type', description: 'driver description',
      isFallbackAdapter: false, subgroupMinSize: 4, subgroupMaxSize: 32 } };
    negotiation.advance('adapter-request'); negotiation.observeAdapter(adapter);
    const descriptor = { requiredLimits: { maxBufferSize: 512, maxStorageBufferBindingSize: 256 } };
    negotiation.observeRequest(descriptor); negotiation.observeDevice(capabilities(512, []));
    adapter.info.vendor = 'changed'; descriptor.requiredLimits.maxBufferSize = 999;
    negotiation.advance('shader-compilation'); negotiation.advance('pipeline-creation'); negotiation.advance('renderer-creation');
    negotiation.advance('validation'); negotiation.advance('ready');
    const observed = negotiation.snapshot;
    expect(observed.adapter!.info!.vendor).toBe('vendor'); expect(Object.isFrozen(observed.adapter!.info)).toBe(true);
    expect(observed.adapter!.features).toContain('timestamp-query'); expect(observed.requested!.features).toEqual([]);
    expect(observed.requested!.limits.maxBufferSize).toBe(512); expect(observed.device!.features).toEqual([]);
    expect(observed.startedAtMs).toBe(10); expect(observed.observedAtMs).toBe(19); expect(observed.stages).toHaveLength(10);
    expect(observed.gpuTimestamps).toEqual({ available: false, reason: expect.stringContaining('not instrumented') });
    expect(snapshots[0].adapter).toBeNull(); expect(snapshots[0].stages).toHaveLength(1);
    expect(Object.isFrozen(observed)).toBe(true); expect(Object.isFrozen(observed.stages)).toBe(true);
    expect(Object.isFrozen(observed.stages[0])).toBe(true); expect(Object.isFrozen(observed.requested)).toBe(true);
    expect(Object.isFrozen(observed.requested!.features)).toBe(true); expect(Object.isFrozen(observed.requested!.limits)).toBe(true);
    expect(JSON.parse(JSON.stringify(observed))).toEqual(observed);
  });
  it('records info access refusal while retaining the observed adapter capabilities', () => {
    const negotiation = new RendererNegotiation(undefined, () => 12);
    negotiation.observeAdapter({ ...capabilities(2048), get info() { throw new Error('identification unavailable'); } });
    expect(negotiation.snapshot.adapter!.info).toBeNull(); expect(negotiation.snapshot.adapter!.infoUnavailableReason).toBe('identification unavailable');
    expect(negotiation.snapshot.adapter!.limits!.maxBufferSize).toBe(2048);
  });
  it('distinguishes actually empty adapter identification fields from a named GPU', () => {
    const negotiation = new RendererNegotiation(undefined, () => 12);
    negotiation.observeAdapter({ ...capabilities(2048), info: { vendor: '', architecture: '', device: '', description: '' } });
    expect(negotiation.snapshot.adapter!.info).toEqual({ vendor: '', architecture: '', device: '', description: '' });
    expect(negotiation.snapshot.adapter!.infoUnavailableReason).toContain('empty or redacted');
  });
  it('records unavailable clocks as null and retains the actual failing initialization stage', () => {
    const negotiation = new RendererNegotiation(undefined, () => { throw new Error('clock unavailable'); });
    negotiation.advance('device-request'); negotiation.fail(new Error('device refused')); const observed = negotiation.snapshot;
    expect(observed.status).toBe('failed'); expect(observed.failure).toEqual({ stage: 'device-request', reason: 'device refused' });
    expect(observed.startedAtMs).toBeNull(); expect(observed.observedAtMs).toBeNull(); expect(observed.clockUnavailableReason).toBe('clock unavailable');
    expect(observed.stages.every(stage => stage.atMs === null)).toBe(true);
    negotiation.advance('ready'); negotiation.fail('later error'); expect(negotiation.snapshot).toBe(observed);
  });
  it('isolates synchronous and asynchronous observer failures and never grows beyond ten stages', async () => {
    let count = 0;
    const negotiation = new RendererNegotiation(() => {
      if (++count === 1) throw new Error('sync observer'); return Promise.reject(new Error('async observer'));
    }, () => 20);
    for (let index = 0; index < 50; index++) negotiation.advance('adapter-request');
    negotiation.fail(new Error('actual failure'));
    await Promise.resolve(); await Promise.resolve();
    expect(negotiation.snapshot.stages).toHaveLength(10); expect(negotiation.snapshot.failure!.reason).toBe('actual failure');
    expect(count).toBe(10); // A terminal event is reserved even after repeated intermediate observations.
  });
});

describe('renderer creation negotiation integration', () => {
  it('reports absent WebGPU without claiming adapter negotiation occurred', async () => {
    vi.stubGlobal('navigator', {}); const snapshots: RendererNegotiationSnapshot[] = [];
    await expect(GaussianRenderer.create({} as HTMLCanvasElement, value => { snapshots.push(value); })).rejects.toThrow('WebGPU is required');
    expect(snapshots).toHaveLength(2); expect(snapshots.at(-1)).toMatchObject({ status: 'failed', stage: 'start',
      adapter: null, requested: null, device: null, failure: { stage: 'start', reason: expect.stringContaining('WebGPU is required') } });
  });
  it('reports actual negotiation and preserves the exact existing requestDevice descriptor', async () => {
    const f = rendererFixture(), snapshots: RendererNegotiationSnapshot[] = [];
    const renderer = await GaussianRenderer.create(f.canvas, value => { snapshots.push(value); throw new Error('observer cannot change creation'); });
    try {
      expect(f.adapter.requestDevice).toHaveBeenCalledWith({ requiredLimits: { maxBufferSize: 512 * 1024 ** 2, maxStorageBufferBindingSize: 512 * 1024 ** 2 } });
      expect(renderer.negotiationSnapshot.status).toBe('ready'); expect(renderer.negotiationSnapshot).toBe(snapshots.at(-1));
      expect(renderer.negotiationSnapshot.adapter!.limits!.maxBufferSize).toBe(1024 ** 3);
      expect(renderer.negotiationSnapshot.requested!.features).toEqual([]); expect(renderer.negotiationSnapshot.device!.features).toEqual([]);
      expect(snapshots.map(value => value.stage)).toEqual(['start', 'adapter-request', 'adapter-observed', 'device-request', 'device-observed',
        'shader-compilation', 'pipeline-creation', 'renderer-creation', 'validation', 'ready']);
      expect(snapshots.every(value => value.observedAtMs !== null && value.observedAtMs >= 0)).toBe(true);
    } finally { renderer.dispose(); }
  });
  it('reports an actual adapter-request failure without inventing an adapter or request', async () => {
    const f = rendererFixture(), snapshots: RendererNegotiationSnapshot[] = [];
    f.gpu.requestAdapter.mockRejectedValueOnce(new Error('adapter refused'));
    await expect(GaussianRenderer.create(f.canvas, value => { snapshots.push(value); })).rejects.toThrow('adapter refused');
    expect(snapshots.at(-1)).toMatchObject({ status: 'failed', stage: 'adapter-request', adapter: null, requested: null,
      failure: { stage: 'adapter-request', reason: 'adapter refused' } });
    expect(f.adapter.requestDevice).not.toHaveBeenCalled();
  });
  it('retains advertised and requested values when the actual device request rejects', async () => {
    const f = rendererFixture(), snapshots: RendererNegotiationSnapshot[] = [];
    f.adapter.requestDevice.mockRejectedValueOnce(new Error('device refused'));
    await expect(GaussianRenderer.create(f.canvas, value => { snapshots.push(value); })).rejects.toThrow('device refused');
    expect(snapshots.at(-1)).toMatchObject({ status: 'failed', stage: 'device-request', device: null,
      requested: { features: [], limits: { maxBufferSize: 512 * 1024 ** 2 } }, failure: { stage: 'device-request', reason: 'device refused' } });
    expect(f.destroy).not.toHaveBeenCalled();
  });
  it('tags actual shader compilation failure and preserves existing device cleanup', async () => {
    const f = rendererFixture(), snapshots: RendererNegotiationSnapshot[] = [];
    f.device.createShaderModule.mockImplementation(() => ({ getCompilationInfo: vi.fn(async () => ({ messages: [{ type: 'error', lineNum: 3, message: 'actual shader error' }] })) }));
    await expect(GaussianRenderer.create(f.canvas, value => { snapshots.push(value); })).rejects.toThrow('Shader 3: actual shader error');
    expect(snapshots.at(-1)).toMatchObject({ status: 'failed', stage: 'shader-compilation', failure: { stage: 'shader-compilation', reason: 'Shader 3: actual shader error' } });
    expect(f.device.popErrorScope).toHaveBeenCalledTimes(3); expect(f.destroy).toHaveBeenCalledTimes(1);
  });
  it('does not publish ready when the final actual validation scope reports failure', async () => {
    const f = rendererFixture(), snapshots: RendererNegotiationSnapshot[] = [];
    f.device.popErrorScope.mockResolvedValueOnce({ message: 'actual final validation error' });
    await expect(GaussianRenderer.create(f.canvas, value => { snapshots.push(value); })).rejects.toThrow('actual final validation error');
    expect(snapshots).toHaveLength(10); expect(snapshots.at(-1)).toMatchObject({ status: 'failed', stage: 'validation',
      failure: { stage: 'validation', reason: 'actual final validation error' } });
    expect(snapshots.some(snapshot => snapshot.status === 'ready')).toBe(false);
    expect(f.context.unconfigure).toHaveBeenCalledTimes(1); expect(f.device.popErrorScope).toHaveBeenCalledTimes(3);
  });
  it('counts only actual display submissions, excluding early geometry preparation and rejected submission', () => {
    const submit = vi.fn(), context = { getCurrentTexture: () => ({ createView: () => ({}) }) };
    const renderer = Object.assign(Object.create(GaussianRenderer.prototype), {
      submittedDisplayFrames: 0, frames: 0, canvas: { width: 64, height: 48, dataset: {} }, context, requireScene() {}, requestGeometryTarget: vi.fn(),
      device: { createCommandEncoder: () => ({ beginRenderPass: () => ({ end() {} }), finish: () => ({}) }), queue: { submit } },
    }) as GaussianRenderer;
    const camera = { background: 'black' } as CameraController;
    renderer.render(undefined, camera); expect(renderer.frameSubmissionSequence).toBe(1);
    renderer.frames = 1000;
    renderer.render({ kind: 'geometry' } as RenderableScene, camera); expect(renderer.frameSubmissionSequence).toBe(1);
    submit.mockImplementationOnce(() => { throw new Error('actual submit rejection'); });
    expect(() => renderer.render(undefined, camera)).toThrow('actual submit rejection'); expect(renderer.frameSubmissionSequence).toBe(1);
    renderer.render(undefined, camera); expect(renderer.frameSubmissionSequence).toBe(2);
  });
});
