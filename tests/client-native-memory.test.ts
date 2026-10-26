import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILD_DESCRIPTOR } from '../src/generated/buildIdentity';
import { transformDefaults } from '../src/document/transformProtocol';
import { CoreClient } from '../src/document/coreClient';
import { NativeHeapAccounting, WASM_PAGE_BYTES as P } from '../src/document/nativeMemory';
import { AdmissionError, ResourceLedger, type ResourceLease } from '../src/document/resources';
import type { SourceLoadOptions, SourceRange } from '../src/document/source';
import { NEUTRAL_COLOR } from '../src/renderer/defaults';
import { type NativeAllocationSnapshot, type NativeSummary, type WorkerRequest } from '../src/document/types';
import type { ColorSessionSummary } from '../src/document/colorProtocol';
import { emptyCensus } from './fixtures/allocation-census';
import { IDENTITY_ALIGNMENT_FRAME } from '../src/document/alignment';
import type { AlignmentSummary } from '../src/document/alignmentProtocol';

vi.mock('../src/build/runtime', () => ({
  ensureRuntime: async () => ({ mode: 'production-verified', assetBase: 'https://example.test/',
    artifacts: new Map([['document-worker', { bytes: new ArrayBuffer(1) }]]) }),
  runtimeNativeSource: () => undefined,
}));

const MiB = 1_048_576;
type Load = Extract<WorkerRequest, { type: 'source-load' }>;
type SourceChunk = Extract<WorkerRequest, { type: 'source-range' }>;
type ReadyOptions = { heapBytes?: number; raw?: Record<string, unknown> };
type TelemetryOptions = { heapBytes?: number; allocation?: NativeAllocationSnapshot; raw?: Record<string, unknown> };
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function nativeSummary(overrides: Partial<NativeSummary> = {}): NativeSummary {
  return { ok: true, selectionCommitRevision: 0, undoSelectionRevision: 0, toleranceRecorded: null, toleranceRange: null, toleranceSessionId: null, toleranceTool: null, duplicateRange: null, loaded: true, kind: 0, format: 'PLY', count: 3, sourceCount: 3, shDegree: 0,
    selected: 0, visible: 3, canUndo: false, canRedo: false, revision: 0, contentRevision: 0,
    transaction: false, selectionDraft: false, sceneChanged: false, pending: false, progress: 1, floor: null, filter: null, transformSession: null, opacitySession: null,
    center: [0, 0, 0], radius: 1, yUp: false,
    camera: [0, 0, 0, 0, 0, 3, 1, 45, 0, 0, 1], memoryBytes: 1024,
    selectionMapId: null, pendingSelectionMapId: null, selectionMapBytes: 0,
    selectionMapRetainedIds: [], ...overrides };
}
function allocation(summary?: NativeSummary): NativeAllocationSnapshot {
  return Object.freeze({ loaded: summary?.loaded ?? false, kind: summary?.kind ?? 0,
    count: summary?.count ?? 0, memoryBytes: summary?.memoryBytes ?? 0,
    selectionMapBytes: summary?.selectionMapBytes ?? 0,
    selectionMapRetainedIds: Object.freeze([...(summary?.selectionMapRetainedIds ?? [])]) });
}
function emptySummary(): NativeSummary {
  return nativeSummary({ loaded: false, count: 0, sourceCount: 0, visible: 0, format: '', memoryBytes: 0 });
}
// Independent literal v1 single-source byte layout. Native hash/encoder code is
// not imported: the client tests only validate the completed wire contract.
function fingerprint(bytes: Uint8Array<ArrayBuffer>) {
  const canonical = Buffer.alloc(69);
  canonical.write('SplatViewSource\0v1\0', 0, 'ascii');
  canonical.writeUInt32BE(1, 20); canonical[24] = 1;
  canonical.writeBigUInt64BE(BigInt(bytes.length), 29);
  createHash('sha256').update(bytes).digest().copy(canonical, 37);
  return { scheme: 'splatview-source-v1' as const, resourceCount: 1, totalBytes: bytes.length,
    sourceKindHint: 'PLY', assetDigest: createHash('sha256').update(canonical).digest('hex') };
}
function sourceRange(request: Load, offset = 0, rangeId = 0): SourceRange {
  return { operationId: request.source.operationId, resourceId: request.source.resourceId,
    offset, rangeId, length: Math.min(MiB, request.source.byteLength - offset) };
}
class ObservedWorker {
  static latest: ObservedWorker;
  static ready: ReadyOptions = {};
  onmessage?: (event: { data: unknown }) => void;
  onerror?: (event: { preventDefault(): void; message: string }) => void;
  onmessageerror?: () => void;
  initializationId = '';
  heapBytes = 2 * P;
  heapSequence = 0;
  censusSequence = 0;
  currentAllocation = allocation();
  terminated = 0;
  sent: WorkerRequest[] = [];
  private unread: WorkerRequest[] = [];
  private waiters: { type: WorkerRequest['type']; resolve(value: WorkerRequest): void }[] = [];
  constructor() { ObservedWorker.latest = this; }
  postMessage(value: WorkerRequest | { type: 'initialize'; initializationId: string; mode: string }, transfer: Transferable[] = []) {
    if (value.type === 'initialize') {
      this.initializationId = value.initializationId;
      this.heapBytes = ObservedWorker.ready.heapBytes ?? 2 * P;
      const raw = ObservedWorker.ready.raw;
      const data = structuredClone({ type: 'ready', initializationId: value.initializationId,
        mode: value.mode, build: BUILD_DESCRIPTOR, core: BUILD_DESCRIPTOR.native.core,
        heap: { sequence: ++this.heapSequence, heapBytes: this.heapBytes }, census: emptyCensus(++this.censusSequence), allocation: null, ...raw });
      setTimeout(() => this.onmessage?.({ data }), 0);
      return;
    }
    // Genuine transferable detachment, rather than a shared sender/receiver.
    const copied = structuredClone(value, { transfer }) as WorkerRequest;
    this.sent.push(copied);
    const index = this.waiters.findIndex(waiter => waiter.type === copied.type);
    if (index === -1) this.unread.push(copied);
    else this.waiters.splice(index, 1)[0].resolve(copied);
  }
  next<T extends WorkerRequest['type']>(type: T): Promise<Extract<WorkerRequest, { type: T }>> {
    const index = this.unread.findIndex(value => value.type === type);
    if (index !== -1) return Promise.resolve(this.unread.splice(index, 1)[0] as Extract<WorkerRequest, { type: T }>);
    return new Promise(resolve => this.waiters.push({ type,
      resolve: value => resolve(value as Extract<WorkerRequest, { type: T }>) }));
  }
  respond(request: WorkerRequest, result: Record<string, unknown>, options: TelemetryOptions = {}): Promise<void> {
    this.heapBytes = options.heapBytes ?? this.heapBytes;
    this.currentAllocation = options.allocation ?? this.currentAllocation;
    const data = structuredClone({ ...request, ...result, initializationId: this.initializationId,
      heap: { sequence: ++this.heapSequence, heapBytes: this.heapBytes },
      census: emptyCensus(++this.censusSequence),
      allocation: this.currentAllocation, ...options.raw });
    return new Promise(resolve => setTimeout(() => { this.onmessage?.({ data }); resolve(); }, 0));
  }
  terminate() { this.terminated++; }
}

