import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILD_DESCRIPTOR } from '../src/generated/buildIdentity';
import { BUILD_ID, PROTOCOL_VERSION, sameRevision, type NativeSummary, type WorkerResponse } from '../src/document/types';
import { sourceWorkerBytes, type SourceDescriptor, type SourceRange } from '../src/document/source';
import type { Category, ResourceLease } from '../src/document/resources';
import type { ModuleFactory, WasmModule } from '../src/workers/wasm';
import type { WorkerBootstrapResponse } from '../src/build/bootstrap';
import { SOURCE_HASH_MAX_CHUNK } from '../src/workers/sourceHash';
import { validateNativeHeapSnapshot, WASM_PAGE_BYTES, type NativeHeapSnapshot } from '../src/document/nativeMemory';
import { validateNativeAllocationCensus, type NativeAllocationCensus } from '../src/document/allocationCensus';
import { gaussianPly } from './fixtures/gaussians';
import { MAX_SOURCE_TRANSPORT_BYTES } from '../src/document/sceneInputLimits';

type Ledger = { readonly limit: number; readonly usage: { bytes: number; peakBytes: number; allocations: number } };
const runtime = vi.hoisted(() => ({ core: undefined as unknown as WasmModule, ledgers: [] as Ledger[],
  reserveCalls: 0, failReserveAt: 0 }));
vi.mock('../src/workers/wasm', async importOriginal => ({
  ...await importOriginal<typeof import('../src/workers/wasm')>(), loadCore: async () => runtime.core,
}));
vi.mock('../src/document/resources', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/document/resources')>();
  return { ...actual, ResourceLedger: class extends actual.ResourceLedger {
    constructor(limit: number) { super(limit); runtime.ledgers.push(this); }
    reserve(category: Category, bytes: number): ResourceLease {
      if (++runtime.reserveCalls === runtime.failReserveAt) throw new Error('Source admission refused.');
      return super.reserve(category, bytes);
    }
  } };
});

type Response = WorkerResponse | WorkerBootstrapResponse;
class WorkerContext {
  location = { origin: 'https://example.test' };
  onmessage?: (event: { data: unknown }) => void;
  sent: Response[] = [];
  failType?: Response['type'];
  onSent?: (value: Response) => void;
  private lastHeap?: NativeHeapSnapshot;
  private lastCensus?: NativeAllocationCensus;
  private waiters: { type: Response['type']; resolve(value: Response): void }[] = [];
  postMessage(value: Response, transfer: Transferable[] = []): void {
    if (value.type === this.failType) { this.failType = undefined; throw new Error('Worker message transfer failed.'); }
    if (value.heap !== null) {
      const snapshot=validateNativeHeapSnapshot(value.heap,this.lastHeap);
      this.lastCensus=validateNativeAllocationCensus(value.census,snapshot,this.lastCensus);
      expect(snapshot.heapBytes).toBe(runtime.core.HEAPU8.buffer.byteLength);
      expect(value.type==='initialization-failed'?value.moduleInitializationId:value.initializationId).toBe('source-test');
      if(value.type!=='ready'&&value.type!=='initialization-failed') {
        expect(value.allocation).not.toBeNull();
        expect(Object.isFrozen(value.allocation)).toBe(true);
        expect(Object.isFrozen(value.allocation!.selectionMapRetainedIds)).toBe(true);
      }
      this.lastHeap=snapshot;
    } else expect(value.type==='error'||value.type==='initialization-failed').toBe(true);
    const copy = structuredClone(value, { transfer }); this.sent.push(copy);
    this.onSent?.(copy);
    for (let index = this.waiters.length - 1; index >= 0; index--)
      if (this.waiters[index].type === copy.type) this.waiters.splice(index, 1)[0].resolve(copy);
  }
  next<T extends Response['type']>(type: T): Promise<Response & { type: T }> {
    return new Promise(resolve => { this.waiters.push({ type, resolve: value => resolve(value as Response & { type: T }) }); });
  }
  send(value: unknown, transfer: Transferable[] = []): void { this.onmessage?.({ data: structuredClone(value, { transfer }) }); }
  raw(value: unknown): void { this.onmessage?.({ data: value }); }
}
const envelope = { protocolVersion: PROTOCOL_VERSION, buildId: BUILD_ID, requestId: 1,
  base: { documentId: 'source-worker', sourceGeneration: 1, contentRevision: 0, selectionRevision: 0, draftRevision: 0 } };
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
let actual: WasmModule, context: WorkerContext, coreFactory: ModuleFactory;
let allocations: Map<number, number>, handles: Set<number>, freed: number[], mallocCalls: number, failMallocAt: number;
let stagingMallocCalls: number, mallocRefused: boolean;
const summaryCommandBytes = new TextEncoder().encode('{"command":"summary"}\0').byteLength;
let opens: { pointer: number; length: number; bytes: Buffer }[];
let updates: { pass: number; offset: number; pointer: number; bytes: Buffer }[], hashPass: number;

