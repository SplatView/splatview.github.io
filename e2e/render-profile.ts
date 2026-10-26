import { GlRenderer } from '../src/renderer/webgl2/renderer';
import { GaussianRenderer } from '../src/renderer/webgpu/renderer';
import type { SceneRenderer } from '../src/renderer/contracts';

/** Bounded, fixture-owned observations; production does not install these wrappers. */
export function profileRenderer(renderer: SceneRenderer, stages = false) {
  let counts: Record<string, number> = {}, cpuMs: Record<string, number> = {};
  let work: object[] = [], gpuRasterMs: number[] = [], pending: WebGLQuery[] = [];
  let disjoint = 0;
  let stageGpuMs: Record<string, number[]> = {}, stageCpuMs: Record<string, number[]> = {};
  const stageSample = (group: Record<string, number[]>, name: string, ms: number) => {
    const values = group[name] ??= []; if (values.length < 4096) values.push(ms);
  };
  const observeCompletion = <T extends (...args: never[]) => Promise<unknown>>(name: string, action: T) =>
    ((...args: never[]) => { const start = performance.now(); return action(...args).finally(() => stageSample(stageCpuMs, name, performance.now() - start)); }) as T;
  const restore: (() => void)[] = [];
  const count = (key: string) => { counts[key] = (counts[key] ?? 0) + 1; };
  const wrap = <T extends object, K extends keyof T>(owner: T, key: K, action: (original: T[K]) => T[K]) => {
    const original = owner[key]; owner[key] = action(original); restore.push(() => { owner[key] = original; });
  };
  const timed = <A extends unknown[], R>(key: string, action: (...args: A) => R) => (...args: A): R => {
    count(key); const start = performance.now();
    try { return action(...args); } finally { cpuMs[key] = (cpuMs[key] ?? 0) + performance.now() - start; }
  };
  let collect = () => {};
  let timerStatus = 'unavailable: device was created without optional timestamp-query';
  if (renderer instanceof GlRenderer) {
    const gl = renderer.gl;
    if(stages) {
      const fence=renderer.fence.bind(renderer),retire=renderer.retireAfterFence.bind(renderer);
      wrap(renderer,'fence',()=>observeCompletion('fence-wall',fence));
      wrap(renderer,'retireAfterFence',()=>observeCompletion('retirement-wall',retire));
    }
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
    timerStatus = ext ? 'available: raster draw GPU timer queries, non-disjoint results only' : 'unavailable: EXT_disjoint_timer_query_webgl2';
    renderer.compute.observeWork = event => { if (work.length < 4096) work.push(event); };
    renderer.compute.observeStages = stages;
    let currentProgram:WebGLProgram|null=null;
    const stageQueries=new Map<WebGLQuery,string>();
    if(stages) wrap(gl,'useProgram',original=>(program=>{currentProgram=program;original.call(gl,program);}));
    for (const key of ['texSubImage2D', 'bufferSubData', 'getUniformLocation', 'getUniformBlockIndex', 'linkProgram', 'clientWaitSync', 'fenceSync', 'renderbufferStorage', 'createTexture', 'createBuffer', 'createFramebuffer', 'texSubImage3D'] as const)
      wrap(gl, key, original => timed(key, (...args: never[]) => (original as (...args: never[]) => unknown).apply(gl, args)) as typeof original);
    for(const key of ['drawArraysInstanced','drawElementsInstanced',...(stages?['drawArrays'] as const:[])] as const) wrap(gl, key, original => ((...args: never[]) => {
      const fullscreen=key==='drawArrays'; count(fullscreen?'fullscreenDraw':'rasterDraw');
      const programs=(renderer as unknown as {steady:{programs?:Record<string,WebGLProgram>}}).steady.programs;
      const stage=stages?(Object.entries(programs??{}).find(([,program])=>program===currentProgram)?.[0]??'sorted-gaussian'):'gaussian';
      const query = ext && pending.length < 1024 ? gl.createQuery() : null;
      if (query) gl.beginQuery(ext!.TIME_ELAPSED_EXT, query);
      const start=stages?performance.now():0;
      try { (original as (...args:never[])=>void).apply(gl, args); } finally {
        if(stages) stageSample(stageCpuMs,stage,performance.now()-start);
        if (query) { gl.endQuery(ext!.TIME_ELAPSED_EXT); pending.push(query); if(stages) stageQueries.set(query,stage); }
      }
    }));
    collect = () => {
      if (!ext) return;
      if (gl.getParameter(ext.GPU_DISJOINT_EXT)) {
        disjoint += pending.length; for (const query of pending) gl.deleteQuery(query); pending = []; stageQueries.clear(); return;
      }
      pending = pending.filter(query => {
        if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) return true;
        const ms=gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6,stage=stageQueries.get(query);
        if(stage) {stageSample(stageGpuMs,stage,ms);stageQueries.delete(query);}
        if(!stage || stage==='sample' || stage==='sorted-gaussian') gpuRasterMs.push(ms);
        gl.deleteQuery(query); return false;
      });
    };
    restore.push(() => { renderer.compute.observeWork = undefined; renderer.compute.observeStages=false; for (const query of pending) gl.deleteQuery(query); });
  } else if (renderer instanceof GaussianRenderer) {
    const device = renderer.device;
    wrap(device, 'createCommandEncoder', original => ((...args: Parameters<typeof original>) => {
      const encoder = original.apply(device, args), beginCompute = encoder.beginComputePass.bind(encoder), beginRender = encoder.beginRenderPass.bind(encoder);
      const observePass=<T extends {end():void}>(pass:T,name:string)=>{
        count(name); if(stages) {const start=performance.now(),end=pass.end.bind(pass);
          pass.end=()=>{end();stageSample(stageCpuMs,name,performance.now()-start);};} return pass;
      };
      encoder.beginComputePass = descriptor => observePass(beginCompute(descriptor),String(descriptor?.label ?? 'compute'));
      encoder.beginRenderPass = descriptor => observePass(beginRender(descriptor),String(descriptor.label ?? 'rasterDraw'));
      return encoder;
    }));
    wrap(device.queue, 'writeBuffer', original => timed('writeBuffer', original.bind(device.queue)) as typeof original);
  }
  return {
    take() { collect(); const value = { counts, cpuMs, work, gpuRasterMs, stageGpuMs,stageCpuMs,disjoint, pendingTimers: pending.length, timerStatus, workerScratch:renderer instanceof GlRenderer?renderer.compute.sortScratchSnapshot:undefined };
      counts = {}; cpuMs = {}; work = []; gpuRasterMs = []; stageGpuMs={};stageCpuMs={};disjoint = 0; return value; },
    dispose() { for (const action of restore.reverse()) action(); },
  };
}