const clients: CoreClient[] = [];
const leases: ResourceLease[] = [];
const unblock: (() => void)[] = [];
function own(ledger: ResourceLedger, category: Parameters<ResourceLedger['reserve']>[0], bytes: number) {
  const lease = ledger.reserve(category, bytes); leases.push(lease); return lease;
}
function createClient(ledger = new ResourceLedger(512 * P), ready: ReadyOptions = {}) {
  vi.stubGlobal('document', { baseURI: 'https://example.test/' }); vi.stubGlobal('Worker', ObservedWorker);
  ObservedWorker.ready = ready;
  const remainder = own(ledger, 'source', 2 * P), memory = new NativeHeapAccounting(ledger, remainder);
  const core = new CoreClient(memory); clients.push(core);
  return { core, memory, remainder, ledger };
}
async function client(ledger?: ResourceLedger, ready?: ReadyOptions) {
  const value = createClient(ledger, ready); await value.core.ready();
  return { ...value, worker: ObservedWorker.latest };
}
function file(bytes: Uint8Array<ArrayBuffer>, held?: Promise<ArrayBuffer>) {
  const value = new File([bytes], 'memory-source.ply'), original = value.slice.bind(value);
  const entered = deferred<void>(), slices: [number | undefined, number | undefined][] = [];
  value.slice = (start, end, type) => {
    slices.push([start, end]); const slice = original(start, end, type), read = slice.arrayBuffer.bind(slice);
    slice.arrayBuffer = () => {
      entered.resolve(); const actual = read();
      return held ? actual.then(() => held) : actual;
    };
    return slice;
  };
  return { file: value, slices, entered: entered.promise };
}
async function begin(value: Awaited<ReturnType<typeof client>>, bytes = new Uint8Array([11, 22, 33, 44]), held?: Promise<ArrayBuffer>) {
  const input = file(bytes, held), nativeLease = own(value.ledger, 'decoded', 2 * P), sourceLeases: ResourceLease[] = [];
  const options: SourceLoadOptions = { nativeLease,
    current() {}, admit(size) { const lease = own(value.ledger, 'source', size); sourceLeases.push(lease); return lease; } };
  const opening = value.core.load(input.file, 100, 128 * P, options);
  const request = await value.worker.next('source-load');
  return { ...value, ...input, bytes, nativeLease, sourceLeases, request, opening };
}
async function deliver(value: Awaited<ReturnType<typeof begin>>, offset = 0, rangeId = 0, heapBytes?: number): Promise<SourceChunk> {
  await value.worker.respond(value.request, { type: 'source-range-request', ...sourceRange(value.request, offset, rangeId) },
    { heapBytes, allocation: allocation() });
  const chunk = await value.worker.next('source-range');
  expect(chunk.bytes.byteLength).toBe(sourceRange(value.request, offset, rangeId).length);
  return chunk;
}
async function consume(value: Awaited<ReturnType<typeof begin>>, offset = 0, rangeId = 0) {
  await value.worker.respond(value.request, { type: 'source-range-consumed', ...sourceRange(value.request, offset, rangeId) });
  await tick();
}
async function finish(value: Awaited<ReturnType<typeof begin>>, heapBytes = value.worker.heapBytes, summary = nativeSummary()) {
  await value.worker.respond(value.request, { type: 'source-load-result', operationId: value.request.source.operationId,
    resourceId: value.request.source.resourceId, consumedBytes: value.bytes.length,
    summary, fingerprint: fingerprint(value.bytes) }, { heapBytes, allocation: allocation(summary) });
  return value.opening;
}
async function loaded(ledger?: ResourceLedger) {
  const value = await begin(await client(ledger)); await deliver(value); await consume(value); await finish(value); return value;
}

afterEach(async () => {
  for (const release of unblock.splice(0)) release();
  for (const core of clients.splice(0)) await core.retireNativeMemory();
  for (const lease of leases.splice(0)) lease();
  vi.unstubAllGlobals();
});

describe('CoreClient required Duplicate topology', () => {
  it.each(['first-result', 'after-null', 'retained-error'] as const)('rejects missing marker metadata on %s', async boundary => {
    const value = boundary === 'first-result' ? await client() : await loaded();
    const before = { ...value.core.revision };
    const reading = value.core.command({ command: 'summary' }), refused = expect(reading).rejects.toThrow(/Duplicate range/);
    const request = await value.worker.next('command'), invalid = boundary === 'first-result' ? emptySummary() : nativeSummary();
    delete (invalid as unknown as Record<string, unknown>).duplicateRange;
    await value.worker.respond(request, boundary === 'retained-error' ? { type: 'error', error: 'Native refused', summary: invalid } :
      { type: 'result', summary: invalid }, { allocation: allocation(invalid) });
    await refused; expect(value.worker.terminated).toBe(1); expect(value.core.revision).toEqual(before);
  });
  it.each([{ count: 4, sourceCount: 4 }, { sourceCount: 4 }, { duplicateRange: { first: 2, count: 1 } }])(
    'retires a retained error whose topology changes without a native revision %#', async change => {
      const value = await loaded(), before = { ...value.core.revision };
      const reading = value.core.command({ command: 'summary' }), refused = expect(reading).rejects.toThrow(/without a revision/);
      const request = await value.worker.next('command'), invalid = nativeSummary(change);
      await value.worker.respond(request, { type: 'error', error: 'Native refused', summary: invalid }, { allocation: allocation(invalid) });
      await refused; expect(value.worker.terminated).toBe(1); expect(value.core.revision).toEqual(before);
    });
  it('accepts grown cardinality and value-equal markers, then refuses a changed suffix without a native revision', async () => {
    const value = await loaded();
    const grown = nativeSummary({ count: 5, sourceCount: 5, selected: 2, visible: 5, revision: 1, contentRevision: 1,
      duplicateRange: { first: 3, count: 2 } });
    for (let index = 0; index < 2; index++) {
      const observing = value.core.command({ command: index === 0 ? 'duplicate' : 'summary' }), request = await value.worker.next('command');
      await value.worker.respond(request, { type: 'result', summary: { ...grown, duplicateRange: { first: 3, count: 2 } } }, { allocation: allocation(grown) });
      await expect(observing).resolves.toMatchObject({ count: 5, duplicateRange: { first: 3, count: 2 } });
    }
    const observing = value.core.command({ command: 'summary' }), refused = expect(observing).rejects.toThrow(/without a revision/);
    const request = await value.worker.next('command');
    await value.worker.respond(request, { type: 'result', summary: { ...grown, duplicateRange: null } });
    await refused; expect(value.worker.terminated).toBe(1);
  });
});

