import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreClient, type CoreClientRecoverySeed, type CoreWorkerFailure, type RecoveryRestoreOptions } from '../src/document/coreClient';
import { DocumentRecoveryStore, type ExternalCommitDecision } from '../src/document/recoveryCoordinator';
import type { RecoveryCheckpointBinding, RecoveryCheckpointPlan } from '../src/document/recoveryCheckpoint';
import { ResourceLedger, MiB } from '../src/document/resources';
import { NativeHeapAccounting } from '../src/document/nativeMemory';
import { BUILD_DESCRIPTOR } from '../src/generated/buildIdentity';
import type { NativeSummary, WorkerRequest } from '../src/document/types';
import type { OperationReceipt } from '../src/document/operationProtocol';
import { emptyCensus } from './fixtures/allocation-census';
import { transformDefaults } from '../src/document/transformProtocol';

vi.mock('../src/build/runtime', () => ({
  ensureRuntime: async () => ({ mode: 'production-verified', assetBase: 'https://example.test/',
    artifacts: new Map([['document-worker', { bytes: new ArrayBuffer(1) }]]) }),
  runtimeNativeSource: () => undefined,
}));
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sourceBytes = new Uint8Array([11, 22, 33, 44]);
function sourceFingerprint() {
  const length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(sourceBytes.length));
  const canonical = Buffer.concat([Buffer.from('SplatViewSource\0v1\0', 'ascii'),
    Buffer.from([0, 0, 0, 0, 1, 1, 0, 0, 0, 0]), length, createHash('sha256').update(sourceBytes).digest()]);
  return { scheme: 'splatview-source-v1' as const, assetDigest: hash(canonical), resourceCount: 1,
    totalBytes: sourceBytes.length, sourceKindHint: 'PLY' };
}
function baseline(): NativeSummary {
  return { ok: true, selectionCommitRevision: 0, undoSelectionRevision: 0, toleranceRecorded: null, toleranceRange: null, toleranceTool: null, duplicateRange: null, loaded: true, count: 3, sourceCount: 9, shDegree: 3, format: 'PLY', kind: 0,
    selected: 0, visible: 3, canUndo: false, canRedo: false, revision: 0, contentRevision: 0,
    transaction: false, selectionDraft: false, sceneChanged: false, pending: false, progress: 1,
    floor: null, filter: null, transformSession: null, opacitySession: null,
    center: [0, 0, 0], radius: 1, yUp: false, camera: [0, 0, 0, 0, 0, 3, 1, 45, 1, 0, 1], memoryBytes: 1024,
    toleranceSessionId: null, toleranceMapId: null, selectionMapId: null, pendingSelectionMapId: null,
    selectionMapBytes: 0, selectionMapRetainedIds: [] };
}
function operationSnapshot(value: NativeSummary) {
  return { count: value.count, sourceCount: value.sourceCount, duplicateRange: value.duplicateRange, revision: value.revision, contentRevision: value.contentRevision, selected: value.selected, visible: value.visible,
    canUndo: value.canUndo, canRedo: value.canRedo, transaction: value.transaction, selectionDraft: value.selectionDraft,
    pending: value.pending, toleranceSessionId: value.toleranceSessionId ?? null, toleranceMapId: value.toleranceMapId ?? null,
    selectionMapId: value.selectionMapId, pendingSelectionMapId: value.pendingSelectionMapId,
    selectionMapRetainedIds: [...value.selectionMapRetainedIds] };
}
/** Transport fixture only. Real codec graph/SH/history reconstruction is covered
 * by native-checkpoint tests, independently of this synthetic framing payload. */
