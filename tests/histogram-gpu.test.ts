import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HISTOGRAM_ALLOCATION_BYTES, HistogramSampler } from '../src/renderer/webgpu/histogram';
import type { RenderableScene } from '../src/renderer/webgpu/renderer';

function deferred() {
  let resolve!: () => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
function fixture() {
  let mapGate: ReturnType<typeof deferred> | undefined;
  let queueGate: ReturnType<typeof deferred> | undefined;
  let allocationFailure = false, scopeFailure = false, mapScopeFailure = false;
  const release = vi.fn(), invalidate = vi.fn(), publish = vi.fn(), unavailable = vi.fn();
  const admit = vi.fn(() => release);
  const buffers: { label: string; destroy: ReturnType<typeof vi.fn>; unmap: ReturnType<typeof vi.fn>;
    mapAsync: ReturnType<typeof vi.fn> }[] = [];
  const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() };
  const queue = { writeBuffer: vi.fn(), submit: vi.fn(),
    onSubmittedWorkDone: vi.fn(() => queueGate?.promise ?? Promise.resolve()) };
  const device = {
    queue, pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(() => {
      const fail = scopeFailure; scopeFailure = false;
      return Promise.resolve(fail ? { message: 'Optional histogram validation failed.' } : null);
    }),
    createShaderModule: vi.fn(() => ({})),
    createComputePipeline: vi.fn(() => ({ getBindGroupLayout: vi.fn(() => ({})) })),
    createBuffer: vi.fn(({ label }: GPUBufferDescriptor) => {
      if (allocationFailure && buffers.length === 1) throw new Error('Optional allocation failed.');
      const buffer = { label: label!, destroy: vi.fn(), unmap: vi.fn(),
        mapAsync: vi.fn(() => {
          if (mapScopeFailure) scopeFailure = true;
          return mapGate?.promise ?? Promise.resolve();
        }),
        getMappedRange: vi.fn(() => new Uint32Array(768).fill(7).buffer) };
      buffers.push(buffer); return buffer;
    }),
    createBindGroup: vi.fn(() => ({})),
    createCommandEncoder: vi.fn(() => ({ clearBuffer: vi.fn(), beginComputePass: () => pass,
      copyBufferToBuffer: vi.fn(), finish: vi.fn(() => ({})) })),
  } as unknown as GPUDevice;
  const sampler = new HistogramSampler(device, 12, { admit, invalidate, publish, unavailable });
  const texture = { createView: vi.fn(() => ({})) } as unknown as GPUTexture;
  const scene = { retired: false } as RenderableScene;
  const frame = (identity: object, frameNumber = 1) => ({ identity, scene, frame: frameNumber, width: 640, height: 480 });
  const observe = (identity: object, frameNumber = 1) => sampler.observe(texture, frame(identity, frameNumber));
  const warm = async (identity: object) => {
    sampler.setEnabled(true); observe(identity); await settle(); invalidate.mockClear();
  };
  return { sampler, texture, scene, observe, warm, buffers, queue, pass, release, admit, invalidate, publish, unavailable,
    gateMap: () => (mapGate = deferred()), gateQueue: () => (queueGate = deferred()),
    failAllocation: () => { allocationFailure = true; }, failScope: () => { scopeFailure = true; },
    failMapScope: () => { mapScopeFailure = true; } };
}

