import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILD_DESCRIPTOR } from '../src/generated/buildIdentity';
import { emptyCensus } from './fixtures/allocation-census';
import { CoreClient } from '../src/document/coreClient';
import { ResourceLedger, type ResourceLease } from '../src/document/resources';
import type { SourceLoadOptions, SourceRange } from '../src/document/source';
import type { NativeSummary, WorkerRequest } from '../src/document/types';

vi.mock('../src/build/runtime', () => ({
  ensureRuntime: async () => ({ mode: 'production-verified', assetBase: 'https://example.test/',
    artifacts: new Map([['document-worker', { bytes: new ArrayBuffer(1) }]]) }),
  runtimeNativeSource: () => undefined,
}));

const MiB = 1_048_576;
type Load = Extract<WorkerRequest, { type: 'source-load' }>;
type RangeMessage = Extract<WorkerRequest, { type: 'source-range' }>;
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function summary(): NativeSummary {
  return { ok: true, selectionCommitRevision: 0, undoSelectionRevision: 0, toleranceRecorded: null, toleranceRange: null, toleranceSessionId: null, toleranceTool: null, duplicateRange: null, loaded: true, count: 3, sourceCount: 3, shDegree: 0, format: 'PLY', kind: 0,
    selected: 0, visible: 3, canUndo: false, canRedo: false, revision: 0, contentRevision: 0,
    transaction: false, selectionDraft: false, sceneChanged: false, pending: false, progress: 1, floor: null, filter: null, transformSession: null, opacitySession: null,
    center: [0, 0, 0], radius: 1, yUp: false, camera: [0, 0, 0, 0, 0, 0, 1, 45, 1, 0, 1], memoryBytes: 1024,
    selectionMapId: null, pendingSelectionMapId: null, selectionMapBytes: 0, selectionMapRetainedIds: [] };
}
// Independent v1 bytes: prefix, single-kind/count/role/empty-path, uint64 size,
// SHA256(original bytes). This does not call the production encoder or hasher.
function fingerprint(bytes: Uint8Array) {
  const size = Buffer.alloc(8); size.writeBigUInt64BE(BigInt(bytes.byteLength));
  const canonical = Buffer.concat([Buffer.from('SplatViewSource\0v1\0', 'ascii'),
    Buffer.from([0, 0, 0, 0, 1, 1, 0, 0, 0, 0]), size, createHash('sha256').update(bytes).digest()]);
  expect(canonical.byteLength).toBe(69);
  return { scheme: 'splatview-source-v1' as const, resourceCount: 1, totalBytes: bytes.byteLength,
    assetDigest: createHash('sha256').update(canonical).digest('hex'), sourceKindHint: 'PLY' };
}
function range(request: Load, offset = 0, rangeId = 0): SourceRange {
  return { operationId: request.source.operationId, resourceId: request.source.resourceId,
    rangeId, offset, length: Math.min(MiB, request.source.byteLength - offset) };
}
function terminal(request: Load, bytes: Uint8Array) {
  return { type: 'source-load-result', operationId: request.source.operationId, resourceId: request.source.resourceId,
    consumedBytes: bytes.byteLength, summary: summary(), fingerprint: fingerprint(bytes) };
}
class ObservedWorker {
  static latest: ObservedWorker;
  onmessage?: (event: { data: unknown }) => void;
  onerror?: (event: { preventDefault(): void; message: string }) => void;
  onmessageerror?: () => void;
  terminated = false;
  failTransfer = false;
  sent: WorkerRequest[] = [];
  transferLists: Transferable[][] = [];
  private unread: WorkerRequest[] = [];
  private waiters: { type: WorkerRequest['type']; resolve(value: WorkerRequest): void }[] = [];
  private initializationId = '';
  private heapSequence = 0;
  private allocation = { loaded: false, kind: 0, count: 0, memoryBytes: 0, selectionMapBytes: 0, selectionMapRetainedIds: [] as number[] };
  constructor() { ObservedWorker.latest = this; }
  telemetry(result: Record<string, unknown> = {}) {
    const state = result.summary ?? (result.outcome as { summary?: unknown } | undefined)?.summary;
    if (state) {
      const value = state as NativeSummary;
      this.allocation = { loaded: value.loaded, kind: value.kind, count: value.count, memoryBytes: value.memoryBytes,
        selectionMapBytes: value.selectionMapBytes, selectionMapRetainedIds: [...value.selectionMapRetainedIds] };
    }
    return { initializationId: this.initializationId, heap: { sequence: ++this.heapSequence, heapBytes: 128 * 1024 * 1024 }, census: emptyCensus(this.heapSequence), allocation: { ...this.allocation } };
  }
  postMessage(value: WorkerRequest | { type: 'initialize'; initializationId: string; mode: string }, transfer: Transferable[] = []) {
    if (value.type === 'initialize') {
      this.initializationId = value.initializationId;
      queueMicrotask(() => this.onmessage?.({ data: { type: 'ready',
        mode: value.mode, build: BUILD_DESCRIPTOR, core: BUILD_DESCRIPTOR.native.core, ...this.telemetry(), allocation: null } }));
      return;
    }
    if (this.failTransfer && value.type === 'source-range') throw new Error('source transfer refused');
    this.transferLists.push([...transfer]);
    // Real transfer semantics matter: successful posting detaches the broker's
    // sender buffer, while the simulated receiver owns a separate live view.
    const copied = structuredClone(value, { transfer }) as WorkerRequest;
    this.sent.push(copied);
    const index = this.waiters.findIndex(waiter => waiter.type === copied.type);
    if (index === -1) this.unread.push(copied);
    else this.waiters.splice(index, 1)[0].resolve(copied);
  }
  next<T extends WorkerRequest['type']>(type: T): Promise<Extract<WorkerRequest, { type: T }>> {
    const index = this.unread.findIndex(value => value.type === type);
    if (index !== -1) return Promise.resolve(this.unread.splice(index, 1)[0] as Extract<WorkerRequest, { type: T }>);
    return new Promise(resolve => this.waiters.push({ type, resolve: value => resolve(value as Extract<WorkerRequest, { type: T }>) }));
  }
  respond(request: Load, result: Record<string, unknown>) {
    const data = structuredClone({ ...request, ...this.telemetry(result), ...result });
    // Real worker responses run in a later task, after sender-side posting and
    // consume/finally complete. Synchronous reentry would invent an early ack.
    setTimeout(() => this.onmessage?.({ data }), 0);
  }
  terminate() { this.terminated = true; }
}
const clients: CoreClient[] = [];
const duplicateLeaseReleases: number[] = [];
async function client() {
  vi.stubGlobal('document', { baseURI: 'https://example.test/' }); vi.stubGlobal('Worker', ObservedWorker);
  const core = new CoreClient(); clients.push(core); await core.ready(); return { core, worker: ObservedWorker.latest };
}
function input(bytes = new Uint8Array([11, 22, 33, 44]), held?: Promise<ArrayBuffer>) {
  const file = new File([bytes], 'source.ply'), slices: [number | undefined, number | undefined][] = [];
  const original = file.slice.bind(file), entered = deferred<void>();
  file.slice = (start, end, type) => {
    slices.push([start, end]); const blob = original(start, end, type), read = blob.arrayBuffer.bind(blob);
    blob.arrayBuffer = () => {
      const actualRead = read();
      if (held) void held.catch(() => undefined);
      entered.resolve(); return actualRead.then(bytes => held ?? bytes);
    };
    return blob;
  };
  const ledger = new ResourceLedger(bytes.byteLength + 65_536 + 3 * MiB), admissions: number[] = [];
  let current = true, releases = 0;
  const options: SourceLoadOptions = {
    current() { if (!current) throw new DOMException('source authority revoked', 'AbortError'); },
    admit(size) {
      admissions.push(size); const lease = ledger.reserve('source', size);
      let releaseCalls = 0;
      const tracked = (() => {
        releases++;
        if (++releaseCalls > 1) duplicateLeaseReleases.push(size);
        lease();
      }) as ResourceLease;
      Object.defineProperty(tracked, 'bytes', { get: () => lease.bytes }); tracked.resize = size => lease.resize(size);
      return tracked;
    },
  };
  return { bytes, file, slices, entered: entered.promise, ledger, admissions, options,
    revoke: () => { current = false; }, releases: () => releases };
}
async function begin(value: ReturnType<typeof input>, budgetBytes = 10_000) {
  const { core, worker } = await client(), opening = core.load(value.file, 100, budgetBytes, value.options);
  const request = await worker.next('source-load'); return { core, worker, request, opening };
}
async function deliver(worker: ObservedWorker, request: Load, offset = 0, rangeId = 0): Promise<RangeMessage> {
  const credit = range(request, offset, rangeId); worker.respond(request, { type: 'source-range-request', ...credit });
  return worker.next('source-range');
}
afterEach(() => {
  for (const core of clients.splice(0)) core.dispose();
  vi.unstubAllGlobals();
  expect(duplicateLeaseReleases.splice(0)).toEqual([]);
});