function binary(summary: NativeSummary, byteLength = 128) {
  const bytes = new Uint8Array(byteLength);
  for (let index = 64; index < byteLength; index++) bytes[index] = (index * 19 + summary.revision) & 255;
  const sha256 = hash(bytes.subarray(64));
  bytes.set(new TextEncoder().encode('SVCKPT01'));
  const header = new DataView(bytes.buffer);
  header.setUint32(8, 3, true); header.setUint32(12, 64, true); header.setBigUint64(16, BigInt(byteLength), true);
  bytes.set(Uint8Array.from(sha256.match(/../g)!, pair => Number.parseInt(pair, 16)), 24);
  const flags = summary.selectionDraft ? 1 : 0; header.setUint32(60, flags, true);
  const plan: RecoveryCheckpointPlan = { ok: true, version: 2, byteLength, workspaceBytes: MiB, maximumChunkBytes: 1048576,
    currentLoadedCount: summary.count, currentSourceCount: summary.sourceCount, currentDuplicateRange: summary.duplicateRange,
    maximumGraphSplats: Math.max(3, summary.count),
    sceneCount: 2, maskCount: 2, normalizationFlags: flags, revision: summary.revision + (flags ? 1 : 0), actualRevision: summary.revision,
    contentRevision: summary.contentRevision, nextContentRevision: summary.contentRevision + 2, memoryBytes: summary.memoryBytes,
    sha256, headerSha256: hash(bytes.subarray(0, 64)) };
  return { bytes, plan };
}
type Request<T extends WorkerRequest['type']> = Extract<WorkerRequest, { type: T }>;
type Export = Request<'recovery-export'>;
type Restore = Request<'recovery-restore'>;
class RecoveryWorker {
  static latest: RecoveryWorker;
  onmessage?: (event: { data: unknown }) => void;
  onerror?: (event: { preventDefault(): void; message: string }) => void;
  onmessageerror?: () => void;
  sent: WorkerRequest[] = [];
  model = baseline();
  before = baseline();
  restored = baseline();
  terminated = 0;
  commits = 0;
  rollbacks = 0;
  skipCommitOnce = false;
  dropCommitReplyOnce = false;
  dropStatusReplies = 0;
  statusConflict?: 'rolled-back' | 'not-started' | 'expired-conflict';
  holdRelease = false;
  holdConsumed = false;
  exportLength = 128;
  planRecoveryId?: string;
  onRelease?: () => void;
  receipt?: OperationReceipt;
  recovery?: { request: Export | Restore; bytes?: Uint8Array; plan: RecoveryCheckpointPlan; next: number };
  private source?: Request<'source-load'>;
  private initializationId = '';
  private heapSequence = 0;
  constructor() { RecoveryWorker.latest = this; }
  private telemetry(intermediate: boolean) {
    const sequence = ++this.heapSequence;
    return { initializationId: this.initializationId, heap: { sequence, heapBytes: 128 * 65536 }, census: emptyCensus(sequence),
      allocation: intermediate ? null : { loaded: this.model.loaded, kind: this.model.kind, count: this.model.count,
        memoryBytes: this.model.memoryBytes, selectionMapBytes: this.model.selectionMapBytes,
        selectionMapRetainedIds: [...this.model.selectionMapRetainedIds] } };
  }
  emit(request: WorkerRequest, result: Record<string, unknown>, intermediate = false) {
    const data = structuredClone({ ...request, ...result, ...this.telemetry(intermediate) });
    // Worker messages are later tasks. This preserves real transfer/consume
    // ordering rather than manufacturing synchronous cross-thread reentry.
    setTimeout(() => { if (!this.terminated) this.onmessage?.({ data }); }, 0);
  }
  private nextExport() {
    const recovery = this.recovery!, offset = recovery.next * MiB;
    if (offset >= recovery.plan.byteLength) this.emit(recovery.request, { type: 'recovery-exported', recoveryId: recovery.request.recoveryId }, true);
    else {
      const length = Math.min(MiB, recovery.plan.byteLength - offset);
      this.emit(recovery.request, { type: 'recovery-chunk', recoveryId: recovery.request.recoveryId,
        index: recovery.next, offset, length, bytes: recovery.bytes!.slice(offset, offset + length).buffer }, true);
    }
  }
  private nextRestore() {
    const recovery = this.recovery!, offset = recovery.next * MiB;
    if (offset >= recovery.plan.byteLength) {
      this.model = structuredClone(this.restored);
      this.model.revision = recovery.plan.revision; this.model.contentRevision = recovery.plan.contentRevision;
      this.emit(recovery.request, { type: 'recovery-result', recoveryId: recovery.request.recoveryId, action: 'restore', summary: this.model });
    } else this.emit(recovery.request, { type: 'recovery-range-request', recoveryId: recovery.request.recoveryId,
      index: recovery.next, offset, length: Math.min(MiB, recovery.plan.byteLength - offset) }, true);
  }
  postMessage(value: WorkerRequest | { type: 'initialize'; initializationId: string; mode: string }, transfer: Transferable[] = []) {
    if (value.type === 'initialize') {
      this.initializationId = value.initializationId;
      queueMicrotask(() => this.onmessage?.({ data: { type: 'ready', mode: value.mode, build: BUILD_DESCRIPTOR,
        core: BUILD_DESCRIPTOR.native.core, ...this.telemetry(true) } })); return;
    }
    const request = structuredClone(value, { transfer }) as WorkerRequest; this.sent.push(request);
    if (request.type === 'source-load') {
      this.source = request;
      this.emit(request, { type: 'source-range-request', operationId: request.source.operationId, resourceId: request.source.resourceId,
        rangeId: 0, offset: 0, length: sourceBytes.length }); return;
    }
    if (request.type === 'source-range') {
      const source = this.source!;
      this.emit(source, { type: 'source-range-consumed', operationId: request.operationId, resourceId: request.resourceId,
        rangeId: request.rangeId, offset: request.offset, length: request.length });
      this.emit(source, { type: 'source-load-result', operationId: source.source.operationId, resourceId: source.source.resourceId,
        consumedBytes: sourceBytes.length, summary: this.model, fingerprint: sourceFingerprint() }); return;
    }
    if (request.type === 'recovery-export') {
      const encoded = binary(this.model, this.exportLength);
      this.recovery = { request, ...encoded, next: 0 };
      this.emit(request, { type: 'recovery-plan', recoveryId: this.planRecoveryId ?? request.recoveryId, plan: encoded.plan, summary: this.model }, true); return;
    }
    if (request.type === 'recovery-proceed') { this.nextExport(); return; }
    if (request.type === 'recovery-ack') { this.recovery!.next++; this.nextExport(); return; }
    if (request.type === 'recovery-release') {
      this.onRelease?.();
      if (!this.holdRelease) this.emit(this.recovery!.request, { type: 'recovery-result', recoveryId: request.recoveryId,
        action: 'export', summary: this.model }); return;
    }
    if (request.type === 'recovery-restore') {
      this.recovery = { request, plan: request.plan, next: 0 }; this.nextRestore(); return;
    }
    if (request.type === 'recovery-range') {
      if (this.holdConsumed) return;
      this.emit(this.recovery!.request, { type: 'recovery-range-consumed', recoveryId: request.recoveryId,
        index: request.index, offset: request.offset, length: request.length }, true);
      this.recovery!.next++; this.nextRestore(); return;
    }
    if (request.type === 'cancel') {
      if (this.recovery) this.emit(this.recovery.request, { type: 'error', error: 'cancelled', cancelled: true }); return;
    }
    if (request.type === 'operation') {
      if (request.action === 'status' && this.dropStatusReplies > 0) { this.dropStatusReplies--; return; }
      if (request.action === 'status' && this.statusConflict) {
        this.model = structuredClone(this.before);
        this.receipt = { version: 2, owner: request.operationOwner, outcome: this.statusConflict,
          before: this.statusConflict === 'expired-conflict' ? null : operationSnapshot(this.before),
          terminal: this.statusConflict === 'expired-conflict' ? null : operationSnapshot(this.model) };
      }
      if (request.action === 'begin') {
        this.before = structuredClone(this.model); this.model.transaction = true;
        this.receipt = { version: 2, owner: request.operationOwner, outcome: 'active', before: operationSnapshot(this.before), terminal: null };
      } else if (request.action === 'commit') {
        if (this.skipCommitOnce) { this.skipCommitOnce = false; return; }
        this.commits++; this.model.transaction = false;
        this.receipt = { version: 2, owner: request.operationOwner, outcome: 'committed', before: operationSnapshot(this.before), terminal: operationSnapshot(this.model) };
        if (this.dropCommitReplyOnce) { this.dropCommitReplyOnce = false; return; }
      } else if (request.action === 'rollback') {
        this.rollbacks++; this.model = structuredClone(this.before);
        this.receipt = { version: 2, owner: request.operationOwner, outcome: 'rolled-back', before: operationSnapshot(this.before), terminal: operationSnapshot(this.model) };
      }
      if (request.action === 'retire') this.emit(request, { type: 'operation-retired', operationOwner: request.operationOwner });
      else this.emit(request, { type: 'operation-result', receipt: this.receipt, summary: this.model }); return;
    }
    if (request.type === 'command') {
      if (request.command.command === 'beginTransform') {
        this.model.transformSession = { id: 1, baseId: 2, epoch: 0, appliedEpoch: null, kind: request.command.kind as 'numeric' | 'gizmo',
          selectedOnly: request.command.selectedOnly as boolean, appliedMatrix: transformDefaults().matrix, pivot: [0, 0, 0],
          gizmo: request.command.kind === 'gizmo' ? { cancelBaseId: null, cancelContentRevision: null, canUndo: false, canRedo: false } : null };
        this.emit(request, { type: 'result', summary: this.model }); return;
      }
      if (request.command.command === 'crop') { this.model.count = 2; this.model.visible = 2; this.model.contentRevision++; }
      if (request.command.command !== 'summary') { this.model.revision++; this.model.selected = 1; this.model.canUndo = true; }
      if (request.command.command === 'duplicate') Object.assign(this.model, { count: 5, sourceCount: 11, visible: 5, selected: 2,
        duplicateRange: { first: 3, count: 2 }, contentRevision: this.model.contentRevision + 1 });
      if (request.command.command === 'colorPick') Object.assign(this.model, { toleranceSessionId: request.command.sessionId, toleranceTool: 'color',
        toleranceRecorded: true, toleranceRange: { enabled: request.command.rangeEnabled, radius: request.command.rangeRadius, center: [1, 2, 3] } });
      this.emit(request, { type: 'result', summary: this.model });
    }
  }
  fail(message = 'worker was terminated') { this.onerror?.({ message, preventDefault() {} }); }
  terminate() { this.terminated++; }
}
const clients: CoreClient[] = [], stores: DocumentRecoveryStore[] = [];
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
async function until(check: () => boolean) { for (let index = 0; index < 200; index++) { if (check()) return; await tick(); } throw new Error('Transport observation timed out.'); }
async function client(seed?: CoreClientRecoverySeed, memory?: NativeHeapAccounting) {
  vi.stubGlobal('document', { baseURI: 'https://example.test/' }); vi.stubGlobal('Worker', RecoveryWorker);
  const core = new CoreClient(memory, seed); clients.push(core); await core.ready(); return { core, worker: RecoveryWorker.latest };
}
async function loaded() {
  const value = await client(), ledger = new ResourceLedger(64 * MiB);
  await value.core.load(new File([sourceBytes], 'source.ply'), 3, 100_000,
    { current() {}, admit: bytes => ledger.reserve('source', bytes) });
  return { ...value, ledger };
}
async function initial() {
  const value = await loaded(), store = new DocumentRecoveryStore(value.ledger); stores.push(store);
  await value.core.captureRecoveryCheckpoint({ ledger: value.ledger, binding: value.core.getRecoveryBinding(), metadata: { camera: [1, 2, 3] } },
    prepared => store.installInitial(prepared));
  return { ...value, store };
}
function restoreOptions(binding: RecoveryCheckpointBinding, plan: RecoveryCheckpointPlan): RecoveryRestoreOptions {
  return { binding, plan, revision: { ...binding.revision }, expectedSummary: { kind: 0, count: plan.currentLoadedCount,
    sourceCount: plan.currentSourceCount, duplicateRange: plan.currentDuplicateRange, shDegree: 3, format: 'PLY' },
    budgetBytes: 100_000 };
}
afterEach(async () => {
  for (const core of clients.splice(0)) await core.retireNativeMemory();
  for (const store of stores.splice(0)) store.release();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('external native checkpoint client transport', () => {
  it('captures and restores grown current topology while retaining the original import subset', async () => {
    const { core, worker, ledger } = await loaded();
    await core.command({ command: 'duplicate' });
    const store = new DocumentRecoveryStore(ledger); stores.push(store);
    await core.captureRecoveryCheckpoint({ ledger, binding: core.getRecoveryBinding(), metadata: null }, prepared => store.installInitial(prepared));
    const description = store.description!;
    expect(description.binding.subset).toEqual({ sourceCount: 9, loadedCount: 3, maxSplats: 3 });
    expect(description.plan).toMatchObject({ version: 2, currentLoadedCount: 5, currentSourceCount: 11,
      currentDuplicateRange: { first: 3, count: 2 }, maximumGraphSplats: 5 });
    const replacement = await client({ revision: { ...description.binding.revision }, expectedBinding: description.binding });
    replacement.worker.restored = { ...worker.model };
    const restored = await replacement.core.restoreRecoveryCheckpoint(await store.openRestore(), restoreOptions(description.binding, description.plan));
    expect(restored).toMatchObject({ count: 5, sourceCount: 11, duplicateRange: { first: 3, count: 2 } });
    expect(replacement.core.getRecoveryBinding().subset).toEqual(description.binding.subset);
  });
  it('retains the original loaded subset after a crop and binds the successful complete source fingerprint', async () => {
    const { core } = await loaded(); const first = core.getRecoveryBinding();
    expect(first.source).toEqual(sourceFingerprint()); expect(first.subset).toEqual({ sourceCount: 9, loadedCount: 3, maxSplats: 3 });
    await core.command({ command: 'crop' }); const next = core.getRecoveryBinding();
    expect(next.subset).toEqual(first.subset); expect(next.revision.contentRevision).toBeGreaterThan(first.revision.contentRevision);
  });
  it('admits each export before proceed, verifies chunks before ACK and accepts synchronously before native release', async () => {
    const { core, worker, ledger } = await loaded(); worker.exportLength = MiB + 73;
    let accepted = false, retainedAtAcceptance = 0;
    worker.onRelease = () => { expect(accepted).toBe(true); };
    await core.captureRecoveryCheckpoint({ ledger, binding: core.getRecoveryBinding(), metadata: { saved: true } }, prepared => {
      retainedAtAcceptance = ledger.usage.bytes;
      expect(worker.sent.filter(value => value.type === 'recovery-ack')).toHaveLength(2);
      const snapshot = prepared.accept(); accepted = true; snapshot.release();
    });
    expect(retainedAtAcceptance).toBeGreaterThan(MiB);
    expect(worker.sent.filter(value => value.type.startsWith('recovery-')).map(value => value.type))
      .toEqual(['recovery-export', 'recovery-proceed', 'recovery-ack', 'recovery-ack', 'recovery-release']);
    expect(ledger.usage.bytes).toBe(0); expect(worker.terminated).toBe(0);
  });
  it.each(['range', 'recorded', 'history'] as const)('refuses a %s-only metadata change while immutable recovery bytes are held, even with unchanged revisions', async field => {
    const { core, worker, ledger } = await loaded();
    await core.command({ command: 'colorPick', sessionId: 4, tolerance: .25, index: 0, camera: [...worker.model.camera], rangeEnabled: true, rangeRadius: 2 });
    worker.onRelease = () => {
      if (field === 'range') worker.model.toleranceRange = { enabled: true, radius: 3, center: [1, 2, 3] };
      else if (field === 'recorded') worker.model.toleranceRecorded = false;
      else worker.model.undoSelectionRevision = 1;
    };
    await expect(core.captureRecoveryCheckpoint({ ledger, binding: core.getRecoveryBinding(), metadata: null }, prepared => {
      prepared.accept().release();
    })).rejects.toThrow('outside its captured request');
    expect(worker.terminated).toBe(1); expect(ledger.usage.bytes).toBe(0);
  });
  it('keeps a same-worker gizmo owner during readonly capture and refuses an unsolicited Cancel baseline at release', async () => {
    const { core, worker, ledger } = await loaded(); await core.command({ command: 'beginTransform', kind: 'gizmo', selectedOnly: false });
    const original = structuredClone(worker.model.transformSession);
    await core.captureRecoveryCheckpoint({ ledger, binding: core.getRecoveryBinding(), metadata: null }, prepared => prepared.accept().release());
    expect(worker.model.transformSession).toEqual(original);
    worker.onRelease = () => { worker.model.transformSession = { ...original!, gizmo: {
      cancelBaseId: 2, cancelContentRevision: worker.model.contentRevision, canUndo: false, canRedo: false } }; };
    await expect(core.captureRecoveryCheckpoint({ ledger, binding: core.getRecoveryBinding(), metadata: null }, prepared => prepared.accept().release()))
      .rejects.toThrow('The transform session changed outside its captured request.');
    expect(worker.terminated).toBe(1); expect(ledger.usage.bytes).toBe(0);
  });
  it('rejects a fresh worker claiming the transient gizmo owner while accepting its admitted durable geometry', async () => {
    const { core, worker, ledger } = await loaded(); await core.command({ command: 'beginTransform', kind: 'gizmo', selectedOnly: false });
    const store = new DocumentRecoveryStore(ledger); stores.push(store);
    await core.captureRecoveryCheckpoint({ ledger, binding: core.getRecoveryBinding(), metadata: null }, prepared => store.installInitial(prepared));
    const description = store.description!, replacement = await client({ revision: { ...description.binding.revision }, expectedBinding: description.binding });
    replacement.worker.restored = structuredClone(worker.model);
    await expect(replacement.core.restoreRecoveryCheckpoint(await store.openRestore(), restoreOptions(description.binding, description.plan)))
      .rejects.toThrow('The replacement worker did not restore the accepted native checkpoint.');
    expect(replacement.worker.terminated).toBe(1);
  });
  it('rejects a mismatched captured revision before dispatching any native checkpoint work', async () => {
    const { core, worker, ledger } = await loaded(), binding = core.getRecoveryBinding();
    await expect(core.captureRecoveryCheckpoint({ ledger, binding: { ...binding, revision: { ...binding.revision, contentRevision: 99 } }, metadata: null }, () => {}))
      .rejects.toThrow(/binding/);
    expect(worker.sent.some(value => value.type === 'recovery-export')).toBe(false); expect(worker.terminated).toBe(0);
  });
  it('retires a foreign intermediate owner before granting a checkpoint allocation or proceeding', async () => {
    const { core, worker, ledger } = await loaded(); worker.planRecoveryId = 'another-owner';
    await expect(core.captureRecoveryCheckpoint({ ledger, binding: core.getRecoveryBinding(), metadata: null }, () => {}))
      .rejects.toThrow(/another checkpoint/);
    expect(worker.sent.some(value => value.type === 'recovery-proceed')).toBe(false); expect(ledger.usage.bytes).toBe(0);
    expect(worker.terminated).toBe(1);
  });
  it('measures actual intermediate heap/census without fabricating scene allocation coverage', async () => {
    const ledger = new ResourceLedger(64 * MiB), remainder = ledger.reserve('source', 0);
    const memory = new NativeHeapAccounting(ledger, remainder), { core } = await client(undefined, memory);
    const native = ledger.reserve('decoded', 1024);
    await core.load(new File([sourceBytes], 'source.ply'), 3, 100_000,
      { current() {}, admit: bytes => ledger.reserve('source', bytes), nativeLease: native });
    core.activateNativeMemory(); const before = memory.state;
    const planner = vi.fn(() => []); core.setNativeCoveragePlanner(planner);
    await core.captureRecoveryCheckpoint({ ledger, binding: core.getRecoveryBinding(), metadata: null }, prepared => prepared.accept().release());
    expect(planner).toHaveBeenCalledTimes(1); expect(memory.state.sequence).toBeGreaterThan(before.sequence);
    expect(memory.state.coveredBytes).toBe(before.coveredBytes); expect(memory.state.coveredBytes).toBe(1024);
    expect(memory.state.heapBytes).toBe(before.heapBytes); await core.retireNativeMemory(); native(); expect(ledger.usage.bytes).toBe(0);
  });
  it('keeps the predecessor checkpoint and sends no release when admission of the successor fails', async () => {
    const { core, worker, ledger, store } = await initial(), previous = store.description;
    const fill = ledger.reserve('recovery', ledger.limit - ledger.usage.bytes - 32);
    await expect(core.captureRecoveryCheckpoint({ ledger, binding: core.getRecoveryBinding(), metadata: null }, prepared => store.installInitial(prepared)))
      .rejects.toThrow(/budget|available/);
    fill(); expect(store.description).toBe(previous);
    expect(worker.sent.filter(value => value.type === 'recovery-release')).toHaveLength(1);
  });
  it('joins held hashing on disposal before returning its checkpoint reservation', async () => {
    const { core, worker, ledger } = await loaded();
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, data) => { entered(); await gate; return digest(algorithm, data); });
    const capture = core.captureRecoveryCheckpoint({ ledger, binding: core.getRecoveryBinding(), metadata: null }, () => {});
    const rejected = expect(capture).rejects.toThrow(); await started;
    core.dispose(); let retired = false; const retiring = core.retireNativeMemory().then(() => { retired = true; });
    await tick(); expect(retired).toBe(false); expect(ledger.usage.bytes).toBeGreaterThan(0);
    expect(worker.terminated).toBe(1); release(); await rejected; await retiring;
    expect(ledger.usage.bytes).toBe(0);
  });
  it('rejects forged external decisions before committing or releasing the native export owner', async () => {
    const { core, worker, ledger } = await initial(), owner = core.createOperation(); await core.beginOperation(owner);
    await expect(core.commitOperation(owner, { ledger, binding: core.getRecoveryBinding(), metadata: null,
      accept: () => Object.freeze({}) as ExternalCommitDecision })).rejects.toThrow(/unrecognized token/);
    expect(worker.commits).toBe(0); expect(worker.rollbacks).toBe(0);
    expect(worker.sent.filter(value => value.type === 'recovery-release')).toHaveLength(1);
  });
  it('records a genuine decision before release and refuses rollback even when its terminal is lost', async () => {
    const { core, worker, ledger, store } = await initial(); core.activateNativeMemory();
    const failures: CoreWorkerFailure[] = []; core.onWorkerFailure = value => failures.push(value);
    const owner = core.createOperation(); await core.beginOperation(owner); await core.command({ command: 'select' });
    let decision: ExternalCommitDecision | undefined;
    worker.onRelease = () => worker.fail('release delivery lost');
    const committed = core.commitOperation(owner, { ledger, binding: core.getRecoveryBinding(), metadata: { selected: 1 },
      accept: prepared => { decision = store.decide(owner, prepared); return decision; } });
    await expect(committed).rejects.toThrow(/delivery lost/);
    expect(failures).toHaveLength(1); expect(failures[0].decision).toBe(decision); expect(worker.terminated).toBe(1);
    await expect(core.rollbackOperation(owner)).rejects.toThrow(/externally decided/); expect(worker.rollbacks).toBe(0);
    expect(store.description!.binding.revision).toEqual(core.revision);
  });
  it('retries commit for a decided active operation instead of reverting its externally retained successor', async () => {
    const { core, worker, ledger, store } = await initial(), owner = core.createOperation(); await core.beginOperation(owner);
    await core.command({ command: 'select' }); worker.skipCommitOnce = true;
    let expire: (() => void) | undefined;
    const original = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
      if (typeof callback === 'function' && callback.name === 'operationAcknowledgementExpired') expire = callback as () => void;
      return Reflect.apply(original, globalThis, [callback, delay, ...args]);
    });
    const committing = core.commitOperation(owner, { ledger, binding: core.getRecoveryBinding(), metadata: null, accept: prepared => store.decide(owner, prepared) });
    await until(() => worker.sent.some(value => value.type === 'operation' && value.action === 'commit'));
    expect(expire).toBeTypeOf('function'); expire!(); await committing;
    expect(worker.commits).toBe(1); expect(worker.rollbacks).toBe(0);
    expect(worker.sent.filter(value => value.type === 'operation' && value.action === 'commit')).toHaveLength(2);
    await core.finishOperation(owner);
  });
  it('keeps a decided live worker parked after a lost reconciliation reply and accepts proof on explicit Retry', async () => {
    const { core, worker, ledger, store } = await initial(), owner = core.createOperation(); await core.beginOperation(owner);
    await core.command({ command: 'select' }); core.activateNativeMemory();
    const states: string[] = [], failures: CoreWorkerFailure[] = [];
    core.onOperationRecovery = recovery => states.push(recovery.state); core.onWorkerFailure = failure => failures.push(failure);
    worker.dropCommitReplyOnce = true; worker.dropStatusReplies = 1;
    const timers = new Map<string, () => void>(), original = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
      if (typeof callback === 'function' && callback.name.startsWith('operation')) timers.set(callback.name, callback as () => void);
      return Reflect.apply(original, globalThis, [callback, delay, ...args]);
    });
    let settled = false;
    const committing = core.commitOperation(owner, { ledger, binding: core.getRecoveryBinding(), metadata: null,
      accept: prepared => store.decide(owner, prepared) });
    void committing.then(() => { settled = true; }, () => { settled = true; });
    await until(() => worker.commits === 1); timers.get('operationAcknowledgementExpired')!();
    await until(() => worker.sent.some(request => request.type === 'operation' && request.action === 'status'));
    timers.get('operationReconciliationExpired')!();
    await until(() => states.includes('required')); await tick();
    expect(settled).toBe(false); expect(worker.terminated).toBe(0); expect(core.failed).toBe(false); expect(failures).toEqual([]);
    await expect(core.rollbackOperation(owner)).rejects.toThrow(/externally decided/);
    await expect(core.retryOperation(owner)).resolves.toBe(true); await committing;
    expect(worker.commits).toBe(1); expect(worker.rollbacks).toBe(0); expect(worker.terminated).toBe(0);
    expect(worker.sent.filter(request => request.type === 'operation' && request.action === 'status')).toHaveLength(2);
    await core.finishOperation(owner); expect(states.at(-1)).toBe('idle');
  });
  it.each(['rolled-back', 'not-started', 'expired-conflict'] as const)('reconstructs only after a matching validated %s receipt contradicts a retained successor', async outcome => {
    const { core, worker, ledger, store } = await initial(), owner = core.createOperation(); await core.beginOperation(owner);
    await core.command({ command: 'select' }); core.activateNativeMemory();
    worker.skipCommitOnce = true; worker.statusConflict = outcome;
    const failures: CoreWorkerFailure[] = []; core.onWorkerFailure = failure => failures.push(failure);
    let expire: (() => void) | undefined, decision: ExternalCommitDecision | undefined;
    const original = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
      if (typeof callback === 'function' && callback.name === 'operationAcknowledgementExpired') expire = callback as () => void;
      return Reflect.apply(original, globalThis, [callback, delay, ...args]);
    });
    const committing = core.commitOperation(owner, { ledger, binding: core.getRecoveryBinding(), metadata: null,
      accept: prepared => { decision = store.decide(owner, prepared); return decision; } });
    const rejected = expect(committing).rejects.toThrow(/conflicts with an externally decided/);
    await until(() => worker.sent.some(request => request.type === 'operation' && request.action === 'commit')); expire!();
    await rejected;
    expect(worker.terminated).toBe(1); expect(failures).toHaveLength(1); expect(failures[0].decision).toBe(decision);
    expect(worker.rollbacks).toBe(0); expect(store.description!.binding.revision).toEqual(core.revision);
  });
  it('restores through fresh transfer copies, preserves public revision counters and uses a new client generation', async () => {
    const { core, store } = await initial(), description = store.description!;
    const oldOwner = core.createOperation(); await core.beginOperation(oldOwner); await core.rollbackOperation(oldOwner); await core.finishOperation(oldOwner);
    const reader = await store.openRestore(), replacement = await client({ revision: { ...description.binding.revision }, expectedBinding: description.binding });
    const restored = await replacement.core.restoreRecoveryCheckpoint(reader, restoreOptions(description.binding, description.plan));
    expect(restored.shDegree).toBe(3); expect(replacement.core.revision).toEqual(description.binding.revision);
    expect(replacement.core.getRecoveryBinding().subset).toEqual(description.binding.subset);
    const owner = replacement.core.createOperation(); expect(owner.operationId).toBe(1); expect(owner.clientGeneration).not.toBe(oldOwner.clientGeneration);
    const reopened = await store.openRestore(); await reopened.cancel();
  });
  it('publishes an explicit restore revision transition without an extra increment from native acceptance', async () => {
    const { store } = await initial(), description = store.description!, reader = await store.openRestore();
    const { core } = await client({ revision: { ...description.binding.revision }, expectedBinding: description.binding });
    const options = restoreOptions(description.binding, description.plan);
    options.revision = { ...options.revision, contentRevision: 15, selectionRevision: 19, draftRevision: 0 };
    await core.restoreRecoveryCheckpoint(reader, options); expect(core.revision).toEqual(options.revision);
    await core.command({ command: 'summary' }); expect(core.revision).toEqual(options.revision);
  });
  it.each(['kind', 'count', 'shDegree', 'format', 'sourceCount'] as const)('refuses restored %s metadata that differs from the independently retained expectation', async key => {
    const { store } = await initial(), description = store.description!, reader = await store.openRestore();
    const { core, worker } = await client({ revision: { ...description.binding.revision }, expectedBinding: description.binding });
    if (key === 'format') worker.restored.format = 'SPZ'; else worker.restored[key]++;
    await expect(core.restoreRecoveryCheckpoint(reader, restoreOptions(description.binding, description.plan))).rejects.toThrow(/accepted native checkpoint/);
    expect(worker.terminated).toBe(1); expect(core.failed).toBe(true);
    const reopened = await store.openRestore(); await reopened.cancel();
  });
  it('joins a transferred restore copy after actual worker termination and leaves the sole external snapshot reusable', async () => {
    const { store, ledger } = await initial(), description = store.description!, retained = ledger.usage.bytes;
    const reader = await store.openRestore(), { core, worker } = await client({ revision: { ...description.binding.revision }, expectedBinding: description.binding });
    worker.holdConsumed = true;
    const restoring = core.restoreRecoveryCheckpoint(reader, restoreOptions(description.binding, description.plan));
    const rejected = expect(restoring).rejects.toThrow(/terminated/);
    await until(() => worker.sent.some(value => value.type === 'recovery-range'));
    expect(ledger.usage.bytes).toBeGreaterThan(retained); worker.fail(); await rejected;
    expect(ledger.usage.bytes).toBe(retained);
    const reopened = await store.openRestore(); await reopened.cancel();
  });
  it('notifies only adopted live authority failures once, after termination, and suppresses ordinary candidate disposal', async () => {
    const { core, worker } = await loaded(), failures: CoreWorkerFailure[] = [];
    core.onWorkerFailure = value => { expect(worker.terminated).toBe(1); failures.push(value); };
    core.activateNativeMemory(); worker.fail(); worker.fail(); expect(failures).toHaveLength(1); expect(core.failed).toBe(true);
    const candidate = await loaded(); candidate.core.onWorkerFailure = value => failures.push(value); candidate.worker.fail();
    expect(failures).toHaveLength(1);
    const disposed = await loaded(); disposed.core.activateNativeMemory(); disposed.core.onWorkerFailure = value => failures.push(value); disposed.core.dispose();
    expect(failures).toHaveLength(1);
  });
});
