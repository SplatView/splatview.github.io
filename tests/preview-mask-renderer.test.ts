import { afterEach, describe, expect, it, vi } from 'vitest';
import { GpuScene, StaleGpuQueryError, type GaussianRenderer, type PreviewMaskChannel } from '../src/renderer/webgpu/renderer';

type Buffer = GPUBuffer & { bytes: Uint8Array; destroy: ReturnType<typeof vi.fn> };
type Group = GPUBindGroup & { entries: [number, GPUBuffer][] };
const mask = (...states: number[]) => Uint8Array.from(states).buffer;
function fixture() {
  vi.stubGlobal('GPUBufferUsage', { STORAGE: 1, COPY_DST: 2, COPY_SRC: 4, UNIFORM: 8 });
  const buffers: Buffer[] = [];
  let failBind = false, allocationFailure = false;
  const queue = { writeBuffer: vi.fn((buffer: Buffer, offset: number, data: ArrayBufferView) => {
    buffer.bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), offset);
  }), onSubmittedWorkDone: vi.fn(async () => {}) };
  const renderer = {
    frame: {}, query: {}, queryOutput: {}, deviceEpoch: 1,
    finish: () => queue.onSubmittedWorkDone(),
    pipelines: Object.fromEntries(['project', 'generate', 'rank', 'scatter', 'local', 'blocks', 'bins', 'pick'].map(key => [key, { key }])), raster: {},
    device: { limits: { maxBufferSize: 1e9, maxStorageBufferBindingSize: 1e9 }, queue,
      createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
        const value = { ...descriptor, bytes: new Uint8Array(descriptor.size), destroy: vi.fn() } as unknown as Buffer;
        buffers.push(value); return value;
      }) },
    bind: vi.fn((_pipeline: unknown, entries: [number, GPUBuffer][]) => {
      if (failBind) throw new Error('Injected group allocation failure');
      return { entries } as Group;
    }),
    async checkedAllocation<T>(create: () => T, release: (value: T) => void | Promise<void>) {
      const value = create();
      if (allocationFailure) { await release(value); throw new Error('Injected settled device allocation error'); }
      return value;
    },
  };
  const scene = new GpuScene(renderer as unknown as GaussianRenderer, 3, 0);
  scene.masks(mask(1, 1, 2)); scene.sortDirty = false;
  const binding = (group: GPUBindGroup, slot: number) => (group as Group).entries.find(([key]) => key === slot)![1];
  return { scene, renderer, buffers, binding, failBind: () => { failBind = true; }, failAllocation: () => { allocationFailure = true; } };
}
afterEach(() => vi.unstubAllGlobals());

