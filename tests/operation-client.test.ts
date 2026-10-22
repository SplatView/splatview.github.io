import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreClient } from '../src/document/coreClient';
import { transformDefaults } from '../src/document/transformProtocol';
import { OperationRestoredError, type OperationOwner, type OperationReceipt, type OperationRecovery } from '../src/document/operationProtocol';
import { BUILD_DESCRIPTOR } from '../src/generated/buildIdentity';
import type { NativeSummary, WorkerRequest } from '../src/document/types';
import { emptyCensus } from './fixtures/allocation-census';

vi.mock('../src/build/runtime', () => ({
  ensureRuntime: async () => ({ mode: 'production-verified', assetBase: 'https://example.test/',
    artifacts: new Map([['document-worker', { bytes: new ArrayBuffer(1) }]]) }),
  runtimeNativeSource: () => undefined,
}));
type OperationRequest = Extract<WorkerRequest, { type: 'operation' }>;
function baseline(): NativeSummary {
  return { ok: true, selectionCommitRevision: 0, undoSelectionRevision: 0, toleranceRecorded: true, toleranceRange: { enabled: false, radius: null, center: [0, 0, 0] }, toleranceTool: 'fill', duplicateRange: null, loaded: true, count: 5, sourceCount: 5, shDegree: 3, format: 'PLY', kind: 0,
    selected: 2, visible: 4, canUndo: true, canRedo: true, revision: 7, contentRevision: 3,
    transaction: false, selectionDraft: true, sceneChanged: false, pending: false, progress: 1,
    floor: null, filter: null, transformSession: null, opacitySession: null,
    center: [0, 0, 0], radius: 1, yUp: false, camera: [0, 0, 0, 0, 0, 3, 1, 45, 0, 0, 1], memoryBytes: 1024,
    toleranceSessionId: 11, toleranceMapId: 12, selectionMapId: 12, pendingSelectionMapId: null,
    selectionMapBytes: 64, selectionMapRetainedIds: [12, 13] };
}
// Independent literal receipt construction. These transport tests do not use
// the production snapshot encoder or validator to manufacture their oracle.
function snapshot(value: NativeSummary) {
  return { count: value.count, sourceCount: value.sourceCount, duplicateRange: value.duplicateRange, revision: value.revision, contentRevision: value.contentRevision, selected: value.selected, visible: value.visible,
    canUndo: value.canUndo, canRedo: value.canRedo, transaction: value.transaction, selectionDraft: value.selectionDraft,
    pending: value.pending, toleranceSessionId: value.toleranceSessionId ?? null, toleranceMapId: value.toleranceMapId ?? null,
    selectionMapId: value.selectionMapId, pendingSelectionMapId: value.pendingSelectionMapId,
    selectionMapRetainedIds: [...value.selectionMapRetainedIds] };
}
class OperationWorker {
  static latest: OperationWorker;
  onmessage?: (event: { data: unknown }) => void;
  onerror?: (event: { preventDefault(): void; message: string }) => void;
  onmessageerror?: () => void;
  sent: WorkerRequest[] = [];
  model = baseline();
  before = baseline();
  owner?: OperationOwner;
  receipt?: OperationReceipt;
  retired = false;
  terminated = 0;
  mutations = 0;
  commits = 0;
  rollbacks = 0;
  retires = 0;
  drops = new Map<string, number>();
  skips = new Map<string, number>();
  held: { request: WorkerRequest; data: Record<string, unknown> }[] = [];
  refuseStatuses = 0;
  private initializationId = '';
  private heapSequence = 0;
  constructor() { OperationWorker.latest = this; }
  private telemetry() {
    const sequence = ++this.heapSequence;
    return { initializationId: this.initializationId, heap: { sequence, heapBytes: 128 * 65536 }, census: emptyCensus(sequence),
      allocation: { loaded: this.model.loaded, kind: this.model.kind, count: this.model.count, memoryBytes: this.model.memoryBytes,
        selectionMapBytes: this.model.selectionMapBytes, selectionMapRetainedIds: [...this.model.selectionMapRetainedIds] } };
  }
  private consume(map: Map<string, number>, key: string): boolean {
    const count = map.get(key) ?? 0; if (!count) return false; map.set(key, count - 1); return true;
  }
  postMessage(value: WorkerRequest | { type: 'initialize'; initializationId: string; mode: string }) {
    if (value.type === 'initialize') {
      this.initializationId = value.initializationId;
      const data = { type: 'ready', mode: value.mode, build: BUILD_DESCRIPTOR, core: BUILD_DESCRIPTOR.native.core,
        ...this.telemetry(), allocation: null };
      queueMicrotask(() => this.onmessage?.({ data })); return;
    }
    const request = structuredClone(value); this.sent.push(request);
    if (request.type === 'cancel' || request.type === 'ack') return;
    const key = request.type === 'operation' ? request.action : request.type;
    if (this.consume(this.skips, key)) return;
    if (request.type === 'stream') return;
    let result: Record<string, unknown>;
    if (request.type === 'operation') {
      if (this.retired && this.owner?.operationId !== request.operationOwner.operationId) {
        this.owner = undefined; this.receipt = undefined; this.retired = false;
      }
      if (request.action === 'begin') {
        this.owner = request.operationOwner; this.before = structuredClone(this.model); this.model.transaction = true; this.retired = false;
        this.receipt = { version: 2, owner: this.owner, outcome: 'active', before: snapshot(this.before), terminal: null };
      } else if (request.action === 'commit') {
        this.commits++; this.model.transaction = false;
        this.receipt = { version: 2, owner: request.operationOwner, outcome: 'committed', before: snapshot(this.before), terminal: snapshot(this.model) };
      } else if (request.action === 'rollback') {
        this.rollbacks++; this.model = structuredClone(this.before); this.model.transaction = false;
        this.receipt = { version: 2, owner: request.operationOwner, outcome: 'rolled-back', before: snapshot(this.before), terminal: snapshot(this.model) };
      } else if (request.action === 'retire') {
        this.retires++; this.retired = true;
      } else if (!this.receipt) {
        this.owner = request.operationOwner;
        this.receipt = { version: 2, owner: this.owner, outcome: 'not-started', before: snapshot(this.model), terminal: snapshot(this.model) };
      }
      if (request.action === 'status' && this.refuseStatuses-- > 0) result = { type: 'error', error: 'native status refused' };
      else if (request.action === 'retire') result = { type: 'operation-retired', operationOwner: request.operationOwner };
      else result = { type: 'operation-result', receipt: this.receipt, summary: this.model };
    } else {
      if (request.type === 'command' && request.command.command !== 'summary') {
        this.mutations++;
        if (request.command.command !== 'noop') {
          this.model.selected++; this.model.revision++; this.model.contentRevision++; this.model.canRedo = false;
        }
      }
      result = { type: 'result', summary: this.model };
    }
    const data = structuredClone({ ...request, ...result, ...this.telemetry() });
    if (this.consume(this.drops, key)) this.held.push({ request, data });
    else queueMicrotask(() => this.onmessage?.({ data }));
  }
  replay(index = 0) { const data = structuredClone(this.held[index].data); this.onmessage?.({ data }); }
  emit(request: WorkerRequest, result: Record<string, unknown>) {
    const data = structuredClone({ ...request, ...result, ...this.telemetry() }); this.onmessage?.({ data });
  }
  requests(action: OperationRequest['action']) {
    return this.sent.filter((request): request is OperationRequest => request.type === 'operation' && request.action === action);
  }
  terminate() { this.terminated++; }
}
const clients: CoreClient[] = [];
async function flush() { for (let index = 0; index < 30; index++) await Promise.resolve(); }
async function client() {
  vi.useFakeTimers(); vi.stubGlobal('document', { baseURI: 'https://example.test/' }); vi.stubGlobal('Worker', OperationWorker);
  const core = new CoreClient(); clients.push(core); await core.ready();
  const recovery: OperationRecovery[] = []; core.onOperationRecovery = value => recovery.push(value);
  return { core, worker: OperationWorker.latest, recovery };
}
async function started() {
  const value = await client(), owner = value.core.createOperation(); await value.core.beginOperation(owner);
  return { ...value, owner };
}
async function expired(ms = 30_000) { await vi.advanceTimersByTimeAsync(ms); await flush(); }
function observe<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  void promise.then(value => { state.settled = true; state.value = value; }, error => { state.settled = true; state.error = error; });
  return state;
}
afterEach(() => {
  for (const core of clients.splice(0)) core.dispose();
  vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('owned edit transport reconciliation', () => {
  it('allocates a monotonic scoped identity before begin and preserves it across every mutation and terminal boundary', async () => {
    const { core, worker, owner, recovery } = await started();
    expect(owner.operationId).toBe(1); expect(owner.documentId).toBe(core.revision.documentId); expect(Object.isFrozen(owner)).toBe(true);
    expect(core.operationOwner).toEqual(owner); expect(() => core.createOperation()).toThrow();
    await core.command({ command: 'select' }); const committed = await core.commitOperation(owner);
    expect(committed.selected).toBe(3); expect(worker.mutations).toBe(1); expect(worker.commits).toBe(1);
    await expect(core.command({ command: 'summary' })).rejects.toThrow(/retained edit/);
    await core.finishOperation(owner); expect(core.operationOwner).toBeUndefined(); expect(worker.retires).toBe(1);
    expect(worker.sent.every(request => request.operationOwner && request.operationOwner.operationId === 1)).toBe(true);
    expect(recovery.map(value => value.state)).toEqual(['idle']);
    const next = core.createOperation(); expect(next.operationId).toBe(2); expect(next.clientGeneration).toBe(owner.clientGeneration);
    await core.finishOperation(next); expect(core.operationOwner).toBeUndefined();
  });
  it('restores an executed begin with a lost acknowledgement without ever replaying a mutation', async () => {
    const { core, worker } = await client(), owner = core.createOperation(); worker.drops.set('begin', 1);
    const opening = observe(core.beginOperation(owner)); await flush(); expect(worker.model.transaction).toBe(true);
    await expired(); expect(opening.error).toBeInstanceOf(OperationRestoredError); expect(worker.rollbacks).toBe(1);
    expect(worker.requests('begin')).toHaveLength(1); expect(worker.mutations).toBe(0); expect(worker.model).toEqual(baseline());
    expect(core.operationOwner).toEqual(owner); await core.finishOperation(owner); expect(worker.terminated).toBe(0);
  });
  it('requires explicit not-started proof when begin was never executed', async () => {
    const { core, worker } = await client(), owner = core.createOperation(); worker.skips.set('begin', 1);
    const opening = observe(core.beginOperation(owner)); await flush(); await expired();
    expect(opening.error).toBeInstanceOf(OperationRestoredError);
    expect((opening.error as OperationRestoredError).receipt.outcome).toBe('not-started'); expect(worker.rollbacks).toBe(0);
    await core.finishOperation(owner); expect(worker.requests('begin')).toHaveLength(1);
  });
  it('resolves an executed lost commit once and discards genuine late and duplicate acknowledgements before heap/revision observation', async () => {
    const { core, worker, owner } = await started(); await core.command({ command: 'select' });
    worker.drops.set('commit', 1); const committing = observe(core.commitOperation(owner)); await flush();
    expect(worker.commits).toBe(1); expect(committing.settled).toBe(false); await expired();
    expect(committing.error).toBeUndefined(); expect(committing.value?.selected).toBe(3); expect(worker.rollbacks).toBe(0);
    const revision = { ...core.revision }; worker.replay(); worker.replay(); await flush(); expect(core.revision).toEqual(revision);
    await core.finishOperation(owner); worker.replay(); await flush(); expect(worker.terminated).toBe(0); expect(core.revision).toEqual(revision);
    expect(worker.mutations).toBe(1); expect(worker.requests('commit')).toHaveLength(1);
  });
  it('rolls back a mutation when commit never executed, preserving prior draft, Redo and map ownership', async () => {
    const { core, worker, owner } = await started(); await core.command({ command: 'select' }); worker.skips.set('commit', 1);
    const committing = observe(core.commitOperation(owner)); await flush(); await expired();
    expect(committing.error).toBeInstanceOf(OperationRestoredError); expect(worker.model).toEqual(baseline());
    expect(worker.rollbacks).toBe(1); expect(worker.commits).toBe(0); expect(worker.mutations).toBe(1);
    await core.rollbackOperation(owner); expect(worker.rollbacks).toBe(1); await core.finishOperation(owner);
  });
  it('restores an unknown ordinary mutation instead of replaying it and allows idempotent controller rollback', async () => {
    const { core, worker, owner } = await started(); worker.drops.set('command', 1);
    const mutation = observe(core.command({ command: 'select' })); await flush(); await expired();
    expect(mutation.error).toBeInstanceOf(OperationRestoredError); expect(worker.mutations).toBe(1); expect(worker.rollbacks).toBe(1);
    expect(await core.rollbackOperation(owner)).toEqual(baseline()); expect(worker.rollbacks).toBe(1); await core.finishOperation(owner);
  });
  it('recognizes a lost executed rollback acknowledgement by its receipt without rolling back twice', async () => {
    const { core, worker, owner } = await started(); await core.command({ command: 'select' }); worker.drops.set('rollback', 1);
    const restoring = observe(core.rollbackOperation(owner)); await flush(); await expired();
    expect(restoring.error).toBeUndefined(); expect(restoring.value).toEqual(baseline()); expect(worker.rollbacks).toBe(1);
    await core.finishOperation(owner);
  });
  it('parks after one lost automatic status, fences competing work and shares one explicit retry', async () => {
    const { core, worker, owner, recovery } = await started(); await core.command({ command: 'select' });
    worker.drops.set('commit', 1); worker.drops.set('status', 1);
    const committing = observe(core.commitOperation(owner)); await flush(); await expired();
    expect(worker.requests('status')).toHaveLength(1); expect(recovery.at(-1)?.state).toBe('checking'); await expired(10_000);
    expect(recovery.at(-1)?.state).toBe('required'); expect(committing.settled).toBe(false); expect(core.operationOwner).toEqual(owner);
    const requests = worker.sent.length; await expect(core.command({ command: 'select' })).rejects.toThrow(/retained edit/);
    expect(worker.sent).toHaveLength(requests); expect(() => core.createOperation()).toThrow();
    const retry = core.retryOperation(owner); expect(core.retryOperation(owner)).toBe(retry); expect(await retry).toBe(true); await flush();
    expect(committing.value?.selected).toBe(3); expect(worker.requests('status')).toHaveLength(2); expect(worker.mutations).toBe(1);
    await core.finishOperation(owner); expect(recovery.at(-1)?.state).toBe('idle');
  });
  it('retains authority after a refused status and retries the exact owner without terminating its worker', async () => {
    const { core, worker, owner, recovery } = await started(); await core.command({ command: 'select' });
    worker.drops.set('commit', 1); worker.refuseStatuses = 1;
    const committing = observe(core.commitOperation(owner)); await flush(); await expired();
    expect(committing.settled).toBe(false); expect(recovery.at(-1)?.state).toBe('required'); expect(worker.terminated).toBe(0);
    expect(await core.retryOperation(owner)).toBe(true); await flush(); expect(committing.value?.selected).toBe(3);
    expect(worker.requests('status').every(request => request.operationOwner.operationId === owner.operationId)).toBe(true);
    await core.finishOperation(owner);
  });
  it('treats an owner-mismatched status as unresolved and accepts only a later matching proof', async () => {
    const { core, worker, owner, recovery } = await started(); await core.command({ command: 'select' });
    worker.drops.set('commit', 1); worker.skips.set('status', 1);
    const committing = observe(core.commitOperation(owner)); await flush(); await expired();
    const status = worker.requests('status')[0];
    worker.emit(status, { type: 'operation-result', receipt: { ...worker.receipt!, owner: { ...owner, operationId: owner.operationId + 1 } }, summary: worker.model });
    await flush(); expect(recovery.at(-1)?.state).toBe('required'); expect(committing.settled).toBe(false); expect(worker.terminated).toBe(0);
    expect(await core.retryOperation(owner)).toBe(true); await flush(); expect(committing.value?.selected).toBe(3); await core.finishOperation(owner);
  });
  it('does not let generic cancellation abort its owner-specific reconciliation attempt', async () => {
    const { core, worker, owner } = await started(); worker.drops.set('commit', 1); worker.skips.set('status', 1);
    const committing = observe(core.commitOperation(owner)); await flush(); await expired();
    const count = worker.sent.length; core.cancel(); expect(worker.sent).toHaveLength(count); expect(committing.settled).toBe(false);
    await expired(10_000); expect(await core.retryOperation(owner)).toBe(true); await flush(); expect(committing.error).toBeUndefined();
    await core.finishOperation(owner);
  });
  it('retains validated commit proof through lost retirement acknowledgements and retries retirement rather than guessing from expired status', async () => {
    const { core, worker, owner, recovery } = await started(); await core.command({ command: 'select' }); await core.commitOperation(owner);
    worker.drops.set('retire', 2); const finishing = observe(core.finishOperation(owner)); await flush();
    await expired(); await expired(10_000); expect(finishing.settled).toBe(false); expect(core.operationOwner).toEqual(owner);
    expect(recovery.at(-1)?.state).toBe('required'); expect(worker.requests('status')).toHaveLength(0);
    expect(await core.retryOperation(owner)).toBe(true); await flush(); expect(finishing.error).toBeUndefined(); expect(finishing.settled).toBe(true);
    expect(core.operationOwner).toBeUndefined(); expect(worker.retires).toBe(3); expect(worker.commits).toBe(1);
    expect(recovery.filter(value => value.state === 'idle')).toHaveLength(1);
  });
  it('uses inactivity deadlines and valid progress to keep a genuine owned request alive', async () => {
    const { core, worker, owner } = await started(); worker.drops.set('command', 1);
    const mutation = observe(core.command({ command: 'select' })); await flush(); const request = worker.sent.at(-1)!;
    await expired(29_999); worker.emit(request, { type: 'progress', stage: 'Editing scene', fraction: .25 }); await flush();
    await expired(29_999); expect(worker.requests('status')).toHaveLength(0); expect(mutation.settled).toBe(false);
    worker.emit(request, { type: 'progress', stage: 'Editing scene', fraction: .75 }); await flush();
    await expired(30_000); expect(mutation.error).toBeInstanceOf(OperationRestoredError); expect(worker.mutations).toBe(1);
    await core.finishOperation(owner);
  });
  it('cancels only an abandoned stream transport and retains its callback copy until it joins', async () => {
    const { core, worker, owner } = await started(); let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const streaming = observe(core.stream(async () => { await held; }, () => undefined)); await flush();
    const request = worker.sent.at(-1)!; worker.emit(request, { type: 'chunk', chunkId: 0, first: 0, count: 1, bytes: new ArrayBuffer(32) });
    await flush(); await expired(); expect(worker.rollbacks).toBe(1); expect(streaming.settled).toBe(false);
    expect(worker.sent.filter(value => value.type === 'cancel').map(value => ({ requestId: value.requestId, operationOwner: value.operationOwner })))
      .toEqual([{ requestId: request.requestId, operationOwner: owner }]);
    release(); await flush(); expect(streaming.error).toBeInstanceOf(OperationRestoredError);
    expect(worker.sent.filter(value => value.type === 'ack')).toHaveLength(0); await core.finishOperation(owner);
  });
  it('acknowledges a joined owned stream with its captured request, revision and operation authority', async () => {
    const { core, worker, owner } = await started(); const uploads: number[] = [];
    const masks = vi.fn(), streaming = observe(core.stream(async first => { uploads.push(first); }, masks)); await flush();
    const request = worker.sent.at(-1)!;
    worker.emit(request, { type: 'chunk', chunkId: 9, first: 2, count: 1, bytes: new ArrayBuffer(32) }); await flush();
    const acknowledgements = worker.sent.filter(value => value.type === 'ack'); expect(acknowledgements).toHaveLength(1);
    expect(acknowledgements[0]).toMatchObject({ requestId: request.requestId, base: request.base, operationOwner: owner, chunkId: 9 });
    expect(uploads).toEqual([2]); expect(request).toMatchObject({ type: 'stream', channel: 'document', operationOwner: owner });
    worker.emit(request, { type: 'masks', bytes: new Uint8Array([1,0,2,1,0]).buffer });
    worker.emit(request, { type: 'result', summary: worker.model }); await flush();
    expect(masks).toHaveBeenCalledOnce(); expect(Array.from(new Uint8Array(masks.mock.calls[0][0]))).toEqual([1,0,2,1,0]);
    expect(streaming.error).toBeUndefined(); expect(streaming.settled).toBe(true); await core.rollbackOperation(owner); await core.finishOperation(owner);
  });
  it('keeps signal and explicit cancellation tied to the exact owned command transport', async () => {
    const { core, worker, owner } = await started(); worker.drops.set('command', 1); const abort = new AbortController();
    const mutation = observe(core.command({ command: 'select' }, abort.signal)); await flush(); const request = worker.sent.at(-1)!;
    abort.abort(); core.cancel();
    expect(worker.sent.filter(value => value.type === 'cancel').map(value => ({ requestId: value.requestId, operationOwner: value.operationOwner, base: value.base })))
      .toEqual([1, 2].map(() => ({ requestId: request.requestId, operationOwner: owner, base: request.base })));
    worker.emit(request, { type: 'error', error: 'Operation cancelled', cancelled: true, summary: worker.model }); await flush();
    expect(mutation.error).toBeInstanceOf(DOMException); expect((mutation.error as DOMException).name).toBe('AbortError');
    await core.rollbackOperation(owner); await core.finishOperation(owner);
  });
  it('leaves ordinary control envelopes owner-free before any edit operation exists', async () => {
    const { core, worker } = await client(), masks = vi.fn(); const streaming = observe(core.stream(async () => undefined, masks)); await flush();
    const request = worker.sent.at(-1)!; expect(Object.hasOwn(request, 'operationOwner')).toBe(false);
    worker.emit(request, { type: 'chunk', chunkId: 0, first: 0, count: 1, bytes: new ArrayBuffer(32) }); await flush();
    const acknowledgement = worker.sent.find(value => value.type === 'ack')!; expect(Object.hasOwn(acknowledgement, 'operationOwner')).toBe(false);
    worker.emit(request, { type: 'masks', bytes: new Uint8Array([1,0,2,1,0]).buffer });
    worker.emit(request, { type: 'result', summary: worker.model }); await flush(); expect(streaming.settled).toBe(true);
    expect(streaming.error).toBeUndefined(); expect(masks).toHaveBeenCalledOnce();
    expect(Array.from(new Uint8Array(masks.mock.calls[0][0]))).toEqual([1,0,2,1,0]);
  });
  it('keeps no-op commit proof meaningful even when all revision counters remain unchanged', async () => {
    const { core, worker, owner } = await started(); await core.command({ command: 'noop' });
    const before = { ...core.revision }; worker.drops.set('commit', 1); const committing = observe(core.commitOperation(owner)); await flush(); await expired();
    expect(committing.value?.contentRevision).toBe(3); expect(core.revision).toEqual(before); expect(worker.rollbacks).toBe(0);
    expect(worker.receipt?.outcome).toBe('committed'); expect(worker.mutations).toBe(1); await core.finishOperation(owner);
  });
  it.each([['commit', 'range'], ['rollback', 'range'], ['commit', 'recorded'], ['rollback', 'recorded'], ['commit', 'history'], ['rollback', 'history']] as const)(
    'authenticates %s %s metadata independently of an otherwise valid unchanged receipt2', async (action, field) => {
    const { core, worker, owner } = await started(), before = structuredClone(worker.model.toleranceRange);
    worker.drops.set(action, 1);
    const terminal = observe(action === 'commit' ? core.commitOperation(owner) : core.rollbackOperation(owner)); await flush();
    const request = worker.requests(action).at(-1)!; worker.refuseStatuses = 1;
    // The receipt's topology/revision/map tuple is valid. Its schema has no
    // Range field, so only the independent operation proof can reject this.
    worker.emit(request, { type: 'operation-result', receipt: worker.receipt, summary: { ...worker.model,
      ...(field === 'range' ? { toleranceRange: { enabled: true, radius: 2, center: [9, 0, 0] } } :
        field === 'recorded' ? { toleranceRecorded: false } : { undoSelectionRevision: 1 }) } }); await flush();
    expect(terminal.settled).toBe(false); expect(terminal.value).toBeUndefined(); expect(worker.terminated).toBe(0);
    expect(await core.retryOperation(owner)).toBe(true); await flush();
    expect(terminal.error).toBeUndefined(); expect(terminal.value?.toleranceRange).toEqual(before);
    expect(terminal.value?.toleranceRecorded).toBe(true);
    expect(terminal.value?.undoSelectionRevision).toBe(0);
    await core.finishOperation(owner);
  });
  it.each(['commit', 'rollback'] as const)('authenticates %s filter.changed before storing a valid receipt2 resolution', async action => {
    const { core, worker } = await client();
    worker.model = { ...worker.model, toleranceSessionId: null, toleranceTool: null, toleranceRange: null, toleranceRecorded: null,
      selectionDraft: false, filter: { id: 7, kind: 'sphere', epoch: 1, previewEpoch: 1, changed: true } };
    await core.command({ command: 'summary' }); const owner = core.createOperation(); await core.beginOperation(owner);
    worker.drops.set(action, 1);
    const terminal = observe(action === 'commit' ? core.commitOperation(owner) : core.rollbackOperation(owner)); await flush();
    const request = worker.requests(action).at(-1)!; worker.refuseStatuses = 1;
    worker.emit(request, { type: 'operation-result', receipt: worker.receipt, summary: { ...worker.model,
      filter: { ...worker.model.filter!, changed: false } } }); await flush();
    expect(terminal.settled).toBe(false); expect(terminal.value).toBeUndefined(); expect(worker.terminated).toBe(0);
    expect(await core.retryOperation(owner)).toBe(true); await flush();
    expect(terminal.error).toBeUndefined(); expect(terminal.value?.filter?.changed).toBe(true);
    await core.finishOperation(owner);
  });
  it.each(['commit', 'rollback'] as const)('binds the complete gizmo owner before storing an otherwise valid %s receipt2 resolution', async action => {
    const { core, worker } = await client();
    worker.model = { ...baseline(), selectionDraft: false, toleranceSessionId: null, toleranceMapId: null,
      toleranceTool: null, toleranceRecorded: null, toleranceRange: null, transformSession: { id: 1, baseId: 4, epoch: 1, appliedEpoch: null,
        kind: 'gizmo', selectedOnly: true, appliedMatrix: transformDefaults().matrix, pivot: [0, 0, 0],
        gizmo: { cancelBaseId: 2, cancelContentRevision: 1, canUndo: true, canRedo: false } } };
    const owner = core.createOperation(); await core.beginOperation(owner); worker.drops.set(action, 1);
    const terminal = observe(action === 'commit' ? core.commitOperation(owner) : core.rollbackOperation(owner)); await flush();
    const request = worker.requests(action).at(-1)!; worker.refuseStatuses = 1;
    worker.emit(request, { type: 'operation-result', receipt: worker.receipt, summary: { ...worker.model,
      transformSession: { ...worker.model.transformSession!, gizmo: { ...worker.model.transformSession!.gizmo!, canUndo: false } } } }); await flush();
    expect(terminal.settled).toBe(false); expect(terminal.value).toBeUndefined(); expect(worker.terminated).toBe(0);
    expect(await core.retryOperation(owner)).toBe(true); await flush();
    expect(terminal.error).toBeUndefined(); expect(terminal.value?.transformSession?.gizmo?.canUndo).toBe(true);
    await core.finishOperation(owner);
  });
  it('rejects the parked continuation if the authoritative worker actually dies', async () => {
    const { core, worker, owner } = await started(); worker.drops.set('commit', 1); worker.drops.set('status', 1);
    const committing = observe(core.commitOperation(owner)); await flush(); await expired();
    worker.onerror?.({ preventDefault() {}, message: 'authoritative worker died' }); await flush();
    expect(committing.error).toBeInstanceOf(Error); expect((committing.error as Error).message).toContain('authoritative worker died');
    expect(worker.terminated).toBe(1); expect(core.operationOwner).toEqual(owner);
  });
});
