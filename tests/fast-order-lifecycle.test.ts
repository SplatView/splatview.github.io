import { afterEach, expect, it, vi } from 'vitest';
import { allocateFastOrder } from '../src/renderer/webgpu/fastOrder';
import { GaussianRenderer, GpuScene } from '../src/renderer/webgpu/renderer';
import { ResourceLedger } from '../src/document/resources';
import { planFastOrder } from '../src/renderer/webgpu/fastOrderLayout';

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 32; i++) await Promise.resolve(); };
afterEach(() => vi.unstubAllGlobals());
function fixture(options: { refuse?: boolean; holdPipelines?: boolean; holdValidation?: boolean; holdFence?: boolean } = {}) {
  vi.stubGlobal('GPUBufferUsage', { STORAGE: 128, UNIFORM: 64, COPY_SRC: 4, COPY_DST: 8, INDIRECT: 256 });
  const compile = deferred<void>(), validation = deferred<null>(), fence = deferred<void>();
  if (!options.holdPipelines) compile.resolve(); if (!options.holdValidation) validation.resolve(null); if (!options.holdFence) fence.resolve();
  const ledger = new ResourceLedger(16 * 1024 ** 2), releases = vi.fn();
  const buffers: { label: string; size: number; destroy: ReturnType<typeof vi.fn> }[] = [];
  const pipeline = { getBindGroupLayout: () => ({}) };
  let pops = 0;
  const device = {
    limits: { maxComputeWorkgroupStorageSize: 16384, maxStorageBufferBindingSize: 128 * 1024 ** 2, maxBufferSize: 128 * 1024 ** 2 },
    pushErrorScope() {}, popErrorScope: () => ++pops <= 3 ? Promise.resolve(null) : validation.promise,
    createShaderModule: vi.fn(() => ({})), createComputePipelineAsync: () => compile.promise.then(() => pipeline),
    createBindGroup: vi.fn(() => ({})),
    createBuffer({ label, size }: { label: string; size: number }) { const buffer = { label, size, destroy: vi.fn() }; buffers.push(buffer); return buffer; },
    queue: { writeBuffer() {}, onSubmittedWorkDone: () => fence.promise },
  };
  const renderer = Object.assign(Object.create(GaussianRenderer.prototype), { device, frame:{size:320,destroy:vi.fn()},raster: pipeline, pipelines: Object.fromEntries(['generate','rank','local','blocks','bins','scatter'].map(name=>[name,pipeline])),
    requireScene(value?: { retired: boolean }) { if (value?.retired) throw new Error('Retired scene'); },
    admitSortScratch(bytes: number) { if (options.refuse) throw new Error('Memory pressure'); const credit = ledger.reserve('render', bytes); return () => { releases(); credit(); }; },
    finish: () => fence.promise,
    trimSurfaceResources() {},
  }) as GaussianRenderer;
  const base = () => ({ destroy: vi.fn(), size: 4096 });
  const scene = Object.assign(Object.create(GpuScene.prototype), { renderer, count: 262144, retired: false,
    buffers: Object.fromEntries(['pairsA','pairsB','splats','states','ranks','projected','counts','groupOffsets','groupSums','blockOffsets','binTotals','binOffsets'].map(name=>[name,base()])),
    ordered:base(),previewBuffers: {}, params: [base()], stateBytes: new Uint8Array(262144),
  }) as GpuScene;
  return { renderer, scene, device, ledger, releases, buffers, compile, validation, fence };
}
it('refused optional credit keeps the exact baseline without starting compilation or allocation', async () => {
  const f = fixture({ refuse: true });
  expect(await allocateFastOrder(f.renderer, f.scene)).toBeUndefined();
  expect(f.device.createShaderModule).not.toHaveBeenCalled(); expect(f.buffers).toHaveLength(0); expect(f.ledger.usage.bytes).toBe(0);
});
it('keeps the planned credit through held pipeline preparation, then rejects a retired scene', async () => {
  const f = fixture({ holdPipelines: true }), pending = allocateFastOrder(f.renderer, f.scene);
  await flush(); expect(f.ledger.usage.bytes).toBe(planFastOrder(262144).bytes); expect(f.buffers).toHaveLength(0);
  f.scene.retired = true; f.compile.resolve(); expect(await pending).toBeUndefined();
  expect(f.releases).toHaveBeenCalledTimes(1); expect(f.ledger.usage.bytes).toBe(0);
});
it('retains unsubmitted optional allocation credit through held validation', async () => {
  const f = fixture({ holdValidation: true, holdFence: true }), pending = allocateFastOrder(f.renderer, f.scene);
  await flush(); expect(f.buffers.length).toBeGreaterThan(0);expect(f.device.createBindGroup.mock.calls.length).toBeGreaterThan(5);
  expect(f.buffers.every(buffer=>buffer.destroy.mock.calls.length===0)).toBe(true);expect(f.releases).not.toHaveBeenCalled();
  f.scene.retired = true; f.validation.resolve(null);expect(await pending).toBeUndefined();
  expect(f.buffers.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true); expect(f.releases).toHaveBeenCalledTimes(1); expect(f.ledger.usage.bytes).toBe(0);
});
it('the scene retains optional buffers and credit until its genuine finish boundary', async () => {
  const f = fixture(); f.scene.fastOrder = await allocateFastOrder(f.renderer, f.scene);
  const retirement=deferred<void>();f.renderer.finish=()=>retirement.promise;
  expect(f.scene.fastOrder).toBeDefined(); const disposing = f.scene.dispose(); await flush();
  expect(f.ledger.usage.bytes).toBeGreaterThan(0); expect(f.releases).not.toHaveBeenCalled();
  retirement.resolve(); await disposing; await f.scene.dispose();
  expect(f.buffers.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true); expect(f.releases).toHaveBeenCalledTimes(1); expect(f.ledger.usage.bytes).toBe(0);
});
it('close joins an allocation held in optional compilation and its failed scene cleanup',async()=>{
  const f=fixture({holdPipelines:true});let closed=false,disposed=false;
  Object.assign(f.renderer,{scenePreparations:new Set(),scene:()=>f.scene,queryQueue:Promise.resolve(),retiringGeometryDepth:new Set(),
    steady:{finish:()=>Promise.resolve()},histogram:{finish:()=>Promise.resolve()},dispose:()=>{disposed=true;},
    requireScene(scene?:GpuScene){if(disposed||scene?.retired)throw new Error('Retired graphics owner');}});
  const allocation=f.renderer.allocateScene(f.scene.count,0).catch(()=>undefined);await flush();
  expect(f.ledger.usage.bytes).toBeGreaterThan(0);
  const closing=f.renderer.close().then(()=>{closed=true;});await flush();
  expect(closed).toBe(false);expect(f.releases).not.toHaveBeenCalled();
  f.compile.resolve();await Promise.all([allocation,closing]);
  expect(f.scene.retired).toBe(true);expect(f.ledger.usage.bytes).toBe(0);expect(f.releases).toHaveBeenCalledTimes(1);
});
it('independently admitted compaction does not inflate base mirror/native coverage bytes',async()=>{
  const f=fixture(),base=f.scene.allocationBytes;
  f.scene.fastOrder=await allocateFastOrder(f.renderer,f.scene);
  expect(f.scene.fastOrder).toBeDefined();expect(f.ledger.usage.bytes).toBe(planFastOrder(f.scene.count).bytes);
  expect(f.scene.allocationBytes).toBe(base);
  await f.scene.dispose();expect(f.ledger.usage.bytes).toBe(0);expect(f.releases).toHaveBeenCalledTimes(1);
});
