import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppController } from '../src/app/controller';
import { setApp, useApp } from '../src/app/store';
import type { CoreClient } from '../src/document/coreClient';
import { NativeHeapAccounting, type NativeCoverageUpdate } from '../src/document/nativeMemory';
import { AdmissionError, MiB, ResourceLedger, type ResourceLease } from '../src/document/resources';
import type { SceneExportOptions, SceneExportPlan } from '../src/document/spz4Export';
import type { NativeAllocationSnapshot, NativeSummary, Revision, SceneCommand } from '../src/document/types';

// These tests use no native module or renderer. Real ledger/accounting owners
// isolate controller consent, cancellation, late publication and download life.
type ExportController = AppController & {
  acceptedExportFormat: number;
  exportScene(format?: number, scope?: number, accepted?: (format: number) => void): Promise<void>;
};
type Internals = { ledger: ResourceLedger; releaseScene?: ResourceLease; releaseHistory?: ResourceLease;
  sourceMemory?: NativeHeapAccounting; floorCleanup: Promise<void>; pendingTolerancePicks: Set<Promise<unknown>>;
  intake?: { cancel: AbortController };
  bindNativeCoverage(client: CoreClient, scene: ResourceLease, history?: ResourceLease): unknown;
  cancelSelectionGesture(): Promise<boolean>; settleColorSession(): Promise<boolean>;
  outputReceipt?: { documentId: string; contentRevision: number; scope: number } };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const initial = useApp.getState();
function summary(contentRevision = 1): NativeSummary {
  return { ok: true, duplicateRange: null, loaded: true, kind: 0, count: 3, sourceCount: 3, selected: 1, visible: 3, shDegree: 0, format: 'PLY',
    canUndo: true, canRedo: true, revision: 2, contentRevision, transaction: false, selectionDraft: false,
    sceneChanged: false, pending: false, progress: 1, floor: null, filter: null, transformSession: null, opacitySession: null, center: [0, 0, 0], radius: 1, yUp: false,
    camera: [0, 0, 0, 0, 0, 3, 1, 45, 0, 0, 1], memoryBytes: 432 + 96,
    selectionMapId: null, pendingSelectionMapId: null, selectionMapBytes: 0, selectionMapRetainedIds: [] };
}
class ExportClient {
  readonly revision: Revision = { documentId: 'owned-export', sourceGeneration: 1, contentRevision: 1, selectionRevision: 2, draftRevision: 0 };
  onProgress?: (stage: string, fraction: number) => void;
  onNativeMemoryChanged?: () => void;
  current = summary();
  readonly encoded = deferred<ArrayBuffer>();
  plan: SceneExportPlan = { format: 0, scope: 0, count: 3, shDegree: 0, outputCapacity: 512, nativeWorkBytes: 4 * MiB };
  planDelivery?: Promise<SceneExportPlan>;
  planSignal?: AbortSignal;
  signal?: AbortSignal;
  private retainedNativeOutput?: ResourceLease;
  readonly dispose = vi.fn();
  readonly encodingStarted = vi.fn();
  readonly sceneExportPlan = vi.fn(async (format: SceneExportPlan['format'], scope: number, signal?: AbortSignal) => {
    this.planSignal = signal;
    return { ...(await (this.planDelivery ?? this.plan)), format, scope };
  });
  readonly exportPlan = vi.fn();
  readonly exportSpz4 = vi.fn();
  readonly export = vi.fn(async (_format: number, _scope: number, signal?: AbortSignal) => { this.signal = signal; return this.encoded.promise; });
  readonly exportOwned = vi.fn(async (format: number, scope: number, plan: SceneExportPlan, options: SceneExportOptions) => {
    expect(plan).toMatchObject({ format, scope });
    this.signal = options.signal;
    let native: ResourceLease | undefined, output: ResourceLease | undefined, retained = false;
    try {
      options.current(); native = options.admitNative(plan.nativeWorkBytes);
      this.nativeMemory.updateCoverage([{ lease: native, nextLeaseBytes: native.bytes, nativeBytes: 0 }]);
      output = options.admitOutput(2 * plan.outputCapacity); options.current(); options.onAccepted();
      this.encodingStarted();
      // Abort starts cleanup, but this deliberately held mock terminal still
      // owns native/output credits until the acknowledgement actually joins.
      const encoded = await this.encoded.promise;
      this.nativeMemory.updateCoverage([{ lease: native, nextLeaseBytes: plan.outputCapacity, nativeBytes: plan.outputCapacity }]);
      this.retainedNativeOutput = native; native = undefined;
      output.resize(2 * encoded.byteLength); const owner = output; output = undefined; retained = true;
      let disposed = false, blob = false;
      return { bytes: encoded,
        retainBlob() { if (!disposed && !blob) { blob = true; owner.resize(encoded.byteLength); } },
        dispose() { if (!disposed) { disposed = true; owner(); } } };
    } finally {
      output?.(); if (native) this.releaseNativeCoverage(native);
      if (!retained) this.signal = options.signal;
    }
  });
  readonly cancel = vi.fn();
  readonly command = vi.fn(async (_request: SceneCommand) => this.current);
  readonly retireNativeMemory = vi.fn(async () => { this.nativeMemory.retire(); this.retainedNativeOutput?.(); this.retainedNativeOutput = undefined; });
  constructor(readonly nativeMemory: NativeHeapAccounting) {}
  get nativeContentRevision() { return this.current.contentRevision; }
  setNativeCoveragePlanner(_planner: (value: NativeAllocationSnapshot) => readonly NativeCoverageUpdate[]) {}
  updateNativeCoverage(updates: readonly NativeCoverageUpdate[]) { this.nativeMemory.updateCoverage(updates); }
  transferNativeCoverage(updates: readonly NativeCoverageUpdate[]) { this.nativeMemory.transferCoverage(updates, this.current.memoryBytes); }
  releaseNativeCoverage(lease: ResourceLease) { if (this.nativeMemory.covers(lease)) this.nativeMemory.releaseCovered(lease); else lease(); }
  setNativeWork(lease?: ResourceLease) { if (lease) expect(this.nativeMemory.covers(lease)).toBe(true); }
  assertNativeAdmission() { if (this.nativeMemory.state.ledgerOverageBytes) throw new AdmissionError('Retained export budget'); }
}
let browserWindow: EventTarget, anchors: { click: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn>; href: string; download: string }[];
let createUrl: ReturnType<typeof vi.fn<(value: Blob | MediaSource) => string>>,
  revokeUrl: ReturnType<typeof vi.fn<(value: string) => void>>;
