import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GlSteadySplats } from '../src/renderer/webgl2/steady';
import { preparePrograms } from '../src/renderer/webgl2/programPreparation';
import type { GlRenderer } from '../src/renderer/webgl2/renderer';

vi.mock('../src/renderer/webgl2/programPreparation', () => ({ preparePrograms: vi.fn() }));
beforeEach(() => vi.mocked(preparePrograms).mockReset());

function fixture() {
  const pending: Promise<void>[] = [];
  const renderer = { lost: false, capabilities: { steady: true, steadyReason: null as string | null }, gl: { deleteProgram: vi.fn() }, admitSteady: vi.fn(), onRenderStatus: vi.fn(),
    retireAfterFence: vi.fn((release: () => void) => release()),
    trackRetirement(task: Promise<void>) { pending.push(task); void task.catch(() => undefined); return task; } };
  const steady = new GlSteadySplats(renderer as unknown as GlRenderer);
  return { steady, renderer, pending };
}
const programs = () => Array.from({ length: 4 }, () => ({} as WebGLProgram));

describe('WebGL optional mode compilation ownership', () => {
  it('does not compile optional shaders when framebuffer support is unavailable', async () => {
    const f = fixture(); f.renderer.capabilities.steady = false; f.renderer.capabilities.steadyReason = 'missing float attachments';
    await expect(f.steady.preparePrograms()).rejects.toThrow('missing float attachments');
    expect(preparePrograms).not.toHaveBeenCalled(); expect(f.renderer.admitSteady).not.toHaveBeenCalled(); f.steady.dispose();
  });
  it('shares pending programs and preserves Sorted without optional frame admission', async () => {
    const f = fixture(); let release!: (value: WebGLProgram[]) => void;
    vi.mocked(preparePrograms).mockReturnValue(new Promise(resolve => { release = resolve; }));
    const first = f.steady.preparePrograms(), second = f.steady.preparePrograms();
    expect(first).toBe(second); expect(f.pending).toHaveLength(1);
    release(programs()); await first; await f.steady.preparePrograms();
    expect(preparePrograms).toHaveBeenCalledTimes(1);
    expect(f.steady.snapshot).toMatchObject({ status: 'sorted', allocationBytes: 0, frame: 0 });
    expect(f.renderer.admitSteady).not.toHaveBeenCalled(); expect(f.renderer.onRenderStatus).not.toHaveBeenCalled();
    f.steady.dispose(); expect(f.renderer.gl.deleteProgram).toHaveBeenCalledTimes(4);
  });
  it('deletes all late compiled programs when disposal precedes publication', async () => {
    const f = fixture(); let release!: (value: WebGLProgram[]) => void;
    vi.mocked(preparePrograms).mockReturnValue(new Promise(resolve => { release = resolve; }));
    const task = f.steady.preparePrograms(), rejected = expect(task).rejects.toMatchObject({ name: 'AbortError' });
    f.steady.dispose(); release(programs()); await rejected; await Promise.allSettled(f.pending);
    expect(f.renderer.gl.deleteProgram).toHaveBeenCalledTimes(4); expect(f.renderer.admitSteady).not.toHaveBeenCalled();
  });
  it('propagates a compiler failure and retries through the same owner', async () => {
    const f = fixture();
    vi.mocked(preparePrograms).mockRejectedValueOnce(new Error('compiler refused')).mockResolvedValueOnce(programs());
    await expect(f.steady.preparePrograms()).rejects.toThrow('compiler refused');
    await f.steady.preparePrograms(); expect(preparePrograms).toHaveBeenCalledTimes(2);
    f.steady.dispose(); expect(f.renderer.gl.deleteProgram).toHaveBeenCalledTimes(4);
  });
});
