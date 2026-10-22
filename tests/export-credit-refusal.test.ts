import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreClient } from '../src/document/coreClient';
import { BUILD_DESCRIPTOR } from '../src/generated/buildIdentity';
import { NativeHeapAccounting } from '../src/document/nativeMemory';
import { bindResourceLeaseCredit, MiB, ResourceLedger, type ResourceLease } from '../src/document/resources';
import type { Envelope, NativeSummary } from '../src/document/types';
import type { SceneExportPlan, Spz4ExportOptions, Spz4ExportPlan } from '../src/document/spz4Export';
import type { AdmittedSceneExportFormat } from '../src/document/exportFormats';
import { emptyCensus } from './fixtures/allocation-census';

// A controlled message transport and real credit owners exercise refusal
// cleanup. No native codec, renderer, browser or output fixture is executed.
vi.mock('../src/build/runtime', () => ({ ensureRuntime: async () => ({ mode: 'production-verified',
  assetBase: 'https://example.test/', artifacts: new Map([['document-worker', { bytes: new ArrayBuffer(1) }]]) }),
  runtimeNativeSource: () => undefined }));
type Request = Envelope & { type: string };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const plan: Spz4ExportPlan = { count: 3, shDegree: 0, outputCapacity: 512, nativeWorkBytes: 4 * MiB };
function summary(): NativeSummary {
  return { ok: true, selectionCommitRevision: 0, undoSelectionRevision: 0, toleranceRecorded: null, toleranceRange: null, toleranceSessionId: null, toleranceTool: null, duplicateRange: null, loaded: true, kind: 0, count: 3, sourceCount: 3, selected: 1, visible: 3, shDegree: 0, format: 'PLY',
    canUndo: true, canRedo: true, revision: 2, contentRevision: 1, transaction: false, selectionDraft: false,
    sceneChanged: false, pending: false, progress: 1, floor: null, filter: null, transformSession: null, opacitySession: null, center: [0, 0, 0], radius: 1, yUp: false,
    camera: [0, 0, 0, 0, 0, 3, 1, 45, 0, 0, 1], memoryBytes: 528, exportBytes: 0, exportOutputBytes: 0,
    selectionMapId: null, pendingSelectionMapId: null, selectionMapBytes: 0, selectionMapRetainedIds: [] };
}
class WorkerDouble {
  static latest: WorkerDouble;
  onmessage?: (event: { data: unknown }) => void;
  onerror?: (event: { preventDefault(): void; message: string }) => void;
  onmessageerror?: () => void;
  sent: Request[] = [];
  initializationId = '';
  sequence = 0;
  current = summary();
  terminated = 0;
  constructor() { WorkerDouble.latest = this; }
  postMessage(value: Request | { type: 'initialize'; initializationId: string; mode: string }) {
    if (value.type === 'initialize') {
      const initial = value as { initializationId: string; mode: string }; this.initializationId = initial.initializationId;
      queueMicrotask(() => this.onmessage?.({ data: { type: 'ready', initializationId: this.initializationId,
        mode: initial.mode, build: BUILD_DESCRIPTOR, core: BUILD_DESCRIPTOR.native.core, allocation: null,
        heap: { sequence: ++this.sequence, heapBytes: 65_536 }, census: emptyCensus(this.sequence) } }));
    } else this.sent.push(structuredClone(value) as Request);
  }
  respond(request: Request, payload: Record<string, unknown>) {
    const value = (payload.summary as NativeSummary | undefined) ?? this.current; this.current = value;
    this.onmessage?.({ data: structuredClone({ ...request, ...payload, initializationId: this.initializationId,
      heap: { sequence: ++this.sequence, heapBytes: 65_536 }, census: emptyCensus(this.sequence),
      allocation: { loaded: value.loaded, kind: value.kind, count: value.count, memoryBytes: value.memoryBytes,
        selectionMapBytes: 0, selectionMapRetainedIds: [], exportBytes: value.exportBytes ?? 0, exportOutputBytes: value.exportOutputBytes ?? 0 } }) });
  }
  terminate() { this.terminated++; }
}
const clients: CoreClient[] = [];
beforeEach(() => {
  vi.stubGlobal('document', { baseURI: 'https://example.test/' }); vi.stubGlobal('Worker', WorkerDouble);
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:credit-refusal'); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.retireNativeMemory()));
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function fixture(format?: AdmittedSceneExportFormat) {
  const ledger = new ResourceLedger(64 * MiB), memory = new NativeHeapAccounting(ledger, ledger.reserve('source', 65_536)),
    client = new CoreClient(memory); clients.push(client); await client.ready(); const worker = WorkerDouble.latest;
  const reading = client.command({ command: 'summary' }); await flush(); worker.respond(worker.sent.at(-1)!, { type: 'result', summary: summary() }); await reading;
  memory.activate();
  const scenePlan: SceneExportPlan = { ...plan, format: format ?? 8, scope: 0 };
  const planning = format === undefined ? client.exportPlan() : client.sceneExportPlan(format, 0); await flush();
  worker.respond(worker.sent.at(-1)!, { type: format === undefined ? 'export-plan' : 'scene-export-plan',
    plan: format === undefined ? plan : scenePlan, summary: worker.current }); await planning;
  worker.sent = [];
  const native: ResourceLease[] = [], output: ResourceLease[] = [], accepted = vi.fn();
  const options: Spz4ExportOptions = { signal: new AbortController().signal, current: () => {}, onAccepted: accepted,
    admitNative(bytes) { const lease = ledger.reserve('work', bytes); native.push(lease); return lease; },
    admitOutput(bytes) { const lease = ledger.reserve('image', bytes); output.push(lease); return lease; } };
  return { client, worker, ledger, memory, options, native, output, accepted, scenePlan, baseline: ledger.usage };
}

describe('refused export credits preserve prior owners', () => {
  it('returns a distinct provisional native-output grant that violates the requested zero-byte credit', async () => {
    const f = await fixture(); f.options.admitNative = requested => {
      const lease = f.ledger.reserve('work', requested || 1); f.native.push(lease); return lease;
    };
    await expect(f.client.exportSpz4(0, plan, f.options)).rejects.toBeInstanceOf(Error);
    expect(f.native).toHaveLength(2); expect(f.native.every(lease => !f.ledger.owns(lease))).toBe(true);
    expect(f.output.every(lease => !f.ledger.owns(lease))).toBe(true); expect(f.accepted).not.toHaveBeenCalled();
    expect(f.worker.sent).toHaveLength(0); expect(f.worker.terminated).toBe(0);
    expect(f.ledger.usage.bytes).toBe(f.baseline.bytes); expect(f.ledger.usage.allocations).toBe(f.baseline.allocations);
  });

  it.each(['work', 'output'] as const)('does not adopt an aliased provisional %s grant and returns each current credit', async alias => {
    const f = await fixture(), grant = f.options.admitNative;
    f.options.admitNative = requested => requested ? grant(requested) : alias === 'work' ? f.native[0] : f.output[0];
    await expect(f.client.exportSpz4(0, plan, f.options)).rejects.toBeInstanceOf(Error);
    expect(f.accepted).not.toHaveBeenCalled(); expect(f.worker.sent).toHaveLength(0);
    expect(f.native.every(lease => !f.ledger.owns(lease))).toBe(true); expect(f.output.every(lease => !f.ledger.owns(lease))).toBe(true);
    expect(f.ledger.usage.bytes).toBe(f.baseline.bytes); expect(f.ledger.usage.allocations).toBe(f.baseline.allocations);
  });

  it('returns the new zero-byte output grant if an authentic foreign work credit makes coverage installation fail', async () => {
    const f = await fixture(), foreign = new ResourceLedger(64 * MiB), grant = f.options.admitNative;
    f.options.admitNative = requested => requested ? foreign.reserve('work', requested) : grant(0);
    await expect(f.client.exportSpz4(0, plan, f.options)).rejects.toBeInstanceOf(Error);
    expect(f.accepted).not.toHaveBeenCalled(); expect(f.worker.sent).toHaveLength(0);
    expect(foreign.usage.bytes).toBe(0); expect(foreign.usage.allocations).toBe(0);
    expect(f.native).toHaveLength(1); expect(f.ledger.owns(f.native[0])).toBe(false);
    expect(f.ledger.usage.bytes).toBe(f.baseline.bytes); expect(f.ledger.usage.allocations).toBe(f.baseline.allocations);
  });

  it.each(['work', 'output'] as const)('preserves the previous native output when a later %s grant borrows its authentic credit', async alias => {
    const f = await fixture(), first = f.client.exportSpz4(0, plan, f.options); await flush();
    const terminal = { ...summary(), memoryBytes: 1040, exportBytes: 512, exportOutputBytes: 512 };
    f.worker.respond(f.worker.sent[0], { type: 'output', bytes: new Uint8Array([2, 3, 5, 7]).buffer, summary: terminal });
    const owned = await first; owned.dispose(); const previous = f.native[1];
    expect(previous.bytes).toBe(512); expect(f.ledger.owns(previous)).toBe(true);
    const before = f.ledger.usage.bytes, planning = f.client.exportPlan(); await flush();
    f.worker.respond(f.worker.sent.at(-1)!, { type: 'export-plan', plan, summary: terminal }); await planning; f.worker.sent = [];
    if (alias === 'work') f.options.admitNative = () => previous;
    else f.options.admitOutput = () => previous;
    await expect(f.client.exportSpz4(0, plan, f.options)).rejects.toBeInstanceOf(Error);
    expect(f.ledger.owns(previous)).toBe(true); expect(previous.bytes).toBe(512);
    expect(f.memory.state.coveredBytes).toBe(512); expect(f.ledger.usage.bytes).toBe(before); expect(f.worker.sent).toHaveLength(0);
    expect(f.client.revision).toMatchObject({ contentRevision: 1, selectionRevision: 1 });
  });

  it('rejects and drains a cleanup wrapper Promise even when it synchronously releases authentic output credit', async () => {
    const f = await fixture();
    f.options.admitOutput = requested => {
      const genuine = f.ledger.reserve('image', requested); f.output.push(genuine);
      const wrapper = (() => { genuine(); return Promise.resolve(); }) as unknown as ResourceLease;
      Object.defineProperty(wrapper, 'bytes', { get: () => genuine.bytes }); wrapper.resize = bytes => genuine.resize(bytes);
      return bindResourceLeaseCredit(wrapper, genuine);
    };
    f.options.onAccepted = () => { throw new Error('Independent acceptance refusal'); };
    const failure = await f.client.exportSpz4(0, plan, f.options).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: 'Source ownership hooks must complete synchronously.' }),
    ]));
    expect(f.worker.sent).toHaveLength(0); expect(f.output.every(lease => !f.ledger.owns(lease))).toBe(true);
    expect(f.ledger.usage.bytes).toBe(f.baseline.bytes);
  });
});

