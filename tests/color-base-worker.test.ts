import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILD_DESCRIPTOR } from '../src/generated/buildIdentity';
import { BUILD_ID, NEUTRAL_COLOR, PROTOCOL_VERSION, type NativeSummary, type WorkerResponse } from '../src/document/types';
import { validateColorBaseIdentity, type ColorBaseIdentity, type ColorSessionSummary } from '../src/document/colorProtocol';
import type { WasmModule } from '../src/workers/wasm';
import type { WorkerBootstrapResponse } from '../src/build/bootstrap';
import { emptyCensus } from './fixtures/allocation-census';
import { transformDefaults, type TransformBaseIdentity } from '../src/document/transformProtocol';
import type { OpacityBaseIdentity } from '../src/document/opacityProtocol';

// These fixtures execute the shipping worker transport against a controlled
// module and real transferable copies. They do not execute native packing or
// measure native allocation ownership or GPU publication.
const runtime = vi.hoisted(() => ({ core: undefined as unknown as WasmModule }));
vi.mock('../src/workers/wasm', async importOriginal => ({
  ...await importOriginal<typeof import('../src/workers/wasm')>(), loadCore: async () => runtime.core,
}));
vi.mock('../src/build/native', () => ({ nativeModuleIdentity: () => BUILD_DESCRIPTOR.native.core }));

type Response = WorkerResponse | WorkerBootstrapResponse;
class WorkerContext {
  location = { origin: 'https://example.test' };
  onmessage?: (event: { data: unknown }) => void;
  sent: Response[] = [];
  private unread: Response[] = [];
  private waiters: { type: Response['type']; resolve(value: Response): void }[] = [];
  postMessage(value: Response, transfer: Transferable[] = []) {
    const copy = structuredClone(value, { transfer }); this.sent.push(copy);
    const index = this.waiters.findIndex(waiter => waiter.type === copy.type);
    if (index === -1) this.unread.push(copy);
    else this.waiters.splice(index, 1)[0].resolve(copy);
  }
  next(type: Response['type']) {
    const index = this.unread.findIndex(value => value.type === type);
    if (index !== -1) return Promise.resolve(this.unread.splice(index, 1)[0]);
    return new Promise<Response>(resolve => this.waiters.push({ type, resolve }));
  }
  send(value: unknown) { this.onmessage?.({ data: structuredClone(value) }); }
}
const identity: ColorBaseIdentity = { sessionId: 1, baseId: 2, epochId: 3 };
function session(): ColorSessionSummary {
  return { ...identity, version: 1, active: true, selectedOnly: true, pending: false,
    values: [...NEUTRAL_COLOR], applied: [...NEUTRAL_COLOR] };
}
function summary(count = 3): NativeSummary {
  return { ok: true, selectionCommitRevision: 0, undoSelectionRevision: 0, toleranceRecorded: null, toleranceRange: null, toleranceSessionId: null, toleranceTool: null, duplicateRange: null, loaded: true, kind: 0, format: 'PLY', count, sourceCount: count, shDegree: 0,
    selected: 1, visible: count, canUndo: true, canRedo: false, revision: 1, contentRevision: 1,
    transaction: false, selectionDraft: false, sceneChanged: false, pending: false, progress: 1, floor: null, filter: null, transformSession: null, opacitySession: null,
    center: [0, 0, 0], radius: 1, yUp: false, camera: [], memoryBytes: 128,
    selectionMapId: null, pendingSelectionMapId: null, selectionMapBytes: 0, selectionMapRetainedIds: [], colorSession: session() };
}
const envelope = { protocolVersion: PROTOCOL_VERSION, buildId: BUILD_ID, requestId: 2,
  base: { documentId: 'color-base-test', sourceGeneration: 1, contentRevision: 0, selectionRevision: 0, draftRevision: 0 } };
