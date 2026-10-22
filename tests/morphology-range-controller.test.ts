import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppController } from '../src/app/controller';
import { setApp, useApp } from '../src/app/store';
import { NativeHeapAccounting, WASM_PAGE_BYTES } from '../src/document/nativeMemory';
import { MORPHOLOGY_RANGE_WORK_BYTES } from '../src/document/morphologyMemory';
import { ResourceLedger, type ResourceLease } from '../src/document/resources';
import { NEUTRAL_COLOR, type NativeSummary, type Revision, type SceneCommand } from '../src/document/types';

const initial = useApp.getState(), range = { version: 1 as const, minimum: .125, maximum: 8, default: 1 };
const flush = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };
function gate() { let resolve!: () => void; return { promise: new Promise<void>(yes => { resolve = yes; }), resolve }; }
function summary(): NativeSummary {
  return { ok: true, duplicateRange: null, loaded: true, kind: 0, count: 3, sourceCount: 3, shDegree: 0, format: 'PLY', selected: 1, visible: 3,
    canUndo: true, canRedo: true, revision: 2, contentRevision: 1, transaction: false, selectionDraft: false,
    sceneChanged: false, pending: false, progress: 1, center: [0, 0, 0], radius: 1, yUp: false,
    camera: [0, 0, 0, 0, 0, 3, 1, 45, 0, 0, 1], memoryBytes: 528, exportBytes: 0, exportOutputBytes: 0,
    selectionMapId: null, pendingSelectionMapId: null, selectionMapBytes: 0, selectionMapRetainedIds: [],
    colorSession: null, transformSession: null, opacitySession: null, filter: null, floor: null, morphologyRange: null };
}
type Internal = {
  ledger: ResourceLedger; generation: number; editingFailed: boolean;
  bindNativeCoverage(client: unknown, scene: ResourceLease, history: ResourceLease): void;
  cancelMorphologyRange(): Promise<void>;
  closeToleranceSelection(): Promise<void>; settleColorSession(): Promise<boolean>;
  executeCommand(command: SceneCommand): Promise<boolean>;
  navigateCollection(owner: unknown, index: number): Promise<void>;
  collectionCleanup: Set<Promise<void>>;
};
const cleanups: (() => Promise<void>)[] = [];
function fixture(extraBudget = MORPHOLOGY_RANGE_WORK_BYTES + 4096) {
  const controller = new AppController(), internal = controller as unknown as Internal;
  const ledger = new ResourceLedger(WASM_PAGE_BYTES + 592 + extraBudget); internal.ledger = ledger;
  const remainder = ledger.reserve('source', WASM_PAGE_BYTES), memory = new NativeHeapAccounting(ledger, remainder);
  memory.observe({ sequence: 1, heapBytes: WASM_PAGE_BYTES }); memory.activate();
  const source = ledger.reserve('decoded', 1024), history = ledger.reserve('history', 96);
  memory.updateCoverage([{ lease: source, nextLeaseBytes: source.bytes, nativeBytes: 432 },
    { lease: history, nextLeaseBytes: history.bytes, nativeBytes: 96 }]);
  let work: ResourceLease | undefined, held: ReturnType<typeof gate> | undefined;
  let response: () => NativeSummary = () => ({ ...useApp.getState().summary!, morphologyRange: range });
  const trace: string[] = [];
  const revision: Revision = { documentId: 'range-document', sourceGeneration: 1, contentRevision: 1, selectionRevision: 2, draftRevision: 0 };
  const client = {
    revision, failed: false, nativeMemory: memory,
    assertNativeAdmission: vi.fn(() => { expect(memory.state.active).toBe(true); expect(ledger.overageBytes).toBe(0); }),
    updateNativeCoverage: vi.fn((updates: Parameters<NativeHeapAccounting['updateCoverage']>[0]) => memory.updateCoverage(updates)),
    setNativeCoveragePlanner: vi.fn(),
    setNativeWork: vi.fn((lease?: ResourceLease) => {
      if (lease) { expect(ledger.owns(lease, 'work')).toBe(true); expect(memory.covers(lease)).toBe(true); }
      work = lease;
    }),
    releaseNativeCoverage: vi.fn((lease: ResourceLease) => memory.releaseCovered(lease)),
    retireNativeMemory: vi.fn(async () => { memory.retire(); }),
    createOperation: vi.fn(), beginOperation: vi.fn(), commitOperation: vi.fn(), rollbackOperation: vi.fn(),
    command: vi.fn(async (command: SceneCommand, signal?: AbortSignal): Promise<NativeSummary> => {
      expect(command).toEqual({ command: 'morphologyRange' });
      const captured = work!;
      expect(captured.bytes).toBe(614400); expect(memory.covers(captured)).toBe(true);
      memory.updateCoverage([{ lease: captured, nextLeaseBytes: captured.bytes, nativeBytes: 640 }]);
      trace.push('started');
      try { if (held) await held.promise; signal?.throwIfAborted(); return response(); }
      finally {
        memory.updateCoverage([{ lease: captured, nextLeaseBytes: captured.bytes, nativeBytes: 0 }]);
        trace.push('terminal');
      }
    }),
  };
  const scene = { kind: 'gaussian', setDuplicateRange: vi.fn(), count: 3, allocationBytes: 100 };
  const camera = { revision: 1, state: summary().camera };
  controller.client = client as unknown as NonNullable<AppController['client']>;
  controller.scene = scene as unknown as NonNullable<AppController['scene']>;
  controller.camera = camera as unknown as NonNullable<AppController['camera']>;
  controller.renderer = { lost: false } as NonNullable<AppController['renderer']>;
  internal.bindNativeCoverage(client, source, history);
  const before = ledger.usage.bytes;
  cleanups.push(async () => { held?.resolve(); await internal.cancelMorphologyRange(); memory.retire(); source(); history(); expect(ledger.usage.bytes).toBe(0); });
  return { controller, internal, ledger, memory, client, source, history, camera, scene, before, trace,
    hold() { held = gate(); return held; }, respond(next: () => NativeSummary) { response = next; } };
}
beforeEach(() => {
  vi.stubGlobal('document', { hidden: true, title: '' });
  setApp({ ...initial, ready: true, busy: false, summary: summary(), mode: 'basic', dirty: true, rendererState: 'ready',
    selectionMorphologyMethod: 'volume', selectionDistance: null, selectionDragging: false, pendingSelectionCount: 0,
    grade: [...NEUTRAL_COLOR], appliedGrade: [...NEUTRAL_COLOR], colorSession: null, colorSelectedOnly: false,
    currentViewOnly: true, settingsOpen: false, exportOpen: false, outputPending: false, navigationPrompt: false,
    savedViewChoices: [], selectionRecovery: 'idle', operationRecovery: 'idle' }, true);
});
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); setApp(initial, true); });