beforeEach(() => {
  browserWindow = new EventTarget(); anchors = [];
  vi.stubGlobal('window', browserWindow);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('document', { hidden: true, title: '', body: { append: vi.fn() }, createElement: () => {
    const anchor = { click: vi.fn(), remove: vi.fn(), href: '', download: '' }; anchors.push(anchor); return anchor;
  } });
  createUrl = vi.fn<(value: Blob | MediaSource) => string>(() => 'blob:owned-export'); revokeUrl = vi.fn<(value: string) => void>();
  vi.spyOn(URL, 'createObjectURL').mockImplementation(value => createUrl(value) as string);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(value => { revokeUrl(value); });
  setApp({ ...initial, ready: true, rendererState: 'ready', busy: false, error: null, dirty: true,
    selectionRecovery: 'idle', memoryOverageBytes: 0, navigationPrompt: false, outputPending: false, exportOpen: true }, true);
});
afterEach(async () => {
  browserWindow.dispatchEvent(new Event('pagehide')); await flush();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); setApp(initial, true);
});
function fixture(limit = 64 * MiB) {
  const controller = new AppController() as ExportController, owned = controller as unknown as Internals,
    ledger = new ResourceLedger(limit), remainder = ledger.reserve('source', MiB), memory = new NativeHeapAccounting(ledger, remainder);
  memory.observe({ sequence: 1, heapBytes: MiB });
  const sceneLease = ledger.reserve('decoded', 4096), history = ledger.reserve('history', 96);
  memory.updateCoverage([{ lease: sceneLease, nextLeaseBytes: sceneLease.bytes, nativeBytes: 432 },
    { lease: history, nextLeaseBytes: history.bytes, nativeBytes: 96 }]); memory.activate();
  const client = new ExportClient(memory), core = client as unknown as CoreClient;
  owned.ledger = ledger; owned.releaseScene = sceneLease; owned.releaseHistory = history; owned.sourceMemory = memory;
  controller.client = core; owned.bindNativeCoverage(core, sceneLease, history);
  const scene = { kind: 'gaussian', setDuplicateRange: vi.fn(), dispose: vi.fn(async () => {}) },
    renderer = { lost: false, dispose: vi.fn(), setHistogramEnabled: vi.fn(), resetHistogram: vi.fn(),
      device: { queue: { onSubmittedWorkDone: vi.fn(async () => {}) } } },
    camera = { clearInput: vi.fn(), dispose: vi.fn() };
  controller.scene = scene as unknown as NonNullable<AppController['scene']>;
  controller.renderer = renderer as unknown as NonNullable<AppController['renderer']>;
  controller.camera = camera as unknown as NonNullable<AppController['camera']>;
  vi.spyOn(owned, 'cancelSelectionGesture').mockResolvedValue(true);
  vi.spyOn(owned, 'settleColorSession').mockResolvedValue(true);
  setApp({ summary: client.current, sourceName: 'kept.ply' });
  return { controller, owned, ledger, memory, client, core, scene, renderer, camera, baseline: ledger.usage.bytes };
}
const bytes = () => new Uint8Array([4, 3, 2, 1]).buffer;
const admittedFormats = [
  { format: 0, extension: 'ply' }, { format: 1, extension: 'spz' }, { format: 2, extension: 'splat' },
  { format: 3, extension: 'compressed.ply' }, { format: 4, extension: 'ksplat' },
  { format: 5, extension: 'csv' }, { format: 6, extension: 'sog' }, { format: 7, extension: 'sogs' }, { format: 8, extension: 'spz' },
] as const;