describe('CoreClient required transform metadata', () => {
  it.each(['first-result', 'after-null', 'retained-error'] as const)('rejects a missing field on %s without advancing semantic revisions', async boundary => {
    const value = boundary === 'first-result' ? await client() : await loaded();
    const before = { ...value.core.revision }, content = value.core.nativeContentRevision;
    const reading = value.core.command({ command: 'summary' }), refused = expect(reading).rejects.toThrow('Invalid native transform session');
    const request = await value.worker.next('command'), invalid = boundary === 'first-result' ? emptySummary() : nativeSummary();
    delete (invalid as unknown as Record<string, unknown>).transformSession;
    await value.worker.respond(request, boundary === 'retained-error' ? { type: 'error', error: 'Native refused', summary: invalid } :
      { type: 'result', summary: invalid }, { allocation: allocation(invalid) });
    await refused; expect(value.worker.terminated).toBe(1); expect(value.core.revision).toEqual(before);
    expect(value.core.nativeContentRevision).toBe(content);
  });
  it('accepts explicit null and fences a transform-base stream to the published owner', async () => {
    const value = await loaded();
    const observe = value.core.command({ command: 'beginTransform', kind: 'numeric', selectedOnly: true }), request = await value.worker.next('command');
    const transformSession = { id: 7, baseId: 8, epoch: 0, appliedEpoch: null, kind: 'numeric' as const,
      selectedOnly: true, appliedMatrix: transformDefaults().matrix, pivot: [0, 0, 0] as [number, number, number], gizmo: null };
    await value.worker.respond(request, { type: 'result', summary: nativeSummary({ transformSession }) }); await observe;
    const masks = vi.fn(), streaming = value.core.stream(async () => {}, masks, 'transformBase'), streamed = await value.worker.next('stream');
    expect(streamed.transformBase).toEqual({ id: 7, baseId: 8, epoch: 0 });
    expect(streamed.channel).toBe('transformBase');
    await value.worker.respond(streamed, { type: 'masks', bytes: new Uint8Array([0,0,0]).buffer });
    await value.worker.respond(streamed, { type: 'result', summary: nativeSummary({ transformSession }) }); await streaming;
    expect(masks).toHaveBeenCalledOnce(); expect(Array.from(new Uint8Array(masks.mock.calls[0][0]))).toEqual([0,0,0]);
    const ended = value.core.command({ command: 'endTransform', id: 7 }), ending = await value.worker.next('command');
    await value.worker.respond(ending, { type: 'result', summary: nativeSummary() }); await expect(ended).resolves.toMatchObject({ transformSession: null, opacitySession: null });
    expect(() => value.core.stream(async () => {}, () => {}, 'transformBase')).toThrow('transform base is unavailable');
    expect(value.worker.terminated).toBe(0);
  });
});

describe('CoreClient required opacity metadata and captured entry transport', () => {
  const opacitySession = { id: 11, baseId: 12, epoch: 0, appliedEpoch: null, selectedOnly: true, appliedScale: 1 };
  async function acknowledge(value: Awaited<ReturnType<typeof loaded>>, metadata = opacitySession) {
    const next = nativeSummary({ opacitySession: metadata }), reading = value.core.command({ command: 'summary' });
    const request = await value.worker.next('command'); await value.worker.respond(request, { type: 'result', summary: next }, { allocation: allocation(next) });
    await reading; return next;
  }
  it.each(['first-result', 'after-null', 'retained-error'] as const)('rejects absent opacitySession on %s before advancing semantic revisions', async boundary => {
    const value = boundary === 'first-result' ? await client() : await loaded(), before = { ...value.core.revision };
    const reading = value.core.command({ command: 'summary' }), refused = expect(reading).rejects.toThrow('Invalid native opacity session');
    const request = await value.worker.next('command'), invalid = boundary === 'first-result' ? emptySummary() : nativeSummary();
    delete (invalid as unknown as Record<string, unknown>).opacitySession;
    await value.worker.respond(request, boundary === 'retained-error' ? { type: 'error', error: 'Native refused', summary: invalid } :
      { type: 'result', summary: invalid }, { allocation: allocation(invalid) });
    await refused; expect(value.worker.terminated).toBe(1); expect(value.core.revision).toEqual(before);
  });
  it('streams only the acknowledged immutable owner and refuses an explicitly ended base before posting', async () => {
    const value = await loaded(), next = await acknowledge(value);
    const chunk = vi.fn(async () => {}), masks = vi.fn(), streaming = value.core.stream(chunk, masks, 'opacityBase');
    const request = await value.worker.next('stream'); expect(request).toMatchObject({ channel: 'opacityBase', opacityBase: { id: 11, baseId: 12, epoch: 0 } });
    await value.worker.respond(request, { type: 'chunk', first: 0, count: 3, chunkId: 0, bytes: new ArrayBuffer(144) });
    await value.worker.next('ack'); await value.worker.respond(request, { type: 'masks', bytes: new ArrayBuffer(3) });
    await value.worker.respond(request, { type: 'result', summary: next }); await streaming;
    expect(chunk).toHaveBeenCalledOnce(); expect(masks).toHaveBeenCalledOnce();
    const ending = value.core.command({ command: 'summary' }), end = await value.worker.next('command');
    await value.worker.respond(end, { type: 'result', summary: nativeSummary() }); await ending;
    expect(() => value.core.stream(chunk, masks, 'opacityBase')).toThrow('opacity base is unavailable');
    expect(value.worker.sent.filter(request => request.type === 'stream')).toHaveLength(1); expect(value.worker.terminated).toBe(0);
  });
  it('captures a queued stream epoch before a later acknowledgment and propagates stale refusal without retiring native memory', async () => {
    const value = await loaded(); await acknowledge(value);
    const reading = value.core.command({ command: 'summary' }), request = await value.worker.next('command');
    const chunk = vi.fn(async () => {}), masks = vi.fn(), streaming = value.core.stream(chunk, masks, 'opacityBase');
    const refused = expect(streaming).rejects.toThrow('The opacity-base stream is stale.'), next = nativeSummary({ opacitySession: { ...opacitySession, epoch: 1 } });
    await value.worker.respond(request, { type: 'result', summary: next }, { allocation: allocation(next) }); await reading;
    const captured = await value.worker.next('stream'); expect(captured.opacityBase).toEqual({ id: 11, baseId: 12, epoch: 0 });
    await value.worker.respond(captured, { type: 'error', error: 'The opacity-base stream is stale.', summary: next }); await refused;
    expect(chunk).not.toHaveBeenCalled(); expect(masks).not.toHaveBeenCalled(); expect(value.worker.terminated).toBe(0);
  });
  it.each(['unloaded', 'manual-draft', 'color-owner', 'transform-owner'] as const)('rejects an opacity owner colliding with %s', async fault => {
    const value = await loaded(), reading = value.core.command(fault === 'transform-owner' ? { command: 'beginTransform', kind: 'numeric', selectedOnly: true } :
      { command: fault === 'unloaded' ? 'restore' : 'summary' }), refused = expect(reading).rejects.toThrow(/opacity/i);
    const request = await value.worker.next('command'), invalid = nativeSummary({ opacitySession,
      ...(fault === 'unloaded' ? { loaded: false, count: 0, sourceCount: 0, visible: 0, revision: 1, contentRevision: 1 } : fault === 'manual-draft' ? { selectionDraft: true } :
        fault === 'color-owner' ? { colorSession: { version: 1, active: true, sessionId: 1, baseId: 2, epochId: 3, pending: false,
          selectedOnly: true, values: [...NEUTRAL_COLOR], applied: [...NEUTRAL_COLOR] } } :
          { transformSession: { id: 1, baseId: 2, epoch: 0, appliedEpoch: null, kind: 'numeric', selectedOnly: true,
            appliedMatrix: transformDefaults().matrix, pivot: [0, 0, 0], gizmo: null } }) });
    await value.worker.respond(request, { type: 'result', summary: invalid }, { allocation: allocation(invalid) }); await refused;
    expect(value.worker.terminated).toBe(1);
  });
  it('rejects active opacity in a newly published source without releasing the old source contract', async () => {
    const value = await begin(await client()), before = { ...value.core.revision }; await deliver(value); await consume(value);
    const refused = expect(value.opening).rejects.toThrow(/source summary|opacity/i);
    await value.worker.respond(value.request, { type: 'source-load-result', operationId: value.request.source.operationId,
      resourceId: value.request.source.resourceId, consumedBytes: value.bytes.length, fingerprint: fingerprint(value.bytes),
      summary: nativeSummary({ opacitySession }) }, { allocation: allocation(nativeSummary()) });
    await refused; expect(value.worker.terminated).toBe(1); expect(value.core.revision).toEqual(before);
  });
});