beforeEach(() => {
  vi.useFakeTimers({ now: 0, toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  vi.stubGlobal('GPUBufferUsage', { STORAGE: 1, COPY_SRC: 2, COPY_DST: 4, MAP_READ: 8, UNIFORM: 16 });
  vi.stubGlobal('GPUMapMode', { READ: 1 });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('optional rendered histogram lifecycle', () => {
  it('allocates lazily, samples once and stops waking a settled view', async () => {
    const f = fixture(), identity = {};
    f.observe(identity); expect(f.buffers).toHaveLength(0);
    await f.warm(identity);
    expect(f.admit).toHaveBeenCalledWith(HISTOGRAM_ALLOCATION_BYTES);
    expect(HISTOGRAM_ALLOCATION_BYTES).toBe(12304);
    f.observe(identity, 9); await settle();
    expect(f.queue.submit).toHaveBeenCalledTimes(1);
    expect(f.pass.dispatchWorkgroups).toHaveBeenCalledWith(16, 9);
    expect(f.publish).toHaveBeenCalledWith(expect.objectContaining({ width: 256, height: 144, frame: 9, deviceEpoch: 12 }), f.scene);
    f.observe(identity, 10); await vi.advanceTimersByTimeAsync(5000);
    expect(f.queue.submit).toHaveBeenCalledTimes(1);
    expect(f.invalidate).not.toHaveBeenCalled();
    f.sampler.dispose(); await settle(); expect(f.release).toHaveBeenCalledTimes(1);
  });

  it('coalesces changing frames to one final wakeup at five samples per second', async () => {
    const f = fixture(), first = {}, final = {};
    await f.warm(first); f.observe(first); await settle();
    await vi.advanceTimersByTimeAsync(50); f.observe({});
    await vi.advanceTimersByTimeAsync(50); f.observe(final);
    expect(f.queue.submit).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(99); expect(f.invalidate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(f.invalidate).toHaveBeenCalledTimes(1);
    f.observe(final); await settle();
    expect(f.queue.submit).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000); expect(f.invalidate).toHaveBeenCalledTimes(1);
    f.sampler.dispose(); await settle();
  });

  it('ignores stale in-flight frames and maps only one staging buffer at a time', async () => {
    const f = fixture(), first = {}, last = {};
    await f.warm(first); const gate = f.gateMap();
    f.observe(first); await settle();
    await vi.advanceTimersByTimeAsync(500); f.observe(last);
    expect(f.buffers[1].mapAsync).toHaveBeenCalledTimes(1);
    gate.resolve(); await settle(); expect(f.publish).not.toHaveBeenCalled();
    expect(f.invalidate).toHaveBeenCalledTimes(1);
    f.observe(last, 7); await settle();
    expect(f.buffers[1].mapAsync).toHaveBeenCalledTimes(2);
    expect(f.publish).toHaveBeenCalledOnce();
    expect(f.publish.mock.calls[0][0].frame).toBe(7);
    f.sampler.dispose(); await settle();
  });

  it('keeps the lease until mapping and GPU retirement settle across hide and re-enable', async () => {
    const f = fixture(), first = {}, replacement = {};
    await f.warm(first); const map = f.gateMap();
    f.observe(first); await settle(); const queue = f.gateQueue();
    f.sampler.setEnabled(false); f.sampler.setEnabled(true); f.observe(replacement);
    expect(f.buffers).toHaveLength(3); expect(f.release).not.toHaveBeenCalled();
    map.resolve(); await settle();
    expect(f.publish).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled();
    expect(f.buffers.every(buffer => buffer.destroy.mock.calls.length === 0)).toBe(true);
    queue.resolve(); await settle(); expect(f.release).toHaveBeenCalledTimes(1);
    f.observe(replacement); await settle(); expect(f.buffers).toHaveLength(6);
    await vi.advanceTimersByTimeAsync(200); f.observe(replacement); await settle();
    expect(f.publish).toHaveBeenCalledOnce();
    f.sampler.dispose(); await settle(); expect(f.release).toHaveBeenCalledTimes(2);
  });

  it('retires a partially failed allocation and reports the optional feature unavailable once', async () => {
    const f = fixture(), identity = {}; f.failAllocation();
    await f.warm(identity); await settle();
    expect(f.unavailable).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledOnce();
    expect(f.buffers[0].destroy).toHaveBeenCalledOnce();
    f.observe(identity); await vi.advanceTimersByTimeAsync(2000);
    expect(f.admit).toHaveBeenCalledOnce(); expect(f.invalidate).not.toHaveBeenCalled();
    f.sampler.setEnabled(false); f.sampler.setEnabled(true); f.observe({}); await settle();
    expect(f.admit).toHaveBeenCalledOnce(); expect(f.unavailable).toHaveBeenCalledTimes(2);
    f.sampler.reset(); f.observe({}); await settle();
    expect(f.admit).toHaveBeenCalledOnce(); expect(f.unavailable).toHaveBeenCalledTimes(3);
    f.sampler.dispose();
  });

  it('contains command validation and mapping failure without publishing or leaking buffers', async () => {
    for (const failure of ['command', 'map-rejection', 'map-validation']) {
      const f = fixture(), identity = {}; await f.warm(identity);
      const gate = failure === 'map-rejection' ? f.gateMap() : undefined;
      if (failure === 'command') f.failScope();
      if (failure === 'map-validation') f.failMapScope();
      f.observe(identity); await settle();
      gate?.reject(new Error('Device map failed.')); await settle();
      expect(f.unavailable).toHaveBeenCalledOnce(); expect(f.publish).not.toHaveBeenCalled();
      expect(f.release).toHaveBeenCalledOnce();
      expect(f.buffers.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
      f.sampler.dispose();
    }
  });
});
