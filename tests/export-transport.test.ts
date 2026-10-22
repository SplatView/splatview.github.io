import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreClient } from '../src/document/coreClient';
import { BUILD_DESCRIPTOR } from '../src/generated/buildIdentity';
import type { Envelope, NativeSummary } from '../src/document/types';
import { NativeHeapAccounting } from '../src/document/nativeMemory';
import { MiB, resourceLeaseCredit, ResourceLedger, type ResourceLease } from '../src/document/resources';
import type { OwnedExportBytes, SceneExportPlan, Spz4ExportOptions } from '../src/document/spz4Export';
import type { AdmittedSceneExportFormat } from '../src/document/exportFormats';
import { emptyCensus } from './fixtures/allocation-census';
import { NEUTRAL_COLOR } from '../src/document/types';

// The real CoreClient talks only to this independently controlled transport.
// No WASM/native module, renderer, fixture decoder or browser is started.
vi.mock('../src/build/runtime', () => ({
  ensureRuntime: async () => ({ mode: 'production-verified', assetBase: 'https://example.test/',
    artifacts: new Map([['document-worker', { bytes: new ArrayBuffer(1) }]]) }),
  runtimeNativeSource: () => undefined,
}));
type Plan = { count: number; shDegree: number; outputCapacity: number; nativeWorkBytes: number };
type Transport = { export(format: number, scope: number, signal?: AbortSignal): Promise<ArrayBuffer>;
  exportPlan(signal?: AbortSignal): Promise<Plan>;
  sceneExportPlan(format: number, scope: number, signal?: AbortSignal): Promise<SceneExportPlan>;
  exportOwned(format: number, scope: number, plan: SceneExportPlan, options: Spz4ExportOptions): Promise<OwnedExportBytes>;
  exportSpz4(scope: number, plan: Plan, options: Spz4ExportOptions): Promise<OwnedExportBytes> };