describe('CoreClient established Gaussian alignment metadata', () => {
  const metadata = (): AlignmentSummary => ({ version: 2, frame: IDENTITY_ALIGNMENT_FRAME, branchId: 0, canReset: false, retainedBranchIds: [0] });
  async function alignedClient() {
    const value = await begin(await client()); await deliver(value); await consume(value);
    await finish(value, value.worker.heapBytes, nativeSummary({ alignment: metadata() })); return value;
  }
  async function acknowledge(value: Awaited<ReturnType<typeof client>>, summary: NativeSummary, command = 'summary') {
    const reading = value.core.command({ command }), request = await value.worker.next('command');
    await value.worker.respond(request, { type: 'result', summary }, { allocation: allocation(summary) });
    return reading;
  }
  const losses = (['summary', 'commitTransaction', 'rollbackTransaction'] as const)
    .flatMap(command => (['missing', 'null'] as const).map(loss => ({ command, loss })));
  it.each(losses)('retires a $command result whose established Gaussian metadata becomes $loss', async ({ command, loss }) => {
    const value = await alignedClient(), before = { ...value.core.revision }, content = value.core.nativeContentRevision;
    const reading = value.core.command({ command }), refused = expect(reading).rejects.toThrow('lost its alignment metadata');
    const request = await value.worker.next('command');
    const invalid = nativeSummary({ alignment: loss === 'null' ? null : undefined });
    await value.worker.respond(request, { type: 'result', summary: invalid }, { allocation: allocation(invalid) }); await refused;
    expect(value.worker.terminated).toBe(1); expect(value.core.revision).toEqual(before);
    expect(value.core.nativeContentRevision).toBe(content);
    const posted = value.worker.sent.length;
    await expect(value.core.command({ command: 'summary' })).rejects.toThrow('lost its alignment metadata');
    expect(value.worker.sent).toHaveLength(posted);
  });
  it('preserves isolated absent-metadata doubles until they establish alignment ownership', async () => {
    const value = await loaded();
    await expect(acknowledge(value, nativeSummary())).resolves.toMatchObject({ loaded: true, kind: 0 });
    await expect(acknowledge(value, nativeSummary({ alignment: null }))).resolves.toMatchObject({ alignment: null });
    expect(value.worker.terminated).toBe(0);
    await acknowledge(value, nativeSummary({ alignment: metadata() }));
    const reading = value.core.command({ command: 'commitTransaction' });
    const refused = expect(reading).rejects.toThrow('lost its alignment metadata'), request = await value.worker.next('command');
    await value.worker.respond(request, { type: 'result', summary: nativeSummary() }); await refused;
    expect(value.worker.terminated).toBe(1);
  });
  it.each(['unloaded', 'geometry'] as const)('clears the presence latch only at an accepted $0 boundary and can establish it again', async boundary => {
    const value = await alignedClient();
    const next = boundary === 'unloaded' ? { ...emptySummary(), revision: 1, contentRevision: 1 } : nativeSummary({ kind: 1, sourceFaces: 0, sampledGeometry: false,
      geometry: { layoutVersion: 1, kind: 1, vertexCount: 3, triangleCount: 0, vertexStride: 16, indexStride: 4,
        vertexBytes: 48, indexBytes: 0, revision: 1, contentRevision: 1 }, memoryBytes: 48, revision: 1, contentRevision: 1 });
    await acknowledge(value, next, 'restore');
    await expect(acknowledge(value, nativeSummary({ revision: 2, contentRevision: 2 }), 'restore')).resolves.toMatchObject({ kind: 0, loaded: true });
    await acknowledge(value, nativeSummary({ revision: 2, contentRevision: 2, alignment: metadata() }));
    await acknowledge(value, nativeSummary({ revision: 2, contentRevision: 2, alignment: { ...metadata(), branchId: 19, canReset: true, retainedBranchIds: [0, 19] } }));
    const reading = value.core.command({ command: 'rollbackTransaction' });
    const refused = expect(reading).rejects.toThrow('lost its alignment metadata'), request = await value.worker.next('command');
    await value.worker.respond(request, { type: 'result', summary: nativeSummary({ revision: 2, contentRevision: 2, alignment: null }) }); await refused;
    expect(value.worker.terminated).toBe(1);
  });
  it('does not discharge the latch when a geometry boundary fails its own acceptance checks', async () => {
    const value = await alignedClient(), before = { ...value.core.revision };
    const reading = value.core.command({ command: 'restore' }), refused = expect(reading).rejects.toThrow('Invalid geometry descriptor');
    const request = await value.worker.next('command');
    const invalid = nativeSummary({ kind: 1, geometry: null, revision: 1, contentRevision: 1 });
    await value.worker.respond(request, { type: 'result', summary: invalid }, { allocation: allocation(invalid) }); await refused;
    expect(value.worker.terminated).toBe(1); expect(value.core.revision).toEqual(before);
    expect((value.core as unknown as { gaussianAlignmentObserved: boolean }).gaussianAlignmentObserved).toBe(true);
  });
});