describe('bounded source CoreClient load family', () => {
  it.each([64, 65])('refuses intrinsic source size %i at a 64-byte decode budget before IDs, admission, reads or messages and remains usable', async sourceBytes => {
    const { core, worker } = await client(), file = new File([new Uint8Array(sourceBytes)], 'over-budget.ply');
    expect(file.size).toBe(sourceBytes);
    Object.defineProperty(file, 'size', { value: 0 });
    const slice = vi.spyOn(file, 'slice'), read = vi.spyOn(file, 'arrayBuffer');
    const admit = vi.fn(), current = vi.fn(), ids = vi.spyOn(crypto, 'randomUUID');
    try {
      await expect(core.load(file, 100, 64, { admit, current })).rejects.toThrow('The scene source does not fit within the available decode memory budget.');
      expect(ids).not.toHaveBeenCalled(); expect(admit).not.toHaveBeenCalled(); expect(current).not.toHaveBeenCalled();
      expect(slice).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(worker.sent).toEqual([]);
      expect(worker.terminated).toBe(false);
    } finally { ids.mockRestore(); }
    const value = input(), opening = core.load(value.file, 100, 10_000, value.options);
    const request = await worker.next('source-load'); await deliver(worker, request);
    worker.respond(request, { type: 'source-range-consumed', ...range(request) }); await tick();
    worker.respond(request, terminal(request, value.bytes));
    await expect(opening).resolves.toMatchObject({ fingerprint: fingerprint(value.bytes) });
    expect(value.ledger.usage.bytes).toBe(0); expect(worker.terminated).toBe(false);
  });

  it('refuses an imitated Blob before source hooks or messages', async () => {
    const { core, worker } = await client(), size = vi.fn(() => 4), slice = vi.fn();
    const file = { name: 'imitated.ply', get size() { return size(); }, slice } as unknown as File;
    const admit = vi.fn(), current = vi.fn();
    await expect(core.load(file, 100, 10_000, { admit, current })).rejects.toThrow('Choose a valid scene file.');
    expect(size).not.toHaveBeenCalled(); expect(slice).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled(); expect(current).not.toHaveBeenCalled();
    expect(worker.sent).toEqual([]); expect(worker.terminated).toBe(false);
  });

  it('uses intrinsic input size despite a throwing own size getter', async () => {
    const value = input(), size = vi.fn(() => { throw new Error('Shadowed size was accessed.'); });
    Object.defineProperty(value.file, 'size', { get: size });
    const { worker, request, opening } = await begin(value);
    expect(request.source.byteLength).toBe(value.bytes.byteLength);
    await deliver(worker, request); worker.respond(request, { type: 'source-range-consumed', ...range(request) }); await tick();
    worker.respond(request, terminal(request, value.bytes)); await opening;
    expect(size).not.toHaveBeenCalled(); expect(value.ledger.usage.bytes).toBe(0);
  });

  it('sends only a single-file descriptor and retains receive ownership beyond successful transfer', async () => {
    const value = input(), { worker, request, opening } = await begin(value);
    expect(request).toMatchObject({ type: 'source-load', format: 0, maxSplats: 100, budgetBytes: 10_000,
      sourceBudgetBytes: 65_544, source: { kind: 'single', byteLength: 4, path: '', role: 'primary' } });
    expect(request.source.operationId).toEqual(expect.any(String)); expect(request.source.resourceId).toEqual(expect.any(String));
    expect(request).not.toHaveProperty('file'); expect(request).not.toHaveProperty('pointer');
    const containsBlob = (value: unknown): boolean => value instanceof Blob ||
      (!!value && typeof value === 'object' && Object.values(value).some(containsBlob));
    expect(containsBlob(request)).toBe(false); expect(value.slices).toEqual([]);
    expect(value.ledger.usage.bytes).toBe(65_540);
    const copied = await deliver(worker, request);
    expect([...new Uint8Array(copied.bytes)]).toEqual([11, 22, 33, 44]);
    expect(value.slices).toEqual([[0, 4]]); expect(value.admissions).toEqual([65_540, 4, 8]);
    expect(value.ledger.usage.peakBytes).toBe(65_552); expect(value.ledger.usage.bytes).toBe(65_544);
    expect(worker.transferLists.at(-1)).toHaveLength(1);
    expect((worker.transferLists.at(-1)![0] as ArrayBuffer).byteLength).toBe(0);
    worker.respond(request, { type: 'source-range-consumed', ...range(request) });
    await tick(); expect(value.ledger.usage.bytes).toBe(65_540);
    const result = terminal(request, value.bytes); worker.respond(request, result);
    await expect(opening).resolves.toEqual({ summary: result.summary, fingerprint: result.fingerprint });
    expect(value.ledger.usage.bytes).toBe(0); expect(value.ledger.usage.allocations).toBe(0);
    expect(value.releases()).toBe(3); expect(worker.terminated).toBe(false);
  });

  it('snapshots option and filename getters once before queued work and ignores later mutation', async () => {
    const value = input(), { core, worker } = await client();
    const counts = { admit: 0, current: 0, name: 0 };
    let admit = value.options.admit, current = value.options.current, name = 'snapshot.splat';
    const options = { get admit() { counts.admit++; return admit; }, get current() { counts.current++; return current; } };
    Object.defineProperty(value.file, 'name', { get() { counts.name++; return name; } });
    const opening = core.load(value.file, 100, 10_000, options);
    admit = () => { throw new Error('late replacement admit'); };
    current = () => { throw new Error('late replacement current'); }; name = 'changed.ksplat';
    const request = await worker.next('source-load'); expect(request.format).toBe(1);
    await deliver(worker, request); worker.respond(request, { type: 'source-range-consumed', ...range(request) }); await tick();
    const result = terminal(request, value.bytes); result.summary.format = 'SPLAT'; result.fingerprint.sourceKindHint = 'SPLAT';
    worker.respond(request, result); await opening;
    expect(counts).toEqual({ admit: 1, current: 1, name: 1 }); expect(value.ledger.usage.bytes).toBe(0);
  });

  it('transfers exact sequential one-MiB chunks and the short tail with one receive credit', async () => {
    const bytes = new Uint8Array(2 * MiB + 3); bytes[0] = 7; bytes[MiB] = 11; bytes[2 * MiB] = 13;
    const value = input(bytes), { worker, request, opening } = await begin(value, 16 * MiB);
    const received: number[] = [];
    for (const [offset, rangeId, expectedLength, firstByte] of [[0, 0, MiB, 7], [MiB, 1, MiB, 11], [2 * MiB, 2, 3, 13]]) {
      const chunk = await deliver(worker, request, offset, rangeId);
      expect(chunk).toMatchObject({ offset, rangeId, length: expectedLength });
      expect(chunk.bytes.byteLength).toBe(expectedLength); expect(new Uint8Array(chunk.bytes)[0]).toBe(firstByte);
      received.push(chunk.bytes.byteLength);
      expect(value.ledger.usage.bytes).toBe(bytes.byteLength + 65_536 + expectedLength);
      worker.respond(request, { type: 'source-range-consumed', ...range(request, offset, rangeId) }); await tick();
      expect(value.ledger.usage.bytes).toBe(bytes.byteLength + 65_536);
    }
    expect(received).toEqual([MiB, MiB, 3]); expect(value.slices).toEqual([[0, MiB], [MiB, 2 * MiB], [2 * MiB, 2 * MiB + 3]]);
    worker.respond(request, terminal(request, bytes)); await expect(opening).resolves.toMatchObject({ fingerprint: fingerprint(bytes) });
    expect(value.ledger.usage.bytes).toBe(0); expect(value.ledger.usage.peakBytes).toBe(bytes.byteLength + 65_536 + 3 * MiB);
  });

  it.each(['operation', 'resource', 'id', 'gap', 'short', 'zero', 'oversized', 'stale-envelope'] as const)(
    'rejects %s range credit before Blob I/O', async fault => {
      const value = input(), { worker, request, opening } = await begin(value), rejected = expect(opening).rejects.toThrow();
      const response: Record<string, unknown> = { type: 'source-range-request', ...range(request) };
      if (fault === 'operation') response.operationId = 'other';
      if (fault === 'resource') response.resourceId = 'other';
      if (fault === 'id') response.rangeId = 1;
      if (fault === 'gap') response.offset = 1;
      if (fault === 'short') response.length = 3;
      if (fault === 'zero') response.length = 0;
      if (fault === 'oversized') response.length = MiB + 1;
      if (fault === 'stale-envelope') response.base = { ...request.base, contentRevision: request.base.contentRevision + 1 };
      worker.respond(request, response); await rejected;
      expect(value.slices).toEqual([]); expect(value.ledger.usage.bytes).toBe(0); expect(worker.terminated).toBe(true);
    });

  it.each(['result', 'output', 'masks', 'chunk', 'geometry-chunk', 'live-preview'] as const)(
    'rejects a %s response on the source family without publishing a summary', async family => {
      const value = input(), { core, worker, request, opening } = await begin(value), rejected = expect(opening).rejects.toThrow();
      worker.respond(request, { type: family, summary: summary(), bytes: new ArrayBuffer(4), chunkId: 0, first: 0, count: 1,
        outcome: { kind: 'published', version: 1, summary: summary() } });
      await rejected; expect(core.nativeContentRevision).toBe(-1); expect(value.slices).toEqual([]);
      expect(worker.terminated).toBe(true); expect(value.ledger.usage.bytes).toBe(0);
    });

  it.each(['unread', 'unconsumed', 'operation', 'resource', 'counter', 'scheme', 'digest', 'resources', 'bytes', 'kind', 'format'] as const)(
    'rejects %s terminal success without changing client revision', async fault => {
      const value = input(), { core, worker, request, opening } = await begin(value), rejected = expect(opening).rejects.toThrow();
      if (fault !== 'unread') {
        await deliver(worker, request);
        if (fault !== 'unconsumed') { worker.respond(request, { type: 'source-range-consumed', ...range(request) }); await tick(); }
      }
      const result = terminal(request, value.bytes);
      if (fault === 'operation') result.operationId = 'other';
      if (fault === 'resource') result.resourceId = 'other';
      if (fault === 'counter') result.consumedBytes = 3;
      if (fault === 'scheme') Object.assign(result.fingerprint, { scheme: 'splatview-source-v2' });
      if (fault === 'digest') result.fingerprint.assetDigest = 'f'.repeat(63);
      if (fault === 'resources') result.fingerprint.resourceCount = 2;
      if (fault === 'bytes') result.fingerprint.totalBytes = 3;
      if (fault === 'kind') result.summary.kind = 3;
      if (fault === 'format') result.fingerprint.sourceKindHint = 'SPLAT';
      worker.respond(request, result); await rejected;
      expect(core.nativeContentRevision).toBe(-1); expect(worker.terminated).toBe(true); expect(value.ledger.usage.bytes).toBe(0);
    });

  it.each(['duplicate-request', 'premature-ack', 'wrong-ack', 'duplicate-ack'] as const)(
    'refuses %s without granting another source read', async fault => {
      const value = input(), { worker, request, opening } = await begin(value), rejected = expect(opening).rejects.toThrow();
      if (fault !== 'premature-ack') await deliver(worker, request);
      if (fault === 'duplicate-ack') { worker.respond(request, { type: 'source-range-consumed', ...range(request) }); await tick(); }
      worker.respond(request, fault === 'duplicate-request' ? { type: 'source-range-request', ...range(request) }
        : { type: 'source-range-consumed', ...range(request), ...(fault === 'wrong-ack' ? { resourceId: 'other' } : {}) });
      await rejected; expect(value.slices).toHaveLength(fault === 'premature-ack' ? 0 : 1);
      expect(worker.sent.filter(value => value.type === 'source-range')).toHaveLength(fault === 'premature-ack' ? 0 : 1);
      expect(worker.terminated).toBe(true); expect(value.ledger.usage.bytes).toBe(0);
    });

  it.each(['cancel', 'dispose', 'worker-error', 'message-error', 'early-terminal', 'overlap'] as const)(
    '%s revokes credit immediately but joins an already-started Blob read before releasing load admission', async fault => {
      const held = deferred<ArrayBuffer>(), value = input(undefined, held.promise);
      const { core, worker, request, opening } = await begin(value), rejected = expect(opening).rejects.toThrow();
      let settled = false; void opening.then(() => { settled = true; }, () => { settled = true; });
      worker.respond(request, { type: 'source-range-request', ...range(request) }); await value.entered;
      expect(value.ledger.usage.bytes).toBe(65_552);
      if (fault === 'cancel') core.cancel();
      if (fault === 'dispose') core.dispose();
      if (fault === 'worker-error') worker.onerror?.({ preventDefault() {}, message: 'worker stopped during read' });
      if (fault === 'message-error') worker.onmessageerror?.();
      if (fault === 'early-terminal') worker.respond(request, terminal(request, value.bytes));
      if (fault === 'overlap') worker.respond(request, { type: 'source-range-request', ...range(request) });
      await tick(); expect(worker.terminated).toBe(true); expect(settled).toBe(false);
      // Worker-owned receive memory can retire at termination. The actual Blob
      // copy and enclosing stage owner must survive until this promise settles.
      expect(value.ledger.usage.bytes).toBeGreaterThanOrEqual(65_548); expect(value.slices).toHaveLength(1);
      worker.respond(request, { type: 'source-range-request', ...range(request) });
      held.resolve(value.bytes.buffer.slice(0)); await rejected;
      expect(worker.sent.filter(value => value.type === 'source-range')).toHaveLength(0);
      expect(value.slices).toHaveLength(1); expect(value.ledger.usage.bytes).toBe(0); expect(value.releases()).toBe(3);
    });

  it('joins an actual rejected Blob read and releases its three admitted owners once', async () => {
    const held = deferred<ArrayBuffer>(), value = input(undefined, held.promise);
    const { worker, request, opening } = await begin(value), rejected = expect(opening).rejects.toThrow('Blob read failed');
    worker.respond(request, { type: 'source-range-request', ...range(request) }); await value.entered;
    held.reject(new Error('Blob read failed')); await rejected;
    expect(worker.terminated).toBe(true); expect(worker.sent.filter(value => value.type === 'source-range')).toHaveLength(0);
    expect(value.ledger.usage.bytes).toBe(0); expect(value.releases()).toBe(3);
  });

  it.each([3, 5])('refuses a malformed %i-byte Blob result and retires all source owners', async size => {
    const held = deferred<ArrayBuffer>(), value = input(undefined, held.promise);
    const { worker, request, opening } = await begin(value), rejected = expect(opening).rejects.toThrow();
    worker.respond(request, { type: 'source-range-request', ...range(request) }); await value.entered;
    held.resolve(new ArrayBuffer(size)); await rejected;
    expect(worker.sent.filter(value => value.type === 'source-range')).toHaveLength(0);
    expect(value.ledger.usage.bytes).toBe(0); expect(value.releases()).toBe(3); expect(worker.terminated).toBe(true);
  });

  it('requires explicit synchronous admission and authority hooks before any source operation', async () => {
    const value = input(), { core, worker } = await client();
    for (const options of [undefined, {}, { admit: value.options.admit }, { current: value.options.current },
      { ...value.options, current: async () => undefined }]) {
      await expect(core.load(value.file, 100, 10_000, options as unknown as SourceLoadOptions)).rejects.toThrow();
    }
    expect(value.slices).toEqual([]); expect(value.ledger.usage.bytes).toBe(0);
    expect(worker.sent.filter(value => value.type === 'source-load')).toHaveLength(0);
  });

  it('retains no transferred copy or receive credit after synchronous posting fails', async () => {
    const value = input(), { worker, request, opening } = await begin(value), rejected = expect(opening).rejects.toThrow('source transfer refused');
    worker.failTransfer = true; worker.respond(request, { type: 'source-range-request', ...range(request) }); await rejected;
    expect(value.slices).toHaveLength(1); expect(worker.sent.filter(value => value.type === 'source-range')).toHaveLength(0);
    expect(value.ledger.usage.bytes).toBe(0); expect(value.releases()).toBe(3); expect(worker.terminated).toBe(true);
  });

  it('checks authority again after a held read and sends no stale bytes', async () => {
    const held = deferred<ArrayBuffer>(), value = input(undefined, held.promise);
    const { worker, request, opening } = await begin(value), rejected = expect(opening).rejects.toThrow('source authority revoked');
    worker.respond(request, { type: 'source-range-request', ...range(request) }); await value.entered;
    value.revoke(); held.resolve(value.bytes.buffer.slice(0)); await rejected;
    expect(worker.sent.filter(value => value.type === 'source-range')).toHaveLength(0);
    expect(value.ledger.usage.bytes).toBe(0); expect(worker.terminated).toBe(true);
  });

  it('refuses stage and receive admission before their corresponding source reads', async () => {
    for (const failAt of [1, 2, 3]) {
      const value = input(), { core, worker } = await client(); let calls = 0;
      const options = { ...value.options, admit(bytes: number) { if (++calls === failAt) throw new Error('source admission refused'); return value.options.admit(bytes); } };
      const opening = core.load(value.file, 100, 10_000, options), rejected = expect(opening).rejects.toThrow('source admission refused');
      if (failAt !== 1) { const request = await worker.next('source-load'); worker.respond(request, { type: 'source-range-request', ...range(request) }); }
      await rejected; expect(value.slices).toEqual([]); expect(value.ledger.usage.bytes).toBe(0);
      if (failAt === 1) expect(worker.sent.filter(value => value.type === 'source-load')).toHaveLength(0);
    }
  });

  it('takes no read credit for zero bytes and preserves the actual decoder failure', async () => {
    const value = input(new Uint8Array()), { worker, request, opening } = await begin(value);
    const rejected = expect(opening).rejects.toThrow('The native decoder rejected empty input.');
    expect(request.source.byteLength).toBe(0); expect(request.sourceBudgetBytes).toBe(65_536);
    worker.respond(request, { type: 'error', error: 'The native decoder rejected empty input.' }); await rejected;
    expect(value.slices).toEqual([]); expect(worker.sent.filter(value => value.type === 'source-range')).toHaveLength(0);
    expect(value.ledger.usage.bytes).toBe(0);
  });

  it('keeps a canceled predecessor read isolated from an independently completing successor client', async () => {
    const held = deferred<ArrayBuffer>(), old = input(undefined, held.promise), predecessor = await begin(old);
    const oldRejected = expect(predecessor.opening).rejects.toThrow();
    predecessor.worker.respond(predecessor.request, { type: 'source-range-request', ...range(predecessor.request) }); await old.entered;
    predecessor.core.dispose();
    const next = input(new Uint8Array([99, 88, 77])), successor = await begin(next);
    expect(successor.request.source.operationId).not.toBe(predecessor.request.source.operationId);
    await deliver(successor.worker, successor.request);
    successor.worker.respond(successor.request, { type: 'source-range-consumed', ...range(successor.request) }); await tick();
    successor.worker.respond(successor.request, terminal(successor.request, next.bytes));
    const winner = await successor.opening;
    predecessor.worker.respond(predecessor.request, terminal(predecessor.request, old.bytes));
    held.resolve(old.bytes.buffer.slice(0)); await oldRejected;
    expect(winner.fingerprint).toEqual(fingerprint(next.bytes)); expect(successor.worker.terminated).toBe(false);
    expect(predecessor.worker.sent.filter(value => value.type === 'source-range')).toHaveLength(0);
    expect(old.ledger.usage.bytes).toBe(0); expect(next.ledger.usage.bytes).toBe(0);
  });
});
