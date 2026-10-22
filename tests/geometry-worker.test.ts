import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILD_DESCRIPTOR } from '../src/generated/buildIdentity';
import { BUILD_ID, PROTOCOL_VERSION, type NativeSummary, type WorkerRequest, type WorkerResponse } from '../src/document/types';
import type { GeometryDescriptor } from '../src/document/geometry';
import type { WasmModule } from '../src/workers/wasm';
import type { WorkerBootstrapResponse } from '../src/build/bootstrap';
import { validateNativeHeapSnapshot, WASM_PAGE_BYTES, type NativeHeapSnapshot } from '../src/document/nativeMemory';
import { validateNativeAllocationCensus, type NativeAllocationCensus } from '../src/document/allocationCensus';
import { emptyCensus } from './fixtures/allocation-census';

const runtime = vi.hoisted(() => ({ core: undefined as unknown as WasmModule }));
vi.mock('../src/workers/wasm', async importOriginal => ({ ...await importOriginal<typeof import('../src/workers/wasm')>(), loadCore: async () => runtime.core }));
vi.mock('../src/build/native', () => ({ nativeModuleIdentity: () => BUILD_DESCRIPTOR.native.core }));

function descriptor(kind: 1 | 2 = 2, vertexCount = 3): GeometryDescriptor {
  return { layoutVersion: 1, kind, vertexCount, triangleCount: kind === 2 ? 1 : 0, vertexStride: 16, indexStride: 4,
    vertexBytes: vertexCount * 16, indexBytes: kind === 2 ? 12 : 0, revision: 0, contentRevision: 0 };
}
function summary(geometry = descriptor()): NativeSummary {
  return { ok: true, selectionCommitRevision: 0, undoSelectionRevision: 0, toleranceRecorded: null, toleranceRange: null, toleranceSessionId: null, toleranceTool: null, duplicateRange: null, loaded: true, count: geometry.vertexCount, sourceCount: geometry.vertexCount,
    shDegree: 0, format: 'PLY', kind: geometry.kind, selected: 0, visible: geometry.vertexCount,
    canUndo: false, canRedo: false, revision: 0, contentRevision: 0, transaction: false, selectionDraft: false,
    sceneChanged: false, pending: false, progress: 1, floor: null, filter: null, transformSession: null, opacitySession: null, center: [0, 0, 0], radius: 1, yUp: false, camera: [], memoryBytes: 100,
    selectionMapId: null, pendingSelectionMapId: null, selectionMapBytes: 0, selectionMapRetainedIds: [],
    geometry, sourceFaces: geometry.kind === 2 ? 1 : 0, sampledGeometry: false, colorSession: null };
}
type Response = WorkerResponse | WorkerBootstrapResponse;
class WorkerContext {
  location = { origin: 'https://example.test' };
  onmessage?: (event: { data: unknown }) => void;
  sent: Response[] = [];
  failType?: Response['type'];
  private lastHeap?: NativeHeapSnapshot;
  private lastCensus?: NativeAllocationCensus;
  private waiters: { predicate(value: Response): boolean; resolve(value: Response): void }[] = [];
  postMessage(value: Response, transfer: Transferable[] = []) {
    if(value.type===this.failType){this.failType=undefined;throw new Error('Bootstrap transfer failed.');}
    if(value.heap!==null){
      const snapshot=validateNativeHeapSnapshot(value.heap,this.lastHeap);
      this.lastCensus=validateNativeAllocationCensus(value.census,snapshot,this.lastCensus);
      expect(snapshot.heapBytes).toBe(runtime.core.HEAPU8.buffer.byteLength);
      expect(value.type==='initialization-failed'?value.moduleInitializationId:value.initializationId).toBe('geometry-test');
      this.lastHeap=snapshot;
    }
    const copy = structuredClone(value, { transfer }); this.sent.push(copy);
    for (let i = this.waiters.length - 1; i >= 0; i--) if (this.waiters[i].predicate(copy)) this.waiters.splice(i, 1)[0].resolve(copy);
  }
  next(type: Response['type']) { return new Promise<Response>(resolve => { this.waiters.push({ predicate: value => value.type === type, resolve }); }); }
  send(value: unknown) { this.onmessage?.({ data: value }); }
}
const envelope = { protocolVersion: PROTOCOL_VERSION, buildId: BUILD_ID, requestId: 1,
  base: { documentId: 'geometry-test', sourceGeneration: 1, contentRevision: 0, selectionRevision: 0, draftRevision: 0 } };