describe('owned export controller lifetime', () => {
  it.each([[9, 0], [1.5, 0], [8, 3], [8, NaN]])('refuses invalid format/scope %s/%s before settlement, encode or accepted choice changes', async (format, scope) => {
    const f = fixture(), accepted = vi.fn(), alignment = vi.spyOn(f.controller, 'cancelAlignment');
    await f.controller.exportScene(format, scope, accepted);
    expect(alignment).not.toHaveBeenCalled(); expect(f.owned.cancelSelectionGesture).not.toHaveBeenCalled();
    expect(f.owned.settleColorSession).not.toHaveBeenCalled(); expect(f.client.sceneExportPlan).not.toHaveBeenCalled();
    expect(f.client.encodingStarted).not.toHaveBeenCalled(); expect(accepted).not.toHaveBeenCalled();
    expect(f.controller.acceptedExportFormat).toBe(0); expect(createUrl).not.toHaveBeenCalled(); expect(f.ledger.usage.bytes).toBe(f.baseline);
  });

  describe.each(admittedFormats)('format $format ($extension)', ({ format, extension }) => {
  it.each(['floor', 'selection', 'color', 'plan'] as const)('cancels held %s preflight without dispatching an encoder or publishing a download', async phase => {
    const f = fixture(), held = deferred<void>();
    if (phase === 'floor') f.owned.floorCleanup = held.promise;
    else if (phase === 'selection') vi.mocked(f.owned.cancelSelectionGesture).mockImplementation(async () => { await held.promise; return true; });
    else if (phase === 'color') vi.mocked(f.owned.settleColorSession).mockImplementation(async () => { await held.promise; return true; });
    else f.client.planDelivery = held.promise.then(() => f.client.plan);
    let finished = false; const exporting = f.controller.exportScene(format).then(() => { finished = true; });
    await flush(); f.controller.cancelOperation(); await flush();
    expect(finished).toBe(false); expect(f.client.exportOwned).not.toHaveBeenCalled();
    if (phase === 'plan') expect(f.client.planSignal?.aborted).toBe(true);
    held.resolve(); await exporting;
    expect(f.client.exportOwned).not.toHaveBeenCalled(); expect(createUrl).not.toHaveBeenCalled();
    expect(useApp.getState()).toMatchObject({ busy: false, outputPending: false, dirty: true, error: null });
    expect(f.controller.scene).toBe(f.scene); expect(f.ledger.usage.bytes).toBe(f.baseline);
  });

  it('rejects a replaced client after selection preflight before admitting output or encoding', async () => {
    const f = fixture(), held = deferred<boolean>();
    vi.mocked(f.owned.cancelSelectionGesture).mockReturnValue(held.promise);
    const exporting = f.controller.exportScene(format); await flush();
    f.controller.client = { revision: { ...f.client.revision, documentId: 'replacement' } } as unknown as CoreClient;
    held.resolve(true); await exporting;
    expect(f.client.sceneExportPlan).not.toHaveBeenCalled(); expect(f.client.exportOwned).not.toHaveBeenCalled();
    expect(createUrl).not.toHaveBeenCalled(); expect(f.ledger.usage.bytes).toBe(f.baseline);
  });

  it('joins a cancelled encoder terminal before retiring its credits and silently preserves the old output receipt and Redo', async () => {
    const f = fixture(), oldReceipt = { documentId: 'owned-export', contentRevision: 1, scope: 0 };
    f.owned.outputReceipt = oldReceipt;
    let finished = false; const exporting = f.controller.exportScene(format).then(() => { finished = true; });
    await flush(); expect(f.client.exportOwned).toHaveBeenCalledOnce(); expect(f.client.signal).toBeInstanceOf(AbortSignal);
    expect(f.client.sceneExportPlan).toHaveBeenCalledExactlyOnceWith(format, 0, f.client.signal);
    expect(f.client.exportPlan).not.toHaveBeenCalled(); expect(f.client.exportSpz4).not.toHaveBeenCalled(); expect(f.client.export).not.toHaveBeenCalled();
    const admitted = f.ledger.usage.bytes; expect(admitted).toBeGreaterThan(f.baseline);
    f.controller.cancelOperation(); await flush();
    expect(f.client.signal!.aborted).toBe(true); expect(finished).toBe(false); expect(f.ledger.usage.bytes).toBe(admitted);
    f.client.encoded.reject(new DOMException('Export cancelled', 'AbortError')); await exporting;
    expect(createUrl).not.toHaveBeenCalled(); expect(f.owned.outputReceipt).toBe(oldReceipt);
    expect(useApp.getState()).toMatchObject({ dirty: true, error: null, summary: { canRedo: true, contentRevision: 1 } });
    expect(f.controller.client).toBe(f.core); expect(f.controller.scene).toBe(f.scene); expect(f.ledger.usage.bytes).toBe(f.baseline);
  });

  it('cancels the active Save export before a separately retained dirty-navigation intake', async () => {
    const f = fixture(), exporting = f.controller.exportScene(format); await flush();
    const intake = { cancel: new AbortController() }; f.owned.intake = intake;
    f.controller.cancelOperation(); expect(f.client.signal!.aborted).toBe(true); expect(intake.cancel.signal.aborted).toBe(false);
    f.owned.intake = undefined;
    f.client.encoded.reject(new DOMException('Export cancelled', 'AbortError')); await exporting;
    expect(createUrl).not.toHaveBeenCalled(); expect(useApp.getState()).toMatchObject({ dirty: true, error: null });
  });

  it.each(['cancel', 'client', 'content', 'selection', 'scene'] as const)('does not download a late successful buffer after %s invalidates its export owner', async boundary => {
    const f = fixture(), oldReceipt = { documentId: 'owned-export', contentRevision: 1, scope: 0 }; f.owned.outputReceipt = oldReceipt;
    const exporting = f.controller.exportScene(format); await flush(); expect(f.client.exportOwned).toHaveBeenCalledOnce();
    if (boundary === 'cancel') f.controller.cancelOperation();
    else if (boundary === 'client') f.controller.client = { revision: { ...f.client.revision, documentId: 'new-owner' } } as unknown as CoreClient;
    else if (boundary === 'content') { f.client.revision.contentRevision++; setApp({ summary: summary(2) }); }
    else if (boundary === 'selection') setApp({ summary: { ...f.client.current, revision: 3 } });
    else f.controller.scene = { ...f.scene } as unknown as NonNullable<AppController['scene']>;
    f.client.encoded.resolve(bytes()); await exporting;
    expect(createUrl).not.toHaveBeenCalled(); expect(anchors).toHaveLength(0); expect(useApp.getState().outputPending).toBe(false);
    expect(f.owned.outputReceipt).toBe(oldReceipt); expect(useApp.getState()).toMatchObject({ dirty: true, error: null, summary: { canRedo: true } });
    expect(f.ledger.usage.bytes).toBe(f.baseline);
  });

  it('captures the committed revision after legitimate color settlement and remembers the admitted choice even if encoding fails', async () => {
    const f = fixture(), accepted = vi.fn();
    vi.mocked(f.owned.settleColorSession).mockImplementation(async () => {
      f.client.current = summary(2); f.client.revision.contentRevision = 2; setApp({ summary: f.client.current }); return true;
    });
    const exporting = f.controller.exportScene(format, 1, accepted); await flush();
    expect(f.client.exportOwned).toHaveBeenCalledOnce(); expect(accepted).toHaveBeenCalledExactlyOnceWith(format);
    expect(f.client.sceneExportPlan).toHaveBeenCalledExactlyOnceWith(format, 1, f.client.signal);
    expect(f.controller.acceptedExportFormat).toBe(format);
    f.client.encoded.reject(new Error('Independent encoder refusal')); await exporting;
    expect(f.controller.acceptedExportFormat).toBe(format); expect(useApp.getState()).toMatchObject({ error: 'Independent encoder refusal', dirty: true, summary: { contentRevision: 2, canRedo: true } });
    expect(createUrl).not.toHaveBeenCalled(); expect(f.ledger.usage.bytes).toBe(f.baseline);
  });

  it.each(['native', 'output'] as const)('retains the previous accepted format and receipt when %s admission refuses', async admission => {
    const f = fixture(), accepted = vi.fn(), previousFormat = format === 2 ? 0 : 2,
      oldReceipt = { documentId: 'owned-export', contentRevision: 1, scope: 0 };
    f.controller.acceptedExportFormat = previousFormat; f.owned.outputReceipt = oldReceipt;
    f.client.plan = { ...f.client.plan, nativeWorkBytes: admission === 'native' ? 64 * MiB : 32 * MiB,
      outputCapacity: admission === 'native' ? 512 : 32 * MiB };
    await f.controller.exportScene(format, 0, accepted);
    expect(f.client.encodingStarted).not.toHaveBeenCalled(); expect(accepted).not.toHaveBeenCalled();
    expect(f.controller.acceptedExportFormat).toBe(previousFormat); expect(f.owned.outputReceipt).toBe(oldReceipt); expect(createUrl).not.toHaveBeenCalled();
    expect(useApp.getState()).toMatchObject({ dirty: true, outputPending: false, summary: { canRedo: true, contentRevision: 1 } });
    expect(f.ledger.usage.bytes).toBe(f.baseline);
  });

  it.each([1, 2])('refuses an empty settled scope %s before acceptance or output admission', async scope => {
    const f = fixture(), accepted = vi.fn(); f.controller.acceptedExportFormat = 2;
    f.client.current = { ...f.client.current, selected: scope === 1 ? 0 : 3 }; setApp({ summary: f.client.current });
    await f.controller.exportScene(format, scope, accepted);
    expect(f.client.sceneExportPlan).not.toHaveBeenCalled(); expect(f.client.exportOwned).not.toHaveBeenCalled(); expect(accepted).not.toHaveBeenCalled();
    expect(f.controller.acceptedExportFormat).toBe(2); expect(createUrl).not.toHaveBeenCalled(); expect(f.ledger.usage.bytes).toBe(f.baseline);
  });

  it('revokes the created URL and releases output credits if constructing the download anchor fails', async () => {
    const f = fixture(), oldReceipt = { documentId: 'owned-export', contentRevision: 1, scope: 0 }; f.owned.outputReceipt = oldReceipt;
    vi.spyOn(document, 'createElement').mockImplementation(() => { throw new Error('Independent anchor refusal'); });
    const exporting = f.controller.exportScene(format); await flush(); f.client.encoded.resolve(bytes()); await exporting;
    expect(createUrl).toHaveBeenCalledOnce(); expect(revokeUrl).toHaveBeenCalledExactlyOnceWith('blob:owned-export');
    expect(anchors).toHaveLength(0); expect(f.owned.outputReceipt).toBe(oldReceipt); expect(f.ledger.usage.bytes).toBe(f.baseline);
    expect(useApp.getState()).toMatchObject({ dirty: true, outputPending: false, error: 'Independent anchor refusal', summary: { canRedo: true } });
  });

  it.each(['timer', 'pagehide'] as const)('keeps actual output and Blob credits until the %s download settlement', async settlement => {
    vi.useFakeTimers(); const f = fixture(), exporting = f.controller.exportScene(format, 0); await flush();
    f.client.encoded.resolve(bytes()); await exporting;
    expect(anchors).toHaveLength(1); expect(anchors[0].click).toHaveBeenCalledOnce(); expect(anchors[0].download).toBe(`kept-edited.${extension}`);
    expect(createUrl).toHaveBeenCalledOnce(); expect(useApp.getState()).toMatchObject({ outputPending: true, dirty: true });
    expect(f.ledger.usage.bytes).toBeGreaterThan(f.baseline); expect(revokeUrl).not.toHaveBeenCalled();
    expect(f.ledger.categorySnapshot.image.bytes).toBe(bytes().byteLength);
    expect(f.owned.outputReceipt).toEqual({ documentId: 'owned-export', contentRevision: 1, scope: 0 });
    expect(useApp.getState().summary).toMatchObject({ canRedo: true, contentRevision: 1 });
    if (settlement === 'timer') await vi.advanceTimersByTimeAsync(60_000);
    else { browserWindow.dispatchEvent(new Event('pagehide')); await flush(); }
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith('blob:owned-export'); expect(f.ledger.usage.bytes).toBe(f.baseline);
    browserWindow.dispatchEvent(new Event('pagehide')); await flush(); expect(revokeUrl).toHaveBeenCalledOnce();
  });

  it.each(['close', 'dispose'] as const)('joins a cancelled export finalizer before %s returns native/output credits', async boundary => {
    const f = fixture(); setApp({ dirty: false });
    const exporting = f.controller.exportScene(format); await flush(); expect(f.client.exportOwned).toHaveBeenCalledOnce();
    let closed = false;
    const closing = boundary === 'close' ? f.controller.closeScene().then(() => { closed = true; }) : undefined;
    if (boundary === 'dispose') f.controller.dispose();
    await flush(); expect(f.client.signal!.aborted).toBe(true); expect(f.client.retireNativeMemory).not.toHaveBeenCalled();
    expect(f.memory.state.retired).toBe(false); expect(f.ledger.usage.bytes).toBeGreaterThan(f.baseline); expect(closed).toBe(false);
    f.client.encoded.reject(new DOMException('Export cancelled', 'AbortError')); await exporting; await closing; await flush();
    expect(f.client.retireNativeMemory).toHaveBeenCalledOnce(); expect(f.ledger.usage.bytes).toBe(0);
    expect(createUrl).not.toHaveBeenCalled();
  });

  it.each([1, 2])('acknowledges scope %s without marking the complete dirty scene saved or changing Redo', async scope => {
    const f = fixture(), before = useApp.getState().summary, exporting = f.controller.exportScene(format, scope); await flush();
    expect(f.client.sceneExportPlan).toHaveBeenCalledExactlyOnceWith(format, scope, f.client.signal);
    f.client.encoded.resolve(bytes()); await exporting;
    expect(f.owned.outputReceipt).toEqual({ documentId: 'owned-export', contentRevision: 1, scope });
    expect(useApp.getState()).toMatchObject({ dirty: true, outputPending: true });
    f.controller.acknowledgeOutput();
    expect(f.owned.outputReceipt).toBeUndefined(); expect(useApp.getState()).toMatchObject({ dirty: true, outputPending: false });
    expect(useApp.getState().summary).toEqual(before); expect(f.client.command).not.toHaveBeenCalled();
    expect(f.ledger.categorySnapshot.image.bytes).toBe(4);
    browserWindow.dispatchEvent(new Event('pagehide')); await flush(); expect(f.ledger.usage.bytes).toBe(f.baseline);
  });

  it('retains the actual Blob payload and independent image credit while native memory retires', async () => {
    const f = fixture(), exporting = f.controller.exportScene(format); await flush();
    f.client.encoded.resolve(bytes()); await exporting;
    expect(createUrl).toHaveBeenCalledOnce(); const blob = createUrl.mock.calls[0][0]; expect(blob).toBeInstanceOf(Blob);
    expect(new Uint8Array(await (blob as Blob).arrayBuffer())).toEqual(new Uint8Array([4, 3, 2, 1]));
    expect(f.ledger.categorySnapshot.image).toEqual({ bytes: 4, allocations: 1 });
    const retainedSceneBytes = f.owned.releaseScene!.bytes + f.owned.releaseHistory!.bytes;
    await f.client.retireNativeMemory();
    expect(f.memory.state.retired).toBe(true); expect(f.ledger.categorySnapshot.source.bytes).toBe(0);
    expect(f.ledger.categorySnapshot.work.bytes).toBe(0); expect(f.ledger.categorySnapshot.image).toEqual({ bytes: 4, allocations: 1 });
    expect(f.ledger.usage.bytes).toBe(retainedSceneBytes + 4); expect(revokeUrl).not.toHaveBeenCalled();
    expect(new Uint8Array(await (blob as Blob).arrayBuffer())).toEqual(new Uint8Array([4, 3, 2, 1]));
    browserWindow.dispatchEvent(new Event('pagehide')); await flush();
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith('blob:owned-export'); expect(f.ledger.categorySnapshot.image.bytes).toBe(0);
    expect(f.ledger.usage.bytes).toBe(retainedSceneBytes);
    f.owned.releaseScene!(); f.owned.releaseHistory!(); expect(f.ledger.usage.bytes).toBe(0);
    expect(useApp.getState()).toMatchObject({ dirty: true, outputPending: true, summary: { canRedo: true, contentRevision: 1 } });
  });
  });

});