describe('independent frozen preview targets and atomic canonical masks', () => {
  it('guards exactly the untouched live copy suffix and updates only when canonical masks publish', async () => {
    const f = fixture();
    f.scene.setDuplicateRange({ first: 1, count: 2 });
    expect(f.scene.duplicateSelectionGuarded).toBe(false);
    f.scene.masks(mask(0, 1, 1));
    expect(f.scene.duplicateSelectionGuarded).toBe(true);
    const partial = await f.scene.stageMasks(mask(0, 1, 0));
    expect(f.scene.duplicateSelectionGuarded).toBe(true);
    partial.publish();
    expect(f.scene.duplicateSelectionGuarded).toBe(false);
    f.scene.masks(mask(1, 1, 1));
    expect(f.scene.duplicateSelectionGuarded).toBe(false);
    f.scene.masks(mask(0, 1, 3));
    expect(f.scene.duplicateSelectionGuarded).toBe(false);
    f.scene.masks(mask(0, 1, 1));
    expect(f.scene.duplicateSelectionGuarded).toBe(true);
    // An attribute edit changes the native Scene owner even if its mask stays.
    f.scene.setDuplicateRange(null);
    expect(f.scene.duplicateSelectionGuarded).toBe(false);
    await partial.dispose(); await f.scene.dispose();
  });
  it('rejects an invalid copy suffix without replacing the previous guarded marker', () => {
    const f = fixture(); f.scene.masks(mask(0, 1, 1));
    f.scene.setDuplicateRange({ first: 1, count: 2 });
    expect(() => f.scene.setDuplicateRange({ first: 1, count: 1 })).toThrow();
    expect(f.scene.duplicateSelectionGuarded).toBe(true);
  });
  it('aliases absent preview owners without allocating three scene-sized copies', () => {
    const f = fixture();
    for (const channel of ['colorBase', 'transformBase', 'opacityBase'] as const) expect(f.scene.previewMask(channel)).toBe(f.scene.buffers.states);
    for (const slot of [2, 8, 9, 10]) expect(f.binding(f.scene.projectGroup, slot)).toBe(f.scene.buffers.states);
    expect(f.binding(f.scene.sortStages[0].group, 11)).toBe(f.scene.buffers.states);
    expect(f.buffers).toHaveLength(20);
  });
  it.each(['colorBase', 'transformBase', 'opacityBase'] as const)('replaces %s eligibility without changing canonical selection or deletion', async channel => {
    const f = fixture(), canonical = f.scene.buffers.states, before = f.scene.allocationBytes;
    const sourceRevision = f.scene.sourceRevision, selectedRevision = f.scene.selectedRevision;
    const update = await f.scene.stagePreviewMasks(mask(0, 1, 2), channel);
    expect(f.scene.previewMask(channel)).toBe(canonical); expect(update.allocationBytes).toBe(12);
    expect(update.retirementBytes).toBe(0); expect(update.retirementBuffers).toEqual([]);
    expect(update.publish()).toBeUndefined(); update.dispose();
    const target = f.scene.previewMask(channel) as Buffer;
    expect(Array.from(new Uint32Array(target.bytes.buffer))).toEqual([0, 1, 2]);
    expect(f.scene.buffers.states).toBe(canonical); expect(f.binding(f.scene.projectGroup, 2)).toBe(canonical);
    expect(f.binding(f.scene.projectGroup, { colorBase: 8, transformBase: 9, opacityBase: 10 }[channel])).toBe(target);
    expect(f.binding(f.scene.sortStages[0].group, 9)).toBe(canonical);
    expect(f.binding(f.scene.sortStages[0].group, 11)).toBe(channel === 'transformBase' ? target : canonical);
    expect(f.scene.sourceRevision).toBe(sourceRevision); expect(f.scene.selectedRevision).toBe(selectedRevision);
    expect(f.scene.previewMaskRevision(channel)).toBe(1); expect(f.scene.allocationBytes).toBe(before + 12);
    expect(f.scene.sortDirty).toBe(channel === 'transformBase'); expect(target.destroy).not.toHaveBeenCalled();
  });
  it('publishes clipped selection and all three frozen owners with one binding candidate', async () => {
    const f = fixture(), old = f.scene.buffers.states as Buffer;
    const update = await f.scene.stageMasks(mask(0, 1, 2), { colorBase: mask(1, 0, 2), transformBase: mask(0, 1, 2), opacityBase: mask(0, 0, 2) });
    expect(update.allocationBytes).toBe(51); expect(update.retirementBytes).toBe(15); expect(update.retirementBuffers).toEqual([old]);
    expect(f.scene.buffers.states).toBe(old); expect(update.publish()).toBe(old);
    expect(f.scene.selectedRevision).toBe(2); expect(f.scene.sourceRevision).toBe(1);
    expect(f.binding(f.scene.projectGroup, 2)).toBe(f.scene.buffers.states);
    for (const [slot, channel] of [[8, 'colorBase'], [9, 'transformBase'], [10, 'opacityBase']] as const)
      expect(f.binding(f.scene.projectGroup, slot)).toBe(f.scene.previewMask(channel));
    expect(old.destroy).not.toHaveBeenCalled();
    expect(() => update.publish()).toThrow(StaleGpuQueryError); update.dispose();
    for (const retired of update.retirementBuffers!) retired.destroy(); expect(old.destroy).toHaveBeenCalledOnce();
  });
  it('keeps unchanged owners while rebuilding canonical groups, then returns every replaced buffer for queued retirement', async () => {
    const f = fixture(); (await f.scene.stagePreviewMasks(mask(1, 0, 2), 'colorBase')).publish();
    const target = f.scene.previewMask('colorBase') as Buffer, old = f.scene.buffers.states as Buffer;
    const update = await f.scene.stageMasks(mask(0, 1, 2)); update.publish();
    expect(f.binding(f.scene.projectGroup, 8)).toBe(target); expect(f.binding(f.scene.projectGroup, 9)).toBe(f.scene.buffers.states);
    const clear = await f.scene.stageMasks(mask(0, 1, 2), { colorBase: null });
    expect(clear.allocationBytes).toBe(15); expect(clear.retirementBytes).toBe(27);
    expect(clear.retirementBuffers).toEqual([f.scene.buffers.states, target]); clear.publish();
    expect(f.scene.previewMask('colorBase')).toBe(f.scene.buffers.states); expect(target.destroy).not.toHaveBeenCalled();
    expect(old.destroy).not.toHaveBeenCalled();
  });
  it('clears a target without allocation and defers destruction to its caller', async () => {
    const f = fixture(), before = f.scene.allocationBytes;
    (await f.scene.stagePreviewMasks(mask(1, 0, 2), 'opacityBase')).publish();
    const target = f.scene.previewMask('opacityBase') as Buffer;
    const clear = await f.scene.stagePreviewMasks(null, 'opacityBase');
    expect(clear.allocationBytes).toBe(0); expect(clear.retirementBytes).toBe(12);
    expect(clear.publish()).toBe(target); expect(target.destroy).not.toHaveBeenCalled();
    expect(f.scene.allocationBytes).toBe(before); expect(f.binding(f.scene.projectGroup, 10)).toBe(f.scene.buffers.states);
  });
  it('refuses stale concurrent staging rather than rebinding a retired canonical or target buffer', async () => {
    const f = fixture(), first = await f.scene.stageMasks(mask(0, 1, 2));
    const second = await f.scene.stagePreviewMasks(mask(1, 0, 2), 'transformBase');
    first.publish(); expect(() => second.publish()).toThrow(StaleGpuQueryError);
    let done!: () => void;
    const fence = new Promise<void>(resolve => { done = resolve; });
    f.renderer.device.queue.onSubmittedWorkDone.mockImplementation(() => fence);
    const retiring = second.dispose(), candidate = f.buffers.at(-1) as Buffer;
    expect(candidate.destroy).not.toHaveBeenCalled();
    done(); await retiring; await second.dispose(); expect(candidate.destroy).toHaveBeenCalledOnce();
    expect(f.scene.previewMask('transformBase')).toBe(f.scene.buffers.states);
  });
  it.each(['bind', 'settled'] as const)('releases a refused %s candidate without publishing either owner', async failure => {
    const f = fixture(), canonical = f.scene.buffers.states, group = f.scene.projectGroup, before = f.scene.allocationBytes, start = f.buffers.length;
    let done!: () => void, entered!: () => void, settled = false;
    const fence = new Promise<void>(resolve => { done = resolve; }), joined = new Promise<void>(resolve => { entered = resolve; });
    f.renderer.device.queue.onSubmittedWorkDone.mockImplementation(() => { entered(); return fence; });
    if (failure === 'bind') f.failBind(); else f.failAllocation();
    const pending = f.scene.stageMasks(mask(0, 1, 2), { colorBase: mask(0, 1, 2) }).then(
      () => { settled = true; throw new Error('Refused candidate was accepted'); }, error => { settled = true; return error as Error; });
    await joined; expect(settled).toBe(false);
    for (const buffer of f.buffers.slice(start)) expect(buffer.destroy).not.toHaveBeenCalled();
    done(); expect((await pending).message).toMatch(/Injected/);
    expect(f.scene.buffers.states).toBe(canonical); expect(f.scene.projectGroup).toBe(group); expect(f.scene.allocationBytes).toBe(before);
    expect(f.buffers.slice(start)).toHaveLength(2); for (const buffer of f.buffers.slice(start)) expect(buffer.destroy).toHaveBeenCalledOnce();
  });
  it('validates every mask/channel before allocating a candidate', async () => {
    const f = fixture(), before = f.buffers.length;
    await expect(f.scene.stageMasks(mask(1, 0))).rejects.toThrow(/Invalid/);
    await expect(f.scene.stageMasks(mask(1, 0, 2), { opacityBase: mask(0, 7, 2) })).rejects.toThrow(/Invalid/);
    await expect(f.scene.stagePreviewMasks(mask(1, 0, 2), 'other' as PreviewMaskChannel)).rejects.toThrow(/Invalid/);
    expect(f.buffers).toHaveLength(before);
  });
  it('joins queued work before disposing active targets and rejects publication after retirement', async () => {
    const f = fixture(); (await f.scene.stagePreviewMasks(mask(1, 0, 2), 'opacityBase')).publish();
    const pending = await f.scene.stageMasks(mask(0, 1, 2)), target = f.scene.previewMask('opacityBase') as Buffer;
    let done!: () => void; const fence = new Promise<void>(resolve => { done = resolve; });
    f.renderer.device.queue.onSubmittedWorkDone.mockImplementation(() => fence);
    const disposing = f.scene.dispose(); expect(target.destroy).not.toHaveBeenCalled();
    expect(() => pending.publish()).toThrow(StaleGpuQueryError);
    const retiring = pending.dispose();
    done(); await disposing; await retiring; expect(target.destroy).toHaveBeenCalledOnce();
    await expect(f.scene.stagePreviewMasks(null, 'opacityBase')).rejects.toThrow(StaleGpuQueryError);
  });
});
