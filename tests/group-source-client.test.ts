import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreClient } from '../src/document/coreClient';
import { ResourceLedger } from '../src/document/resources';
import { NativeHeapAccounting } from '../src/document/nativeMemory';
import { BUILD_DESCRIPTOR } from '../src/generated/buildIdentity';
import { GROUP_NATIVE_BUDGET_BYTES, groupNativeStageBytes, groupStageBytes, groupTransferBytes } from '../src/document/sourceGroup';
import type { NativeSummary, WorkerRequest } from '../src/document/types';
import type { SourceRange } from '../src/document/source';
import { emptyCensus } from './fixtures/allocation-census';
import { groupFixture, independentGroupKey } from './fixtures/group-source';

vi.mock('../src/build/runtime', () => ({ ensureRuntime: async () => ({ mode: 'production-verified',
  assetBase: 'https://example.test/', artifacts: new Map([['document-worker', { bytes: new ArrayBuffer(1) }]]) }), runtimeNativeSource: () => undefined }));
type Load = Extract<WorkerRequest, { type: 'source-group-load' }>;
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function summary(): NativeSummary { return { ok: true, selectionCommitRevision: 0, undoSelectionRevision: 0, toleranceRecorded: null, toleranceRange: null, toleranceSessionId: null, toleranceTool: null, duplicateRange: null, loaded: true, kind: 0, format: 'SOG v1', count: 3, sourceCount: 3, shDegree: 0,
  selected: 0, visible: 3, canUndo: false, canRedo: false, revision: 0, contentRevision: 0, pending: false, progress: 1,
  transaction: false, selectionDraft: false, sceneChanged: false, center: [0, 0, 0], radius: 1, yUp: false,
  camera: [0, 0, 0, 0, 0, 3, 1, 45, 0, 0, 1], memoryBytes: 432, floor: null, filter: null, transformSession: null, opacitySession: null,
  selectionMapId: null, pendingSelectionMapId: null, selectionMapBytes: 0, selectionMapRetainedIds: [] }; }