let context: WorkerContext;
let native: NativeSummary;
let length: number;
let packFault: 'zero' | 'wrong-length' | undefined;
let baseCalls: number[][], documentCalls: number[][], colorMaskCalls: number[][], maskCalls: number;
beforeEach(async () => {
  vi.resetModules(); context = new WorkerContext(); vi.stubGlobal('self', context);
  native = summary(); length = 0; packFault = undefined; baseCalls = []; documentCalls = []; colorMaskCalls = []; maskCalls = 0;
  const heap = new Uint8Array(new WebAssembly.Memory({ initial: 32 }).buffer);
  heap.set([1, 0, 2], 1_200_000);
  let sequence = 0;
  const unused = () => { throw new Error('This native API is outside the color-base transport fixture.'); };
  const pack = (calls: number[][], byte: number, first: number, count: number) => {
    calls.push([first, count]); length = count * 48;
    if (packFault === 'wrong-length') length--;
    heap.fill(byte, 1024, 1024 + length); return packFault === 'zero' ? 0 : 1024;
  };
  runtime.core = {
    HEAPU8: heap, HEAPF32: new Float32Array(heap.buffer), _malloc: () => 16, _free: () => undefined,
    UTF8ToString: pointer => JSON.stringify(pointer === 12 ? emptyCensus(sequence) : native),
    _sv_command: () => 8, _sv_allocation_snapshot: () => { sequence++; return 12; },
    _sv_abi_version: () => BUILD_DESCRIPTOR.native.core.abi, _sv_build_identity: () => 8,
    _sv_recovery_prepare: unused, _sv_recovery_read: unused, _sv_recovery_read_size: unused,
    _sv_recovery_release: unused, _sv_recovery_restore_begin: unused, _sv_recovery_restore_write: unused,
    _sv_recovery_restore_finish: unused, _sv_recovery_restore_cancel: unused,
    _sv_open: unused, _sv_open_group: unused, _sv_live_preview: unused, _sv_step: unused, _sv_scene_ptr: unused,
    _sv_pack: (first, count) => pack(documentCalls, 83, first, count),
    _sv_pack_color_base: (first, count) => pack(baseCalls, 17, first, count), _sv_pack_len: () => length,
    _sv_color_base_states_ptr: (sessionId, baseId, epochId) => {
      colorMaskCalls.push([sessionId, baseId, epochId]);
      const captured = native.colorSession;
      return captured && !captured.pending && captured.sessionId === sessionId && captured.baseId === baseId && captured.epochId === epochId ? 1_200_000 : 0;
    },
    _sv_pack_transform_base: () => 0, _sv_transform_base_states_ptr: () => 0,
    _sv_pack_opacity_base: () => 0, _sv_opacity_base_states_ptr: () => 0,
    _sv_states_ptr: () => { maskCalls++; return 1_200_000; },
    _sv_geometry_range: unused, _sv_geometry_range_len: unused, _sv_output_ptr: unused, _sv_output_len: unused,
    _sv_map_write: unused, _sv_source_hash_create: unused, _sv_source_hash_delete: unused,
    _sv_source_hash_begin: unused, _sv_source_hash_update: unused, _sv_source_hash_finish: unused,
    _sv_source_hash_digest: unused, _sv_source_hash_reset: unused, _sv_source_hash_state: unused,
    _sv_source_hash_expected_bytes: unused, _sv_source_hash_consumed_bytes: unused,
  };
  await import('../src/workers/document.worker');
  context.send({ type: 'initialize', initializationId: 'color-base-test', build: BUILD_DESCRIPTOR,
    mode: 'development-module-graph', assetBase: 'https://example.test/' }); await context.next('ready');
  context.send({ ...envelope, requestId: 1, type: 'command', command: { command: 'summary' } }); await context.next('result');
});

