import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppController } from '../src/app/controller';
import { setApp, useApp } from '../src/app/store';
import type { CoreClient } from '../src/document/coreClient';
import { NativeHeapAccounting, type NativeCoverageUpdate } from '../src/document/nativeMemory';
import { AdmissionError, MiB, ResourceLedger, type ResourceLease } from '../src/document/resources';
import type { NativeAllocationSnapshot, NativeSummary } from '../src/document/types';

// Native allocation/telemetry arithmetic is exercised by the real accounting
// owner below. This client double isolates user consent and joined retirement.
vi.mock('../src/document/coreClient', () => ({ CoreClient: class {
  onNativeMemoryChanged?: () => void;
  revision = { documentId: 'memory-policy', sourceGeneration: 1, contentRevision: 1, selectionRevision: 0, draftRevision: 0 };
  retirementJoin?: Promise<void>;
  dispose = vi.fn(); cancel = vi.fn();
  constructor(readonly nativeMemory: NativeHeapAccounting) {}
  assertNativeAdmission() { if (this.nativeMemory.state.ledgerOverageBytes) throw new AdmissionError('Retained native overage'); }
  setNativeCoveragePlanner(_planner: (allocation: NativeAllocationSnapshot) => readonly NativeCoverageUpdate[]) {}
  retireNativeMemory = vi.fn(async () => { this.dispose(); await this.retirementJoin; this.nativeMemory.retire(); this.onNativeMemoryChanged?.(); });
} }));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function summary(): NativeSummary {
  return { ok: true, duplicateRange: null, loaded: true, count: 1000, sourceCount: 1000, kind: 0, shDegree: 0, format: 'PLY',
    selected: 0, visible: 1000, canUndo: true, canRedo: false, revision: 1, contentRevision: 1,
    transaction: false, selectionDraft: false, sceneChanged: false, pending: false, progress: 1,
    center: [0, 0, 0], radius: 1, yUp: false, camera: [0, 0, 0, 0, 0, 3, 100, 45, 0, 0, 1],
    memoryBytes: 149000, selectionMapId: null, pendingSelectionMapId: null, selectionMapBytes: 0, selectionMapRetainedIds: [], floor: null, filter: null, transformSession: null, opacitySession: null };
}
type PolicyClient = CoreClient & { retirementJoin?: Promise<void>; dispose: ReturnType<typeof vi.fn>; retireNativeMemory: ReturnType<typeof vi.fn> };
type Navigation = { kind: 'replace' | 'close'; run(): Promise<void> };
type Internals = {
  ledger: ResourceLedger; releaseScene?: ResourceLease; releaseHistory?: ResourceLease; sourceMemory?: NativeHeapAccounting;
  candidate?: CoreClient; files: readonly File[]; currentFile: number; fingerprint?: object;
  pendingNavigation?: Navigation; outputReceipt?: { documentId: string; contentRevision: number; scope: number };
  selectionCleanupOwner?: object; sourceLoads: Set<Promise<void>>;
  editOperation?: { cancel: AbortController; committing: boolean; finished: Promise<void>; tolerance: boolean };
  createCoreClient(memory: NativeHeapAccounting): CoreClient;
  syncMemoryOverage(): void;
};
function fixture(dirty = false) {
  const controller = new AppController(), internals = controller as unknown as Internals, ledger = new ResourceLedger(48 * MiB);
  const remainder = ledger.reserve('source', 32 * MiB), owner = new NativeHeapAccounting(ledger, remainder);
  owner.observe({ sequence: 1, heapBytes: 32 * MiB });
  const sceneLease = ledger.reserve('decoded', 4 * MiB), history = ledger.reserve('history', 5000);
  owner.updateCoverage([{ lease: sceneLease, nextLeaseBytes: sceneLease.bytes, nativeBytes: 144000 },
    { lease: history, nextLeaseBytes: history.bytes, nativeBytes: 5000 }]); owner.activate();
  internals.ledger = ledger;
  const client = internals.createCoreClient(owner) as PolicyClient;
  controller.client = client; internals.sourceMemory = owner; internals.releaseScene = sceneLease; internals.releaseHistory = history;
  const scene = { kind: 'gaussian', setDuplicateRange: vi.fn(), dispose: vi.fn(async () => {}) };
  const renderer = { lost: false, dispose: vi.fn(), capture: vi.fn(), setHistogramEnabled: vi.fn(), resetHistogram: vi.fn(),
    finish(): Promise<void> { return this.device.queue.onSubmittedWorkDone(); }, device: { queue: { onSubmittedWorkDone: vi.fn(async () => {}) } } };
  const camera = { clearInput: vi.fn(), dispose: vi.fn() };
  controller.scene = scene as unknown as NonNullable<AppController['scene']>;
  controller.renderer = renderer as unknown as NonNullable<AppController['renderer']>;
  controller.camera = camera as unknown as NonNullable<AppController['camera']>;
  const key = Object.freeze({ scheme: 'test-independent-key', assetDigest: 'owned-key' }); internals.fingerprint = key;
  internals.files = Object.freeze([new File(['source bytes'], 'kept.ply')]); internals.currentFile = 0;
  setApp({ summary: summary(), sourceName: 'kept.ply', dirty, ready: true, rendererState: 'ready' });
  function overage() { owner.observe({ sequence: 2, heapBytes: 64 * MiB }); client.onNativeMemoryChanged?.(); }
  return { controller, internals, ledger, remainder, owner, sceneLease, history, client, scene, renderer, camera, key, overage };
}
beforeEach(() => {
  vi.stubGlobal('document', { hidden: true, title: '' }); vi.stubGlobal('cancelAnimationFrame', vi.fn());
  setApp({ summary: null, sourceName: '', dirty: false, busy: false, error: null, ready: false,
    rendererState: 'unavailable', memoryOverageBytes: 0, selectionRecovery: 'idle', navigationPrompt: false,
    navigationIntent: null, outputPending: false, settingsOpen: false, exportOpen: false, pendingSelectionCount: 0 });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('retained-memory user policy', () => {
  it('publishes persistent shared-ledger overage without changing graphics state or terminating the document', async () => {
    const f = fixture(); f.overage();
    expect(useApp.getState().memoryOverageBytes).toBe(f.ledger.overageBytes);
    expect(useApp.getState().memoryOverageBytes).toBeGreaterThan(0);
    expect(useApp.getState().rendererState).toBe('ready'); expect(f.controller.client).toBe(f.client);
    expect(f.client.dispose).not.toHaveBeenCalled(); expect(f.controller.sourceFingerprint).toBe(f.key);
    setApp({ error: null }); expect(useApp.getState().memoryOverageBytes).toBe(f.ledger.overageBytes);
    expect(f.controller.editingAvailable).toBe(false);
    await expect(f.controller.capture()).rejects.toThrow('Retained native overage'); expect(f.renderer.capture).not.toHaveBeenCalled();
    await f.controller.closeScene(); expect(useApp.getState().memoryOverageBytes).toBe(0);
  });
  it('retains a dirty document on Close and Stay, including its key, catalog and native owner', async () => {
    const f = fixture(true); f.overage();
    await f.controller.closeScene();
    expect(useApp.getState()).toMatchObject({ navigationPrompt: true, navigationIntent: 'close', dirty: true });
    expect(f.client.dispose).not.toHaveBeenCalled(); expect(f.scene.dispose).not.toHaveBeenCalled();
    expect(f.controller.sourceFingerprint).toBe(f.key); expect(f.internals.files[0].name).toBe('kept.ply');
    f.controller.stay();
    expect(useApp.getState()).toMatchObject({ navigationPrompt: false, navigationIntent: null, dirty: true });
    expect(f.owner.state.retired).toBe(false); expect(f.ledger.owns(f.remainder)).toBe(true);
    setApp({ dirty: false }); await f.controller.closeScene();
  });
  it('explicit Discard closes despite failed GPU restoration and retains memory through GPU and read joins', async () => {
    const f = fixture(true), gpu = deferred(), read = deferred(); f.overage();
    f.scene.dispose.mockImplementation(() => gpu.promise); f.client.retirementJoin = read.promise;
    f.internals.selectionCleanupOwner = { selection: { session: { restoring: false } }, client: f.client,
      documentId: f.client.revision.documentId }; setApp({ selectionRecovery: 'required' });
    await f.controller.closeScene(); const closing = f.controller.discardAndContinue(); await tick();
    expect(f.controller.client).toBeUndefined(); expect(f.controller.scene).toBeUndefined(); expect(f.controller.sourceFingerprint).toBeUndefined();
    expect(f.internals.files).toEqual([]); expect(Object.isFrozen(f.internals.files)).toBe(true);
    expect(f.internals.pendingNavigation).toBeUndefined(); expect(f.internals.outputReceipt).toBeUndefined();
    expect(useApp.getState()).toMatchObject({ summary: null, dirty: false, busy: true, stage: 'Closing scene', selectionRecovery: 'idle' });
    expect(f.client.dispose).toHaveBeenCalled(); expect(f.client.retireNativeMemory).not.toHaveBeenCalled();
    expect(f.ledger.owns(f.remainder)).toBe(true); expect(f.renderer.dispose).not.toHaveBeenCalled(); expect(f.camera.dispose).not.toHaveBeenCalled();
    gpu.resolve(); await tick(); expect(f.client.retireNativeMemory).toHaveBeenCalledOnce();
    expect(f.ledger.owns(f.sceneLease)).toBe(true); expect(useApp.getState().memoryOverageBytes).toBeGreaterThan(0);
    read.resolve(); await closing;
    expect(f.ledger.usage.bytes).toBe(0); expect(useApp.getState()).toMatchObject({ ready: true, rendererState: 'ready', busy: false, memoryOverageBytes: 0 });
    expect(f.controller.renderer).toBe(f.renderer); expect(f.controller.camera).toBe(f.camera);
  });
  it('joins every canceled candidate finalizer before returning a reusable empty viewer', async () => {
    const f = fixture(), held = deferred();
    const candidateLease = f.ledger.reserve('source', MiB), candidateOwner = new NativeHeapAccounting(f.ledger, candidateLease);
    candidateOwner.observe({ sequence: 1, heapBytes: MiB });
    const candidate = f.internals.createCoreClient(candidateOwner) as PolicyClient; f.internals.candidate = candidate;
    const sourceFinalizer: Promise<void> = held.promise.then(() => candidate.retireNativeMemory())
      .finally(() => { f.internals.sourceLoads.delete(sourceFinalizer); }); f.internals.sourceLoads.add(sourceFinalizer);
    const closing = f.controller.closeScene(); await tick();
    expect(candidate.dispose).toHaveBeenCalled(); expect(f.client.retireNativeMemory).not.toHaveBeenCalled();
    expect(f.ledger.owns(candidateLease)).toBe(true); expect(f.ledger.owns(f.remainder)).toBe(true);
    const repeated = f.controller.closeScene(); expect(repeated).toBeDefined();
    held.resolve(); await Promise.all([closing, repeated]);
    expect(candidate.retireNativeMemory).toHaveBeenCalledOnce(); expect(f.client.retireNativeMemory).toHaveBeenCalledOnce();
    expect(f.ledger.usage.bytes).toBe(0); expect(f.renderer.dispose).not.toHaveBeenCalled(); expect(f.camera.dispose).not.toHaveBeenCalled();
  });
  it('accepts an already-produced matching All output receipt before dirty Close even while new export is blocked', async () => {
    const f = fixture(true); f.overage();
    f.internals.outputReceipt = { documentId: f.client.revision.documentId, contentRevision: 1, scope: 0 };
    setApp({ outputPending: true }); await f.controller.closeScene();
    expect(useApp.getState().navigationPrompt).toBe(true); expect(f.client.dispose).not.toHaveBeenCalled();
    f.controller.acknowledgeOutput(); await tick();
    expect(f.owner.state.retired).toBe(true); expect(f.controller.client).toBeUndefined();
    expect(useApp.getState()).toMatchObject({ dirty: false, outputPending: false, navigationPrompt: false, memoryOverageBytes: 0 });
  });
  it.each([['Selected output', 1, 1], ['stale content output', 0, 0]] as const)('does not close or clear dirty state for %s', async (_label, scope, revision) => {
    const f = fixture(true);
    f.internals.outputReceipt = { documentId: f.client.revision.documentId, contentRevision: revision, scope };
    setApp({ outputPending: true }); await f.controller.closeScene(); f.controller.acknowledgeOutput(); await tick();
    expect(useApp.getState()).toMatchObject({ dirty: true, navigationPrompt: true, navigationIntent: 'close', outputPending: false });
    expect(f.controller.client).toBe(f.client); expect(f.client.dispose).not.toHaveBeenCalled();
    await f.controller.discardAndContinue();
  });
  it('does not let a stale Close decision terminate a replacement document', async () => {
    const f = fixture(true); await f.controller.closeScene(); const decision = f.internals.pendingNavigation!;
    const replacement = f.internals.createCoreClient(f.owner); f.controller.client = replacement;
    await decision.run();
    expect(f.controller.client).toBe(replacement); expect(f.controller.sourceFingerprint).toBe(f.key);
    expect(f.client.dispose).not.toHaveBeenCalled(); expect(f.scene.dispose).not.toHaveBeenCalled();
    f.controller.client = f.client; await f.controller.discardAndContinue();
  });
  it('waits for an in-flight commit before deciding whether Close needs dirty protection', async () => {
    const f = fixture(), edit = deferred();
    f.internals.editOperation = { cancel: new AbortController(), committing: true, finished: edit.promise, tolerance: false };
    const request = f.controller.closeScene(); await tick();
    expect(f.client.dispose).not.toHaveBeenCalled(); expect(useApp.getState().navigationPrompt).toBe(false);
    setApp({ dirty: true }); f.internals.editOperation = undefined; edit.resolve(); await request;
    expect(useApp.getState()).toMatchObject({ dirty: true, navigationPrompt: true, navigationIntent: 'close' });
    expect(f.client.dispose).not.toHaveBeenCalled(); await f.controller.discardAndContinue();
  });
  it('lets notifications from a retired client refresh shared memory without restoring its source or graphics error', async () => {
    const f = fixture(); f.overage(); await f.controller.closeScene();
    setApp({ error: null }); f.client.onNativeMemoryChanged?.();
    expect(useApp.getState()).toMatchObject({ summary: null, sourceName: '', error: null, memoryOverageBytes: 0, rendererState: 'ready' });
    expect(f.controller.sourceFingerprint).toBeUndefined(); expect(f.internals.files).toEqual([]);
  });
});
