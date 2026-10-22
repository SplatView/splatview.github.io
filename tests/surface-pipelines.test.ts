import { describe, expect, it, vi } from 'vitest';
import { GaussianRenderer } from '../src/renderer/webgpu/renderer';
import { forgetSurfacePipelines, prepareSurfacePipelines } from '../src/renderer/webgpu/surfacePipelines';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
function preparationFixture() {
  const events: string[] = [], pending: { entry: string; gate: ReturnType<typeof deferred<GPUComputePipeline>> }[] = [];
  let scopeFailure = false;
  const renderer = {
    lost: false,
    requireScene: vi.fn(() => { if (renderer.lost) throw new Error('The graphics device is unavailable.'); }),
    device: {
      pushErrorScope: vi.fn((kind: string) => events.push(`push:${kind}`)),
      popErrorScope: vi.fn(() => {
        events.push('pop'); const fail = scopeFailure; scopeFailure = false;
        return Promise.resolve(fail ? { message: 'Injected scope failure.' } : null);
      }),
      createShaderModule: vi.fn(() => ({})),
      createComputePipelineAsync: vi.fn((descriptor: GPUComputePipelineDescriptor) => {
        events.push(`pipeline:${descriptor.compute.entryPoint}`);
        const gate = deferred<GPUComputePipeline>(); pending.push({ entry: descriptor.compute.entryPoint!, gate });
        return gate.promise;
      }),
    },
    checkedAllocation: GaussianRenderer.prototype.checkedAllocation,
  };
  const finish = () => pending.forEach(({ entry, gate }) => gate.resolve({ label: entry } as GPUComputePipeline));
  return { renderer: renderer as unknown as GaussianRenderer, pending, events, finish,
    failScope: () => { scopeFailure = true; }, lose: () => { renderer.lost = true; } };
}

describe('asynchronous surface pipeline preparation', () => {
  it('shares asynchronous base compilation and pops every scope before yielding', async () => {
    const f = preparationFixture();
    const first = prepareSurfacePipelines(f.renderer), second = prepareSurfacePipelines(f.renderer);
    expect(f.pending.map(value => value.entry)).toEqual(['bin', 'scatter', 'sortTile', 'composite', 'prepareAuxiliary']);
    expect(f.events.slice(-3)).toEqual(['pop', 'pop', 'pop']);
    expect(f.renderer.device.createShaderModule).toHaveBeenCalledOnce();
    f.finish();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b); expect(a.markVisible).toBeUndefined();
    expect(f.renderer.device.createComputePipelineAsync).toHaveBeenCalledTimes(5);
  });
  it('compiles optional visibility only on demand and shares its pending compilation', async () => {
    const f = preparationFixture(), base = prepareSurfacePipelines(f.renderer); f.finish(); await base;
    const first = prepareSurfacePipelines(f.renderer, { visible: true });
    const second = prepareSurfacePipelines(f.renderer, { visible: true }); await settle();
    expect(f.pending.filter(value => value.entry === 'markVisible')).toHaveLength(1);
    expect(f.events.slice(-3)).toEqual(['pop', 'pop', 'pop']);
    f.finish();
    const [a, b] = await Promise.all([first, second]);
    expect(a.markVisible).toBe(b.markVisible); expect(a.markVisible?.label).toBe('markVisible');
    expect(f.renderer.device.createComputePipelineAsync).toHaveBeenCalledTimes(6);
  });
  it('evicts a rejected compilation and permits a later query to retry', async () => {
    const f = preparationFixture(), failed = prepareSurfacePipelines(f.renderer);
    const refusal = expect(failed).rejects.toThrow('Injected compilation failure.');
    f.pending[0].gate.reject(new Error('Injected compilation failure.')); f.finish(); await refusal;
    const retried = prepareSurfacePipelines(f.renderer); f.finish();
    expect((await retried).bin.label).toBe('bin');
    expect(f.renderer.device.createShaderModule).toHaveBeenCalledTimes(2);
  });
  it('joins compilation when an allocation scope fails and does not cache the failed scope', async () => {
    const f = preparationFixture(); f.failScope();
    const failed = prepareSurfacePipelines(f.renderer);
    const refusal = expect(failed).rejects.toThrow('Injected scope failure.');
    f.finish(); await refusal;
    const retried = prepareSurfacePipelines(f.renderer); f.finish(); await retried;
    expect(f.renderer.device.pushErrorScope).toHaveBeenCalledTimes(6);
    expect(f.renderer.device.popErrorScope).toHaveBeenCalledTimes(6);
  });
  it('rejects a device lost during compilation and forgets explicit renderer teardown', async () => {
    const f = preparationFixture(), pending = prepareSurfacePipelines(f.renderer);
    const refusal = expect(pending).rejects.toThrow(/unavailable|lost/);
    f.lose(); f.finish(); await refusal;
    const available = preparationFixture(), first = prepareSurfacePipelines(available.renderer);
    available.finish(); await first; forgetSurfacePipelines(available.renderer);
    const second = prepareSurfacePipelines(available.renderer); available.finish(); await second;
    expect(available.renderer.device.createShaderModule).toHaveBeenCalledTimes(2);
  });
});