class GroupWorker {
  static latest: GroupWorker; onmessage?: (event: { data: unknown }) => void; onerror?: (event: { preventDefault(): void; message: string }) => void;
  onmessageerror?: () => void; sent: WorkerRequest[] = []; transfers: Transferable[][] = []; terminated = 0;
  private initializationId = ''; private sequence = 0;
  private allocation = { loaded: false, kind: 0, count: 0, memoryBytes: 0, selectionMapBytes: 0, selectionMapRetainedIds: [] as number[] };
  private unread: WorkerRequest[] = []; private waiters: { type: WorkerRequest['type']; resolve(value: WorkerRequest): void }[] = [];
  constructor() { GroupWorker.latest = this; }
  telemetry(value?: NativeSummary) { if (value) this.allocation = { loaded: value.loaded, kind: value.kind, count: value.count,
    memoryBytes: value.memoryBytes, selectionMapBytes: value.selectionMapBytes, selectionMapRetainedIds: [...value.selectionMapRetainedIds] };
    return { initializationId: this.initializationId, heap: { sequence: ++this.sequence, heapBytes: 128 * 1024 * 1024 }, census: emptyCensus(this.sequence), allocation: { ...this.allocation } }; }
  postMessage(value: WorkerRequest | { type: 'initialize'; initializationId: string; mode: string }, transfer: Transferable[] = []) {
    if (value.type === 'initialize') { this.initializationId = value.initializationId;
      queueMicrotask(() => this.onmessage?.({ data: { type: 'ready', mode: value.mode, build: BUILD_DESCRIPTOR,
        core: BUILD_DESCRIPTOR.native.core, ...this.telemetry(), allocation: null } })); return; }
    const copied = structuredClone(value, { transfer }); this.sent.push(copied); this.transfers.push([...transfer]);
    const index = this.waiters.findIndex(waiter => waiter.type === copied.type);
    if (index < 0) this.unread.push(copied); else this.waiters.splice(index, 1)[0].resolve(copied);
  }
  next<T extends WorkerRequest['type']>(type: T): Promise<Extract<WorkerRequest, { type: T }>> {
    const index = this.unread.findIndex(value => value.type === type);
    if (index >= 0) return Promise.resolve(this.unread.splice(index, 1)[0] as Extract<WorkerRequest, { type: T }>);
    return new Promise(resolve => this.waiters.push({ type, resolve: value => resolve(value as Extract<WorkerRequest, { type: T }>) }));
  }
  respond(load: Load, response: Record<string, unknown>) { this.onmessage?.({ data: structuredClone({ ...load,
    ...this.telemetry(response.summary as NativeSummary | undefined), ...response }) }); }
  terminate() { this.terminated++; }
}
const clients: CoreClient[] = [];
afterEach(() => { clients.splice(0).forEach(client => client.dispose()); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function client(memory?: NativeHeapAccounting) {
  vi.stubGlobal('document', { baseURI: 'https://example.test/' }); vi.stubGlobal('Worker', GroupWorker);
  const core = new CoreClient(memory); clients.push(core); await core.ready(); return { core, worker: GroupWorker.latest };
}
function range(load: Load, resourceId: string, offset: number, length: number, rangeId: number): SourceRange {
  return { operationId: load.source.operationId, resourceId, offset, length, rangeId };
}
async function transfer(worker: GroupWorker, load: Load, source: Awaited<ReturnType<typeof groupFixture>>, after?: (range: SourceRange) => void) {
  let rangeId = 0;
  for (const resource of [...load.source.resources, load.source.decoder]) for (let offset = 0; offset < resource.byteLength;) {
    const value = range(load, resource.resourceId, offset, Math.min(1024 * 1024, resource.byteLength - offset), rangeId++);
    worker.respond(load, { type: 'source-range-request', ...value }); const delivered = await worker.next('source-range');
    expect(new Uint8Array(delivered.bytes)).toEqual(source.bytes.get(resource.resourceId)!.slice(offset, offset + value.length));
    expect(worker.transfers.at(-1)).toHaveLength(1); expect(worker.transfers.at(-1)![0]).toBeInstanceOf(ArrayBuffer);
    expect((worker.transfers.at(-1)![0] as ArrayBuffer).byteLength).toBe(0);
    await tick(); worker.respond(load, { type: 'source-range-consumed', ...value }); after?.(value); offset += value.length;
  }
  worker.respond(load, { type: 'source-load-result', operationId: load.source.operationId, resourceId: load.source.resourceId,
    consumedBytes: groupTransferBytes(load.source), summary: summary(), fingerprint: { scheme: 'splatview-source-v1',
      resourceCount: load.source.resources.length, totalBytes: load.source.byteLength,
      assetDigest: independentGroupKey(load.source, source.bytes), sourceKindHint: 'SOG v1' } });
}
describe('grouped source client transport', () => {
  it('uses one global range credit, transfers original resources then decoder, and covers only actual block+descriptor native bytes', async () => {
    const source = await groupFixture(), ledger = new ResourceLedger(512 * 1024 * 1024), memory = new NativeHeapAccounting(ledger, ledger.reserve('source', 0));
    const { core, worker } = await client(memory), nativeLease = ledger.reserve('decoded', 1024 * 1024);
    const update = vi.spyOn(memory, 'reconcile');
    const loading = core.loadGroup(source.group, 1_000_000, GROUP_NATIVE_BUDGET_BYTES, { admit: bytes => ledger.reserve('source', bytes), current() {}, nativeLease });
    const load = await worker.next('source-group-load'); expect(load.source).toEqual(source.group.descriptor);
    await transfer(worker, load, source);
    const loaded = await loading; expect(loaded.fingerprint.totalBytes).toBe(701); expect(loaded.fingerprint.resourceCount).toBe(6);
    expect(update.mock.calls.some(([, coverage]) => coverage?.some(row => row.nextLeaseBytes === groupStageBytes(load.source) &&
      row.nativeBytes === groupNativeStageBytes(load.source)))).toBe(true);
    expect(worker.terminated).toBe(0); await core.retireNativeMemory(); nativeLease(); source.dispose();
    expect(ledger.usage.bytes).toBe(0); expect(source.ledger.usage.bytes).toBe(0);
  });
  it.each(['parallel-resource', 'wrong-resource', 'replayed-range', 'early-terminal'] as const)('retires a %s malformed transfer without accepting a source', async kind => {
    const source = await groupFixture(), ledger = new ResourceLedger(32 * 1024 * 1024), { core, worker } = await client();
    const loading = core.loadGroup(source.group, 100, GROUP_NATIVE_BUDGET_BYTES, { admit: bytes => ledger.reserve('source', bytes), current() {} });
    const rejected = expect(loading).rejects.toThrow(/source|credit|range|bytes/i), load = await worker.next('source-group-load');
    const primary = load.source.resources[0], first = range(load, primary.resourceId, 0, primary.byteLength, 0);
    if (kind === 'early-terminal') worker.respond(load, { type: 'source-load-result', operationId: load.source.operationId,
      resourceId: load.source.resourceId, consumedBytes: groupTransferBytes(load.source), summary: summary(), fingerprint: {} });
    else {
      worker.respond(load, { type: 'source-range-request', ...first }); await worker.next('source-range'); await tick();
      if (kind === 'parallel-resource') worker.respond(load, { type: 'source-range-request', ...range(load, load.source.resources[1].resourceId, 0, load.source.resources[1].byteLength, 1) });
      else {
        worker.respond(load, { type: 'source-range-consumed', ...first });
        worker.respond(load, { type: 'source-range-request', ...(kind === 'replayed-range' ? first :
          range(load, load.source.decoder.resourceId, 0, load.source.decoder.byteLength, 1)) });
      }
    }
    await rejected; expect(worker.terminated).toBe(1); expect(ledger.usage.bytes).toBe(0); source.dispose();
  });
  it('joins a held middle-resource Blob read on cancellation and retains stopped native stage credit until retirement', async () => {
    const source = await groupFixture(), ledger = new ResourceLedger(512 * 1024 * 1024), memory = new NativeHeapAccounting(ledger, ledger.reserve('source', 0));
    const { core, worker } = await client(memory), nativeLease = ledger.reserve('decoded', 1024 * 1024);
    const middle = source.group.sources[1].blob; let release!: (bytes: ArrayBuffer) => void;
    const held = new Promise<ArrayBuffer>(resolve => { release = resolve; }); vi.spyOn(middle, 'slice').mockReturnValue({ arrayBuffer: () => held } as Blob);
    const loading = core.loadGroup(source.group, 100, GROUP_NATIVE_BUDGET_BYTES, { admit: bytes => ledger.reserve('source', bytes), current() {}, nativeLease });
    const rejection = expect(loading).rejects.toMatchObject({ name: 'AbortError' }), load = await worker.next('source-group-load');
    const primary = load.source.resources[0], first = range(load, primary.resourceId, 0, primary.byteLength, 0);
    worker.respond(load, { type: 'source-range-request', ...first }); await worker.next('source-range'); await tick();
    worker.respond(load, { type: 'source-range-consumed', ...first });
    const next = load.source.resources[1]; worker.respond(load, { type: 'source-range-request', ...range(load, next.resourceId, 0, next.byteLength, 1) });
    await tick(); core.cancel(); let retired = false; const retirement = core.retireNativeMemory().then(() => { retired = true; });
    await tick(); expect(retired).toBe(false); expect(ledger.usage.bytes).toBeGreaterThan(groupStageBytes(load.source));
    release(source.bytes.get(next.resourceId)!.slice().buffer); await rejection; await retirement; nativeLease(); source.dispose();
    expect(worker.sent.filter(value => value.type === 'source-range')).toHaveLength(1); expect(ledger.usage.bytes).toBe(0);
  });
});
