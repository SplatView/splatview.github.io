import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILD_DESCRIPTOR } from '../src/generated/buildIdentity';
import { BUILD_ID, PROTOCOL_VERSION, type NativeSummary, type WorkerResponse } from '../src/document/types';
import { SOURCE_FINGERPRINT_SCHEME } from '../src/io/fingerprint';
import type { WasmModule } from '../src/workers/wasm';
import type { WorkerBootstrapResponse } from '../src/build/bootstrap';
import type { RecoveryCheckpointBinding, RecoveryCheckpointPlan, RecoveryCheckpointRange } from '../src/document/recoveryCheckpoint';
import { isRecoveryIntermediateType, RECOVERY_CONTROL_TIMEOUT_MS } from '../src/document/recoveryProtocol';
import { validateNativeHeapSnapshot, type NativeHeapSnapshot } from '../src/document/nativeMemory';
import { validateNativeAllocationCensus, type NativeAllocationCensus } from '../src/document/allocationCensus';
import { emptyCensus } from './fixtures/allocation-census';
import { transformDefaults, type TransformSessionSummary } from '../src/document/transformProtocol';

// This authored native boundary deliberately throws on summary traversal while
// a recovery owner is held. Real ABI/graph reconstruction is covered separately;
// these tests isolate wire ownership, transfer credits and cleanup ordering.
const runtime = vi.hoisted(() => ({ core: undefined as unknown as WasmModule }));
vi.mock('../src/workers/wasm', async importOriginal => ({ ...await importOriginal<typeof import('../src/workers/wasm')>(), loadCore: async () => runtime.core }));
vi.mock('../src/build/native', () => ({ nativeModuleIdentity: () => BUILD_DESCRIPTOR.native.core }));

type Response = WorkerResponse | WorkerBootstrapResponse;
type RecoveryResponse = Extract<WorkerResponse, { type: 'recovery-plan' | 'recovery-chunk' | 'recovery-exported' | 'recovery-range-request' | 'recovery-range-consumed' | 'recovery-result' }>;
class WorkerContext {
  location = { origin: 'https://example.test' };
  onmessage?: (event: { data: unknown }) => void;
  sent: Response[] = [];
  onSent?: (value: Response) => void;
  failType?: Response['type'];
  private heap?: NativeHeapSnapshot;
  private census?: NativeAllocationCensus;
  private waiters: { type: Response['type']; resolve(value: Response): void }[] = [];
  postMessage(value: Response, transfer: Transferable[] = []): void {
    if (value.type === this.failType) { this.failType = undefined; throw new Error('Recovery transfer refused.'); }
    if (value.heap) {
      const heap = validateNativeHeapSnapshot(value.heap, this.heap);
      this.census = validateNativeAllocationCensus(value.census, heap, this.census); this.heap = heap;
      expect(value.type === 'initialization-failed' ? value.moduleInitializationId : value.initializationId).toBe('recovery-test');
      if (isRecoveryIntermediateType(value.type)) expect(value.allocation).toBeNull();
      else if (value.type !== 'ready' && value.type !== 'initialization-failed') expect(value.allocation).not.toBeNull();
    }
    const copy = structuredClone(value, { transfer }); this.sent.push(copy);
    for (let index = this.waiters.length - 1; index >= 0; index--)
      if (this.waiters[index].type === copy.type) this.waiters.splice(index, 1)[0].resolve(copy);
    this.onSent?.(copy);
  }
  next<T extends Response['type']>(type: T): Promise<Extract<Response, { type: T }>> {
    return new Promise(resolve => { this.waiters.push({ type, resolve: value => resolve(value as Extract<Response, { type: T }>) }); });
  }
  send(value: unknown, transfer: Transferable[] = []): void { this.onmessage?.({ data: structuredClone(value, { transfer }) }); }
  raw(value: unknown): void { this.onmessage?.({ data: value }); }
}
const base = { documentId: 'd1a355c4-25e0-4e06-8db9-18c211c17e3d', sourceGeneration: 2,
  contentRevision: 20, selectionRevision: 30, draftRevision: 4 };