let context: WorkerContext;
let nativeSummary: NativeSummary;
let length = 0;
let rangeFault: 'truncated' | 'wrong-length' | undefined;
let rangeCalls: number[][];
let gaussianCalls: number;
let growOnRange: boolean;
beforeEach(async () => {
  vi.resetModules(); context = new WorkerContext(); vi.stubGlobal('self', context);
  nativeSummary = summary(); rangeFault = undefined; rangeCalls = []; gaussianCalls = 0; growOnRange = false;
  const memory=new WebAssembly.Memory({initial:32});
  const heap = new Uint8Array(memory.buffer);
  for (let i = 0; i < 48; i++) heap[1024 + i] = i;
  heap.set(new Uint8Array(new Uint32Array([0, 1, 2]).buffer), 2048);
  const unusedSourceHash = () => { throw new Error('Source hashing is outside this geometry-stream fixture.'); };
  const unusedRecovery = () => { throw new Error('Recovery is outside this geometry-stream fixture.'); };
  let censusSequence = 0;
  runtime.core = {
    HEAPU8: heap, HEAPF32: new Float32Array(heap.buffer), _malloc: () => 16, _free: () => undefined,
    UTF8ToString: pointer => JSON.stringify(pointer === 12 ? emptyCensus(censusSequence) : nativeSummary), _sv_command: () => 8,
    _sv_allocation_snapshot: () => { censusSequence++; return 12; },
    _sv_recovery_prepare: unusedRecovery, _sv_recovery_read: unusedRecovery, _sv_recovery_read_size: unusedRecovery,
    _sv_recovery_release: unusedRecovery, _sv_recovery_restore_begin: unusedRecovery, _sv_recovery_restore_write: unusedRecovery,
    _sv_recovery_restore_finish: unusedRecovery, _sv_recovery_restore_cancel: unusedRecovery,
    _sv_abi_version: () => BUILD_DESCRIPTOR.native.core.abi, _sv_build_identity: () => 8, _sv_open: () => 8,
    _sv_open_group: () => { throw new Error('Grouped loading is outside this geometry fixture.'); }, _sv_live_preview: () => 8,
    _sv_step: () => 8, _sv_scene_ptr: () => 0, _sv_pack_len: () => 0,
    _sv_output_ptr: () => 0, _sv_output_len: () => 0, _sv_map_write: () => 8,
    _sv_source_hash_create: unusedSourceHash, _sv_source_hash_delete: unusedSourceHash,
    _sv_source_hash_begin: unusedSourceHash, _sv_source_hash_update: unusedSourceHash,
    _sv_source_hash_finish: unusedSourceHash, _sv_source_hash_digest: unusedSourceHash,
    _sv_source_hash_reset: unusedSourceHash, _sv_source_hash_state: unusedSourceHash,
    _sv_source_hash_expected_bytes: unusedSourceHash, _sv_source_hash_consumed_bytes: unusedSourceHash,
    _sv_geometry_range(channel, first, count) {
      rangeCalls.push([channel, first, count]); length = count * (channel === 0 ? 16 : 4);
      if(growOnRange){
        memory.grow(3);runtime.core.HEAPU8=new Uint8Array(memory.buffer);runtime.core.HEAPF32=new Float32Array(memory.buffer);
        nativeSummary={...nativeSummary,memoryBytes:321};growOnRange=false;
      }
      if (rangeFault === 'wrong-length') length--;
      return rangeFault === 'truncated' ? runtime.core.HEAPU8.byteLength - 4 : channel === 0 ? 1024 : 2048;
    },
    _sv_geometry_range_len: () => length,
    _sv_pack: () => { gaussianCalls++; return 0; }, _sv_pack_color_base: () => { gaussianCalls++; return 0; },
    _sv_color_base_states_ptr: () => { gaussianCalls++; return 0; },
    _sv_pack_transform_base: () => 0, _sv_transform_base_states_ptr: () => 0,
    _sv_pack_opacity_base: () => 0, _sv_opacity_base_states_ptr: () => 0,
    _sv_states_ptr: () => { gaussianCalls++; return 0; },
  };
  await import('../src/workers/document.worker');
  const ready = context.next('ready');
  context.send({ type: 'initialize', initializationId: 'geometry-test', build: BUILD_DESCRIPTOR,
    mode: 'development-module-graph', assetBase: 'https://example.test/' }); await ready;
});
afterEach(() => { vi.unstubAllGlobals(); });
function begin(geometry = descriptor()) {
  const request: WorkerRequest = { ...envelope, type: 'geometry-stream', descriptor: geometry }; context.send(request); return request;
}
function ack(chunkId: number, overrides: Record<string, unknown> = {}) { context.send({ ...envelope, type: 'ack', chunkId, ...overrides }); }
function response(value: Response): Extract<WorkerResponse, { type: 'geometry-chunk' }> {
  expect(value.type).toBe('geometry-chunk'); return value as Extract<WorkerResponse, { type: 'geometry-chunk' }>;
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
describe('worker geometry range ownership', () => {
  it('samples refreshed real Memory.grow and fresh allocation state after native ranges, then retains heap through completion',async()=>{
    const ready=context.sent.find(value=>value.type==='ready');
    if(!ready||ready.type!=='ready')throw new Error('Missing ready heap.');
    expect(ready.heap).toEqual({sequence:1,heapBytes:32*WASM_PAGE_BYTES});expect(ready.allocation).toBeNull();
    growOnRange=true;
    const first=context.next('geometry-chunk');begin();const vertices=response(await first);
    expect(vertices.heap).toEqual({sequence:2,heapBytes:35*WASM_PAGE_BYTES});
    expect(vertices.initializationId).toBe('geometry-test');
    expect(vertices.allocation).toEqual({loaded:true,kind:2,count:3,memoryBytes:321,
      selectionMapBytes:0,selectionMapRetainedIds:[],exportBytes:0,exportOutputBytes:0});
    expect(Array.from(new Uint8Array(vertices.bytes))).toEqual(Array.from({length:48},(_,i)=>i));
    const next=context.next('geometry-chunk');ack(0);const indices=response(await next);
    expect(indices.heap).toEqual({sequence:3,heapBytes:35*WASM_PAGE_BYTES});
    expect(Array.from(new Uint32Array(indices.bytes))).toEqual([0,1,2]);
    const done=context.next('result');ack(1);const terminal=await done;
    expect(terminal.heap).toEqual({sequence:4,heapBytes:35*WASM_PAGE_BYTES});
    expect(terminal.allocation).toMatchObject({memoryBytes:321});
    expect(ready.heap).toEqual({sequence:1,heapBytes:32*WASM_PAGE_BYTES});
  });

  it('keeps pre-adoption ordinary and bootstrap failures explicitly unmeasured',async()=>{
    vi.resetModules();context=new WorkerContext();vi.stubGlobal('self',context);await import('../src/workers/document.worker');
    const refused=context.next('error');context.send({...envelope,type:'command',command:{command:'summary'}});
    expect(await refused).toMatchObject({type:'error',initializationId:null,heap:null,census:null,allocation:null});
    const failed=context.next('initialization-failed');
    context.send({type:'initialize',initializationId:'geometry-test',build:BUILD_DESCRIPTOR,
      mode:'development-module-graph',assetBase:'file:///not-admitted/'});
    expect(await failed).toMatchObject({type:'initialization-failed',initializationId:'geometry-test',
      moduleInitializationId:null,heap:null,census:null,allocation:null});
    expect(context.sent.some(value=>value.type==='ready')).toBe(false);
  });

  it('binds duplicate initialization failure heap to the original adopted module separately from request identity',async()=>{
    const failed=context.next('initialization-failed');
    context.send({type:'initialize',initializationId:'second-request',build:BUILD_DESCRIPTOR,
      mode:'development-module-graph',assetBase:'https://example.test/'});
    expect(await failed).toMatchObject({type:'initialization-failed',initializationId:'second-request',
      moduleInitializationId:'geometry-test',heap:{sequence:2,heapBytes:32*WASM_PAGE_BYTES},allocation:null});
  });

  it('reports actual adopted heap after a ready transfer fails instead of claiming no module exists',async()=>{
    vi.resetModules();context=new WorkerContext();context.failType='ready';vi.stubGlobal('self',context);
    await import('../src/workers/document.worker');const failed=context.next('initialization-failed');
    context.send({type:'initialize',initializationId:'geometry-test',build:BUILD_DESCRIPTOR,
      mode:'development-module-graph',assetBase:'https://example.test/'});
    expect(await failed).toMatchObject({error:'Bootstrap transfer failed.',moduleInitializationId:'geometry-test',
      heap:{sequence:2,heapBytes:32*WASM_PAGE_BYTES},allocation:null});
    expect(context.sent.some(value=>value.type==='ready')).toBe(false);
  });

  it.each(['heap-view','allocation-query','refusal-heap-view','missing-census','invalid-census','replayed-census'] as const)('fails %s telemetry via one fatal worker error without a fabricated initialized response',async fault=>{
    vi.useFakeTimers();
    try{
      if(fault==='heap-view'||fault==='refusal-heap-view')runtime.core.HEAPU8=new Uint8Array(runtime.core.HEAPU8.buffer,WASM_PAGE_BYTES);
      if(fault==='allocation-query')nativeSummary={...nativeSummary,ok:false,error:'Allocation query failed.'};
      if(fault==='missing-census')runtime.core._sv_allocation_snapshot=undefined as unknown as WasmModule['_sv_allocation_snapshot'];
      if(fault==='invalid-census')runtime.core.UTF8ToString=pointer=>JSON.stringify(pointer===12?{...emptyCensus(2),unionBytes:1}:nativeSummary);
      if(fault==='replayed-census')runtime.core.UTF8ToString=pointer=>JSON.stringify(pointer===12?emptyCensus(1):nativeSummary);
      context.send({...envelope,protocolVersion:fault==='refusal-heap-view'?-1:PROTOCOL_VERSION,type:'command',command:{command:'summary'}});
      // Join the promise queue without running the pending uncaught error task.
      for(let i=0;i<12;i++)await Promise.resolve();
      expect(vi.getTimerCount()).toBe(1);
      const message=fault==='allocation-query'?'Allocation query failed.':fault==='missing-census'?'_sv_allocation_snapshot':
        fault==='invalid-census'?'census union':fault==='replayed-census'?'census sequence':'The native heap view is invalid.';
      expect(()=>vi.runOnlyPendingTimers()).toThrow(message);
      expect(context.sent.map(value=>value.type)).toEqual(['ready']);
      context.send({...envelope,requestId:2,type:'command',command:{command:'summary'}});
      for(let i=0;i<4;i++)await Promise.resolve();
      expect(vi.getTimerCount()).toBe(0);expect(context.sent.map(value=>value.type)).toEqual(['ready']);
    }finally{vi.useRealTimers();}
  });

  it('copies exact native bytes and holds each channel until its matching acknowledgement', async () => {
    const first = context.next('geometry-chunk'); begin(); const vertices = response(await first);
    expect(vertices).toMatchObject({ channel: 'vertices', first: 0, count: 3, chunkId: 0, descriptor: descriptor() });
    expect(Array.from(new Uint8Array(vertices.bytes))).toEqual(Array.from({ length: 48 }, (_, i) => i));
    await tick(); expect(rangeCalls).toEqual([[0, 0, 3]]); expect(context.sent.filter(row => row.type === 'result')).toHaveLength(0);
    // Only a copy is transferred; native retained scene storage remains intact.
    expect(runtime.core.HEAPU8.byteLength).toBe(2 * 1024 * 1024);
    const next = context.next('geometry-chunk'); ack(0); const indices = response(await next);
    expect(indices).toMatchObject({ channel: 'indices', count: 3, chunkId: 1 }); expect(Array.from(new Uint32Array(indices.bytes))).toEqual([0, 1, 2]);
    const terminal = context.next('result'); ack(1); expect(await terminal).toMatchObject({ summary: { geometry: descriptor() } });
    expect(gaussianCalls).toBe(0); expect(context.sent.filter(row => row.type === 'masks' || row.type === 'chunk')).toHaveLength(0);
  });
  it('streams a sampled point cloud in bounded one MiB chunks with no indices or masks', async () => {
    const geometry = descriptor(1, 65537); nativeSummary = summary(geometry);
    const first = context.next('geometry-chunk'); begin(geometry); const vertices = response(await first);
    expect(vertices.bytes.byteLength).toBe(1024 * 1024); expect(vertices.count).toBe(65536);
    const next = context.next('geometry-chunk'); ack(0); const tail = response(await next);
    expect(tail).toMatchObject({ channel: 'vertices', first: 65536, count: 1, chunkId: 1 }); expect(tail.bytes.byteLength).toBe(16);
    const terminal = context.next('result'); ack(1); await terminal;
    expect(rangeCalls).toEqual([[0, 0, 65536], [0, 65536, 1]]); expect(gaussianCalls).toBe(0);
  });
  it('cancels a held acknowledgement once, exposes unchanged native state and admits the next request', async () => {
    const first = context.next('geometry-chunk'); begin(); await first;
    const cancelled = context.next('error'); context.send({ ...envelope, type: 'cancel' });
    expect(await cancelled).toMatchObject({ cancelled: true, cleanupFailed: false, summary: { geometry: descriptor(), selected: 0 } });
    expect(rangeCalls).toHaveLength(1); expect(context.sent.filter(row => row.type === 'error')).toHaveLength(1);
    const read = context.next('result'); context.send({ ...envelope, requestId: 2, type: 'command', command: { command: 'summary' } }); await read;
  });
  it.each(['wrong-id', 'wrong-envelope', 'duplicate'] as const)('refuses %s acknowledgement with one error and no additional native range', async fault => {
    const first = context.next('geometry-chunk'); begin(); await first; const failed = context.next('error');
    if (fault === 'wrong-id') ack(99);
    if (fault === 'wrong-envelope') ack(0, { base: { ...envelope.base, contentRevision: 1 } });
    if (fault === 'duplicate') { ack(0); ack(0); }
    expect(await failed).toMatchObject({ cancelled: false, cleanupFailed: false, summary: { geometry: descriptor() } });
    expect(rangeCalls).toHaveLength(1); expect(context.sent.filter(row => row.type === 'error')).toHaveLength(1);
  });
  it.each(['truncated', 'wrong-length'] as const)('refuses a %s native range before transferring bytes', async fault => {
    rangeFault = fault; const failed = context.next('error'); begin();
    expect(await failed).toMatchObject({ error: 'Invalid native geometry chunk.', summary: { geometry: descriptor() } });
    expect(context.sent.filter(row => row.type === 'geometry-chunk')).toHaveLength(0);
  });
  it('refuses stale descriptors without allocating or exposing native geometry ranges', async () => {
    const failed = context.next('error'); begin({ ...descriptor(), revision: 1 });
    expect(await failed).toMatchObject({ error: 'The requested geometry is no longer current.', summary: { geometry: descriptor() } });
    expect(rangeCalls).toHaveLength(0); expect(context.sent.filter(row => row.type === 'geometry-chunk')).toHaveLength(0);
  });
  it.each(['stream', 'masks'] as const)('refuses Gaussian %s for readonly geometry before touching Gaussian storage', async type => {
    const read = context.next('result'); context.send({ ...envelope, type: 'command', command: { command: 'summary' } }); await read;
    const failed = context.next('error'); context.send({ ...envelope, requestId: 2, type });
    expect(await failed).toMatchObject({ error: 'Gaussian upload is unavailable for this scene.', summary: { kind: 2 } }); expect(gaussianCalls).toBe(0);
  });
});