describe('CoreClient color-base transport ownership', () => {
  const session = (epochId = 3, pending = false): ColorSessionSummary => ({ version: 1, active: true,
    sessionId: 1, baseId: 2, epochId, selectedOnly: false, pending, values: [...NEUTRAL_COLOR], applied: [...NEUTRAL_COLOR] });
  async function acknowledge(value: Awaited<ReturnType<typeof loaded>>, colorSession: ColorSessionSummary | null) {
    const summary = nativeSummary({ colorSession }), reading = value.core.command({ command: 'summary' });
    const request = await value.worker.next('command');
    await value.worker.respond(request, { type: 'result', summary }, { allocation: allocation(summary) }); await reading;
    return summary;
  }
  it('captures the acknowledged identity and delivers only the requested base transfer', async () => {
    const value = await loaded(), summary = await acknowledge(value, session());
    const chunk = vi.fn(async () => {}), masks = vi.fn(), streaming = value.core.stream(chunk, masks, 'colorBase');
    const request = await value.worker.next('stream');
    expect(request).toMatchObject({ channel: 'colorBase', colorBase: { sessionId: 1, baseId: 2, epochId: 3 } });
    await value.worker.respond(request, { type: 'chunk', first: 0, count: 3, chunkId: 0, bytes: new ArrayBuffer(144) });
    await value.worker.next('ack'); await value.worker.respond(request, { type: 'masks', bytes: new ArrayBuffer(3) });
    await value.worker.respond(request, { type: 'result', summary }); await streaming;
    expect(chunk).toHaveBeenCalledTimes(1); expect(masks).toHaveBeenCalledTimes(1); expect(value.worker.terminated).toBe(0);
  });
  it('keeps a queued stream tied to its captured epoch and exposes no chunks when that epoch becomes stale', async () => {
    const value = await loaded(); await acknowledge(value, session());
    const reading = value.core.command({ command: 'summary' }), readRequest = await value.worker.next('command');
    const chunk = vi.fn(async () => {}), masks = vi.fn(), streaming = value.core.stream(chunk, masks, 'colorBase');
    const refused = expect(streaming).rejects.toThrow('The color-base stream is stale.');
    const current = nativeSummary({ colorSession: session(4) });
    await value.worker.respond(readRequest, { type: 'result', summary: current }, { allocation: allocation(current) }); await reading;
    const request = await value.worker.next('stream'); expect(request.colorBase?.epochId).toBe(3);
    await value.worker.respond(request, { type: 'error', error: 'The color-base stream is stale.', summary: current }); await refused;
    expect(chunk).not.toHaveBeenCalled(); expect(masks).not.toHaveBeenCalled(); expect(value.worker.terminated).toBe(0);
  });
  it.each(['inactive', 'pending'] as const)('refuses an %s base before posting a stream', async state => {
    const value = await loaded(); await acknowledge(value, state === 'pending' ? session(3, true) : null);
    expect(() => value.core.stream(async () => {}, () => {}, 'colorBase')).toThrow('The color base is unavailable.');
    expect(value.worker.sent.filter(request => request.type === 'stream')).toHaveLength(0);
  });
  it.each(['identity', 'fields'] as const)('retires malformed acknowledged %s without publishing a reusable base identity', async field => {
    const value = await loaded(), reading = value.core.command({ command: 'summary' });
    const refused = expect(reading).rejects.toThrow(/Invalid (native color identity|color values)/);
    const request = await value.worker.next('command');
    const colorSession = field === 'identity' ? { ...session(), epochId: Number.MAX_SAFE_INTEGER + 1 } :
      { ...session(), applied: new Array(15) };
    const summary = nativeSummary({ colorSession });
    await value.worker.respond(request, { type: 'result', summary }, { allocation: allocation(summary) }); await refused;
    expect(value.worker.terminated).toBe(1); expect(value.worker.sent.filter(request => request.type === 'stream')).toHaveLength(0);
  });
});