type Request = Envelope & { type: string; format?: number; scope?: number; command?: { command: string; format?: number; scope?: number } };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function summary(): NativeSummary {
  return { ok: true, selectionCommitRevision: 0, undoSelectionRevision: 0, toleranceRecorded: null, toleranceRange: null, toleranceSessionId: null, toleranceTool: null, duplicateRange: null, loaded: true, kind: 0, count: 3, sourceCount: 3, selected: 1, visible: 3, shDegree: 0, format: 'PLY',
    canUndo: true, canRedo: true, revision: 2, contentRevision: 1, transaction: false, selectionDraft: false,
    sceneChanged: false, pending: false, progress: 1, floor: null, filter: null, transformSession: null, opacitySession: null, center: [0, 0, 0], radius: 1, yUp: false,
    camera: [0, 0, 0, 0, 0, 3, 1, 45, 0, 0, 1], memoryBytes: 528,
    selectionMapId: null, pendingSelectionMapId: null, selectionMapBytes: 0, selectionMapRetainedIds: [] };
}
class WorkerDouble {
  static latest: WorkerDouble;
  onmessage?: (event: { data: unknown }) => void;
  onerror?: (event: { preventDefault(): void; message: string }) => void;
  onmessageerror?: () => void;
  initializationId = '';
  sequence = 0;
  terminated = 0;
  sent: Request[] = [];
  constructor() { WorkerDouble.latest = this; }
  postMessage(value: Request | { type: 'initialize'; initializationId: string; mode: string }, transfer: Transferable[] = []) {
    if (value.type === 'initialize') {
      this.initializationId = (value as { initializationId: string }).initializationId;
      queueMicrotask(() => this.onmessage?.({ data: {
        type: 'ready', initializationId: this.initializationId, mode: (value as { mode: string }).mode,
        build: BUILD_DESCRIPTOR, core: BUILD_DESCRIPTOR.native.core, allocation: null,
        heap: { sequence: ++this.sequence, heapBytes: 65_536 }, census: emptyCensus(this.sequence),
      } })); return;
    }
    this.sent.push(structuredClone(value, { transfer }) as Request);
  }
  respond(request: Request, payload: Record<string, unknown>, transfer: Transferable[] = []) {
    const value = (payload.summary as NativeSummary | undefined) ?? summary();
    const data = structuredClone({ ...request, ...payload, initializationId: this.initializationId,
      heap: { sequence: ++this.sequence, heapBytes: 65_536 }, census: emptyCensus(this.sequence),
      allocation: { loaded: true, kind: 0, count: value.count, memoryBytes: value.memoryBytes,
        selectionMapBytes: 0, selectionMapRetainedIds: [], exportBytes: value.exportBytes ?? 0, exportOutputBytes: value.exportOutputBytes ?? 0 },
    }, { transfer });
    this.onmessage?.({ data });
  }
  terminate() { this.terminated++; }
}
const clients: CoreClient[] = [];
beforeEach(() => {
  vi.stubGlobal('document', { baseURI: 'https://example.test/' }); vi.stubGlobal('Worker', WorkerDouble);
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:export-transport'); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.retireNativeMemory()));
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function fixture(memory?: NativeHeapAccounting) {
  const client = new CoreClient(memory); clients.push(client); await client.ready();
  const worker = WorkerDouble.latest, initial = client.command({ command: 'summary' }); await flush();
  const request = worker.sent.at(-1)!; worker.respond(request, { type: 'result', summary: summary() }); await initial;
  worker.sent = [];
  return { client, transport: client as unknown as Transport, worker, revision: { ...client.revision } };
}
async function accountingFixture(format?: AdmittedSceneExportFormat, scope = 0) {
  const ledger = new ResourceLedger(64 * MiB), remainder = ledger.reserve('source', 65_536),
    memory = new NativeHeapAccounting(ledger, remainder), f = await fixture(memory);
  memory.activate(); const native: ResourceLease[] = [], outputs: ResourceLease[] = [], accepted = vi.fn(), cancel = new AbortController();
  const options: Spz4ExportOptions = { signal: cancel.signal, current: vi.fn(), onAccepted: accepted,
    admitNative(bytes) { const lease = ledger.reserve('work', bytes); native.push(lease); return lease; },
    admitOutput(bytes) { const lease = ledger.reserve('image', bytes); outputs.push(lease); return lease; } };
  const plan: Plan = { count: 3, shDegree: 0, outputCapacity: 512, nativeWorkBytes: 4 * MiB };
  const scenePlan: SceneExportPlan = { ...plan, format: format ?? 8, scope };
  const planning = format === undefined ? f.transport.exportPlan() : f.transport.sceneExportPlan(format, scope); await flush();
  f.worker.respond(f.worker.sent.at(-1)!, { type: format === undefined ? 'export-plan' : 'scene-export-plan',
    plan: format === undefined ? plan : scenePlan, summary: summary() }); await planning;
  f.worker.sent = [];
  return { ...f, ledger, memory, native, outputs, accepted, cancel, options, plan, scenePlan, baseline: ledger.usage.bytes };
}

describe('current-view scope and authenticated edit-mask channels', () => {
  it('detaches a selection camera before a preceding queued command settles', async () => {
    const f = await fixture(), preceding = f.client.command({ command: 'summary' }); await flush();
    const camera = [0, 0, 0, .35, .18, 3, 1, 45, 0, 0, 1];
    const selecting = f.client.command({ command: 'single', index: 1, operation: 0, selectionView: camera });
    camera[0] = 100;
    f.worker.respond(f.worker.sent[0], { type: 'result', summary: summary() }); await preceding; await flush();
    expect(f.worker.sent[1].command).toMatchObject({ selectionView: [0, 0, 0, Math.fround(.35), Math.fround(.18), 3, 1, 45, 0, 0, 1] });
    f.worker.respond(f.worker.sent[1], { type: 'result', summary: summary() }); await selecting;
  });
  it.each(['colorBase', 'transformBase', 'opacityBase'] as const)('fences explicit %s masks with the acknowledged native base identity', async channel => {
    const f = await fixture(), native = summary();
    if (channel === 'colorBase') native.colorSession = { version: 1, active: true, sessionId: 3, baseId: 8, epochId: 5,
      selectedOnly: true, pending: false, values: [...NEUTRAL_COLOR], applied: [...NEUTRAL_COLOR] };
    else if (channel === 'transformBase') native.transformSession = { id: 3, baseId: 8, epoch: 0, appliedEpoch: null,
      selectedOnly: true, kind: 'numeric', appliedMatrix: [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1], pivot: [0,0,0], gizmo: null };
    else native.opacitySession = { id: 3, baseId: 8, epoch: 5, appliedEpoch: 4, selectedOnly: true, appliedScale: 2 };
    const observing = f.client.command(channel === 'transformBase' ? { command: 'beginTransform', kind: 'numeric', selectedOnly: true } : { command: 'summary' }); await flush();
    f.worker.respond(f.worker.sent.at(-1)!, { type: 'result', summary: native }); await observing;
    const mask = vi.fn(), reading = f.client.readMasks(mask, channel); await flush();
    const request = f.worker.sent.at(-1)!;
    expect(request).toMatchObject({ type: 'masks', channel,
      [channel]: channel === 'colorBase' ? { sessionId: 3, baseId: 8, epochId: 5 } : { id: 3, baseId: 8, epoch: channel === 'transformBase' ? 0 : 5 } });
    f.worker.respond(request, { type: 'masks', bytes: new Uint8Array([0, 0, 1]).buffer, summary: native });
    f.worker.respond(request, { type: 'result', summary: native }); await reading;
    expect(mask).toHaveBeenCalledOnce(); expect(Array.from(new Uint8Array(mask.mock.calls[0][0]))).toEqual([0,0,1]);
    const canonical = f.client.readMasks(() => {}); await flush(); const ordinary = f.worker.sent.at(-1)!;
    expect(ordinary).toMatchObject({ type: 'masks', channel: 'document' });
    f.worker.respond(ordinary, { type: 'masks', bytes: new Uint8Array([1,0,0]).buffer, summary: native });
    f.worker.respond(ordinary, { type: 'result', summary: native }); await canonical;
  });
  it.each(['short', 'state', 'missing', 'duplicate'] as const)('retires a worker for a %s mask response before accepting a successor', async fault => {
    const f = await fixture(), mask = vi.fn(), reading = f.client.readMasks(mask);
    const rejected = expect(reading).rejects.toThrow(/mask channel/); await flush(); const request = f.worker.sent.at(-1)!;
    if (fault === 'missing') f.worker.respond(request, { type: 'result', summary: summary() });
    else {
      const bytes = fault === 'short' ? new Uint8Array(2).buffer : fault === 'state' ? new Uint8Array([0,3,1]).buffer : new Uint8Array([0,2,1]).buffer;
      f.worker.respond(request, { type: 'masks', bytes });
      if (fault === 'duplicate') f.worker.respond(request, { type: 'masks', bytes: new Uint8Array([0,2,1]).buffer });
    }
    await rejected; expect(f.worker.terminated).toBe(1); expect(mask).toHaveBeenCalledTimes(fault === 'duplicate' ? 1 : 0);
  });
});

describe('export request transport ownership', () => {
  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8])('refuses raw bounded export %s before it can bypass admission', async format => {
    const f = await fixture();
    await expect(f.transport.export(format, 0)).rejects.toThrow('requires an admitted export plan');
    expect(f.worker.sent).toHaveLength(0); expect(f.worker.terminated).toBe(0); expect(f.client.revision).toEqual(f.revision);
  });

  it('refuses export through the ordinary command family before native dispatch', async () => {
    const f = await fixture();
    await expect(f.client.command({ command: 'export', format: 5, scope: 0 })).rejects.toThrow('owned export request family');
    expect(f.worker.sent).toHaveLength(0); expect(f.worker.terminated).toBe(0); expect(f.client.revision).toEqual(f.revision);
  });

  it('refuses a cancelled queued SOG export before admission or posting and preserves the active document and successor queue', async () => {
    const f = await accountingFixture(6), first = f.client.command({ command: 'summary' }); await flush(); const active = f.worker.sent[0];
    const cancel = new AbortController(), exporting = f.transport.exportOwned(6, 0, f.scenePlan, { ...f.options, signal: cancel.signal }),
      rejected = expect(exporting).rejects.toMatchObject({ name: 'AbortError' });
    cancel.abort(); await flush(); expect(f.worker.sent.map(value => value.type)).toEqual(['command']);
    expect(f.native).toHaveLength(0); expect(f.outputs).toHaveLength(0); expect(f.accepted).not.toHaveBeenCalled(); expect(f.ledger.usage.bytes).toBe(f.baseline);
    f.worker.respond(active, { type: 'result', summary: summary() }); await first; await rejected;
    expect(f.worker.sent.map(value => value.type)).toEqual(['command']); expect(f.worker.terminated).toBe(0); expect(f.client.revision).toEqual(f.revision);
    const next = f.client.command({ command: 'summary' }); await flush(); const successor = f.worker.sent.at(-1)!;
    expect(successor.requestId).toBeGreaterThan(active.requestId); f.worker.respond(successor, { type: 'result', summary: summary() }); await next;
    expect(f.worker.terminated).toBe(0);
  });

  it('sends cancellation to the exact admitted SOGS export and keeps its credits and queue joined until terminal', async () => {
    const f = await accountingFixture(7, 2), cancel = new AbortController(); let settled = false;
    const exporting = f.transport.exportOwned(7, 2, f.scenePlan, { ...f.options, signal: cancel.signal }).finally(() => { settled = true; });
    const rejected = expect(exporting).rejects.toMatchObject({ name: 'AbortError' }); await flush();
    const active = f.worker.sent[0]; expect(active).toMatchObject({ type: 'export', command: { command: 'export', format: 7, scope: 2 } });
    const admitted = f.ledger.usage;
    cancel.abort(); const next = f.client.command({ command: 'summary' }); await flush();
    expect(f.worker.sent).toHaveLength(2); const cancellation = f.worker.sent[1];
    expect(cancellation).toMatchObject({ type: 'cancel', requestId: active.requestId, base: active.base });
    expect(settled).toBe(false); expect(f.worker.terminated).toBe(0); expect(f.client.revision).toEqual(f.revision);
    expect(f.ledger.usage).toEqual(admitted);
    f.worker.respond(active, { type: 'error', cancelled: true, cleanupFailed: false, error: 'Export cancelled', summary: summary() });
    await rejected; await flush(); expect(f.ledger.usage.bytes).toBe(f.baseline); const successor = f.worker.sent.at(-1)!;
    expect(successor.type).toBe('command'); expect(successor.requestId).toBeGreaterThan(active.requestId);
    f.worker.respond(successor, { type: 'result', summary: summary() }); await next; expect(f.worker.terminated).toBe(0);
  });

  it('removes a completed admitted SOG abort listener so its old signal cannot cancel a SOGS successor', async () => {
    const f = await accountingFixture(6), old = new AbortController(),
      exporting = f.transport.exportOwned(6, 0, f.scenePlan, { ...f.options, signal: old.signal }); await flush();
    const active = f.worker.sent[0], bytes = new Uint8Array([5, 8, 13]).buffer;
    const terminal = { ...summary(), memoryBytes: 1040, exportBytes: 512, exportOutputBytes: 512 };
    f.worker.respond(active, { type: 'output', bytes, summary: terminal }, [bytes]); const firstOutput = await exporting;
    expect(bytes.byteLength).toBe(0); expect([...new Uint8Array(firstOutput.bytes)]).toEqual([5, 8, 13]);
    const nextPlan: SceneExportPlan = { ...f.scenePlan, format: 7, scope: 1 }, planning = f.transport.sceneExportPlan(7, 1); await flush();
    f.worker.respond(f.worker.sent.at(-1)!, { type: 'scene-export-plan', plan: nextPlan, summary: terminal }); await planning;
    const next = f.transport.exportOwned(7, 1, nextPlan, f.options); await flush(); const successor = f.worker.sent.at(-1)!;
    old.abort(); await flush(); expect(f.worker.sent.filter(value => value.type === 'cancel')).toHaveLength(0);
    const nextBytes = new Uint8Array([21]).buffer; f.worker.respond(successor, { type: 'output', bytes: nextBytes, summary: terminal }, [nextBytes]);
    const secondOutput = await next; expect([...new Uint8Array(secondOutput.bytes)]).toEqual([21]);
    expect(f.worker.terminated).toBe(0); expect(f.client.revision).toEqual(f.revision);
    expect(f.outputs.map(lease => lease.bytes)).toEqual([6, 2]); firstOutput.dispose(); secondOutput.dispose(); expect(f.ledger.usage.bytes).toBe(f.baseline);
  });

  it('authenticates a plan against the committed count/degree before returning its allocation authority', async () => {
    const f = await fixture(), planning = f.transport.exportPlan(); await flush(); const active = f.worker.sent[0];
    expect(active.type).toBe('export-plan');
    const plan: Plan = { count: 3, shDegree: 0, outputCapacity: 512, nativeWorkBytes: 4_194_304 };
    f.worker.respond(active, { type: 'export-plan', plan, summary: summary() });
    expect(await planning).toEqual(plan); expect(f.worker.terminated).toBe(0); expect(f.client.revision).toEqual(f.revision);
  });

  it.each(['count', 'degree', 'capacity', 'work', 'extra'] as const)('refuses a malformed or mismatched plan %s without publishing allocation authority', async fault => {
    const f = await fixture(), planning = f.transport.exportPlan(), rejected = expect(planning).rejects.toBeInstanceOf(Error); await flush();
    const active = f.worker.sent[0], plan: Record<string, unknown> = { count: 3, shDegree: 0, outputCapacity: 512, nativeWorkBytes: 4_194_304 };
    if (fault === 'count') plan.count = 4;
    else if (fault === 'degree') plan.shDegree = 1;
    else if (fault === 'capacity') plan.outputCapacity = Number.MAX_SAFE_INTEGER + 1;
    else if (fault === 'work') plan.nativeWorkBytes = 1.5;
    else plan.unadmitted = 32;
    f.worker.respond(active, { type: 'export-plan', plan, summary: summary() }); await rejected;
    expect(f.client.revision).toEqual(f.revision);
  });

  it('does not interpret a command result as an authenticated export plan', async () => {
    const f = await fixture(), planning = f.transport.exportPlan(), rejected = expect(planning).rejects.toBeInstanceOf(Error); await flush();
    f.worker.respond(f.worker.sent[0], { type: 'result', summary: summary() }); await rejected;
    expect(f.client.revision).toEqual(f.revision);
  });

  it('refuses a caller-invented otherwise valid plan before requesting either admission', async () => {
    const f = await fixture(), grant = vi.fn(() => { throw new Error('Unreceived plan acquired credit'); }), accepted = vi.fn();
    await expect(f.transport.exportSpz4(0, { count: 3, shDegree: 0, outputCapacity: 512, nativeWorkBytes: 4 * MiB },
      { signal: new AbortController().signal, current: () => {}, admitNative: grant, admitOutput: grant, onAccepted: accepted })).rejects.toBeInstanceOf(Error);
    expect(grant).not.toHaveBeenCalled(); expect(accepted).not.toHaveBeenCalled(); expect(f.worker.sent).toHaveLength(0);
  });

  it('retires an admitted SOG transport that returns a command result instead of an output terminal', async () => {
    const f = await accountingFixture(6), exporting = f.transport.exportOwned(6, 0, f.scenePlan, f.options), rejected = expect(exporting).rejects.toBeInstanceOf(Error); await flush();
    f.worker.respond(f.worker.sent[0], { type: 'result', summary: summary() }); await rejected;
    expect(f.worker.terminated).toBe(1); expect(f.client.revision).toEqual(f.revision);
    expect(f.outputs.every(lease => !f.ledger.owns(lease))).toBe(true); await f.client.retireNativeMemory(); expect(f.ledger.usage.bytes).toBe(0);
  });

  it('returns the first native grant when output admission fails before acceptance or dispatch', async () => {
    const f = await accountingFixture(); f.options.admitOutput = () => { throw new Error('Independent output credit refusal'); };
    await expect(f.transport.exportSpz4(0, f.plan, f.options)).rejects.toThrow('Independent output credit refusal');
    expect(f.accepted).not.toHaveBeenCalled(); expect(f.worker.sent).toHaveLength(0);
    expect(f.native).toHaveLength(1); expect(f.ledger.owns(f.native[0])).toBe(false); expect(f.ledger.usage.bytes).toBe(f.baseline);
  });

  it('refuses a short real output credit before encoding rather than resizing only after receiving an unadmitted buffer', async () => {
    const f = await accountingFixture();
    f.options.admitOutput = requested => { const lease = f.ledger.reserve('image', requested - 1); f.outputs.push(lease); return lease; };
    const exporting = f.transport.exportSpz4(0, f.plan, f.options), rejected = expect(exporting).rejects.toBeInstanceOf(Error); await flush();
    // If a regression dispatched, provide a valid terminal so the test fails
    // promptly on the acceptance assertion without leaving an unresolved job.
    const request = f.worker.sent.find(value => value.type === 'export');
    if (request) f.worker.respond(request, { type: 'error', error: 'Unadmitted export dispatched', cancelled: false, cleanupFailed: false, summary: summary() });
    await rejected; expect(f.worker.sent).toHaveLength(0); expect(f.accepted).not.toHaveBeenCalled();
    expect(f.ledger.usage.bytes).toBe(f.baseline);
  });

  it('refuses a returned Promise from the synchronous current hook before ownership grants or dispatch', async () => {
    const f = await accountingFixture(); f.options.current = (() => Promise.resolve()) as () => void;
    const exporting = f.transport.exportSpz4(0, f.plan, f.options), rejected = expect(exporting).rejects.toBeInstanceOf(Error); await flush();
    const request = f.worker.sent.find(value => value.type === 'export');
    if (request) f.worker.respond(request, { type: 'error', error: 'Async current hook dispatched', cancelled: false, cleanupFailed: false, summary: summary() });
    await rejected; expect(f.worker.sent).toHaveLength(0); expect(f.accepted).not.toHaveBeenCalled();
    expect(f.native).toHaveLength(0); expect(f.outputs).toHaveLength(0); expect(f.ledger.usage.bytes).toBe(f.baseline);
  });

  it('holds both output-copy credits through transfer, then retains only Blob credit while native output remains charged', async () => {
    const f = await accountingFixture(), exporting = f.transport.exportSpz4(1, f.plan, f.options); await flush();
    const request = f.worker.sent[0]; expect(request).toMatchObject({ type: 'export', command: { format: 8, scope: 1, outputCapacity: 512 } });
    expect(f.accepted).toHaveBeenCalledOnce(); expect(f.native.map(lease => lease.bytes)).toEqual([4 * MiB, 0]);
    expect(f.outputs.map(lease => lease.bytes)).toEqual([1024]); expect(f.ledger.usage.bytes).toBe(f.baseline + 4 * MiB + 1024);
    const bytes = new Uint8Array([1, 4, 9, 16]).buffer,
      terminal = { ...summary(), memoryBytes: summary().memoryBytes + 512, exportBytes: 512, exportOutputBytes: 512 };
    f.worker.respond(request, { type: 'output', bytes, summary: terminal }, [bytes]); const owned = await exporting;
    expect(bytes.byteLength).toBe(0); expect([...new Uint8Array(owned.bytes)]).toEqual([1, 4, 9, 16]);
    expect(f.outputs[0].bytes).toBe(8); expect(f.ledger.usage.bytes).toBe(f.baseline + 8);
    expect(f.memory.state.coveredBytes).toBe(512); expect(f.memory.state.remainderBytes).toBe(65_536 - 512);
    owned.retainBlob(); expect(() => owned.bytes).toThrow(); expect(f.outputs[0].bytes).toBe(4); expect(f.ledger.usage.bytes).toBe(f.baseline + 4);
    owned.dispose(); owned.dispose(); expect(f.ledger.usage.bytes).toBe(f.baseline); expect(f.memory.state.coveredBytes).toBe(512);
    await f.client.retireNativeMemory(); expect(f.ledger.usage.bytes).toBe(0); expect(f.worker.terminated).toBe(1);
  });

  it('retains admitted codec/output storage until a cancelled terminal reports cleanup and then keeps the heap charged', async () => {
    const f = await accountingFixture(), exporting = f.transport.exportSpz4(0, f.plan, f.options), rejected = expect(exporting).rejects.toMatchObject({ name: 'AbortError' });
    await flush(); const request = f.worker.sent[0], admitted = f.ledger.usage.bytes;
    let joined = false; void exporting.then(() => { joined = true; }, () => { joined = true; });
    f.cancel.abort(); await flush(); expect(joined).toBe(false); expect(f.ledger.usage.bytes).toBe(admitted);
    expect(f.worker.sent[1]).toMatchObject({ type: 'cancel', requestId: request.requestId, base: request.base });
    f.worker.respond(request, { type: 'error', error: 'SPZ export cancelled', cancelled: true, cleanupFailed: false, summary: summary() }); await rejected;
    expect(f.outputs.every(lease => !f.ledger.owns(lease))).toBe(true); expect(f.ledger.usage.bytes).toBe(f.baseline);
    expect(f.memory.state.retired).toBe(false); expect(f.memory.state.heapBytes).toBe(65_536); expect(f.worker.terminated).toBe(0);
    expect(f.client.revision).toEqual(f.revision);
  });
});