describe('native morphology metrics query ownership', () => {
  it.each(['success', 'failure'] as const)('preserves operation errors while an automatic query waits, then handles its own %s', async outcome => {
    const f = fixture(), held = f.hold(), before = structuredClone(useApp.getState().summary);
    setApp({ error: 'Retained polygon refusal' });
    if (outcome === 'failure') f.respond(() => { throw new Error('Selection reach query refused'); });
    const pending = f.controller.ensureSelectionMorphologyRange();
    expect(useApp.getState().error).toBe('Retained polygon refusal');
    expect(useApp.getState().busy).toBe(true);
    await flush();
    expect(f.trace).toEqual(['started']);
    expect(useApp.getState().error).toBe('Retained polygon refusal');
    // A success must also preserve an error published after query admission.
    setApp({ error: 'Newer operation refusal' });
    held.resolve();
    expect(await pending).toBe(outcome === 'success');
    expect(useApp.getState().error).toBe(outcome === 'success' ? 'Newer operation refusal' : 'Selection reach query refused');
    expect(useApp.getState().summary).toEqual(outcome === 'success' ? { ...before, morphologyRange: range } : before);
    expect(useApp.getState().busy).toBe(false);
    expect(useApp.getState().dirty).toBe(true);
    expect(f.client.command).toHaveBeenCalledOnce();
    expect(f.client.createOperation).not.toHaveBeenCalled();
    expect(f.client.beginOperation).not.toHaveBeenCalled();
    expect(f.client.commitOperation).not.toHaveBeenCalled();
    expect(f.client.rollbackOperation).not.toHaveBeenCalled();
    expect(f.ledger.usage.bytes).toBe(f.before);
    expect(f.ledger.categorySnapshot.work).toEqual({ bytes: 0, allocations: 0 });
    expect(f.memory.covers(f.source)).toBe(true); expect(f.memory.covers(f.history)).toBe(true);
  });
  it('admits one genuine small readonly owner, publishes only metadata, and reuses its scene cache in tutorial Basic mode', async () => {
    const f = fixture(), before = structuredClone(useApp.getState().summary);
    expect(await f.controller.ensureSelectionMorphologyRange()).toBe(true);
    expect(useApp.getState().summary).toEqual({ ...before, morphologyRange: range });
    expect(useApp.getState().dirty).toBe(true); expect(useApp.getState().mode).toBe('basic');
    expect(f.controller.selectionMorphologyRange).toEqual({ minimum: .125, maximum: 8, value: 1 });
    expect(f.controller.selectionMorphologyVolumeEnabled).toBe(true);
    expect(f.client.createOperation).not.toHaveBeenCalled(); expect(f.client.beginOperation).not.toHaveBeenCalled();
    expect(f.client.commitOperation).not.toHaveBeenCalled(); expect(f.client.rollbackOperation).not.toHaveBeenCalled();
    expect(f.ledger.usage.bytes).toBe(f.before); expect(f.ledger.categorySnapshot.work).toEqual({ bytes: 0, allocations: 0 });
    expect(f.memory.covers(f.source)).toBe(true); expect(f.memory.covers(f.history)).toBe(true);
    expect(await f.controller.ensureSelectionMorphologyRange()).toBe(true); expect(f.client.command).toHaveBeenCalledOnce();
  });
  it('deduplicates a held query and ignores camera/view changes while preserving exact retained color ownership', async () => {
    const color = { version: 1 as const, active: true as const, sessionId: 1, baseId: 2, epochId: 3, selectedOnly: true,
      pending: false, values: [...NEUTRAL_COLOR], applied: [...NEUTRAL_COLOR] };
    setApp({ summary: { ...summary(), colorSession: color }, colorSession: color });
    const f = fixture(), held = f.hold(), pending = f.controller.ensureSelectionMorphologyRange(); await flush();
    expect(f.controller.ensureSelectionMorphologyRange()).toBe(pending);
    expect(f.ledger.categorySnapshot.work).toEqual({ bytes: 614400, allocations: 1 });
    expect(f.memory.state.coveredBytes).toBe(528 + 640);
    f.camera.state[0] = 99; f.camera.revision++; setApp({ currentViewOnly: false }); held.resolve();
    expect(await pending).toBe(true); expect(useApp.getState().summary?.colorSession).toEqual(color);
    expect(useApp.getState().colorSession).toBe(color); expect(f.client.command).toHaveBeenCalledOnce();
  });
  it('holds authentic workspace and the busy fence through cancellation until the native terminal is joined', async () => {
    const f = fixture(), held = f.hold(), before = structuredClone(useApp.getState().summary);
    const pending = f.controller.ensureSelectionMorphologyRange(); await flush();
    let joined = false; const cancellation = f.internal.cancelMorphologyRange().then(() => { joined = true; }); await flush();
    expect(joined).toBe(false); expect(useApp.getState().busy).toBe(true);
    expect(f.ledger.categorySnapshot.work.bytes).toBe(614400); expect(f.memory.state.coveredBytes).toBe(1168);
    held.resolve(); expect(await pending).toBe(false); await cancellation;
    expect(joined).toBe(true); expect(f.trace).toEqual(['started', 'terminal']);
    expect(useApp.getState().summary).toEqual(before); expect(useApp.getState().error).toBeNull();
    expect(useApp.getState().dirty).toBe(true); expect(useApp.getState().busy).toBe(false);
    expect(f.ledger.usage.bytes).toBe(f.before); expect(f.memory.state.coveredBytes).toBe(528);
  });
  it('joins cancelled metrics before dispatching another document action', async () => {
    const f = fixture(), held = f.hold();
    vi.spyOn(f.internal, 'closeToleranceSelection').mockResolvedValue();
    vi.spyOn(f.internal, 'settleColorSession').mockResolvedValue(true);
    vi.spyOn(f.controller, 'cancelSelectionGesture').mockResolvedValue(true);
    const execute = vi.spyOn(f.internal, 'executeCommand').mockImplementation(async () => {
      expect(f.ledger.categorySnapshot.work.bytes).toBe(0); f.trace.push('edit'); return true;
    });
    const pending = f.controller.ensureSelectionMorphologyRange(); await flush();
    const action = f.controller.command({ command: 'selectAll' }); await flush(); expect(execute).not.toHaveBeenCalled();
    held.resolve(); expect(await pending).toBe(false); expect(await action).toBe(true);
    expect(f.trace).toEqual(['started', 'terminal', 'edit']);
  });
  it('captures protected drop handles synchronously while a held metrics owner joins before directory enumeration', async () => {
    const f = fixture(MORPHOLOGY_RANGE_WORK_BYTES + 4 * WASM_PAGE_BYTES), held = f.hold();
    const pending = f.controller.ensureSelectionMorphologyRange(); await flush();
    let readable = true, batch = 0;
    const file = { name: 'next.ply', isFile: true, isDirectory: false,
      file: vi.fn((yes: (value: File) => void) => yes(new File(['unused native payload'], 'next.ply'))) };
    const reader = vi.fn((yes: (entries: unknown[]) => void) => {
      expect(f.trace).toEqual(['started', 'terminal']); expect(f.ledger.categorySnapshot.work.bytes).toBe(0);
      expect(f.memory.state.coveredBytes).toBe(528); yes(batch++ === 0 ? [file] : []);
    });
    const directory = { name: 'selected', isFile: false, isDirectory: true, createReader: vi.fn(() => ({ readEntries: reader })) };
    const capture = vi.fn(() => { expect(readable).toBe(true); return directory; });
    const transfer = { get items() { expect(readable).toBe(true); return [{ kind: 'file', webkitGetAsEntry: capture }]; } };
    const navigate = vi.spyOn(f.internal, 'navigateCollection').mockImplementation(async () => {
      expect(f.ledger.categorySnapshot.work.bytes).toBe(0); expect(f.memory.state.coveredBytes).toBe(528);
    });
    const snapshot = f.controller.snapshotDrop(transfer as unknown as DataTransfer);
    expect(snapshot).toBeDefined(); expect(capture).toHaveBeenCalledOnce();
    const opening = f.controller.openDrop(snapshot!); readable = false;
    expect(reader).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled();
    await flush(); expect(f.ledger.categorySnapshot.work.bytes).toBe(614400);
    expect(reader).not.toHaveBeenCalled(); held.resolve(); expect(await pending).toBe(false);
    await opening; await Promise.allSettled(f.internal.collectionCleanup);
    expect(reader).toHaveBeenCalledTimes(2); expect(navigate).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledOnce(); expect(file.file).not.toHaveBeenCalled();
    expect(f.ledger.usage.bytes).toBe(f.before);
  });
  it('refuses one byte below admission without dispatch or changing retained memory/history', async () => {
    const f = fixture(MORPHOLOGY_RANGE_WORK_BYTES - 1), before = structuredClone(useApp.getState().summary);
    expect(await f.controller.ensureSelectionMorphologyRange()).toBe(false);
    expect(f.client.command).not.toHaveBeenCalled(); expect(useApp.getState().summary).toEqual(before);
    expect(f.ledger.usage.bytes).toBe(f.before); expect(f.source.bytes).toBe(1024); expect(f.history.bytes).toBe(96);
    expect(f.memory.state.coveredBytes).toBe(528); expect(useApp.getState().error).toContain('budget');
  });
  it('does not retry a transient refusal from an effect, but an explicit Volume choice retries without dirty/history changes', async () => {
    const f = fixture(), before = structuredClone(useApp.getState().summary);
    f.respond(() => { throw new Error('Temporary metrics refusal'); });
    expect(await f.controller.ensureSelectionMorphologyRange()).toBe(false);
    expect(await f.controller.ensureSelectionMorphologyRange()).toBe(false);
    expect(f.client.command).toHaveBeenCalledOnce(); expect(f.controller.selectionMorphologyControlsEnabled).toBe(true);
    expect(f.controller.selectionMorphologyVolumeEnabled).toBe(false); expect(useApp.getState().summary).toEqual(before);
    f.respond(() => ({ ...summary(), morphologyRange: range }));
    f.controller.setSelectionMorphologyMethod('volume'); await flush();
    expect(f.client.command).toHaveBeenCalledTimes(2); expect(f.controller.selectionMorphologyVolumeEnabled).toBe(true);
    expect(useApp.getState().summary).toEqual({ ...before, morphologyRange: range }); expect(useApp.getState().dirty).toBe(true);
    expect(f.client.beginOperation).not.toHaveBeenCalled(); expect(f.ledger.usage.bytes).toBe(f.before);
  });
  it('uses the native default or a clamped effective reach without rewriting raw float preferences on source/range changes', () => {
    const f = fixture(); setApp({ summary: { ...summary(), morphologyRange: range } });
    expect(f.controller.selectionMorphologyRange?.value).toBe(1);
    const raw = Math.fround(123.123456789); f.controller.setSelectionDistance(raw);
    expect(useApp.getState().selectionDistance).toBe(raw); expect(f.controller.selectionMorphologyRange?.value).toBe(8);
    setApp({ summary: { ...summary(), morphologyRange: { version: 1, minimum: 100, maximum: 256, default: 128 } } });
    expect(f.controller.selectionMorphologyRange?.value).toBe(raw); expect(useApp.getState().selectionDistance).toBe(raw);
    for (const invalid of [0, -1, NaN, Infinity, 1e-100]) f.controller.setSelectionDistance(invalid);
    expect(useApp.getState().selectionDistance).toBe(raw);
    f.controller.setSelectionDistance(null); expect(useApp.getState().selectionDistance).toBeNull();
    expect(f.controller.selectionMorphologyRange?.value).toBe(128); expect(f.client.command).not.toHaveBeenCalled();
  });
  it.each(['scene', 'generation'] as const)('rejects a late reply after %s replacement without overwriting the new summary', async replacement => {
    const f = fixture(), held = f.hold(), pending = f.controller.ensureSelectionMorphologyRange(); await flush();
    if (replacement === 'scene') f.controller.scene = { ...f.scene } as unknown as NonNullable<AppController['scene']>;
    else f.internal.generation++;
    const newer = { ...summary(), format: 'Replacement', revision: 7 }; setApp({ summary: newer }); held.resolve();
    expect(await pending).toBe(false); expect(useApp.getState().summary).toBe(newer);
    expect(f.ledger.usage.bytes).toBe(f.before); expect(f.memory.state.coveredBytes).toBe(528);
  });
  it.each(['selected', 'history', 'owner', 'map'] as const)('blocks editing if readonly result changes captured %s authority', async change => {
    const f = fixture(), before = structuredClone(useApp.getState().summary);
    f.respond(() => ({ ...summary(), morphologyRange: range,
      ...(change === 'selected' ? { selected: 2 } : change === 'history' ? { canRedo: false } :
        change === 'owner' ? { toleranceSessionId: 4 } : { selectionMapRetainedIds: [17] }) }));
    expect(await f.controller.ensureSelectionMorphologyRange()).toBe(false);
    expect(useApp.getState().summary).toEqual(before); expect(f.internal.editingFailed).toBe(true);
    expect(f.controller.selectionMorphologyControlsEnabled).toBe(false);
    expect(useApp.getState().error).toContain('preserve its captured document and edit owners');
    expect(f.ledger.usage.bytes).toBe(f.before);
  });
});