function nativeSummary(): NativeSummary {
  const text = new TextEncoder().encode('{"command":"summary"}\0'), pointer = actual._malloc(text.byteLength);
  try { actual.HEAPU8.set(text, pointer); return JSON.parse(actual.UTF8ToString(actual._sv_command(pointer))) as NativeSummary; }
  finally { actual._free(pointer); }
}
function descriptor(byteLength: number): SourceDescriptor {
  return { kind: 'single', operationId: 'source-operation', resourceId: 'primary-resource', byteLength, path: '', role: 'primary' };
}
function load(data: Uint8Array, overrides: Record<string, unknown> = {}): void {
  context.send({ ...envelope, type: 'source-load', source: descriptor(data.byteLength), format: 0,
    maxSplats: 100, budgetBytes: 32 * 1024 * 1024, sourceBudgetBytes: sourceWorkerBytes(data.byteLength), ...overrides });
}
function rangeFields({ operationId, resourceId, rangeId, offset, length }: SourceRange): SourceRange {
  // Worker responses also carry telemetry. Only the granted range scalars
  // belong in a source-range request; reflecting response fields is invalid.
  return { operationId, resourceId, rangeId, offset, length };
}
function deliver(range: SourceRange, data: Uint8Array, overrides: Record<string, unknown> = {}): ArrayBuffer {
  const bytes = data.slice(range.offset, range.offset + range.length).buffer;
  context.send({ ...envelope, ...rangeFields(range), type: 'source-range', bytes, ...overrides }, [bytes]); return bytes;
}
function canonicalDigest(data: Uint8Array): string {
  const header = Buffer.from('53706c617456696577536f757263650076310000000000010100000000', 'hex');
  const size = Buffer.alloc(8); size.writeBigUInt64BE(BigInt(data.byteLength));
  return createHash('sha256').update(header).update(size).update(createHash('sha256').update(data).digest()).digest('hex');
}
function terminals(): Response[] { return context.sent.filter(value => ['source-load-result', 'error', 'result'].includes(value.type)); }
async function clean(): Promise<void> {
  await tick(); expect(allocations.size).toBe(0); expect(handles.size).toBe(0);
  // The real allocator may reuse freed addresses; the live map rejects actual
  // duplicate/foreign frees while this count covers each successful allocation.
  expect(freed.length).toBe(mallocCalls - (mallocRefused ? 1 : 0));
  expect(runtime.ledgers.every(ledger => ledger.usage.bytes === 0)).toBe(true);
}