const envelope = { protocolVersion: PROTOCOL_VERSION, buildId: BUILD_ID, requestId: 1, base };
const binding: RecoveryCheckpointBinding = { version: 1, core: BUILD_DESCRIPTOR.native.core,
  source: { scheme: SOURCE_FINGERPRINT_SCHEME, assetDigest: 'a'.repeat(64), resourceCount: 1, totalBytes: 1024, sourceKindHint: 'PLY' },
  subset: { sourceCount: 9, loadedCount: 5, maxSplats: 100 }, revision: base };
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function checkpoint(flags = 0): { bytes: Uint8Array<ArrayBuffer>; plan: RecoveryCheckpointPlan } {
  const bytes = new Uint8Array(1024 * 1024 + 201);
  for (let index = 64; index < bytes.length; index++) bytes[index] = index * 19 + 11;
  const hash = digest(bytes.subarray(64)); bytes.set(new TextEncoder().encode('SVCKPT01'));
  const header = new DataView(bytes.buffer); header.setUint32(8, 3, true); header.setUint32(12, 64, true);
  header.setBigUint64(16, BigInt(bytes.byteLength), true);
  bytes.set(Uint8Array.from(hash.match(/../g)!, pair => Number.parseInt(pair, 16)), 24); header.setUint32(60, flags, true);
  return { bytes, plan: { ok: true, version: 2, byteLength: bytes.length, workspaceBytes: 1024 * 1024 + 8192,
    currentLoadedCount: 3, currentSourceCount: 9, currentDuplicateRange: null, maximumGraphSplats: 5,
    maximumChunkBytes: 1048576, sceneCount: 2, maskCount: 2, normalizationFlags: flags, actualRevision: 11,
    revision: 11, contentRevision: 9, nextContentRevision: 14, memoryBytes: 8192,
    sha256: hash, headerSha256: digest(bytes.subarray(0, 64)) } };
}
function summary(loaded: boolean): NativeSummary {
  return { ok: true, selectionCommitRevision: 0, undoSelectionRevision: 0, toleranceRecorded: null, toleranceRange: null, toleranceSessionId: null, toleranceTool: null, duplicateRange: null, loaded, count: loaded ? 3 : 0, sourceCount: loaded ? 9 : 0, shDegree: 3,
    format: loaded ? 'PLY' : '', kind: 0, selected: loaded ? 2 : 0, visible: loaded ? 3 : 0,
    canUndo: loaded, canRedo: loaded, revision: loaded ? 11 : 0, contentRevision: loaded ? 9 : 0,
    transaction: false, selectionDraft: false, sceneChanged: loaded, pending: false, progress: 1,
    center: [0, 0, 0], radius: 1, yUp: false, camera: [], memoryBytes: loaded ? 8192 : 0,
    selectionMapId: null, pendingSelectionMapId: null, selectionMapBytes: 0, selectionMapRetainedIds: [],
    colorSession: null, alignment: null, floor: null, filter: null, transformSession: null, opacitySession: null };
}
let context: WorkerContext, nativeSummary: NativeSummary, busy: boolean, source: ReturnType<typeof checkpoint>;
let releases: number, cancels: number, finishes: number, prepareCalls: number, summaryQueries: number;
let readCalls: number[][], writeCalls: number[][], nativeInput: Uint8Array<ArrayBuffer> | undefined;
let failWrite: boolean, failFinish: boolean, failRead: boolean, failMalloc: boolean;
let nativeReply: unknown, allocations: Set<number>;
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function rangeFields(value: RecoveryCheckpointRange) { return { index: value.index, offset: value.offset, length: value.length }; }
function control(type: 'recovery-proceed' | 'recovery-release', requestId = 2, patch: Record<string, unknown> = {}): void {
  context.send({ ...envelope, requestId, type, recoveryId: `checkpoint-${requestId}`, ...patch });
}
function acknowledge(value: Extract<RecoveryResponse, { type: 'recovery-chunk' }>, patch: Record<string, unknown> = {}): void {
  context.send({ ...envelope, requestId: value.requestId, type: 'recovery-ack', recoveryId: value.recoveryId, ...rangeFields(value), ...patch });
}
function deliver(value: Extract<RecoveryResponse, { type: 'recovery-range-request' }>, mutate?: (bytes: Uint8Array) => void): void {
  const data = source.bytes.slice(value.offset, value.offset + value.length); mutate?.(data);
  const bytes = data.buffer;
  context.send({ ...envelope, requestId: value.requestId, type: 'recovery-range', recoveryId: value.recoveryId,
    ...rangeFields(value), bytes }, [bytes]);
  expect(bytes.byteLength).toBe(0);
}
async function restore(): Promise<Extract<WorkerResponse, { type: 'recovery-result' }>> {
  context.onSent = value => { if (value.type === 'recovery-range-request') deliver(value); };
  const completed = context.next('recovery-result');
  context.send({ ...envelope, type: 'recovery-restore', recoveryId: 'checkpoint-1', binding, plan: source.plan, budgetBytes: 32 * 1024 * 1024 });
  const result = await completed; context.onSent = undefined; await tick(); return result;
}
function startExport(patch: Record<string, unknown> = {}): void {
  context.send({ ...envelope, requestId: 2, type: 'recovery-export', recoveryId: 'checkpoint-2', binding, ...patch });
}
function autoExport(hold?: 'plan' | 'chunk' | 'release'): void {
  context.onSent = value => {
    if (value.type === 'recovery-plan' && hold !== 'plan') control('recovery-proceed');
    if (value.type === 'recovery-chunk' && hold !== 'chunk') acknowledge(value);
    if (value.type === 'recovery-exported' && hold !== 'release') control('recovery-release');
  };
}
beforeEach(async () => {
  vi.resetModules(); context = new WorkerContext(); vi.stubGlobal('self', context);
  source = checkpoint(); nativeSummary = summary(false); busy = false;
  releases = cancels = finishes = prepareCalls = summaryQueries = 0; readCalls = []; writeCalls = [];
  failWrite = failFinish = failRead = failMalloc = false; nativeInput = undefined; allocations = new Set();
  const heap = new Uint8Array(new WebAssembly.Memory({ initial: 128 }).buffer);
  let censusSequence = 0, readLength = 0, smallPointer = 4 * 1024 * 1024;
  const unsupported = () => { throw new Error('This operation is outside the recovery transport fixture.'); };
  runtime.core = {
    HEAPU8: heap, HEAPF32: new Float32Array(heap.buffer),
    _malloc(bytes) { if (failMalloc && bytes > 1024) return 0; const pointer = bytes > 1024 ? 5 * 1024 * 1024 : smallPointer;
      if (bytes <= 1024) smallPointer += (bytes + 15) & ~15;
      if (allocations.has(pointer)) throw new Error('An earlier native input is still retained.'); allocations.add(pointer); return pointer; },
    _free(pointer) { expect(allocations.delete(pointer)).toBe(true); },
    UTF8ToString(pointer) { return JSON.stringify(pointer === 8 ? nativeSummary : pointer === 12 ? nativeReply : emptyCensus(censusSequence)); },
    _sv_command() { if (busy) throw new Error('Forbidden summary traversal while native recovery is held.'); summaryQueries++; return 8; },
    _sv_abi_version: () => BUILD_DESCRIPTOR.native.core.abi, _sv_build_identity: () => 8,
    _sv_allocation_snapshot() { censusSequence++; return 16; },
    _sv_recovery_prepare() { prepareCalls++; if (busy) throw new Error('Duplicate native owner.'); busy = true;
      source = checkpoint(nativeSummary.selectionDraft ? 1 : 0);
      source.plan = { ...source.plan, currentLoadedCount: nativeSummary.count, currentSourceCount: nativeSummary.sourceCount,
        currentDuplicateRange: nativeSummary.duplicateRange, maximumGraphSplats: Math.max(5, nativeSummary.count), actualRevision: nativeSummary.revision,
        revision: nativeSummary.revision + (nativeSummary.selectionDraft ? 1 : 0), contentRevision: nativeSummary.contentRevision };
      nativeReply = source.plan; return 12; },
    _sv_recovery_read(offset, length) { expect(busy).toBe(true); readCalls.push([offset, length]);
      heap.set(source.bytes.subarray(offset, offset + length), 1024 * 1024); readLength = failRead ? length - 1 : length; return 1024 * 1024; },
    _sv_recovery_read_size: () => readLength,
    _sv_recovery_release() { releases++; busy = false; },
    _sv_recovery_restore_begin(length, maxSplats, budget, expectedJson) {
      expect(busy).toBe(false); expect(maxSplats).toBe(source.plan.maximumGraphSplats); expect(budget).toBe(32 * 1024 * 1024);
      const expected = JSON.parse(new TextDecoder().decode(heap.subarray(expectedJson, heap.indexOf(0, expectedJson))));
      expect(expected).toEqual({ codecVersion: 3, currentLoadedCount: source.plan.currentLoadedCount, currentSourceCount: source.plan.currentSourceCount,
        currentDuplicateRange: source.plan.currentDuplicateRange, maximumGraphSplats: source.plan.maximumGraphSplats, originalSourceCount: 9,
        revision: source.plan.revision, contentRevision: source.plan.contentRevision, nextContentRevision: source.plan.nextContentRevision });
      busy = true; nativeInput = new Uint8Array(length); nativeReply = { ok: true, version: 1, byteLength: length, written: 0 }; return 12; },
    _sv_recovery_restore_write(offset, pointer, length) { expect(busy).toBe(true); writeCalls.push([offset, pointer, length]);
      nativeInput!.set(heap.subarray(pointer, pointer + length), offset);
      nativeReply = failWrite ? { ok: false, error: 'Native checkpoint write failed.' } : { ok: true, byteLength: nativeInput!.length, written: offset + length }; return 12; },
    _sv_recovery_restore_finish() { finishes++; expect(busy).toBe(true);
      if (failFinish) { nativeReply = { ok: false, error: 'Native graph validation failed.' }; return 12; }
      expect(nativeInput).toEqual(source.bytes); nativeSummary = { ...summary(true), count: source.plan.currentLoadedCount,
        sourceCount: source.plan.currentSourceCount, duplicateRange: source.plan.currentDuplicateRange,
        visible: source.plan.currentLoadedCount, selected: source.plan.currentDuplicateRange?.count ?? 2 };
      busy = false; nativeInput = undefined; return 8; },
    _sv_recovery_restore_cancel() { cancels++; busy = false; nativeInput = undefined; },
    _sv_open: unsupported, _sv_open_group: unsupported, _sv_live_preview: unsupported, _sv_step: unsupported,
    _sv_scene_ptr: unsupported, _sv_states_ptr: unsupported, _sv_pack: unsupported, _sv_pack_color_base: unsupported,
    _sv_color_base_states_ptr: unsupported,
    _sv_pack_transform_base: unsupported, _sv_transform_base_states_ptr: unsupported, _sv_pack_opacity_base: unsupported,
    _sv_opacity_base_states_ptr: unsupported, _sv_pack_len: unsupported, _sv_output_ptr: unsupported, _sv_output_len: unsupported,
    _sv_map_write: unsupported, _sv_geometry_range: unsupported, _sv_geometry_range_len: unsupported,
    _sv_source_hash_create: unsupported, _sv_source_hash_delete: unsupported, _sv_source_hash_begin: unsupported,
    _sv_source_hash_update: unsupported, _sv_source_hash_finish: unsupported, _sv_source_hash_digest: unsupported,
    _sv_source_hash_reset: unsupported, _sv_source_hash_state: unsupported, _sv_source_hash_expected_bytes: unsupported,
    _sv_source_hash_consumed_bytes: unsupported,
  };
  await import('../src/workers/document.worker');
  const ready = context.next('ready'); context.send({ type: 'initialize', initializationId: 'recovery-test', build: BUILD_DESCRIPTOR,
    mode: 'development-module-graph', assetBase: 'https://example.test/' }); await ready;
});
afterEach(async () => {
  // A failing assertion still joins the actual owner before removing its world.
  if (busy) {
    const terminal = context.next('error');
    const requestId = context.sent.some(value => value.type === 'recovery-plan') ? 2 : 1;
    context.send({ ...envelope, requestId, type: 'cancel' }); await terminal;
  }
  await Promise.resolve(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('worker recovery transport ownership', () => {
  it('restores a grown current scene using the admitted graph and exact suffix expectations', async () => {
    source.plan = { ...source.plan, currentLoadedCount: 7, currentSourceCount: 11,
      currentDuplicateRange: { first: 5, count: 2 }, maximumGraphSplats: 7 };
    const result = await restore();
    expect(result.summary).toMatchObject({ count: 7, sourceCount: 11, duplicateRange: { first: 5, count: 2 } });
    expect(binding.subset).toEqual({ sourceCount: 9, loadedCount: 5, maxSplats: 100 });
  });
  it('restores bounded sequential ranges in a fresh worker and preserves initial subset independently of cropped count', async () => {
    const result = await restore();
    expect(result).toMatchObject({ action: 'restore', summary: { count: 3, sourceCount: 9, canUndo: true, canRedo: true, revision: 11, contentRevision: 9 } });
    expect(writeCalls.map(([offset, , length]) => [offset, length])).toEqual([[0, 1048576], [1048576, 201]]);
    expect(finishes).toBe(1); expect(cancels).toBe(1); expect(busy).toBe(false);
    expect(allocations.size).toBe(1); // The initialized summary request lives with the module.
    const requests = context.sent.filter(value => value.type === 'recovery-range-request');
    const consumed = context.sent.filter(value => value.type === 'recovery-range-consumed');
    expect(requests).toHaveLength(2); expect(consumed).toHaveLength(2);
    expect(requests.every(value => value.allocation === null)).toBe(true);
    expect(result.allocation).toMatchObject({ loaded: true, count: 3, memoryBytes: 8192 });
    autoExport(); const exported = context.next('recovery-result'); startExport();
    expect(await exported).toMatchObject({ action: 'export', summary: { count: 3 } });
  });

  it('holds native export ownership until exact per-chunk ACKs and the final external release', async () => {
    await restore();
    const prepared = context.next('recovery-plan'); startExport(); const plan = await prepared;
    expect(plan).toMatchObject({ allocation: null, summary: { loaded: true, count: 3 }, plan: { actualRevision: 11 } });
    expect(readCalls).toHaveLength(0); expect(busy).toBe(true); expect(releases).toBe(0);
    const queryCount = summaryQueries;
    const first = context.next('recovery-chunk'); control('recovery-proceed'); const chunk = await first;
    expect(new Uint8Array(chunk.bytes)).toEqual(source.bytes.subarray(0, 1048576));
    await tick(); expect(readCalls).toHaveLength(1); expect(summaryQueries).toBe(queryCount);
    const second = context.next('recovery-chunk'); acknowledge(chunk); const remainder = await second;
    expect(remainder).toMatchObject({ index: 1, offset: 1048576, length: 201 });
    expect(new Uint8Array(remainder.bytes)).toEqual(source.bytes.subarray(1048576));
    const complete = context.next('recovery-exported'); acknowledge(remainder); await complete;
    expect(busy).toBe(true); expect(releases).toBe(0); expect(summaryQueries).toBe(queryCount);
    const terminal = context.next('recovery-result'); control('recovery-release');
    expect(await terminal).toMatchObject({ action: 'export', allocation: { count: 3 } });
    expect(releases).toBe(1); expect(busy).toBe(false);
  });
  it.each(['range', 'recorded', 'history'] as const)('authenticates retained %s metadata after export release independently of unchanged topology and revisions', async field => {
    await restore(); Object.assign(nativeSummary, { toleranceSessionId: 4, toleranceTool: 'color', toleranceRecorded: true,
      toleranceRange: { enabled: true, radius: 2, center: [1, 2, 3] } });
    autoExport('release'); const exported = context.next('recovery-exported'); startExport(); await exported;
    if (field === 'range') nativeSummary.toleranceRange = { enabled: true, radius: 3, center: [1, 2, 3] };
    else if (field === 'recorded') nativeSummary.toleranceRecorded = false;
    else nativeSummary.undoSelectionRevision = 1;
    const failure = context.next('error'); control('recovery-release');
    expect(await failure).toMatchObject({ error: field === 'history' ? 'The selection history changed outside its captured request.' :
      'The tolerance Range owner changed outside its captured request.', cleanupFailed: false });
    expect(releases).toBe(1); expect(busy).toBe(false);
    expect(context.sent.filter(value => value.type === 'recovery-result' && value.requestId === 2)).toHaveLength(0);
  });
  it('preserves the complete same-worker gizmo owner while exporting and refuses altered eligibility after release', async () => {
    await restore();
    const transform: TransformSessionSummary = { id: 1, baseId: 4, epoch: 1, appliedEpoch: null, kind: 'gizmo', selectedOnly: false,
      appliedMatrix: transformDefaults().matrix, pivot: [0, 0, 0], gizmo: { cancelBaseId: 2, cancelContentRevision: 1, canUndo: true, canRedo: false } };
    nativeSummary.transformSession = transform;
    autoExport('release'); const exported = context.next('recovery-exported'); startExport(); await exported;
    nativeSummary.transformSession = { ...transform, gizmo: { ...transform.gizmo!, canUndo: false } };
    const failure = context.next('error'); control('recovery-release');
    expect(await failure).toMatchObject({ error: 'The transform session changed outside its captured request.', cleanupFailed: false });
    expect(releases).toBe(1); expect(context.sent.filter(value => value.type === 'recovery-result' && value.requestId === 2)).toHaveLength(0);
  });
  it('refuses a fresh restored gizmo owner while preserving the codec3 durable scene/history policy', async () => {
    const finish = runtime.core._sv_recovery_restore_finish;
    runtime.core._sv_recovery_restore_finish = () => {
      const pointer = finish(); nativeSummary.transformSession = { id: 1, baseId: 2, epoch: 0, appliedEpoch: null, kind: 'gizmo', selectedOnly: false,
        appliedMatrix: transformDefaults().matrix, pivot: [0, 0, 0], gizmo: { cancelBaseId: null, cancelContentRevision: null, canUndo: false, canRedo: false } };
      return pointer;
    };
    context.onSent = value => { if (value.type === 'recovery-range-request') deliver(value); };
    const failure = context.next('error');
    context.send({ ...envelope, type: 'recovery-restore', recoveryId: 'checkpoint-1', binding, plan: source.plan, budgetBytes: 32 * 1024 * 1024 });
    expect(await failure).toMatchObject({ error: 'The native restored document does not match the admitted checkpoint.' });
    expect(context.sent.filter(value => value.type === 'recovery-result')).toHaveLength(0);
  });
  it('binds filter.changed throughout immutable recovery export without inferring it from selected count', async () => {
    await restore(); nativeSummary.filter = { id: 7, kind: 'sphere', epoch: 1, previewEpoch: 1, changed: true };
    autoExport('release'); const exported = context.next('recovery-exported'); startExport(); await exported;
    nativeSummary.filter = { ...nativeSummary.filter, changed: false };
    const failure = context.next('error'); control('recovery-release');
    expect(await failure).toMatchObject({ error: 'The selection filter changed outside its captured request.', cleanupFailed: false });
    expect(releases).toBe(1); expect(busy).toBe(false);
    expect(context.sent.filter(value => value.type === 'recovery-result' && value.requestId === 2)).toHaveLength(0);
  });

  it('ignores foreign recovery IDs, envelopes and operation owners without cancelling the active pump', async () => {
    await restore(); const prepared = context.next('recovery-plan'); startExport(); await prepared;
    const errorsBefore = context.sent.filter(value => value.type === 'error').length;
    for (const patch of [{ recoveryId: 'foreign' }, { requestId: 99 }, { base: { ...base, draftRevision: 5 } },
      { operationOwner: { version: 1, documentId: base.documentId, sourceGeneration: 2,
        clientGeneration: 'd45cfe27-4092-4744-a4b8-461deaa0f959', operationId: 3 } }]) control('recovery-proceed', 2, patch);
    await tick(); expect(readCalls).toHaveLength(0); expect(releases).toBe(0); expect(busy).toBe(true);
    expect(context.sent.filter(value => value.type === 'error')).toHaveLength(errorsBefore);
    autoExport(); const first = context.next('recovery-chunk'), terminal = context.next('recovery-result'); control('recovery-proceed');
    await first; expect(await terminal).toMatchObject({ action: 'export' });
  });

  it.each(['range', 'phase', 'family', 'cancel'] as const)('joins native cleanup before the terminal %s refusal', async fault => {
    await restore(); const prepared = context.next('recovery-plan'); startExport(); await prepared;
    const first = context.next('recovery-chunk'); control('recovery-proceed'); const chunk = await first;
    const terminal = context.next('error');
    if (fault === 'range') acknowledge(chunk, { offset: 1 });
    if (fault === 'phase') control('recovery-release');
    if (fault === 'family') context.send({ ...envelope, requestId: 2, type: 'ack', chunkId: 0 });
    if (fault === 'cancel') context.send({ ...envelope, requestId: 2, type: 'cancel' });
    expect(await terminal).toMatchObject({ cleanupFailed: false, cancelled: fault === 'cancel', allocation: { loaded: true, count: 3 } });
    expect(releases).toBe(1); expect(busy).toBe(false); expect(allocations.size).toBe(1);
  });

  it('does not let a foreign existing cancel abort recovery', async () => {
    await restore(); const prepared = context.next('recovery-plan'); startExport(); await prepared;
    context.send({ ...envelope, requestId: 77, type: 'cancel' }); await tick();
    expect(busy).toBe(true); expect(releases).toBe(0);
    autoExport(); const terminal = context.next('recovery-result'); control('recovery-proceed'); await terminal;
  });

  it.each(['header', 'payload', 'write', 'finish', 'malloc'] as const)('refuses %s corruption/failure before publishing and cancels native import', async fault => {
    failWrite = fault === 'write'; failFinish = fault === 'finish'; failMalloc = fault === 'malloc';
    context.onSent = value => {
      if (value.type === 'recovery-range-request') deliver(value, bytes => {
        if (fault === 'header' && value.index === 0) bytes[0] ^= 1;
        if (fault === 'payload' && value.index === 1) bytes[0] ^= 1;
      });
    };
    const terminal = context.next('error');
    context.send({ ...envelope, type: 'recovery-restore', recoveryId: 'checkpoint-1', binding, plan: source.plan, budgetBytes: 32 * 1024 * 1024 });
    expect(await terminal).toMatchObject({ cancelled: false, cleanupFailed: false, allocation: { loaded: false, count: 0 } });
    expect(nativeSummary.loaded).toBe(false); expect(cancels).toBe(1); expect(busy).toBe(false);
    expect(finishes).toBe(fault === 'finish' ? 1 : 0); expect(allocations.size).toBe(1);
  });

  it.each(['length', 'detached', 'shared', 'resizable'] as const)('rejects %s restore buffers before native writes', async fault => {
    const first = context.next('recovery-range-request');
    context.send({ ...envelope, type: 'recovery-restore', recoveryId: 'checkpoint-1', binding, plan: source.plan, budgetBytes: 32 * 1024 * 1024 });
    const range = await first; let bytes: unknown = new ArrayBuffer(range.length);
    if (fault === 'length') bytes = new ArrayBuffer(range.length - 1);
    if (fault === 'shared') bytes = new SharedArrayBuffer(range.length);
    if (fault === 'detached') structuredClone(bytes, { transfer: [bytes as ArrayBuffer] });
    if (fault === 'resizable') bytes = Reflect.construct(ArrayBuffer, [range.length, { maxByteLength: range.length + 1 }]);
    const terminal = context.next('error');
    context.raw({ ...envelope, type: 'recovery-range', recoveryId: 'checkpoint-1', ...rangeFields(range), bytes });
    expect(await terminal).toMatchObject({ cleanupFailed: false, cancelled: false });
    expect(writeCalls).toHaveLength(0); expect(cancels).toBe(1); expect(busy).toBe(false);
  });

  it('rejects restoration after any prior ordinary work', async () => {
    const summarized = context.next('result'); context.send({ ...envelope, requestId: 8, type: 'command', command: { command: 'summary' } }); await summarized;
    const refused = context.next('error'); context.send({ ...envelope, type: 'recovery-restore', recoveryId: 'checkpoint-1', binding, plan: source.plan, budgetBytes: 32 * 1024 * 1024 });
    expect(await refused).toMatchObject({ error: 'Recovery restoration requires a fresh, unloaded scene worker.' });
    expect(writeCalls).toHaveLength(0); expect(cancels).toBe(0);
  });

  it('refuses a different source/subset before preparing any export plan', async () => {
    await restore();
    for (const patch of [{ source: { ...binding.source, assetDigest: 'b'.repeat(64) } }, { subset: { ...binding.subset, loadedCount: 4 } }]) {
      const refused = context.next('error'); startExport({ binding: { ...binding, ...patch } });
      expect(await refused).toMatchObject({ cancelled: false, cleanupFailed: false });
    }
    expect(prepareCalls).toBe(0); expect(releases).toBe(0);
  });

  it.each(['read', 'transfer'] as const)('releases native ownership after export %s failure and remains usable', async fault => {
    await restore(); failRead = fault === 'read'; if (fault === 'transfer') context.failType = 'recovery-chunk';
    autoExport(); const terminal = context.next('error'); startExport();
    expect(await terminal).toMatchObject({ cancelled: false, cleanupFailed: false, allocation: { loaded: true } });
    expect(releases).toBe(1); expect(busy).toBe(false); expect(allocations.size).toBe(1);
    failRead = false; const recovered = context.next('result'); context.send({ ...envelope, requestId: 7, type: 'command', command: { command: 'summary' } });
    expect(await recovered).toMatchObject({ summary: { loaded: true } });
  });

  it.each(['plan', 'chunk', 'release'] as const)('times out a lost %s control and releases ownership before ordinary telemetry', async phase => {
    await restore(); vi.useFakeTimers(); autoExport(phase);
    const waiting = context.next(phase === 'plan' ? 'recovery-plan' : phase === 'chunk' ? 'recovery-chunk' : 'recovery-exported');
    startExport(); await waiting;
    const terminal = context.next('error'); await vi.advanceTimersByTimeAsync(RECOVERY_CONTROL_TIMEOUT_MS);
    expect(await terminal).toMatchObject({ error: 'The recovery transfer acknowledgement timed out.', cleanupFailed: false, cancelled: false });
    expect(releases).toBe(1); expect(busy).toBe(false);
  });

  it('times out a lost restore range without publishing or retaining native input', async () => {
    vi.useFakeTimers(); const requested = context.next('recovery-range-request');
    context.send({ ...envelope, type: 'recovery-restore', recoveryId: 'checkpoint-1', binding, plan: source.plan, budgetBytes: 32 * 1024 * 1024 });
    await requested;
    const terminal = context.next('error'); await vi.advanceTimersByTimeAsync(RECOVERY_CONTROL_TIMEOUT_MS);
    expect(await terminal).toMatchObject({ error: 'The recovery transfer acknowledgement timed out.', cleanupFailed: false, allocation: { loaded: false } });
    expect(writeCalls).toHaveLength(0); expect(finishes).toBe(0); expect(cancels).toBe(1); expect(nativeInput).toBeUndefined();
  });

  it('refuses a native plan with a different actual revision and releases its lock before error telemetry', async () => {
    await restore();
    const prepare = runtime.core._sv_recovery_prepare;
    runtime.core._sv_recovery_prepare = () => {
      const pointer = prepare(); nativeReply = { ...source.plan, actualRevision: source.plan.actualRevision + 1 }; return pointer;
    };
    const terminal = context.next('error'); startExport();
    expect(await terminal).toMatchObject({ error: 'The native recovery plan changed the captured document.', cleanupFailed: false });
    expect(readCalls).toHaveLength(0); expect(releases).toBe(1); expect(busy).toBe(false);
    expect(context.sent.some(value => value.type === 'recovery-plan')).toBe(false);
  });

  it('queues unrelated malformed-message refusal until recovery releases its summary lock', async () => {
    await restore(); const prepared = context.next('recovery-plan'); startExport(); await prepared;
    context.send({ ...envelope, requestId: 9, type: 'unknown-family' }); await tick();
    expect(context.sent.some(value => value.type === 'error' && value.requestId === 9)).toBe(false);
    autoExport(); const completed = context.next('recovery-result'), refusal = context.next('error'); control('recovery-proceed');
    await completed; expect(await refusal).toMatchObject({ requestId: 9, error: 'Unknown scene message type.', allocation: { loaded: true } });
    expect(releases).toBe(1); expect(busy).toBe(false);
  });
});