describe('general scene export credits preserve prior owners', () => {
  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8] as const)('returns format %s work credit when independent browser output admission is refused', async format => {
    const f = await fixture(format); f.options.admitOutput = () => { throw new Error('Independent browser output refusal'); };
    await expect(f.client.exportOwned(format, 0, f.scenePlan, f.options)).rejects.toThrow('Independent browser output refusal');
    expect(f.accepted).not.toHaveBeenCalled(); expect(f.worker.sent).toHaveLength(0); expect(f.worker.terminated).toBe(0);
    expect(f.native).toHaveLength(1); expect(f.native.every(lease => !f.ledger.owns(lease))).toBe(true);
    expect(f.ledger.usage).toMatchObject({ bytes: f.baseline.bytes, allocations: f.baseline.allocations });
  });

  it('refuses output borrowing work credit through a distinct authentic wrapper', async () => {
    const f = await fixture(5);
    f.options.admitOutput = () => {
      const work = f.native[0], wrapper = (() => work()) as ResourceLease;
      Object.defineProperty(wrapper, 'bytes', { get: () => work.bytes }); wrapper.resize = bytes => work.resize(bytes);
      return bindResourceLeaseCredit(wrapper, work);
    };
    await expect(f.client.exportOwned(5, 0, f.scenePlan, f.options)).rejects.toThrow('separate credit');
    expect(f.accepted).not.toHaveBeenCalled(); expect(f.worker.sent).toHaveLength(0); expect(f.worker.terminated).toBe(0);
    expect(f.native.every(lease => !f.ledger.owns(lease))).toBe(true);
    expect(f.ledger.usage).toMatchObject({ bytes: f.baseline.bytes, allocations: f.baseline.allocations });
  });

  it('rechecks the plan revision after admission hooks before accepting or dispatching generic output', async () => {
    const f = await fixture(5), grant = f.options.admitOutput;
    f.options.admitOutput = requested => { const lease = grant(requested); f.client.revision.contentRevision++; return lease; };
    await expect(f.client.exportOwned(5, 0, f.scenePlan, f.options)).rejects.toThrow('no longer current');
    expect(f.accepted).not.toHaveBeenCalled(); expect(f.worker.sent).toHaveLength(0); expect(f.worker.terminated).toBe(0);
    expect(f.native.every(lease => !f.ledger.owns(lease))).toBe(true); expect(f.output.every(lease => !f.ledger.owns(lease))).toBe(true);
    expect(f.ledger.usage).toMatchObject({ bytes: f.baseline.bytes, allocations: f.baseline.allocations });
  });

  it.each([
    { previousFormat: 0, nextFormat: 5, alias: 'work' }, { previousFormat: 0, nextFormat: 5, alias: 'output' },
    { previousFormat: 1, nextFormat: 8, alias: 'work' }, { previousFormat: 1, nextFormat: 8, alias: 'output' },
    { previousFormat: 8, nextFormat: 1, alias: 'work' }, { previousFormat: 8, nextFormat: 1, alias: 'output' },
    { previousFormat: 6, nextFormat: 7, alias: 'work' }, { previousFormat: 6, nextFormat: 7, alias: 'output' },
    { previousFormat: 7, nextFormat: 6, alias: 'work' }, { previousFormat: 7, nextFormat: 6, alias: 'output' },
    { previousFormat: 1, nextFormat: 6, alias: 'work' }, { previousFormat: 1, nextFormat: 6, alias: 'output' },
    { previousFormat: 7, nextFormat: 8, alias: 'work' }, { previousFormat: 7, nextFormat: 8, alias: 'output' },
  ] as const)('preserves format $previousFormat native output when format $nextFormat borrows its $alias credit', async ({ previousFormat, nextFormat, alias }) => {
    const f = await fixture(previousFormat), first = f.client.exportOwned(previousFormat, 0, f.scenePlan, f.options); await flush();
    const terminal = { ...summary(), memoryBytes: 1040, exportBytes: 512, exportOutputBytes: 512 };
    f.worker.respond(f.worker.sent[0], { type: 'output', bytes: new Uint8Array([2, 3, 5, 7]).buffer, summary: terminal });
    const owned = await first; owned.dispose(); const previous = f.native[1];
    const nextPlan: SceneExportPlan = { ...plan, format: nextFormat, scope: 1 }, planning = f.client.sceneExportPlan(nextFormat, 1); await flush();
    f.worker.respond(f.worker.sent.at(-1)!, { type: 'scene-export-plan', plan: nextPlan, summary: terminal }); await planning; f.worker.sent = [];
    const before = f.ledger.usage, accepted = f.accepted.mock.calls.length;
    if (alias === 'work') f.options.admitNative = () => previous;
    else f.options.admitOutput = () => previous;
    await expect(f.client.exportOwned(nextFormat, 1, nextPlan, f.options)).rejects.toBeInstanceOf(Error);
    expect(f.ledger.owns(previous)).toBe(true); expect(previous.bytes).toBe(512); expect(f.memory.state.coveredBytes).toBe(512);
    expect(f.accepted).toHaveBeenCalledTimes(accepted); expect(f.worker.sent).toHaveLength(0);
    expect(f.ledger.usage).toMatchObject({ bytes: before.bytes, allocations: before.allocations });
    expect(f.client.revision).toMatchObject({ contentRevision: 1, selectionRevision: 1 });
  });

  it('lets the real ledger refuse a native CSV plan above the SPZ size ceiling before encoding or acceptance', async () => {
    const f = await fixture(5);
    const large: SceneExportPlan = { ...f.scenePlan, outputCapacity: 200 * MiB, nativeWorkBytes: 210 * MiB };
    const planning = f.client.sceneExportPlan(5, 0); await flush();
    f.worker.respond(f.worker.sent.at(-1)!, { type: 'scene-export-plan', plan: large, summary: summary() });
    expect(await planning).toEqual(large); f.worker.sent = [];
    await expect(f.client.exportOwned(5, 0, large, f.options)).rejects.toThrow('available scene budget');
    expect(f.accepted).not.toHaveBeenCalled(); expect(f.worker.sent).toHaveLength(0); expect(f.worker.terminated).toBe(0);
    expect(f.native).toHaveLength(0); expect(f.output).toHaveLength(0);
    expect(f.ledger.usage).toMatchObject({ bytes: f.baseline.bytes, allocations: f.baseline.allocations });
  });
});