beforeAll(async () => {
  // Exact shipping artifacts, with the real SHA256 and decoder implementations.
  const glue = pathToFileURL(resolve('public/wasm/splatview-core.mjs')).href;
  const wasm = resolve('public/wasm/splatview-core.wasm');
  coreFactory = (await import(/* @vite-ignore */ glue) as { default: ModuleFactory }).default;
  actual = await coreFactory({ locateFile: (name: string) => { assert.equal(name, 'splatview-core.wasm'); return wasm; } });
});
beforeEach(async () => {
  vi.resetModules(); context = new WorkerContext(); vi.stubGlobal('self', context);
  runtime.ledgers = []; runtime.reserveCalls = 0; runtime.failReserveAt = 0;
  allocations = new Map(); handles = new Set(); freed = []; mallocCalls = failMallocAt = stagingMallocCalls = 0; mallocRefused = false;
  opens = []; updates = []; hashPass = -1;
  // Seed an earlier native scene: failed transfer/cancellation must not decode over it.
  const baseline = gaussianPly(0), pointer = actual._malloc(baseline.byteLength);
  try {
    actual.HEAPU8.set(baseline, pointer);
    expect(JSON.parse(actual.UTF8ToString(actual._sv_open(pointer, baseline.byteLength, 0, 100, 32 * 1024 * 1024))).ok).toBe(true);
  } finally { actual._free(pointer); }
  runtime.core = new Proxy(actual, { get(target, key) {
    if (key === '_malloc') return (bytes: number): number => {
      mallocCalls++;
      // Fault ordinal targets operation input allocations. Telemetry retains
      // its canonical request from initialization and makes no new malloc.
      if (bytes !== summaryCommandBytes && ++stagingMallocCalls === failMallocAt) { mallocRefused = true; return 0; }
      const allocated = target._malloc(bytes); if (allocated) allocations.set(allocated, bytes); return allocated;
    };
    if (key === '_free') return (allocated: number): void => {
      assert.ok(allocations.delete(allocated), 'Worker freed a duplicate or foreign allocation.');
      freed.push(allocated); target._free(allocated);
    };
    if (key === '_sv_source_hash_create') return (): number => {
      const handle = target._sv_source_hash_create(); if (handle) handles.add(handle >>> 0); return handle;
    };
    if (key === '_sv_source_hash_delete') return (handle: number): number => {
      const status = target._sv_source_hash_delete(handle); if (status === 0) handles.delete(handle >>> 0); return status;
    };
    if (key === '_sv_source_hash_begin') return (handle: number, expected: number): number => {
      const status = target._sv_source_hash_begin(handle, expected); if (status === 0) hashPass++; return status;
    };
    if (key === '_sv_source_hash_update') return (handle: number, offset: number, input: number, length: number): number => {
      updates.push({ pass: hashPass, offset, pointer: input, bytes: Buffer.from(target.HEAPU8.subarray(input, input + length)) });
      return target._sv_source_hash_update(handle, offset, input, length);
    };
    if (key === '_sv_open') return (input: number, length: number, format: number, maxSplats: number, budget: number): number => {
      opens.push({ pointer: input, length, bytes: Buffer.from(target.HEAPU8.subarray(input, input + length)) });
      return target._sv_open(input, length, format, maxSplats, budget);
    };
    return Reflect.get(target, key);
  } });
  await import('../src/workers/document.worker');
  const ready = context.next('ready');
  context.send({ type: 'initialize', initializationId: 'source-test', build: BUILD_DESCRIPTOR,
    mode: 'development-module-graph', assetBase: 'https://example.test/' }); await ready;
  const summarized = context.next('result');
  context.send({ ...envelope, requestId: 9000, type: 'command', command: { command: 'summary' } }); await summarized;
  await tick(); context.sent = []; allocations.clear(); freed = []; mallocCalls = stagingMallocCalls = 0; mallocRefused = false;
});
afterEach(async () => {
  // A refused foreign envelope is not the active source's joined terminal.
  // Still retire that real outstanding owner if the test exits early.
  const completed = context.sent.some(value => value.type === 'source-load-result' || value.type === 'error' &&
    value.requestId === envelope.requestId && sameRevision(value.base, envelope.base) && typeof value.cleanupFailed === 'boolean');
  if (context.sent.some(value => value.type === 'source-range-request') && !completed) {
    const failed = context.next('error'); context.send({ ...envelope, type: 'cancel' }); await failed;
  }
  await tick(); vi.unstubAllGlobals();
});