describe('initialized CoreClient heap admission and lifecycle', () => {
  it('owns initial measurement before readiness and keeps a candidate inactive until activation', async () => {
    const { core, memory, remainder, ledger } = await client();
    expect(core.nativeMemory).toBe(memory);
    expect(memory.state).toMatchObject({ observed: true, active: false, sequence: 1,
      heapBytes: 2 * P, coveredBytes: 0, remainderBytes: 2 * P });
    expect(remainder.bytes).toBe(2 * P); expect(ledger.usage.bytes).toBe(2 * P);
    core.activateNativeMemory(); expect(memory.state.active).toBe(true);
    await core.retireNativeMemory(); await core.retireNativeMemory();
    expect(memory.state.retired).toBe(true); expect(ledger.usage.bytes).toBe(0);
  });

  it('refuses an unaffordable initialized candidate before I/O and preserves another owner', async () => {
    const ledger = new ResourceLedger(4 * P), prior = own(ledger, 'render', P);
    const value = createClient(ledger, { heapBytes: 4 * P });
    await expect(value.core.ready()).rejects.toThrow();
    const worker = ObservedWorker.latest;
    expect(worker.sent).toEqual([]); expect(worker.terminated).toBe(1);
    expect(value.memory.state).toMatchObject({ active: false, unreconciledHeapBytes: 4 * P });
    expect(prior.bytes).toBe(P); expect(ledger.usage.bytes).toBe(3 * P);
    await value.core.retireNativeMemory();
    expect(ledger.usage.bytes).toBe(P); expect(ledger.owns(prior)).toBe(true);
  });

  it.each([
    ['missing heap', { heap: undefined }],
    ['zero sequence', { heap: { sequence: 0, heapBytes: 2 * P } }],
    ['unaligned heap', { heap: { sequence: 1, heapBytes: 2 * P + 1 } }],
    ['loaded allocation on ready', { allocation: allocation(nativeSummary()) }],
    ['missing census', { census: undefined }],
    ['unexpected census scope', { census: { ...emptyCensus(1), scope: 'whole-heap' } }],
    ['wrong initialization', { initializationId: 'foreign-initialization' }],
  ] as const)('rejects %s at ready without publishing admission', async (_label, raw) => {
    const { core, memory } = createClient(undefined, { raw });
    await expect(core.ready()).rejects.toThrow();
    expect(memory.state.active).toBe(false); expect(ObservedWorker.latest.sent).toEqual([]);
    expect(ObservedWorker.latest.terminated).toBe(1);
  });

  it('atomically accounts actual source growth and transfers freed staging into retained heap', async () => {
    // Independent page arithmetic: input20P + hash1P, decoded lease2P.
    // Reading16P owns48P of range copies. H32P−C20P gives R12P:
    // peak=12P+21P+2P+48P=83P. Terminal H64P/N1024 requires66P−1024.
    // Observing terminal H first while stage still exists would require87P,
    // exceeding this84P budget despite sufficient correctly assigned credit.
    const bytes = new Uint8Array(20 * P); bytes[0] = 17; bytes[MiB] = 23;
    const value = await begin(await client(new ResourceLedger(84 * P)), bytes);
    const first = await deliver(value, 0, 0, 32 * P);
    expect(new Uint8Array(first.bytes)[0]).toBe(17);
    await consume(value);
    const tail = await deliver(value, MiB, 1, 32 * P);
    expect(new Uint8Array(tail.bytes)[0]).toBe(23); await consume(value, MiB, 1);
    const result = await finish(value, 64 * P);
    expect(result.fingerprint).toEqual(fingerprint(bytes));
    expect(value.memory.state).toMatchObject({ active: false, heapBytes: 64 * P,
      coveredBytes: 1024, remainderBytes: 64 * P - 1024, ledgerOverageBytes: 0 });
    expect(value.nativeLease.bytes).toBe(2 * P);
    expect(value.ledger.usage).toEqual({ bytes: 66 * P - 1024, peakBytes: 83 * P, allocations: 2 });
    expect(value.sourceLeases.every(lease => !value.ledger.owns(lease))).toBe(true);
    expect(value.worker.terminated).toBe(0);
  });

  it('preserves final decoded admission refusal and holds staging until the candidate retires', async () => {
    const value = await begin(await client(new ResourceLedger(84 * P)), new Uint8Array(20 * P));
    await deliver(value, 0, 0, 32 * P); await consume(value);
    await deliver(value, MiB, 1, 32 * P); await consume(value, MiB, 1);
    const before = value.ledger.usage;
    const rejected = value.opening.catch(error => error as unknown);
    // Final H96P cannot fit an84P budget even after the atomic stage release.
    // This is an admission refusal; releasing the stopped stage is deferred,
    // rather than a second cleanup failure that should hide that reason.
    await finish(value, 96 * P).catch(() => undefined);
    const error = await rejected;
    expect(error).toBeInstanceOf(AdmissionError); expect(error).not.toBeInstanceOf(AggregateError);
    expect((error as Error).message).toMatch(/budget/i);
    expect(value.worker.terminated).toBe(1);
    expect(value.memory.state).toMatchObject({ active: false, retired: false, unreconciledHeapBytes: 96 * P });
    expect(value.ledger.usage).toEqual(before);
    expect(value.sourceLeases.filter(lease => value.ledger.owns(lease)).map(lease => lease.bytes)).toEqual([21 * P]);
    await value.core.retireNativeMemory();
    expect(value.memory.state.retired).toBe(true);
    expect(value.sourceLeases.every(lease => !value.ledger.owns(lease))).toBe(true);
    expect(value.ledger.usage.bytes).toBe(value.nativeLease.bytes);
    value.nativeLease(); expect(value.ledger.usage.bytes).toBe(0);
  });

  it('joins a genuinely held canceled Blob read before releasing the heap owner, independently of a successor', async () => {
    const ledger = new ResourceLedger(64 * P), held = deferred<ArrayBuffer>();
    unblock.push(() => held.resolve(new Uint8Array([11, 22, 33, 44]).buffer));
    const value = await begin(await client(ledger), undefined, held.promise);
    const rejected = expect(value.opening).rejects.toThrow();
    await value.worker.respond(value.request, { type: 'source-range-request', ...sourceRange(value.request) },
      { heapBytes: 4 * P, allocation: allocation() });
    await value.entered;
    const before = ledger.usage;
    let done = false; const retiring = value.core.retireNativeMemory().then(() => { done = true; });
    await tick(); expect(done).toBe(false); expect(value.worker.terminated).toBe(1);
    expect(value.memory.state.retired).toBe(false); expect(ledger.usage).toEqual(before);
    const successor = await client(ledger);
    expect(successor.memory.state).toMatchObject({ heapBytes: 2 * P, retired: false });
    expect(ledger.usage.bytes).toBe(before.bytes + 2 * P);
    held.resolve(new Uint8Array([11, 22, 33, 44]).buffer);
    await rejected; await retiring;
    expect(value.worker.sent.filter(request => request.type === 'source-range')).toHaveLength(0);
    expect(value.memory.state.retired).toBe(true); expect(value.remainder.bytes).toBe(0);
    expect(successor.worker.terminated).toBe(0);
    expect(successor.memory.state).toMatchObject({ sequence: 1, heapBytes: 2 * P, retired: false });
    // The canceled native decoded-peak reservation remains with its caller.
    expect(ledger.usage.bytes).toBe(value.nativeLease.bytes + 2 * P);
    value.nativeLease(); await successor.core.retireNativeMemory(); expect(ledger.usage.bytes).toBe(0);
  });
});

