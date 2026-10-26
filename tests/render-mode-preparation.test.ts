import { describe, expect, it, vi } from 'vitest';
import { SteadySplats } from '../src/renderer/webgpu/steady';
import { DEFAULT_STEADY_SETTINGS } from '../src/renderer/steadySettings';

function deferred() {
  let resolve!: (value: object) => void, reject!: (error: Error) => void;
  const promise = new Promise<object>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const compilers = Array.from({ length: 4 }, deferred);
  let next = 0;
  const compile = vi.fn(() => compilers[next++].promise);
  const device = { createShaderModule: vi.fn(() => ({})),
    limits: { maxTextureDimension2D: 8192, maxComputeWorkgroupsPerDimension: 65535, maxBufferSize: 128 * 1024 ** 2, maxStorageBufferBindingSize: 128 * 1024 ** 2 },
    createRenderPipelineAsync: compile, createComputePipelineAsync: compile,
    createTexture: vi.fn(), createBuffer: vi.fn() };
  const callbacks = { admit: vi.fn(), invalidate: vi.fn(), status: vi.fn() };
  const steady = new SteadySplats(device as unknown as GPUDevice, 'bgra8unorm', {} as GPUBuffer, callbacks);
  return { steady, compilers, compile, device, callbacks };
}
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

describe('optional SteadySplats shader preparation', () => {
  it('shares concurrent asynchronous compilers without allocating frame buffers or selecting the mode', async () => {
    const f = fixture(), before = f.steady.snapshot;
    const first = f.steady.preparePipelines(), second = f.steady.preparePipelines();
    expect(first).toBe(second); await flush(); expect(f.compile).toHaveBeenCalledTimes(4);
    f.compilers.forEach((compiler, index) => compiler.resolve({ index }));
    await first; await f.steady.preparePipelines();
    expect(f.compile).toHaveBeenCalledTimes(4);
    expect(f.steady.snapshot).toEqual(before); expect(f.callbacks.status).not.toHaveBeenCalled();
    expect(f.callbacks.admit).not.toHaveBeenCalled(); expect(f.device.createTexture).not.toHaveBeenCalled();
    expect(f.device.createBuffer).not.toHaveBeenCalled();
    f.steady.dispose(); await f.steady.finish();
  });
  it('waits for every sibling compiler before rejecting, then permits a retry', async () => {
    const f = fixture(); let settled = false;
    const task = f.steady.preparePipelines();
    void task.then(() => { settled = true; }, () => { settled = true; });
    await flush(); f.compilers[0].reject(new Error('compiler refused')); await flush();
    expect(settled).toBe(false);
    f.compilers.slice(1).forEach(compiler => compiler.resolve({}));
    await expect(task).rejects.toThrow('compiler refused');
    f.compile.mockImplementation(async () => ({})); await f.steady.preparePipelines();
    expect(f.compile).toHaveBeenCalledTimes(8); expect(f.callbacks.admit).not.toHaveBeenCalled();
    f.steady.dispose(); await f.steady.finish();
  });
  it('shutdown joins pending compilation and prevents its late publication', async () => {
    const f = fixture(), task = f.steady.preparePipelines();
    const rejected = expect(task).rejects.toMatchObject({ name: 'AbortError' });
    await flush(); f.steady.dispose(); let finished = false;
    const joining = f.steady.finish().then(() => { finished = true; });
    await flush(); expect(finished).toBe(false);
    f.compilers.forEach(compiler => compiler.resolve({})); await Promise.all([rejected, joining]);
    expect(f.callbacks.admit).not.toHaveBeenCalled();
    await expect(f.steady.preparePipelines()).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('switching back to Sorted during compilation prevents later optional allocation', async () => {
    const f = fixture();
    f.steady.configure({ ...DEFAULT_STEADY_SETTINGS, mode: 'steady' }); f.steady.ready(4, 4);
    await flush(); f.steady.configure(DEFAULT_STEADY_SETTINGS);
    f.compilers.forEach(compiler => compiler.resolve({})); await f.steady.finish();
    expect(f.steady.snapshot).toMatchObject({ status: 'sorted', allocationBytes: 0, frame: 0 });
    expect(f.callbacks.admit).not.toHaveBeenCalled(); expect(f.device.createTexture).not.toHaveBeenCalled();
    f.steady.dispose();
  });
});