describe('admitted scene export transport ownership', () => {
  it.each([{ firstFormat: 1, nextFormat: 8 }, { firstFormat: 6, nextFormat: 7 }, { firstFormat: 7, nextFormat: 6 }] as const)(
    'replaces format $firstFormat with $nextFormat and back while retaining authentic old output through refusal and joined cancellation', async ({ firstFormat, nextFormat }) => {
    const f = await accountingFixture(firstFormat), first = f.transport.exportOwned(firstFormat, 0, f.scenePlan, f.options); await flush();
    const state = (capacity: number) => ({ ...summary(), memoryBytes: 528 + capacity, exportBytes: capacity, exportOutputBytes: capacity });
    f.worker.respond(f.worker.sent.at(-1)!, { type: 'output', bytes: new Uint8Array([1, 3, 5, 7]).buffer, summary: state(512) });
    const firstOutput = await first; firstOutput.retainBlob();
    const retained = f.native[1], retainedCredit = resourceLeaseCredit(retained);
    expect(f.ledger.owns(retained)).toBe(true); expect(f.memory.covers(retained)).toBe(true); expect(retained.bytes).toBe(512);
    const planFor = async (format: AdmittedSceneExportFormat, capacity: number, previousCapacity: number) => {
      const plan: SceneExportPlan = { ...f.scenePlan, format, outputCapacity: capacity, nativeWorkBytes: 4 * MiB };
      const planning = f.transport.sceneExportPlan(format, 0); await flush();
      f.worker.respond(f.worker.sent.at(-1)!, { type: 'scene-export-plan', plan, summary: state(previousCapacity) });
      expect(await planning).toEqual(plan); return plan;
    };
    const replacementPlan = await planFor(nextFormat, 1024, 512), beforeReplacement = f.ledger.usage.bytes;
    const second = f.transport.exportOwned(nextFormat, 0, replacementPlan, f.options); await flush();
    expect(resourceLeaseCredit(retained)).toBe(retainedCredit); expect(retained.bytes).toBe(512);
    expect(f.memory.covers(retained)).toBe(true); expect(f.ledger.usage.bytes).toBe(beforeReplacement + 4 * MiB + 2048);
    f.worker.respond(f.worker.sent.at(-1)!, { type: 'output', bytes: new Uint8Array([2, 4, 6, 8, 10]).buffer, summary: state(1024) });
    const secondOutput = await second; expect([...new Uint8Array(secondOutput.bytes)]).toEqual([2, 4, 6, 8, 10]);
    expect(resourceLeaseCredit(retained)).toBe(retainedCredit); expect(retained.bytes).toBe(1024); expect(f.memory.state.coveredBytes).toBe(1024);
    const nextPlan = await planFor(firstFormat, 768, 1024), beforeRefusal = f.ledger.usage, accepted = f.accepted.mock.calls.length;
    f.worker.sent = [];
    await expect(f.transport.exportOwned(firstFormat, 0, nextPlan, { ...f.options, admitOutput: () => retained })).rejects.toThrow('separate credit');
    expect(f.worker.sent).toHaveLength(0); expect(f.accepted).toHaveBeenCalledTimes(accepted);
    expect(f.ledger.usage).toMatchObject({ bytes: beforeRefusal.bytes, allocations: beforeRefusal.allocations });
    expect(resourceLeaseCredit(retained)).toBe(retainedCredit); expect(f.ledger.owns(retained)).toBe(true); expect(retained.bytes).toBe(1024);
    const cancel = new AbortController(), cancelled = f.transport.exportOwned(firstFormat, 0, nextPlan, { ...f.options, signal: cancel.signal });
    const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' }); await flush();
    const held = f.worker.sent.at(-1)!, duringCancellation = f.ledger.usage;
    let joined = false; void cancelled.then(() => { joined = true; }, () => { joined = true; });
    cancel.abort(); await flush();
    expect(joined).toBe(false); expect(f.ledger.usage).toEqual(duringCancellation);
    expect(f.worker.sent.at(-1)).toMatchObject({ type: 'cancel', requestId: held.requestId, base: held.base });
    expect(f.memory.covers(retained)).toBe(true); expect(retained.bytes).toBe(1024);
    f.worker.respond(held, { type: 'error', error: 'Scene export cancelled', cancelled: true, cleanupFailed: false, summary: state(1024) }); await rejected;
    expect(f.ledger.usage).toMatchObject({ bytes: beforeRefusal.bytes, allocations: beforeRefusal.allocations });
    expect(resourceLeaseCredit(retained)).toBe(retainedCredit); expect(f.ledger.owns(retained)).toBe(true); expect(retained.bytes).toBe(1024);
    const third = f.transport.exportOwned(firstFormat, 0, nextPlan, f.options); await flush();
    expect(f.memory.covers(retained)).toBe(true); expect(retained.bytes).toBe(1024);
    f.worker.respond(f.worker.sent.at(-1)!, { type: 'output', bytes: new Uint8Array([11, 13, 17]).buffer, summary: state(768) });
    const finalOutput = await third; expect([...new Uint8Array(finalOutput.bytes)]).toEqual([11, 13, 17]);
    expect(resourceLeaseCredit(retained)).toBe(retainedCredit); expect(retained.bytes).toBe(768); expect(f.memory.state.coveredBytes).toBe(768);
    expect(f.client.revision).toEqual(f.revision); expect(f.worker.terminated).toBe(0);
    expect(f.native.filter(lease => f.ledger.owns(lease))).toEqual([retained]);
    expect(f.outputs.filter(lease => f.ledger.owns(lease)).map(lease => lease.bytes)).toEqual([4, 10, 6]);
    await f.client.retireNativeMemory(); expect(f.worker.terminated).toBe(1); expect(f.ledger.owns(retained)).toBe(false);
    expect(f.ledger.usage.bytes).toBe(20); firstOutput.dispose(); secondOutput.dispose(); finalOutput.dispose(); expect(f.ledger.usage.bytes).toBe(0);
  });

  it.each([5, 6, 7] as const)('keeps independently authenticated format %s scope plans when concurrent callers queue both before either encoder', async format => {
    const f = await accountingFixture(format);
    const encode = async (scope: number) => {
      const plan = await f.transport.sceneExportPlan(format, scope);
      return f.transport.exportOwned(format, scope, plan, f.options);
    };
    const first = encode(1), second = encode(2); await flush();
    const firstPlan = f.worker.sent[0]; expect(firstPlan).toMatchObject({ type: 'scene-export-plan', format, scope: 1 });
    f.worker.respond(firstPlan, { type: 'scene-export-plan', plan: { ...f.scenePlan, scope: 1 }, summary: summary() }); await flush();
    const secondPlan = f.worker.sent.at(-1)!; expect(secondPlan).toMatchObject({ type: 'scene-export-plan', format, scope: 2 });
    f.worker.respond(secondPlan, { type: 'scene-export-plan', plan: { ...f.scenePlan, scope: 2 }, summary: summary() }); await flush();
    const firstExport = f.worker.sent.at(-1)!; expect(firstExport).toMatchObject({ type: 'export', command: { format, scope: 1 } });
    const terminal = { ...summary(), memoryBytes: 1040, exportBytes: 512, exportOutputBytes: 512 };
    f.worker.respond(firstExport, { type: 'output', bytes: new Uint8Array([1, 3, 5]).buffer, summary: terminal });
    const firstOutput = await first; expect([...new Uint8Array(firstOutput.bytes)]).toEqual([1, 3, 5]); firstOutput.dispose(); await flush();
    const secondExport = f.worker.sent.at(-1)!; expect(secondExport).toMatchObject({ type: 'export', command: { format, scope: 2 } });
    f.worker.respond(secondExport, { type: 'output', bytes: new Uint8Array([2, 4, 6]).buffer, summary: terminal });
    const secondOutput = await second; expect([...new Uint8Array(secondOutput.bytes)]).toEqual([2, 4, 6]); secondOutput.dispose();
    expect(f.worker.sent.map(request => request.type)).toEqual(['scene-export-plan', 'scene-export-plan', 'export', 'export']);
    expect(f.accepted).toHaveBeenCalledTimes(2); expect(f.client.revision).toEqual(f.revision);
    expect(f.worker.terminated).toBe(0); expect(f.ledger.usage.bytes).toBe(f.baseline);
    expect(f.native[1].bytes).toBe(512); expect(f.memory.state.coveredBytes).toBe(512);
  });

  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8] as const)('authenticates format %s and scope, owns transfer/Blob copies, and joins native retirement', async format => {
    const f = await accountingFixture(format, 2);
    const exporting = f.transport.exportOwned(format, 2, f.scenePlan, f.options); await flush();
    const request = f.worker.sent[0];
    expect(request).toMatchObject({ type: 'export', command: { command: 'export', format, scope: 2,
      outputCapacity: 512, nativeWorkBytes: 4 * MiB } });
    expect(f.accepted).toHaveBeenCalledOnce(); expect(f.native.map(lease => lease.bytes)).toEqual([4 * MiB, 0]);
    expect(f.outputs.map(lease => lease.bytes)).toEqual([1024]); expect(f.ledger.usage.bytes).toBe(f.baseline + 4 * MiB + 1024);
    const bytes = new Uint8Array([2, 3, 5, 7]).buffer;
    const terminal = { ...summary(), memoryBytes: 1040, exportBytes: 512, exportOutputBytes: 512 };
    f.worker.respond(request, { type: 'output', bytes, summary: terminal }, [bytes]); const owned = await exporting;
    expect(bytes.byteLength).toBe(0); expect([...new Uint8Array(owned.bytes)]).toEqual([2, 3, 5, 7]);
    expect(f.client.revision).toEqual(f.revision); expect(f.memory.state.coveredBytes).toBe(512);
    expect(f.outputs[0].bytes).toBe(8); expect(f.ledger.usage.bytes).toBe(f.baseline + 8);
    owned.retainBlob(); expect(f.outputs[0].bytes).toBe(4); expect(() => owned.bytes).toThrow();
    await f.client.retireNativeMemory(); expect(f.worker.terminated).toBe(1);
    // Browser output outlives the native module and is never retired with H.
    expect(f.ledger.usage.bytes).toBe(4); owned.dispose(); owned.dispose(); expect(f.ledger.usage.bytes).toBe(0);
  });

  it('copies an exact format/scope plan from the authenticated response rather than a caller object', async () => {
    const f = await fixture(), planning = f.transport.sceneExportPlan(5, 1); await flush();
    expect(f.worker.sent[0]).toMatchObject({ type: 'scene-export-plan', format: 5, scope: 1 });
    const plan: SceneExportPlan = { format: 5, scope: 1, count: 3, shDegree: 0, outputCapacity: 512, nativeWorkBytes: 4 * MiB };
    f.worker.respond(f.worker.sent[0], { type: 'scene-export-plan', plan, summary: summary() });
    const received = await planning; expect(received).toEqual(plan); expect(received).not.toBe(plan); expect(Object.isFrozen(received)).toBe(true);
    expect(f.worker.terminated).toBe(0); expect(f.client.revision).toEqual(f.revision);
  });

  it.each([{ requested: 6, substituted: 7 }, { requested: 7, substituted: 6 }] as const)(
    'refuses a format $substituted response for the authenticated format $requested plan request', async ({ requested, substituted }) => {
      const f = await fixture(), planning = f.transport.sceneExportPlan(requested, 1), rejected = expect(planning).rejects.toBeInstanceOf(Error); await flush();
      f.worker.respond(f.worker.sent[0], { type: 'scene-export-plan', plan: { format: substituted, scope: 1,
        count: 3, shDegree: 0, outputCapacity: 512, nativeWorkBytes: 4 * MiB }, summary: summary() });
      await rejected; expect(f.worker.sent.some(request => request.type === 'export')).toBe(false); expect(f.client.revision).toEqual(f.revision);
    });

  it.each(['format', 'scope', 'count', 'degree', 'capacity', 'work', 'extra'] as const)('refuses a substituted or malformed general plan %s before granting authority', async fault => {
    const f = await fixture(), planning = f.transport.sceneExportPlan(5, 1), rejected = expect(planning).rejects.toBeInstanceOf(Error); await flush();
    const plan: Record<string, unknown> = { format: 5, scope: 1, count: 3, shDegree: 0, outputCapacity: 512, nativeWorkBytes: 4 * MiB };
    if (fault === 'format') plan.format = 0;
    else if (fault === 'scope') plan.scope = 2;
    else if (fault === 'count') plan.count = 4;
    else if (fault === 'degree') plan.shDegree = 1;
    else if (fault === 'capacity') plan.outputCapacity = 0x8000_0000;
    else if (fault === 'work') plan.nativeWorkBytes = 0x1_0000_0000;
    else plan.extra = 1;
    f.worker.respond(f.worker.sent[0], { type: 'scene-export-plan', plan, summary: summary() }); await rejected;
    expect(f.worker.sent.some(request => request.type === 'export')).toBe(false); expect(f.client.revision).toEqual(f.revision);
  });

  it.each([1, 5, 6, 7, 8])('does not accept a legacy SPZ4 plan response for general format %s', async format => {
    const f = await fixture(), planning = f.transport.sceneExportPlan(format, 0), rejected = expect(planning).rejects.toBeInstanceOf(Error); await flush();
    f.worker.respond(f.worker.sent[0], { type: 'export-plan', plan: { count: 3, shDegree: 0, outputCapacity: 512, nativeWorkBytes: 4 * MiB }, summary: summary() });
    await rejected; expect(f.client.revision).toEqual(f.revision);
  });

  it('does not let a six-field SPZ3 response publish legacy SPZ4 plan authority', async () => {
    const f = await fixture(), planning = f.transport.exportPlan(), rejected = expect(planning).rejects.toBeInstanceOf(Error); await flush();
    f.worker.respond(f.worker.sent[0], { type: 'scene-export-plan', plan: { format: 1, scope: 0,
      count: 3, shDegree: 0, outputCapacity: 512, nativeWorkBytes: 4 * MiB }, summary: summary() });
    await rejected; expect(f.client.revision).toEqual(f.revision); expect(f.worker.sent.some(request => request.type === 'export')).toBe(false);
  });

  it.each(['invented', 'format', 'scope', 'revision'] as const)('rejects %s plan authority before admissions or acceptance', async fault => {
    const f = await accountingFixture(5, 1);
    let plan = f.scenePlan;
    if (fault === 'invented') plan = { ...plan, outputCapacity: 513 };
    else if (fault === 'format') plan = { ...plan, format: 0 };
    else if (fault === 'scope') plan = { ...plan, scope: 2 };
    else f.client.revision.contentRevision++;
    await expect(f.transport.exportOwned(plan.format, plan.scope, plan, f.options)).rejects.toBeInstanceOf(Error);
    expect(f.accepted).not.toHaveBeenCalled(); expect(f.native).toHaveLength(0); expect(f.outputs).toHaveLength(0);
    expect(f.worker.sent).toHaveLength(0); expect(f.ledger.usage.bytes).toBe(f.baseline);
  });

  it.each(['format', 'scope'] as const)('refuses caller %s arguments that do not match the received plan', async fault => {
    const f = await accountingFixture(5, 1);
    await expect(f.transport.exportOwned(fault === 'format' ? 0 : 5, fault === 'scope' ? 2 : 1, f.scenePlan, f.options)).rejects.toBeInstanceOf(Error);
    expect(f.accepted).not.toHaveBeenCalled(); expect(f.native).toHaveLength(0); expect(f.outputs).toHaveLength(0); expect(f.worker.sent).toHaveLength(0);
  });

  it('retains all admitted generic credits until a cancelled terminal joins, then preserves the charged module and queue', async () => {
    const f = await accountingFixture(5), exporting = f.transport.exportOwned(5, 0, f.scenePlan, f.options);
    const rejected = expect(exporting).rejects.toMatchObject({ name: 'AbortError' }); await flush();
    const request = f.worker.sent[0], admitted = f.ledger.usage.bytes;
    let joined = false; void exporting.then(() => { joined = true; }, () => { joined = true; });
    f.cancel.abort(); const next = f.client.command({ command: 'summary' }); await flush();
    expect(joined).toBe(false); expect(f.ledger.usage.bytes).toBe(admitted); expect(f.worker.sent).toHaveLength(2);
    expect(f.worker.sent[1]).toMatchObject({ type: 'cancel', requestId: request.requestId, base: request.base });
    f.worker.respond(request, { type: 'error', error: 'Export cancelled', cancelled: true, cleanupFailed: false, summary: summary() }); await rejected; await flush();
    expect(f.ledger.usage.bytes).toBe(f.baseline); expect(f.memory.state.retired).toBe(false); expect(f.worker.terminated).toBe(0);
    const successor = f.worker.sent.at(-1)!; expect(successor.type).toBe('command'); expect(successor.requestId).toBeGreaterThan(request.requestId);
    f.worker.respond(successor, { type: 'result', summary: summary() }); await next; expect(f.client.revision).toEqual(f.revision);
  });

  it.each(['output-bound', 'native-retention', 'family'] as const)('retires a generic worker whose terminal violates %s ownership', async fault => {
    const f = await accountingFixture(0), exporting = f.transport.exportOwned(0, 0, f.scenePlan, f.options);
    const rejected = expect(exporting).rejects.toBeInstanceOf(Error); await flush();
    const terminal = { ...summary(), memoryBytes: 1040, exportBytes: 512, exportOutputBytes: fault === 'native-retention' ? 511 : 512 };
    if (fault === 'family') f.worker.respond(f.worker.sent[0], { type: 'result', summary: terminal });
    else f.worker.respond(f.worker.sent[0], { type: 'output', bytes: new ArrayBuffer(fault === 'output-bound' ? 513 : 4), summary: terminal });
    await rejected; expect(f.worker.terminated).toBe(1); expect(f.outputs.every(lease => !f.ledger.owns(lease))).toBe(true);
    await f.client.retireNativeMemory(); expect(f.ledger.usage.bytes).toBe(0);
  });
});