describe('synchronous initialized telemetry before semantic response dispatch', () => {
  it.each(['missing', 'malformed', 'replayed'] as const)('retires a pending command on %s census in nonterminal progress', async fault => {
    const value = await client(), result = value.core.command({ command: 'summary' });
    const rejected = expect(result).rejects.toThrow(/census/i), request = await value.worker.next('command');
    const before = value.ledger.usage, progress = vi.fn(); value.core.onProgress = progress;
    const census = fault === 'missing' ? undefined : fault === 'replayed' ? value.core.nativeAllocationCensus :
      { ...emptyCensus(2), unionBytes: 1 };
    await value.worker.respond(request, { type: 'progress', stage: 'unverifiable', fraction: .5 }, { raw: { census } });
    await rejected; expect(value.worker.terminated).toBe(1); expect(progress).not.toHaveBeenCalled();
    expect(value.worker.sent.map(request => request.type)).toEqual(['command']);
    expect(value.ledger.usage).toEqual(before); expect(value.memory.state.retired).toBe(false);
    await value.core.retireNativeMemory(); expect(value.ledger.usage.bytes).toBe(0);
  });

  it('observes fresh physical storage without granting admission credit or equating query and heap sequences', async () => {
    const value = await client(), before = value.ledger.usage;
    expect(value.core.nativeAllocationCensus).toEqual(emptyCensus(1));
    const result = value.core.command({ command: 'summary' }), request = await value.worker.next('command');
    const census = { ...emptyCensus(101), scenePayloadBytes: 1024, ownedRawBytes: 2048, overlapBytes: 1024,
      contextBytes: 64, unionBytes: 2048, liveBlocks: 2, liveContexts: 1 };
    await value.worker.respond(request, { type: 'result', summary: emptySummary() }, { raw: { census } }); await result;
    expect(value.core.nativeAllocationCensus).toEqual(census); expect(Object.isFrozen(value.core.nativeAllocationCensus)).toBe(true);
    expect(value.memory.state).toMatchObject({ sequence: 2, coveredBytes: 0, remainderBytes: 2 * P });
    expect(value.ledger.usage).toEqual(before); expect(value.worker.terminated).toBe(0);
  });

  it('accounts a valid late old-revision response without pending work or stale summary publication', async () => {
    const value = await client(), result = value.core.command({ command: 'summary' });
    const request = await value.worker.next('command'), summary = emptySummary();
    await value.worker.respond(request, { type: 'result', summary }, { allocation: allocation(summary) });
    await result; const revision = { ...value.core.revision }, progress = vi.fn(); value.core.onProgress = progress;
    expect(request.base).not.toEqual(revision);
    await value.worker.respond(request, { type: 'progress', stage: 'late', fraction: .5 }, { heapBytes: 5 * P });
    expect(value.memory.state).toMatchObject({ sequence: 3, heapBytes: 5 * P, coveredBytes: 0, remainderBytes: 5 * P });
    expect(value.core.revision).toEqual(revision); expect(progress).not.toHaveBeenCalled();
    expect(value.worker.terminated).toBe(0);
  });

  it('commits newer heap telemetry while a transferred chunk callback remains held', async () => {
    const value = await loaded(), held = deferred<void>(), entered = deferred<void>(); unblock.push(() => held.resolve());
    const inspection = value.core.command({ command: 'summary' }), old = await value.worker.next('command');
    await value.worker.respond(old, { type: 'result', summary: nativeSummary() }); await inspection;
    const stream = value.core.stream(async () => { entered.resolve(); await held.promise; }, () => {});
    const request = await value.worker.next('stream');
    await value.worker.respond(request, { type: 'chunk', first: 0, count: 3, chunkId: 0, bytes: new ArrayBuffer(144) });
    await entered; const revision = { ...value.core.revision };
    await value.worker.respond(old, { type: 'progress', stage: 'old request', fraction: .5 }, { heapBytes: 5 * P });
    expect(value.memory.state.heapBytes).toBe(5 * P); expect(value.core.revision).toEqual(revision);
    held.resolve(); await value.worker.next('ack');
    await value.worker.respond(request, { type: 'masks', bytes: new Uint8Array([0,0,0]).buffer });
    await value.worker.respond(request, { type: 'result', summary: nativeSummary() }); await stream;
    expect(value.memory.state.sequence).toBe(value.worker.heapSequence);
    expect(value.memory.state.heapBytes).toBe(5 * P); expect(value.worker.terminated).toBe(0);
  });

  it.each(['initialization', 'build', 'document', 'generation', 'future request', 'replay', 'shrink', 'unaligned',
    'unsafe sequence', 'missing allocation', 'invalid native bytes', 'invalid retained IDs',
    'missing census', 'replayed census', 'invalid census union', 'oversized census', 'unsupported census'] as const)(
    'refuses %s telemetry even after its request left the pending map', async fault => {
      const value = await client(), result = value.core.command({ command: 'summary' });
      const request = await value.worker.next('command'), summary = emptySummary();
      await value.worker.respond(request, { type: 'result', summary }, { allocation: allocation(summary) }); await result;
      const before = value.ledger.usage, state = value.memory.state;
      const raw: Record<string, unknown> = {};
      if (fault === 'initialization') raw.initializationId = 'other';
      if (fault === 'build') raw.buildId = 'other';
      if (fault === 'document') raw.base = { ...request.base, documentId: 'other' };
      if (fault === 'generation') raw.base = { ...request.base, sourceGeneration: request.base.sourceGeneration + 1 };
      if (fault === 'future request') raw.requestId = request.requestId + 100;
      if (fault === 'replay') raw.heap = { sequence: state.sequence, heapBytes: state.heapBytes };
      if (fault === 'shrink') raw.heap = { sequence: state.sequence + 1, heapBytes: P };
      if (fault === 'unaligned') raw.heap = { sequence: state.sequence + 1, heapBytes: state.heapBytes + 1 };
      if (fault === 'unsafe sequence') raw.heap = { sequence: Number.MAX_SAFE_INTEGER + 1, heapBytes: state.heapBytes };
      if (fault === 'missing allocation') raw.allocation = undefined;
      if (fault === 'invalid native bytes') raw.allocation = { ...allocation(), memoryBytes: -1 };
      if (fault === 'invalid retained IDs') raw.allocation = { ...allocation(), selectionMapRetainedIds: [1, 1] };
      if (fault === 'missing census') raw.census = undefined;
      if (fault === 'replayed census') raw.census = value.core.nativeAllocationCensus;
      if (fault === 'invalid census union') raw.census = { ...emptyCensus(100), ownedRawBytes: 1 };
      if (fault === 'oversized census') raw.census = { ...emptyCensus(100), ownedRawBytes: state.heapBytes + 1, unionBytes: state.heapBytes + 1 };
      if (fault === 'unsupported census') raw.census = { ...emptyCensus(100), version: 2 };
      await value.worker.respond(request, { type: 'progress', stage: 'late', fraction: .5 }, { raw });
      await expect(value.core.ready()).rejects.toThrow(); expect(value.worker.terminated).toBe(1);
      expect(value.ledger.usage).toEqual(before); expect(value.memory.state.heapBytes).toBe(state.heapBytes);
      await value.core.retireNativeMemory(); expect(value.ledger.usage.bytes).toBe(0);
    });
});