describe('transform-base stream identity and frozen mask ownership', () => {
  const transformIdentity: TransformBaseIdentity = { id: 4, baseId: 5, epoch: 0 };
  async function transformBase(count = 3) {
    native = { ...summary(count), colorSession: null, transformSession: { ...transformIdentity, kind: 'numeric', selectedOnly: true,
      appliedEpoch: null, appliedMatrix: transformDefaults().matrix, pivot: [0, 0, 0], gizmo: null } };
    const pack = vi.fn((_id: number, _base: number, _epoch: number, _first: number, count: number) => {
      length = count * 48; runtime.core.HEAPU8.fill(113, 1024, 1024 + length); return 1024;
    });
    runtime.core.HEAPU8.set([0, 1, 2], 1_300_000);
    const masks = vi.fn(() => 1_300_000);
    runtime.core._sv_pack_transform_base = pack; runtime.core._sv_transform_base_states_ptr = masks;
    context.send({ ...envelope, requestId: 1, type: 'command', command: { command: 'summary' } }); await context.next('result');
    return { pack, masks };
  }
  function stream(transformBase: unknown = transformIdentity) { context.send({ ...envelope, type: 'stream', channel: 'transformBase', transformBase }); }
  it('passes native identities on every pack and uses the frozen entry mask', async () => {
    const f = await transformBase(); stream(); const first = chunk(await context.next('chunk'));
    expect(Array.from(new Uint8Array(first.bytes))).toEqual(Array(144).fill(113)); ack(0);
    const masks = await context.next('masks'); expect(masks.type).toBe('masks');
    if (masks.type === 'masks') expect(Array.from(new Uint8Array(masks.bytes))).toEqual([0, 1, 2]);
    await context.next('result'); expect(f.pack).toHaveBeenCalledWith(4, 5, 0, 0, 3); expect(f.masks).toHaveBeenCalledWith(4, 5, 0);
    expect(baseCalls).toHaveLength(0); expect(documentCalls).toHaveLength(0); expect(maskCalls).toBe(0);
  });
  it.each(['id', 'baseId', 'epoch'] as const)('refuses stale %s before either native transform export', async field => {
    const f = await transformBase(); stream({ ...transformIdentity, [field]: transformIdentity[field] + 1 });
    expect(await context.next('error')).toMatchObject({ error: 'The transform-base stream is stale.' });
    expect(f.pack).not.toHaveBeenCalled(); expect(f.masks).not.toHaveBeenCalled();
  });
  it.each([undefined, null, { id: 0, baseId: 5, epoch: 0 }, { id: 4, baseId: 5, epoch: -1 }, { ...transformIdentity, extra: 1 }])('refuses malformed transform identity %#', async value => {
    const f = await transformBase(); context.send({ ...envelope, type: 'stream', channel: 'transformBase', transformBase: value });
    expect(await context.next('error')).toMatchObject({ error: 'Invalid transform-base stream identity.' });
    expect(f.pack).not.toHaveBeenCalled(); expect(f.masks).not.toHaveBeenCalled();
  });
  it('rechecks a changed epoch after the final chunk and does not publish a mask', async () => {
    const f = await transformBase(); stream(); await context.next('chunk');
    native = { ...native, transformSession: { ...native.transformSession!, epoch: 1 } }; ack(0);
    expect(await context.next('error')).toMatchObject({ error: 'The transform-base stream is stale.' }); expect(f.masks).not.toHaveBeenCalled();
  });
  it('refuses a pending transform before packing', async () => {
    const f = await transformBase(); native = { ...native, pending: true }; stream();
    expect(await context.next('error')).toMatchObject({ error: 'The transform-base stream is stale.' }); expect(f.pack).not.toHaveBeenCalled();
  });
  it('rejects a wrong native mask pointer without borrowing the document mask', async () => {
    const f = await transformBase(); f.masks.mockReturnValue(0); stream(); await context.next('chunk'); ack(0);
    expect(await context.next('error')).toMatchObject({ error: 'The scene mask range is unavailable.' }); expect(maskCalls).toBe(0);
    expect(f.masks).toHaveBeenCalledExactlyOnceWith(4,5,0); expect(f.pack).toHaveBeenCalledOnce();
    expect(context.sent.filter(value => value.type === 'masks')).toHaveLength(0);
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('opacity-base stream identity and immutable mask ownership', () => {
  const identity: OpacityBaseIdentity = { id: 9, baseId: 10, epoch: 0 };
  async function opacityBase(count = 3) {
    const topologyChanged = count !== native.count;
    native = { ...summary(count), revision: native.revision + Number(topologyChanged), contentRevision: native.contentRevision + Number(topologyChanged),
      colorSession: null, opacitySession: { ...identity, selectedOnly: true, appliedEpoch: null, appliedScale: 1 } };
    const pack = vi.fn((_id: number, _base: number, _epoch: number, _first: number, count: number) => {
      length = count * 48; runtime.core.HEAPU8.fill(127, 1024, 1024 + length); return 1024;
    }), masks = vi.fn(() => 1_300_000);
    runtime.core.HEAPU8.set([0, 1, 2], 1_300_000); runtime.core._sv_pack_opacity_base = pack; runtime.core._sv_opacity_base_states_ptr = masks;
    context.send({ ...envelope, requestId: 1, type: 'command', command: { command: 'summary' } }); await context.next('result');
    return { pack, masks };
  }
  function stream(opacityBase: unknown = identity) { context.send({ ...envelope, type: 'stream', channel: 'opacityBase', opacityBase }); }
  it('fences every native pack and frozen mask export with the captured three-part identity', async () => {
    const f = await opacityBase(); stream(); const first = chunk(await context.next('chunk'));
    expect(Array.from(new Uint8Array(first.bytes))).toEqual(Array(144).fill(127)); ack(0);
    const masks = await context.next('masks'); expect(masks.type).toBe('masks');
    if (masks.type === 'masks') expect(Array.from(new Uint8Array(masks.bytes))).toEqual([0, 1, 2]);
    await context.next('result'); expect(f.pack).toHaveBeenCalledWith(9, 10, 0, 0, 3); expect(f.masks).toHaveBeenCalledWith(9, 10, 0);
    expect(baseCalls).toHaveLength(0); expect(documentCalls).toHaveLength(0); expect(maskCalls).toBe(0);
  });
  it.each(['id', 'baseId', 'epoch'] as const)('refuses stale %s before either opacity export', async field => {
    const f = await opacityBase(); stream({ ...identity, [field]: identity[field] + 1 });
    expect(await context.next('error')).toMatchObject({ error: 'The opacity-base stream is stale.' });
    expect(f.pack).not.toHaveBeenCalled(); expect(f.masks).not.toHaveBeenCalled();
  });
  it.each([undefined, null, { id: 0, baseId: 10, epoch: 0 }, { ...identity, extra: 1 }])('refuses malformed opacity identity %#', async value => {
    const f = await opacityBase(); context.send({ ...envelope, type: 'stream', channel: 'opacityBase', opacityBase: value });
    expect(await context.next('error')).toMatchObject({ error: 'Invalid opacity-base stream identity.' });
    expect(f.pack).not.toHaveBeenCalled(); expect(f.masks).not.toHaveBeenCalled();
  });
  it.each([3, 21_846])('rechecks the epoch after an acknowledged chunk of %s records and exposes no stale masks', async count => {
    const f = await opacityBase(count); stream(); await context.next('chunk');
    native = { ...native, opacitySession: { ...native.opacitySession!, epoch: 1 } }; ack(0);
    expect(await context.next('error')).toMatchObject({ error: 'The opacity-base stream is stale.' }); expect(f.pack).toHaveBeenCalledTimes(1);
    expect(f.masks).not.toHaveBeenCalled(); expect(maskCalls).toBe(0);
  });
  it('refuses a pending opacity job and never substitutes a document base', async () => {
    const f = await opacityBase(); native = { ...native, pending: true }; stream();
    expect(await context.next('error')).toMatchObject({ error: 'The opacity-base stream is stale.' }); expect(f.pack).not.toHaveBeenCalled();
    expect(documentCalls).toHaveLength(0);
  });
  it('rejects an unavailable frozen mask pointer without borrowing current document masks', async () => {
    const f = await opacityBase(); f.masks.mockReturnValue(0); stream(); await context.next('chunk'); ack(0);
    expect(await context.next('error')).toMatchObject({ error: 'The scene mask range is unavailable.' }); expect(maskCalls).toBe(0);
    expect(f.masks).toHaveBeenCalledExactlyOnceWith(9,10,0); expect(f.pack).toHaveBeenCalledOnce();
    expect(context.sent.filter(value => value.type === 'masks')).toHaveLength(0);
  });
  it('cancels held base transfer without releasing its native owner or publishing masks', async () => {
    const f = await opacityBase(); stream(); await context.next('chunk'); context.send({ ...envelope, type: 'cancel' });
    expect(await context.next('error')).toMatchObject({ cancelled: true, cleanupFailed: false }); expect(f.masks).not.toHaveBeenCalled();
    context.send({ ...envelope, requestId: 3, type: 'command', command: { command: 'summary' } });
    expect(await context.next('result')).toMatchObject({ summary: { opacitySession: identity } }); expect(documentCalls).toHaveLength(0);
  });
  it.each(['missing', 'collision'] as const)('retires fatal %s opacity telemetry before packing or fabricating an initialized response', async fault => {
    const f = await opacityBase(); vi.useFakeTimers();
    try {
      if (fault === 'missing') delete (native as unknown as Record<string, unknown>).opacitySession;
      else native = { ...native, colorSession: session() };
      const before = context.sent.length; stream(); for (let index = 0; index < 20; index++) await Promise.resolve();
      expect(vi.getTimerCount()).toBe(1); expect(() => vi.runOnlyPendingTimers()).toThrow(/opacity/i);
      expect(context.sent).toHaveLength(before); expect(f.pack).not.toHaveBeenCalled(); expect(f.masks).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
function begin(overrides: Record<string, unknown> = {}) {
  context.send({ ...envelope, type: 'stream', channel: 'colorBase', colorBase: identity, ...overrides });
}
function ack(chunkId: number) { context.send({ ...envelope, type: 'ack', chunkId }); }
function chunk(value: Response): Extract<WorkerResponse, { type: 'chunk' }> {
  expect(value.type).toBe('chunk'); return value as Extract<WorkerResponse, { type: 'chunk' }>;
}
function refusedBeforePacking() {
  expect(baseCalls).toHaveLength(0); expect(documentCalls).toHaveLength(0); expect(maskCalls).toBe(0);
  expect(colorMaskCalls).toHaveLength(0);
  expect(context.sent.filter(value => value.type === 'chunk' || value.type === 'masks')).toHaveLength(0);
}

describe('color-base stream identity and packing ownership', () => {
  it('streams the immutable base through the base packer and its keyed frozen masks', async () => {
    begin(); const first = chunk(await context.next('chunk'));
    expect(first).toMatchObject({ first: 0, count: 3, chunkId: 0 });
    expect(Array.from(new Uint8Array(first.bytes))).toEqual(Array(144).fill(17));
    ack(0); const masks = await context.next('masks');
    expect(masks.type).toBe('masks'); if (masks.type === 'masks') expect(Array.from(new Uint8Array(masks.bytes))).toEqual([1, 0, 2]);
    expect(await context.next('result')).toMatchObject({ summary: { colorSession: identity } });
    expect(baseCalls).toEqual([[0, 3]]); expect(documentCalls).toHaveLength(0); expect(maskCalls).toBe(0);
    expect(colorMaskCalls).toEqual([[1, 2, 3]]);
  });
  it('keeps the ordinary document channel on the baked document packer', async () => {
    begin({ channel: 'document', colorBase: undefined }); const first = chunk(await context.next('chunk'));
    expect(Array.from(new Uint8Array(first.bytes))).toEqual(Array(144).fill(83));
    ack(0); await context.next('masks'); await context.next('result');
    expect(documentCalls).toEqual([[0, 3]]); expect(baseCalls).toHaveLength(0);
  });
  it.each(['sessionId', 'baseId', 'epochId'] as const)('refuses stale %s before either packer', async field => {
    begin({ colorBase: { ...identity, [field]: identity[field] + 1 } });
    expect(await context.next('error')).toMatchObject({ error: 'The color-base stream is stale.' }); refusedBeforePacking();
  });
  it.each([undefined, null, [], { ...identity, extra: true }, { ...identity, epochId: '3' },
    { ...identity, sessionId: 0 }, { ...identity, baseId: Number.MAX_SAFE_INTEGER + 1 },
    Object.assign([], identity)])('refuses a malformed or missing identity %# before packing', async colorBase => {
    begin({ colorBase }); expect(await context.next('error')).toMatchObject({ error: 'Invalid color-base stream identity.' }); refusedBeforePacking();
  });
  it.each(['pending', 'inactive'] as const)('refuses an %s base before packing', async state => {
    native = { ...native, colorSession: state === 'pending' ? { ...session(), pending: true } : null };
    begin(); expect(await context.next('error')).toMatchObject({ error: 'The color-base stream is stale.' }); refusedBeforePacking();
  });
  it.each([{ channel: 'document' }, { channel: undefined }, { channel: 'other' }])('refuses an invalid stream channel/identity pairing %#', async fields => {
    begin(fields); expect((await context.next('error')).type).toBe('error'); refusedBeforePacking();
  });
  it('refuses a changed epoch before the next chunk and never publishes masks', async () => {
    native = { ...summary(21_846), revision: native.revision + 1, contentRevision: native.contentRevision + 1 };
    context.send({ ...envelope, requestId: 1, type: 'command', command: { command: 'summary' } }); await context.next('result');
    begin(); const first = chunk(await context.next('chunk'));
    expect(first.count).toBe(21_845); native = { ...native, colorSession: { ...session(), epochId: 4 } };
    ack(first.chunkId); expect(await context.next('error')).toMatchObject({ error: 'The color-base stream is stale.' });
    expect(baseCalls).toEqual([[0, 21_845]]); expect(documentCalls).toHaveLength(0); expect(maskCalls).toBe(0);
    expect(context.sent.filter(value => value.type === 'chunk')).toHaveLength(1);
  });
  it('rechecks the epoch after the final chunk before publishing masks', async () => {
    begin(); await context.next('chunk'); native = { ...native, colorSession: { ...session(), epochId: 4 } };
    ack(0); expect(await context.next('error')).toMatchObject({ error: 'The color-base stream is stale.' });
    expect(baseCalls).toEqual([[0, 3]]); expect(documentCalls).toHaveLength(0); expect(maskCalls).toBe(0);
  });
  it.each(['zero', 'wrong-length'] as const)('refuses %s base packing without exposing a chunk', async fault => {
    packFault = fault; begin(); expect(await context.next('error')).toMatchObject({ error: 'Invalid packed scene chunk.' });
    expect(baseCalls).toEqual([[0, 3]]); expect(documentCalls).toHaveLength(0); expect(maskCalls).toBe(0);
    expect(context.sent.filter(value => value.type === 'chunk')).toHaveLength(0);
  });
  it('cancels a held transfer without reading masks and admits the next summary', async () => {
    begin(); await context.next('chunk'); context.send({ ...envelope, type: 'cancel' });
    expect(await context.next('error')).toMatchObject({ cancelled: true, cleanupFailed: false });
    expect(baseCalls).toEqual([[0, 3]]); expect(maskCalls).toBe(0);
    context.send({ ...envelope, requestId: 3, type: 'command', command: { command: 'summary' } });
    expect(await context.next('result')).toMatchObject({ summary: { colorSession: identity } });
  });
  it('copies and freezes exact safe identities independently of later caller mutation', () => {
    const input = { ...identity, epochId: Number.MAX_SAFE_INTEGER }, captured = validateColorBaseIdentity(input);
    input.epochId = 1; expect(captured.epochId).toBe(Number.MAX_SAFE_INTEGER); expect(Object.isFrozen(captured)).toBe(true);
    expect(() => validateColorBaseIdentity(Object.create(identity))).toThrow('Invalid color-base stream identity.');
  });
});