describe('active single-file source worker protocol', () => {
  it.each([64, 65])('refuses descriptor size %i at a 64-byte decode budget before progress, staging, native allocation or range I/O and preserves the native scene', async byteLength => {
    const before = nativeSummary(), failed = context.next('error');
    load(new Uint8Array(0), { source: descriptor(byteLength), budgetBytes: 64, sourceBudgetBytes: sourceWorkerBytes(byteLength) });
    expect(await failed).toMatchObject({ error: 'The scene source does not fit within the available decode memory budget.', cancelled: false, cleanupFailed: false });
    expect(runtime.ledgers).toHaveLength(0); expect(runtime.reserveCalls).toBe(0); expect(mallocCalls).toBe(0);
    expect(context.sent.filter(value => value.type === 'progress' || value.type === 'source-range-request')).toHaveLength(0);
    expect(opens).toHaveLength(0); expect(updates).toHaveLength(0); expect(terminals()).toHaveLength(1);
    expect(nativeSummary()).toEqual(before); await clean();
    const data = gaussianPly(0), first = context.next('source-range-request'); load(data);
    const result = context.next('source-load-result'); deliver(await first, data);
    expect(await result).toMatchObject({ summary: { ok: true, loaded: true }, consumedBytes: data.byteLength });
    expect(opens).toHaveLength(1); await clean();
  });

  it('refuses a descriptor beyond uint32 transport without constructing or reading its source body', async () => {
    const before = nativeSummary(), failed = context.next('error');
    load(new Uint8Array(0), { source: descriptor(MAX_SOURCE_TRANSPORT_BYTES + 1),
      sourceBudgetBytes: MAX_SOURCE_TRANSPORT_BYTES + 1 + 65_536 + 1_048_576 });
    expect(await failed).toMatchObject({ error: 'Invalid source descriptor.', cancelled: false, cleanupFailed: false });
    expect(runtime.ledgers).toHaveLength(0); expect(runtime.reserveCalls).toBe(0); expect(mallocCalls).toBe(0);
    expect(context.sent.filter(value => value.type === 'progress' || value.type === 'source-range-request')).toHaveLength(0);
    expect(opens).toHaveLength(0); expect(updates).toHaveLength(0); expect(terminals()).toHaveLength(1);
    expect(nativeSummary()).toEqual(before); await clean();
  });

  it('reports command-input refusal with fresh telemetry and remains usable without allocating a telemetry request', async () => {
    const before = nativeSummary(); failMallocAt = 1;
    const failed = context.next('error');
    context.send({ ...envelope, type: 'command', command: { command: 'selectAll' } });
    const refusal = await failed;
    expect(refusal).toMatchObject({ error: 'There is not enough memory for this command.', cleanupFailed: false,
      summary: before, allocation: { loaded: true, count: before.count, memoryBytes: before.memoryBytes } });
    expect(mallocCalls).toBe(1); expect(freed).toHaveLength(0);
    expect(nativeSummary()).toEqual(before);
    failMallocAt = 0;
    const recovered = context.next('result');
    context.send({ ...envelope, requestId: 2, type: 'command', command: { command: 'selectAll' } });
    expect(await recovered).toMatchObject({ summary: { ok: true, selected: before.count } });
    await clean();
  });

  it('actual scene-free core exposes an unloaded allocation summary while all other commands still refuse',async()=>{
    const fresh=await coreFactory({locateFile:(name:string)=>{
      assert.equal(name,'splatview-core.wasm');return resolve('public/wasm/splatview-core.wasm');
    }});
    const query=(command:string)=>{
      const text=new TextEncoder().encode(JSON.stringify({command})+'\0'),pointer=fresh._malloc(text.byteLength);
      assert.ok(pointer);
      try{fresh.HEAPU8.set(text,pointer);return JSON.parse(fresh.UTF8ToString(fresh._sv_command(pointer))) as NativeSummary;}
      finally{fresh._free(pointer);}
    };
    const initial=query('summary');
    expect(initial).toMatchObject({ok:true,loaded:false,kind:0,count:0,memoryBytes:0,
      selectionMapBytes:0,selectionMapRetainedIds:[]});
    for(const command of ['selectAll','cancel','cancelSelection','export','beginTransaction'])
      expect(query(command)).toMatchObject({ok:false,error:'Open a scene first'});
    expect(query('summary')).toEqual(initial);
  });

  it('hashes the exact decoder allocation before acknowledgement and publishes only its complete decoded fingerprint', async () => {
    const data = gaussianPly(0), first = context.next('source-range-request');
    let acknowledged = false;
    context.onSent = value => {
      if(value.type==='source-load-result') {
        expect(allocations.size).toBe(0);expect(handles.size).toBe(0);
        expect(runtime.ledgers[0].usage.bytes).toBe(0);
        expect(value.allocation).toMatchObject({loaded:true,kind:0,count:3,memoryBytes:value.summary.memoryBytes,
          selectionMapBytes:0,selectionMapRetainedIds:[]});
      }
      if (value.type !== 'source-range-consumed') return;
      acknowledged = true; expect(opens).toHaveLength(0);
      expect(updates.filter(call => call.pass === 0)).toHaveLength(1);
      assert.deepEqual(updates[0].bytes, Buffer.from(data));
      expect(actual._sv_source_hash_consumed_bytes([...handles][0])).toBe(data.byteLength);
      expect(runtime.ledgers[0].usage.bytes).toBe(data.byteLength + 32 + 96);
    };
    load(data); const range = await first;
    expect(range).toMatchObject({ operationId: 'source-operation', resourceId: 'primary-resource', rangeId: 0, offset: 0, length: data.byteLength });
    expect(runtime.ledgers[0].limit).toBe(sourceWorkerBytes(data.byteLength));
    expect(runtime.ledgers[0].usage.bytes).toBe(2 * data.byteLength + 32 + 96);
    const completed = context.next('source-load-result'), detached = deliver(range, data);
    expect(detached.byteLength).toBe(0);
    const result = await completed;
    expect(acknowledged).toBe(true); expect(result).toMatchObject({ operationId: 'source-operation', resourceId: 'primary-resource',
      consumedBytes: data.byteLength, summary: { ok: true, loaded: true, count: 3, sourceCount: 3, kind: 0, shDegree: 0 },
      fingerprint: { scheme: 'splatview-source-v1', resourceCount: 1, totalBytes: data.byteLength,
        assetDigest: canonicalDigest(data), sourceKindHint: 'PLY' } });
    expect(opens).toHaveLength(1); assert.deepEqual(opens[0].bytes, Buffer.from(data));
    expect(opens[0].pointer).toBe(updates[0].pointer); expect(opens[0].length).toBe(data.byteLength);
    const firstGaussian = new Float32Array(actual.HEAPU8.buffer, actual._sv_scene_ptr(), 4);
    expect(firstGaussian[0]).toBeCloseTo(-0.4, 6); expect(firstGaussian[1]).toBe(-0); expect(firstGaussian[2]).toBe(-0);
    expect(firstGaussian[3]).toBeCloseTo(0.8, 6);
    expect(terminals()).toHaveLength(1); await clean();
  });

  it('samples actual malloc heap growth at the first source range and retains it after cancellation cleanup', async()=>{
    const before=actual.HEAPU8.buffer.byteLength, data=new Uint8Array(before+WASM_PAGE_BYTES);
    const first=context.next('source-range-request');load(data,{budgetBytes:data.byteLength+32*1024*1024});const range=await first;
    if(!range.heap)throw new Error('Missing initialized source heap.');
    const reading=context.sent.find(value=>value.type==='progress'&&value.stage==='Reading scene');
    expect(reading?.heap?.heapBytes).toBe(before);
    expect(range.heap.heapBytes).toBeGreaterThan(before);
    expect(range.allocation).toMatchObject({loaded:true,count:3});
    const failed=context.next('error');
    context.onSent=value=>{if(value.type==='error'){
      expect(allocations.size).toBe(0);expect(handles.size).toBe(0);expect(runtime.ledgers[0].usage.bytes).toBe(0);
    }};
    context.send({...envelope,type:'cancel'});const terminal=await failed;
    expect(terminal.heap?.heapBytes).toBe(range.heap.heapBytes);
    expect(terminal.heap!.sequence).toBeGreaterThan(range.heap.sequence);
    expect(reading?.heap?.heapBytes).toBe(before);
    await clean();
  });

  it('permits one exact MiB credit then a tail and binds both native ranges to the final decoder bytes', async () => {
    const data = new Uint8Array(SOURCE_HASH_MAX_CHUNK + 17), ply = gaussianPly(0);
    data.fill(32); data.set(ply);
    const first = context.next('source-range-request'); load(data); const initial = await first;
    expect(initial).toMatchObject({ rangeId: 0, offset: 0, length: SOURCE_HASH_MAX_CHUNK });
    await tick(); expect(context.sent.filter(value => value.type === 'source-range-request')).toHaveLength(1);
    const ack = context.next('source-range-consumed'), next = context.next('source-range-request'); deliver(initial, data);
    await ack; const tail = await next;
    expect(tail).toMatchObject({ rangeId: 1, offset: SOURCE_HASH_MAX_CHUNK, length: 17 });
    expect(opens).toHaveLength(0);
    const completed = context.next('source-load-result'); deliver(tail, data); const result = await completed;
    expect(result.fingerprint.assetDigest).toBe(canonicalDigest(data));
    assert.deepEqual(Buffer.concat(updates.filter(call => call.pass === 0).map(call => call.bytes)), Buffer.from(data));
    expect(updates[1].pointer).toBe(updates[0].pointer + SOURCE_HASH_MAX_CHUNK);
    expect(opens[0].pointer).toBe(updates[0].pointer); assert.deepEqual(opens[0].bytes, Buffer.from(data));
    expect(context.sent.filter(value => value.type === 'source-range-consumed')).toHaveLength(2);
    expect(terminals()).toHaveLength(1); await clean();
  });

  it('cancels a waiting credit with one terminal, releases ownership and preserves the earlier native scene', async () => {
    const before = nativeSummary(), data = gaussianPly(0), first = context.next('source-range-request'); load(data); const range = await first;
    expect(allocations.size).toBe(2); expect(handles.size).toBe(1);
    const failed = context.next('error'); context.send({ ...envelope, type: 'cancel' });
    expect(await failed).toMatchObject({ cancelled: true, cleanupFailed: false, summary: { count: 3, kind: 0 } });
    await clean(); deliver(range, data); await tick();
    expect(terminals()).toHaveLength(1); expect(opens).toHaveLength(0); expect(nativeSummary()).toEqual(before);
    const summarized = context.next('result'); context.send({ ...envelope, requestId: 2, type: 'command', command: { command: 'summary' } });
    expect(await summarized).toMatchObject({ summary: { count: 3 } }); await clean();
  });

  it('holds a delivered credit through cancellation until staging releases the borrowed chunk', async () => {
    const data = gaussianPly(0), first = context.next('source-range-request'); load(data); const range = await first;
    const failed = context.next('error'); deliver(range, data); context.send({ ...envelope, type: 'cancel' });
    // Delivery resolved the staging promise, but its continuation has not run.
    expect(runtime.ledgers[0].usage.bytes).toBe(2 * data.byteLength + 32 + 96);
    expect(allocations.size).toBe(2); expect(handles.size).toBe(1);
    expect(await failed).toMatchObject({ cancelled: true, cleanupFailed: false });
    expect(updates).toHaveLength(0); expect(opens).toHaveLength(0);
    expect(context.sent.filter(value => value.type === 'source-range-consumed')).toHaveLength(0);
    expect(terminals()).toHaveLength(1); await clean();
  });

  it('rejects a consumed stale range while the successor credit waits without rereading or decoding', async () => {
    const data = new Uint8Array(SOURCE_HASH_MAX_CHUNK + 1); data.fill(32); data.set(gaussianPly(0));
    const first = context.next('source-range-request'); load(data); const initial = await first;
    const next = context.next('source-range-request'); deliver(initial, data); const successor = await next;
    expect(successor.rangeId).toBe(1);
    const failed = context.next('error'); deliver(initial, data);
    expect(await failed).toMatchObject({ cancelled: false, cleanupFailed: false });
    expect(updates.filter(value => value.pass === 0)).toHaveLength(1); expect(opens).toHaveLength(0);
    expect(context.sent.filter(value => value.type === 'source-range-consumed')).toHaveLength(1);
    expect(terminals()).toHaveLength(1); await clean();
  });

  it.each(['request-id', 'revision', 'protocol', 'build'] as const)
  ('refuses foreign %s controls while preserving the real active source credit and its single successful decode', async fault => {
    const before = nativeSummary(), data = gaussianPly(0), first = context.next('source-range-request'); load(data); const range = await first;
    const ownedBytes = runtime.ledgers[0].usage.bytes;
    const changes = { 'request-id': { requestId: 99 }, revision: { base: { ...envelope.base, contentRevision: 1 } },
      protocol: { protocolVersion: PROTOCOL_VERSION - 1 }, build: { buildId: 'obsolete-build' } };
    const failed = context.next('error'); deliver(range, data, changes[fault]); const refusal = await failed;
    expect(refusal.error).toBe(fault === 'request-id' || fault === 'revision' ? 'Discarded an obsolete scene message.' :
      'The application files have different versions. Reload SplatView.');
    expect(refusal.cancelled).toBeUndefined(); expect(refusal.cleanupFailed).toBeUndefined();
    expect(opens).toHaveLength(0); expect(updates).toHaveLength(0); expect(allocations.size).toBe(2); expect(handles.size).toBe(1);
    expect(nativeSummary()).toEqual(before); expect(runtime.ledgers[0].usage.bytes).toBe(ownedBytes);
    expect(context.sent.filter(value => value.type === 'source-range-request')).toHaveLength(1);
    expect(context.sent.filter(value => value.type === 'source-range-consumed')).toHaveLength(0);
    const consumed = context.next('source-range-consumed'), completed = context.next('source-load-result'); deliver(range, data);
    expect(await consumed).toMatchObject({ requestId: envelope.requestId, base: envelope.base, rangeId: 0,
      operationId: range.operationId, resourceId: range.resourceId, offset: 0, length: data.byteLength });
    expect(await completed).toMatchObject({ requestId: envelope.requestId, base: envelope.base, consumedBytes: data.byteLength,
      summary: { ok: true, loaded: true, count: 3, sourceCount: 3 }, fingerprint: { assetDigest: canonicalDigest(data), totalBytes: data.byteLength } });
    expect(opens).toHaveLength(1); expect(opens[0].bytes).toEqual(Buffer.from(data));
    expect(updates.filter(value => value.pass === 0)).toHaveLength(1);
    expect(context.sent.filter(value => value.type === 'source-load-result')).toHaveLength(1);
    expect(context.sent.filter(value => value.type === 'error')).toHaveLength(1); await clean();
  });

  it.each(['operation', 'resource', 'range-id', 'offset', 'length',
    'ack-family', 'map-family', 'command-family', 'duplicate', 'extra-pointer', 'echo-response-telemetry'] as const)
  ('fails %s controls through exactly one operation terminal before decoding', async fault => {
    const data = gaussianPly(0), first = context.next('source-range-request'); load(data); const range = await first;
    const failed = context.next('error');
    const changes: Record<string, unknown> = {
      operation: { operationId: 'old-operation' }, resource: { resourceId: 'other-resource' }, 'range-id': { rangeId: 1 },
      offset: { offset: 1 }, length: { length: range.length - 1 }, 'extra-pointer': { pointer: 128 },
    };
    if (fault === 'ack-family') context.send({ ...envelope, type: 'ack', chunkId: 0 });
    else if (fault === 'map-family') context.send({ ...envelope, type: 'map-chunk', mapId: 1, offset: 0, bytes: new ArrayBuffer(4) });
    else if (fault === 'command-family') context.send({ ...envelope, type: 'command', command: { command: 'summary' } });
    else if (fault === 'duplicate') { deliver(range, data); deliver(range, data); }
    else if (fault === 'echo-response-telemetry') {
      const bytes = data.slice().buffer;
      context.send({ ...envelope, ...range, type: 'source-range', bytes }, [bytes]);
      expect(bytes.byteLength).toBe(0);
    }
    else deliver(range, data, changes[fault] as Record<string, unknown>);
    const error = await failed;
    expect(error).toMatchObject({ cancelled: false, cleanupFailed: false });
    if (fault === 'echo-response-telemetry') expect(error.error).toBe('Invalid source message fields.');
    await clean();
    expect(opens).toHaveLength(0); expect(terminals()).toHaveLength(1);
    expect(context.sent.filter(value => value.type === 'source-range-consumed')).toHaveLength(0);
  });

  it.each(['short', 'view', 'shared', 'resizable', 'detached', 'forged'] as const)
  ('refuses a %s byte buffer at the worker boundary without consuming it', async fault => {
    const data = gaussianPly(0), first = context.next('source-range-request'); load(data); const range = await first;
    let bytes: unknown = data.slice().buffer;
    if (fault === 'short') bytes = new ArrayBuffer(range.length - 1);
    if (fault === 'view') bytes = new Uint8Array(bytes as ArrayBuffer);
    if (fault === 'shared') bytes = new SharedArrayBuffer(range.length);
    if (fault === 'resizable') bytes = Reflect.construct(ArrayBuffer, [range.length, { maxByteLength: range.length + 1 }]);
    if (fault === 'detached') structuredClone(bytes, { transfer: [bytes as ArrayBuffer] });
    if (fault === 'forged') bytes = Object.create(ArrayBuffer.prototype);
    const failed = context.next('error');
    // Raw dispatch also exercises invalid/detached inputs which a real sender's
    // structured clone would refuse before dispatching a worker event.
    context.raw({ ...envelope, ...rangeFields(range), type: 'source-range', bytes });
    const error = await failed;
    expect(error).toMatchObject({ cancelled: false, cleanupFailed: false });
    expect(error.error).not.toBe('Invalid source message fields.');
    expect(updates).toHaveLength(0); expect(opens).toHaveLength(0); expect(terminals()).toHaveLength(1); await clean();
  });

  it.each(['source-range-request', 'source-range-consumed'] as const)
  ('releases receive and staged ownership when sending %s throws', async fault => {
    const data = gaussianPly(0), failed = context.next('error'); context.failType = fault;
    if (fault === 'source-range-request') load(data);
    else { const first = context.next('source-range-request'); load(data); deliver(await first, data); }
    expect(await failed).toMatchObject({ error: 'Worker message transfer failed.', cleanupFailed: false });
    expect(opens).toHaveLength(0); expect(terminals()).toHaveLength(1); await clean();
  });

  it.each([1, 2, 3, 4])('releases native ownership after local admission refusal %i', async admission => {
    runtime.failReserveAt = admission;
    const data = gaussianPly(0), failed = context.next('error');
    if (admission <= 3) load(data);
    else { const first = context.next('source-range-request'); load(data); deliver(await first, data); }
    expect(await failed).toMatchObject({ error: 'Source admission refused.', cleanupFailed: false });
    expect(opens).toHaveLength(0); expect(terminals()).toHaveLength(1); await clean();
  });

  it.each([1, 2, 3])('releases ownership after staging allocation refusal %i', async allocation => {
    failMallocAt = allocation;
    const data = gaussianPly(0), failed = context.next('error');
    if (allocation < 3) load(data);
    else { const first = context.next('source-range-request'); load(data); deliver(await first, data); }
    expect(await failed).toMatchObject({ cleanupFailed: false }); expect(opens).toHaveLength(0);
    expect(terminals()).toHaveLength(1); await clean();
  });

  it.each([
    { format: -1 }, { format: 5 }, { format: 0.5 }, { maxSplats: 0 }, { maxSplats: 0x1_0000_0000 },
    { budgetBytes: 0 }, { budgetBytes: NaN }, { sourceBudgetBytes: 0 },
    { source: { ...descriptor(1), path: 'file.ply' } }, { file: new Blob(['x']) }, { pointer: 1 },
  ])('refuses invalid source load configuration %j before native allocation or range I/O', async change => {
    const failed = context.next('error'); load(gaussianPly(0), change);
    expect(await failed).toMatchObject({ cancelled: false, cleanupFailed: false });
    expect(runtime.ledgers).toHaveLength(0); expect(context.sent.filter(value => value.type === 'source-range-request')).toHaveLength(0);
    expect(opens).toHaveLength(0); expect(terminals()).toHaveLength(1); await clean();
  });

  it('does not publish a fingerprint when complete empty bytes are rejected by the actual decoder', async () => {
    const before = nativeSummary(), failed = context.next('error'); load(new Uint8Array(0));
    expect(await failed).toMatchObject({ cancelled: false, cleanupFailed: false });
    expect(context.sent.filter(value => value.type === 'source-range-request')).toHaveLength(0);
    expect(opens).toHaveLength(1); expect(opens[0].length).toBe(0);
    expect(nativeSummary()).toEqual(before); expect(terminals()).toHaveLength(1); await clean();
  });
});