describe('active client native coverage and retained overage', () => {
  it('publishes committed accounting to observers after late retained growth and joined retirement', async () => {
    const value = await loaded(new ResourceLedger(6 * P));
    const gpu = own(value.ledger, 'render', P);
    value.core.activateNativeMemory(); await tick();
    const notifications: { heap: number; covered: number; remainder: number; used: number; overage: number; retired: boolean }[] = [];
    value.core.onNativeMemoryChanged = () => {
      const state = value.memory.state;
      notifications.push({ heap: state.heapBytes, covered: state.coveredBytes, remainder: state.remainderBytes,
        used: value.ledger.usage.bytes, overage: value.ledger.overageBytes, retired: state.retired });
    };
    const inspect = value.core.command({ command: 'summary' }), request = await value.worker.next('command');
    await value.worker.respond(request, { type: 'result', summary: nativeSummary() }); await inspect;
    notifications.length = 0;
    // A valid duplicate request with newer telemetry has no waiting caller;
    // its retained growth must still reach the persistent UI pressure state.
    await value.worker.respond(request, { type: 'result', summary: nativeSummary() }, { heapBytes: 6 * P });
    expect(notifications).toEqual([{ heap: 6 * P, covered: 1024, remainder: 6 * P - 1024,
      used: 9 * P - 1024, overage: 3 * P - 1024, retired: false }]);
    expect(value.worker.terminated).toBe(0);
    value.core.dispose(); value.core.releaseNativeCoverage(value.nativeLease); gpu();
    await value.core.retireNativeMemory(); await tick();
    expect(notifications.at(-1)).toMatchObject({ used: 0, overage: 0, retired: true });
  });

  it('plans new actual work coverage with growth before transferring it into retained history', async () => {
    const value = await loaded(new ResourceLedger(10 * P));
    const history = own(value.ledger, 'history', P), work = own(value.ledger, 'work', 4 * P);
    value.core.activateNativeMemory();
    value.core.updateNativeCoverage([{ lease: work, nextLeaseBytes: work.bytes, nativeBytes: 0 }]);
    value.core.setNativeWork(work);
    value.core.setNativeCoveragePlanner(snapshot => [
      { lease: value.nativeLease, nextLeaseBytes: value.nativeLease.bytes, nativeBytes: 1024 },
      { lease: history, nextLeaseBytes: history.bytes, nativeBytes: 0 },
      { lease: work, nextLeaseBytes: work.bytes, nativeBytes: snapshot.memoryBytes - 1024 },
    ]);
    const operation = value.core.command({ command: 'beginTransaction' }), request = await value.worker.next('command');
    const summary = nativeSummary({ memoryBytes: 3 * P + 1024, transaction: true });
    await value.worker.respond(request, { type: 'result', summary }, { heapBytes: 6 * P, allocation: allocation(summary) });
    await operation;
    expect(value.memory.state).toMatchObject({ active: true, heapBytes: 6 * P, coveredBytes: 3 * P + 1024,
      remainderBytes: 3 * P - 1024, ledgerOverageBytes: 0 });
    expect(value.ledger.usage.bytes).toBe(10 * P - 1024);
    expect(() => value.core.assertNativeAdmission()).not.toThrow();
    value.core.transferNativeCoverage([
      { lease: history, nextLeaseBytes: 3 * P, nativeBytes: 3 * P },
      { lease: work, nextLeaseBytes: 2 * P, nativeBytes: 0 },
    ]);
    expect(value.memory.state.coveredBytes).toBe(3 * P + 1024);
    expect(value.ledger.usage.bytes).toBe(10 * P - 1024);
    expect(history.bytes).toBe(3 * P); expect(work.bytes).toBe(2 * P);
    expect(value.worker.terminated).toBe(0);
  });

  it('retains a committed result on measured overage and blocks queued new allocation without terminating', async () => {
    const value = await loaded(new ResourceLedger(6 * P)), gpu = own(value.ledger, 'render', P);
    value.core.activateNativeMemory();
    const operation = value.core.command({ command: 'single', index: 0 }), request = await value.worker.next('command');
    const summary = nativeSummary({ selected: 1, revision: 1, canUndo: true, canRedo: true });
    const queued = value.core.command({ command: 'grade', values: [] }), rejected = expect(queued).rejects.toThrow(AdmissionError);
    await value.worker.respond(request, { type: 'result', summary }, { heapBytes: 6 * P, allocation: allocation(summary) });
    await expect(operation).resolves.toEqual(summary); await rejected;
    expect(value.worker.sent.filter(message => message.type === 'command').map(message => message.command.command)).toEqual(['single']);
    expect(value.memory.state).toMatchObject({ active: true, heapBytes: 6 * P,
      coveredBytes: 1024, remainderBytes: 6 * P - 1024, ledgerOverageBytes: 3 * P - 1024 });
    expect(() => value.core.assertNativeAdmission()).toThrow(AdmissionError);
    expect(value.worker.terminated).toBe(0); expect(value.ledger.owns(value.nativeLease)).toBe(true);
    const inspect = value.core.command({ command: 'summary' }), inspectRequest = await value.worker.next('command');
    await value.worker.respond(inspectRequest, { type: 'result', summary }); await expect(inspect).resolves.toEqual(summary);
    expect(value.worker.terminated).toBe(0); expect(value.core.nativeContentRevision).toBe(summary.contentRevision);
    gpu(); await value.core.retireNativeMemory(); value.nativeLease();
    expect(value.ledger.usage.bytes).toBe(0);
  });

  it('moves freed native coverage into the remainder at unchanged H before releasing its lease', async () => {
    const value = await loaded(); value.core.activateNativeMemory();
    const history = own(value.ledger, 'history', P);
    const grown = nativeSummary({ memoryBytes: 1536 });
    const observe = value.core.command({ command: 'summary' }), observeRequest = await value.worker.next('command');
    await value.worker.respond(observeRequest, { type: 'result', summary: grown }, { allocation: allocation(grown) });
    await observe;
    value.core.updateNativeCoverage([{ lease: history, nextLeaseBytes: P, nativeBytes: 512 }]);
    const before = value.ledger.usage;
    expect(value.memory.state.coveredBytes).toBe(1536);
    value.core.setNativeCoveragePlanner(() => [
      { lease: value.nativeLease, nextLeaseBytes: value.nativeLease.bytes, nativeBytes: 1024 },
      { lease: history, nextLeaseBytes: history.bytes, nativeBytes: 0 },
    ]);
    const cleanup = value.core.command({ command: 'summary' }), cleanupRequest = await value.worker.next('command');
    await value.worker.respond(cleanupRequest, { type: 'result', summary: nativeSummary() }, { allocation: allocation(nativeSummary()) });
    await cleanup;
    value.core.releaseNativeCoverage(history);
    expect(value.memory.state).toMatchObject({ heapBytes: 2 * P, coveredBytes: 1024, remainderBytes: 2 * P - 1024 });
    expect(value.ledger.usage.bytes).toBe(before.bytes - P + 512);
    expect(value.ledger.owns(history)).toBe(false); expect(value.worker.terminated).toBe(0);
  });
});
