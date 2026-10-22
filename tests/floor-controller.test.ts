import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppController } from '../src/app/controller';
import { setApp, useApp } from '../src/app/store';
import { NEUTRAL_COLOR, type NativeSummary, type Revision, type SceneCommand } from '../src/document/types';
import { IDENTITY_ALIGNMENT_FRAME, alignmentFrameChange, type AlignmentFrame } from '../src/document/alignment';
import type { AlignmentSummary } from '../src/document/alignmentProtocol';
import type { FloorSummary } from '../src/document/floorProtocol';
import type { NativeCoverageUpdate } from '../src/document/nativeMemory';
import { AdmissionError, FLOOR_VIEW_BOOKKEEPING_BYTES, estimateFloorWorkBytes, MiB, ResourceLedger, type ResourceLease } from '../src/document/resources';
import type { OperationOwner } from '../src/document/operationProtocol';

vi.mock('../src/generated/buildIdentity', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/generated/buildIdentity')>();
  return { ...actual, BUILD_DESCRIPTOR: { ...actual.BUILD_DESCRIPTOR, native: { ...actual.BUILD_DESCRIPTOR.native,
    core: { ...actual.BUILD_DESCRIPTOR.native.core, capabilities: { ...actual.BUILD_DESCRIPTOR.native.core.capabilities, alignment: 4 } } } } };
});

// Ownership/transport qualification only. The supplied frame and metadata are
// native response doubles; these tests do not fit planes, edit Gaussians,
// measure a WASM heap, or qualify native camera/geometry mathematics.
const initial = useApp.getState(), CAMERA = [4, 6, 8, .4, .2, 12, 7, 55, 1, .45, 2];
function frame(x: number, y = 0): AlignmentFrame {
  const value = [...IDENTITY_ALIGNMENT_FRAME]; value[12] = x; value[13] = y;
  return value as unknown as AlignmentFrame;
}
const BEFORE_FRAME = frame(3), AFTER_FRAME = frame(3, -2);
function alignment(value = BEFORE_FRAME, branchId = 2): AlignmentSummary {
  return { version: 2, frame: value, branchId, canReset: true, retainedBranchIds: branchId === 2 ? [0, 2] : [0, 2, branchId] };
}
function summary(patch: Partial<NativeSummary> = {}): NativeSummary {
  return { ok: true, duplicateRange: null, loaded: true, count: 10, sourceCount: 12, shDegree: 0, format: 'ply', kind: 0, selected: 8, visible: 9,
    canUndo: true, canRedo: true, revision: 3, contentRevision: 2, transaction: false, selectionDraft: false, sceneChanged: false,
    pending: false, progress: 1, center: [0, 0, 0], radius: 7, yUp: true, camera: [...CAMERA], memoryBytes: 1740,
    selectionMapId: null, pendingSelectionMapId: null, selectionMapBytes: 0, selectionMapRetainedIds: [],
    alignment: alignment(), floor: null, filter: null, transformSession: null, opacitySession: null, ...patch };
}
function floor(id = 1, ready = true): FloorSummary {
  const common = { version: 1 as const, id, stage: 'complete' as const, selectedOnly: true };
  return ready ? { ...common, status: 'ready', plane: { normal: [0, 1, 0], center: [1, 2, 3], radius: 4, rms: Math.fround(.05), inliers: 7, tested: 8 } } :
    { ...common, status: 'none', plane: null };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve };
}
type Internals = {
  ledger: ResourceLedger; releaseScene?: ResourceLease; releaseHistory?: ResourceLease; generation: number;
  bindNativeCoverage(client: NonNullable<AppController['client']>, scene: ResourceLease, history: ResourceLease): unknown;
};
type BoundaryInternals = {
  canvas?: HTMLCanvasElement;
  navigate(action: () => Promise<void>, kind?: string): Promise<void>;
  ensureStartupCore(): Promise<void>;
  selectionMaps: { invalidate(): Promise<void> };
};
const fixtures: { settle(): Promise<void> }[] = [];
function fixture(limit = 256 * MiB) {
  const controller = new AppController(), internal = controller as unknown as Internals, ledger = new ResourceLedger(limit);
  const sceneLease = ledger.reserve('decoded', 8192), history = ledger.reserve('history', 300);
  internal.ledger = ledger; internal.releaseScene = sceneLease; internal.releaseHistory = history;
  let native = summary(), checkpoint: NativeSummary | undefined, nextId = 1, readyFit = true, disposed = false;
  let detectGate: Promise<void> | undefined, queued = false, retireGate: Promise<void> | undefined;
  let streamGate: Promise<void> | undefined, rollbackGate: Promise<void> | undefined, commitGate: Promise<void> | undefined;
  let wire: ((value: NativeSummary) => NativeSummary) | undefined, commitWire: ((value: NativeSummary) => NativeSummary) | undefined;
  let failure: 'heap' | 'allocation' | 'upload' | 'fence' | 'coverage' | 'commit' | undefined;
  let stoppedReleases: ResourceLease[] = [];
  const gates: ReturnType<typeof deferred>[] = [], starts: Promise<boolean>[] = [], events: string[] = [];
  const gate = () => { const value = deferred(); gates.push(value); return value; };
  const revision: Revision = { documentId: 'floor-controller-double', sourceGeneration: 1, contentRevision: 2, selectionRevision: 3, draftRevision: 0 };
  let cameraValues = [...CAMERA];
  const camera = { revision: 1, background: 'black', clearInput: vi.fn(), dispose: vi.fn(),
    get state() { return [...cameraValues]; },
    frameChange: vi.fn((before: readonly number[], after: readonly number[]) => [...alignmentFrameChange(before, after)]),
    orientationFrameChange: vi.fn(() => [...IDENTITY_ALIGNMENT_FRAME]),
    transformState: vi.fn((values: readonly number[], matrix: readonly number[], policy = 0) => values.map((value, index) =>
      index < 3 ? Math.fround(value + matrix[12 + index]) : index === 9 && policy === 1 ? 0 : value)),
    set: vi.fn((values: number[]) => { events.push('camera-publication'); cameraValues = values.map(Math.fround); camera.revision++; }),
    aspect: vi.fn((aspect: number) => { cameraValues[10] = aspect; camera.revision++; }),
    focus: vi.fn((point: number[]) => { cameraValues.splice(0, 3, ...point); camera.revision++; }),
    orbit: vi.fn(() => { cameraValues[3] = -.75; camera.revision++; }),
    pan: vi.fn(() => { cameraValues[0] += 2; camera.revision++; }),
    navigate(values: readonly number[]) { cameraValues = [...values]; camera.revision++; },
  };
  const makeScene = (name: string) => ({ kind: 'gaussian', setDuplicateRange: vi.fn(), count: 10, degree: 0, sourceRevision: 5, allocationBytes: 8000,
    upload: vi.fn(async () => { events.push(`${name}-upload`); if (failure === 'upload') { failure = undefined; throw new Error('Injected GPU upload refusal'); } }),
    masks: vi.fn(), stageMasks: vi.fn(), dispose: vi.fn(async () => { events.push(`${name}-dispose`); }),
  });
  const base = makeScene('base'), staged: ReturnType<typeof makeScene>[] = [];
  const renderer = { lost: false, deviceEpoch: 7,
    canvas: { width: 800, height: 400, getBoundingClientRect: () => ({ width: 400, height: 200 }) },
    render: vi.fn(), pick: vi.fn(async () => ({ index: 2, deviceEpoch: 7 })), setHistogramEnabled: vi.fn(), resetHistogram: vi.fn(), dispose: vi.fn(),
    device: { queue: { onSubmittedWorkDone: vi.fn(async () => {
      events.push('gpu-fence'); if (failure === 'fence') { failure = undefined; throw new Error('Injected GPU fence refusal'); }
    }) } },
    allocateScene: vi.fn(async () => {
      events.push('gpu-allocation'); if (failure === 'allocation') { failure = undefined; throw new AdmissionError('Injected GPU admission refusal'); }
      const scene = makeScene(`candidate-${staged.length}`); staged.push(scene); return scene;
    }),
  };
  const rebalance = (updates: readonly NativeCoverageUpdate[]) => ledger.rebalance(updates.map(update => ({ lease: update.lease, bytes: update.nextLeaseBytes })));
  const command = vi.fn(async (request: SceneCommand, signal?: AbortSignal): Promise<NativeSummary> => {
    events.push(request.command);
    // A retirement transport settlement can be delayed even when it will
    // reject because the module was stopped. Never model native success after
    // dispose; the controller still has to join that cleanup finalizer.
    if (request.command === 'cancelFloor') await retireGate;
    if (disposed) throw new Error('Transport disposed');
    if (request.command === 'detectFloor') {
      if (failure === 'heap') { failure = undefined; throw new AdmissionError('Injected retained native heap admission refusal'); }
      const id = nextId++;
      const captured = structuredClone(native);
      await detectGate;
      if (queued && signal?.aborted) throw new DOMException('Queued detection cancelled', 'AbortError');
      native = { ...native, floor: floor(id, readyFit) };
      const emitted = { ...captured, floor: structuredClone(native.floor) }, transform = wire; wire = undefined;
      return transform ? transform(emitted) : emitted;
    }
    if (request.command === 'cancelFloor') {
      await retireGate;
      if (native.floor?.id === request.id) native = { ...native, floor: null };
      events.push(`floor-retired-${request.id}`);
    } else if (request.command === 'beginTransaction') {
      checkpoint = structuredClone(native); native = { ...native, transaction: true };
    } else if (request.command === 'alignFloor') {
      native = { ...native, alignment: alignment(AFTER_FRAME, 3), revision: native.revision + 1, contentRevision: native.contentRevision + 1,
        memoryBytes: 2200, canRedo: false, sceneChanged: true, floor: null };
      revision.contentRevision++; revision.selectionRevision++;
    } else if (request.command === 'commitTransaction') {
      await commitGate;
      if (failure === 'commit') { failure = undefined; throw new Error('Injected prepublication commit refusal'); }
      checkpoint = undefined; native = { ...native, transaction: false, sceneChanged: false };
      if (commitWire) return commitWire(native);
    } else if (request.command === 'rollbackTransaction') {
      await rollbackGate; native = checkpoint!; checkpoint = undefined; revision.contentRevision++; revision.selectionRevision++;
      events.push('rollback-acknowledged');
    } else if (request.command === 'point') return { ...native, point: [9, 8, 7] };
    return structuredClone(native);
  });
  let operationSequence = 0, operationOwner: OperationOwner | undefined;
  let operationPhase: 'created' | 'active' | 'terminal' | undefined;
  const owned = (owner: OperationOwner) => {
    if (owner !== operationOwner) throw new Error('The fixture operation owner changed.');
  };
  // Preserve the existing command/GPU/held-commit model behind the typed API.
  // Malformed terminal fixtures deliberately have no validated native receipt.
  const client = { command, revision, operationResolution: undefined,
    createOperation: vi.fn((): OperationOwner => {
      if (operationOwner) throw new Error('Finish the fixture operation first.');
      operationOwner = { version: 1, documentId: revision.documentId, sourceGeneration: revision.sourceGeneration,
        clientGeneration: '22222222-2222-4222-8222-222222222222', operationId: ++operationSequence };
      operationPhase = 'created'; return operationOwner;
    }),
    beginOperation: vi.fn(async (owner: OperationOwner) => {
      owned(owner); if (operationPhase !== 'created') throw new Error('The fixture operation already started.');
      const value = await command({ command: 'beginTransaction' }); operationPhase = 'active'; return value;
    }),
    commitOperation: vi.fn(async (owner: OperationOwner) => {
      owned(owner); if (operationPhase !== 'active') throw new Error('The fixture operation is not active.');
      const value = await command({ command: 'commitTransaction' }); operationPhase = 'terminal'; return value;
    }),
    rollbackOperation: vi.fn(async (owner: OperationOwner) => {
      owned(owner); if (operationPhase !== 'active') throw new Error('The fixture operation cannot be rolled back.');
      const value = await command({ command: 'rollbackTransaction' }); operationPhase = 'terminal'; return value;
    }),
    finishOperation: vi.fn(async (owner: OperationOwner) => {
      owned(owner); if (operationPhase === 'active') throw new Error('Restore the fixture operation before retiring it.');
      operationOwner = undefined; operationPhase = undefined;
    }),
    onProgress: undefined as ((stage: string, fraction: number) => void) | undefined,
    stream: vi.fn(async (chunk: (first: number, count: number, bytes: ArrayBuffer) => Promise<void>, masks: (bytes: ArrayBuffer) => void) => {
      events.push('stream'); await streamGate; await chunk(0, 10, new ArrayBuffer(480)); masks(new ArrayBuffer(10)); return structuredClone(native);
    }), readMasks: vi.fn(), cancel: vi.fn(), assertNativeAdmission: vi.fn(), setNativeWork: vi.fn(), setNativeCoveragePlanner: vi.fn(),
    updateNativeCoverage: vi.fn(rebalance), transferNativeCoverage: vi.fn((updates: readonly NativeCoverageUpdate[]) => {
      events.push('coverage-transfer'); if (failure === 'coverage') { failure = undefined; throw new AdmissionError('Injected retained-history admission refusal'); }
      rebalance(updates);
    }), releaseNativeCoverage: vi.fn((lease: ResourceLease) => {
      events.push('coverage-release'); if (disposed) stoppedReleases.push(lease); else lease();
    }),
    dispose: vi.fn(() => { disposed = true; events.push('transport-disposed'); }),
    retireNativeMemory: vi.fn(async () => { events.push('native-retirement'); stoppedReleases.forEach(lease => lease()); stoppedReleases = []; }),
  };
  controller.client = client as unknown as NonNullable<AppController['client']>;
  controller.scene = base as unknown as NonNullable<AppController['scene']>;
  controller.renderer = renderer as unknown as NonNullable<AppController['renderer']>;
  controller.camera = camera as unknown as NonNullable<AppController['camera']>;
  internal.bindNativeCoverage(controller.client, sceneLease, history);
  setApp({ summary: structuredClone(native) });
  const value = { controller, internal, ledger, sceneLease, history, client, renderer, camera, base, staged, events, gate,
    native: () => structuredClone(native), baselineBytes: ledger.usage.bytes,
    supersedeNative: (next: NativeSummary) => { native = structuredClone(next); revision.contentRevision = next.contentRevision; revision.selectionRevision = next.revision; },
    start: () => { const task = controller.startFloorDetection(); starts.push(task); return task; },
    holdDetection: (promise: Promise<void>, beforeDispatch = false) => { detectGate = promise; queued = beforeDispatch; },
    holdRetirement: (promise: Promise<void>) => { retireGate = promise; }, holdStream: (promise: Promise<void>) => { streamGate = promise; },
    holdRollback: (promise: Promise<void>) => { rollbackGate = promise; }, holdCommit: (promise: Promise<void>) => { commitGate = promise; },
    fit: (ready: boolean) => { readyFit = ready; }, wire: (transform: (value: NativeSummary) => NativeSummary) => { wire = transform; },
    commitWire: (transform: (value: NativeSummary) => NativeSummary) => { commitWire = transform; },
    fail: (kind: typeof failure) => { failure = kind; },
    settle: async () => { gates.forEach(item => item.resolve()); controller.cancelAlignment(); await Promise.allSettled(starts); await new Promise(resolve => setTimeout(resolve, 0)); },
  };
  fixtures.push(value); return value;
}
type Fixture = ReturnType<typeof fixture>;
const requested = (value: Fixture, name: string) => value.client.command.mock.calls.filter(([request]) => request.command === name);
const workLeases = (value: Fixture) => value.client.updateNativeCoverage.mock.calls.flatMap(([updates]) => updates.map(update => update.lease))
  .filter(lease => value.ledger.owns(lease, 'work'));
async function ready(value: Fixture) {
  expect(await value.start()).toBe(true); expect(value.controller.floorCandidateReady).toBe(true);
  expect(useApp.getState()).toMatchObject({ alignmentTool: 'floor', alignmentFloor: { phase: 'candidate' }, busy: false });
}
async function heldUnverifiedFloorCommit(value: Fixture) {
  await ready(value);
  const commit = value.gate(), retirement = value.gate(); value.holdCommit(commit.promise); value.holdRetirement(retirement.promise);
  value.commitWire(result => ({ ...result, alignment: alignment(AFTER_FRAME, 99) }));
  const confirmation = value.controller.confirmAlignment();
  await vi.waitFor(() => expect(requested(value, 'commitTransaction')).toHaveLength(1));
  return { commit, retirement, confirmation };
}
beforeEach(() => {
  vi.stubGlobal('document', { title: '', hidden: true }); vi.stubGlobal('cancelAnimationFrame', vi.fn());
  setApp({ ...initial, ready: true, rendererState: 'ready', busy: false, error: null, dirty: false, summary: summary(),
    grade: [...NEUTRAL_COLOR], appliedGrade: [...NEUTRAL_COLOR], colorSession: null, pendingSelectionCount: 0,
    alignmentTool: null, alignmentPoint: null, alignmentSecondPoint: null, alignmentThirdPoint: null, alignmentNormal: null,
    alignmentFlip: false, alignmentFloor: null, selectionRecovery: 'idle', memoryOverageBytes: 0,
    settingsOpen: false, exportOpen: false, navigationPrompt: false, outputPending: false, savedViewChoices: [] }, true);
});
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(value => value.settle())); vi.restoreAllMocks(); vi.unstubAllGlobals(); setApp(initial, true);
});

describe('Floor read-only analysis ownership and admission', () => {
  it('retains the original frame, masks, Redo and GPU owner without a transaction or scene clone', async () => {
    const value = fixture(), before = structuredClone(useApp.getState().summary), camera = value.camera.state;
    await ready(value);
    expect(requested(value, 'detectFloor')[0][0]).toEqual({ command: 'detectFloor', camera });
    expect(value.native()).toEqual({ ...before, floor: floor() });
    expect(useApp.getState().summary).toEqual({ ...before, floor: floor() });
    expect(value.controller.scene).toBe(value.base); expect(value.camera.state).toEqual(camera);
    expect(value.client.command.mock.calls.map(([request]) => request.command)).toEqual(['detectFloor']);
    expect(value.renderer.allocateScene).not.toHaveBeenCalled(); expect(value.client.stream).not.toHaveBeenCalled();
    expect(value.client.readMasks).not.toHaveBeenCalled(); expect(value.base.stageMasks).not.toHaveBeenCalled();
    expect(value.camera.set).not.toHaveBeenCalled(); expect(value.ledger.usage.bytes).toBe(value.baselineBytes + FLOOR_VIEW_BOOKKEEPING_BYTES);
    expect(value.client.releaseNativeCoverage).toHaveBeenCalledOnce(); expect(value.ledger.owns(value.sceneLease)).toBe(true); expect(value.history.bytes).toBe(300);
  });
  it('allows owned analysis camera navigation but captures one detect pose, and Flip/navigation never re-detect', async () => {
    const value = fixture(), held = value.gate(); value.holdDetection(held.promise); const originalProgress = vi.fn(); value.client.onProgress = originalProgress;
    const task = value.start(); await vi.waitFor(() => expect(requested(value, 'detectFloor')).toHaveLength(1));
    expect(value.controller.cameraNavigationEnabled).toBe(true); expect(value.controller.floorCandidateReady).toBe(false);
    value.controller.setAlignmentFlip(true); expect(useApp.getState().alignmentFlip).toBe(false);
    expect(value.controller.alignmentControlsEnabled).toBe(false); value.camera.orbit(); value.camera.pan(); value.controller.invalidate();
    value.client.onProgress?.('RANSAC', .6); expect(originalProgress).toHaveBeenCalledWith('RANSAC', .6);
    expect(useApp.getState().alignmentFloor).toMatchObject({ phase: 'detecting', progress: .6, candidate: null });
    expect(requested(value, 'detectFloor')[0][0].camera).toEqual(CAMERA); expect(await value.controller.confirmAlignment()).toBe(false);
    await value.controller.focusPixel(10, 10); expect(value.renderer.pick).not.toHaveBeenCalled();
    held.resolve(); expect(await task).toBe(true); const candidate = useApp.getState().alignmentFloor?.candidate;
    const calls = value.client.command.mock.calls.length; value.controller.setAlignmentFlip(true); value.camera.pan(); value.controller.invalidate();
    expect(useApp.getState().alignmentFloor?.candidate).toBe(candidate); expect(useApp.getState().alignmentFlip).toBe(true);
    expect(value.client.command).toHaveBeenCalledTimes(calls); expect(value.client.onProgress).toBe(originalProgress);
  });
  it.each([{ busy: true }, { settingsOpen: true }, { exportOpen: true }, { rendererState: 'recovering' as const },
    { selectionRecovery: 'required' as const }, { memoryOverageBytes: 1 }])('refuses unavailable detection without transport or leases: %j', async patch => {
    const value = fixture(); setApp(patch); expect(value.controller.floorDetectionEnabled).toBe(false);
    expect(await value.start()).toBe(false);
    expect(value.client.command).not.toHaveBeenCalled(); expect(value.ledger.usage.bytes).toBe(value.baselineBytes);
  });
  it('keeps queued cancellation work live until its transport rejects, then makes another tool admissible', async () => {
    const value = fixture(), held = value.gate(); value.holdDetection(held.promise, true); let settled = false;
    const task = value.start().then(result => { settled = true; return result; }); await vi.waitFor(() => expect(requested(value, 'detectFloor')).toHaveLength(1));
    const work = workLeases(value); expect(work).toHaveLength(1); expect(work[0].bytes).toBe(estimateFloorWorkBytes(10));
    value.controller.cancelAlignment(); expect(requested(value, 'detectFloor')[0][1]?.aborted).toBe(true);
    expect(value.controller.cameraNavigationEnabled).toBe(false); expect(value.controller.floorDetectionEnabled).toBe(false);
    expect(useApp.getState().alignmentFloor?.phase).toBe('cancelling'); expect(settled).toBe(false);
    expect(value.ledger.owns(work[0])).toBe(true); expect(value.client.releaseNativeCoverage).not.toHaveBeenCalled();
    expect(await value.controller.startCenterAlignment()).toBe(false); held.resolve(); expect(await task).toBe(false);
    await vi.waitFor(() => expect(useApp.getState().alignmentTool).toBeNull()); expect(requested(value, 'cancelFloor')).toHaveLength(0);
    expect(value.ledger.usage.bytes).toBe(value.baselineBytes); expect(await value.controller.startCenterAlignment()).toBe(true);
  });
  it('joins actual detection and exact-ID cancellation acknowledgement before releasing work and metadata', async () => {
    const value = fixture(), detect = value.gate(), retirement = value.gate(); value.holdDetection(detect.promise); value.holdRetirement(retirement.promise);
    const task = value.start(); await vi.waitFor(() => expect(requested(value, 'detectFloor')).toHaveLength(1));
    const work = workLeases(value)[0]; value.controller.cancelAlignment(); detect.resolve();
    await vi.waitFor(() => expect(requested(value, 'cancelFloor')).toHaveLength(1));
    expect(requested(value, 'cancelFloor')[0][0]).toEqual({ command: 'cancelFloor', id: 1 });
    expect(value.ledger.owns(work)).toBe(true); expect(value.client.releaseNativeCoverage).not.toHaveBeenCalled();
    expect(value.ledger.usage.bytes).toBe(value.baselineBytes + FLOOR_VIEW_BOOKKEEPING_BYTES + estimateFloorWorkBytes(10));
    expect(value.controller.floorDetectionEnabled).toBe(false); retirement.resolve(); expect(await task).toBe(false);
    await vi.waitFor(() => expect(useApp.getState().alignmentFloor).toBeNull()); expect(value.native().floor).toBeNull();
    expect(value.ledger.usage.bytes).toBe(value.baselineBytes); expect(requested(value, 'cancelFloor')).toHaveLength(1);
  });
  it('retries failed fitting only after retiring the captured old ID, and resets Flip for the new candidate', async () => {
    const value = fixture(); value.fit(false); expect(await value.start()).toBe(true);
    expect(useApp.getState().alignmentFloor).toMatchObject({ phase: 'failed', candidate: { id: 1, status: 'none' } });
    expect(await value.controller.confirmAlignment()).toBe(false); const retirement = value.gate(); value.holdRetirement(retirement.promise); value.fit(true);
    const retry = value.start(); await vi.waitFor(() => expect(requested(value, 'cancelFloor')).toHaveLength(1));
    expect(requested(value, 'detectFloor')).toHaveLength(1); expect(value.native().floor?.id).toBe(1);
    retirement.resolve(); expect(await retry).toBe(true); expect(requested(value, 'detectFloor')).toHaveLength(2);
    expect(useApp.getState()).toMatchObject({ alignmentFlip: false, alignmentFloor: { phase: 'candidate', candidate: { id: 2 } } });
    expect(value.events.indexOf('floor-retired-1')).toBeLessThan(value.events.lastIndexOf('detectFloor'));
  });
  it('retires an old module ID without clearing a replacement module candidate with the same numeric ID', async () => {
    const old = fixture(); await ready(old); const retirement = old.gate(); old.holdRetirement(retirement.promise);
    old.controller.cancelAlignment(); await vi.waitFor(() => expect(requested(old, 'cancelFloor')).toHaveLength(1));
    setApp({ busy: false, alignmentTool: null, alignmentFloor: null }); const replacement = fixture();
    old.controller.client = replacement.controller.client; old.controller.scene = replacement.controller.scene;
    old.controller.renderer = replacement.controller.renderer; old.controller.camera = replacement.controller.camera; old.internal.generation++;
    await ready(replacement); const owner = useApp.getState().alignmentFloor;
    expect(owner?.candidate?.id).toBe(1); retirement.resolve(); await vi.waitFor(() => expect(old.native().floor).toBeNull());
    expect(useApp.getState().alignmentFloor).toBe(owner); expect(replacement.native().floor?.id).toBe(1);
    expect(replacement.controller.floorCandidateReady).toBe(true); expect(requested(replacement, 'cancelFloor')).toHaveLength(0);
    expect(old.ledger.usage.bytes).toBe(old.baselineBytes); expect(replacement.ledger.usage.bytes).toBe(replacement.baselineBytes + FLOOR_VIEW_BOOKKEEPING_BYTES);
  });
  it.each(['source', 'revision', 'loss'] as const)('rejects an older completion after %s ownership changes', async change => {
    const value = fixture(), held = value.gate(); value.holdDetection(held.promise); const task = value.start();
    await vi.waitFor(() => expect(requested(value, 'detectFloor')).toHaveLength(1));
    value.controller.cancelAlignment();
    const successor = change === 'loss' ? summary() : summary({ revision: 8, contentRevision: 7, camera: [2, 3, 4, ...CAMERA.slice(3)] });
    if (change === 'source') { value.internal.generation++; value.controller.scene = { ...value.base, sourceRevision: 6 } as unknown as NonNullable<AppController['scene']>; }
    else if (change === 'revision') value.supersedeNative(successor);
    else value.renderer.lost = true;
    setApp({ summary: successor, alignmentTool: null, alignmentFloor: null }); held.resolve(); expect(await task).toBe(false);
    expect(useApp.getState().summary).toEqual(successor); expect(useApp.getState().alignmentFloor).toBeNull();
    expect(value.camera.set).not.toHaveBeenCalled(); expect(value.renderer.allocateScene).not.toHaveBeenCalled();
    expect(value.native().floor).toBeNull(); expect(value.ledger.usage.bytes).toBe(value.baselineBytes);
  });
  it.each(['plane', 'history', 'frame', 'count'] as const)('refuses a malformed readonly %s result without publishing it or staging GPU content', async mismatch => {
    const value = fixture(), before = structuredClone(useApp.getState().summary);
    value.wire(result => mismatch === 'plane' ? { ...result, floor: { ...result.floor!, plane: { ...(result.floor as Extract<FloorSummary, { status: 'ready' }>).plane, normal: [0, 0, 0] } } as FloorSummary } :
      mismatch === 'history' ? { ...result, canRedo: false } : mismatch === 'frame' ? { ...result, alignment: alignment(frame(99)) } : { ...result, count: 9 });
    expect(await value.start()).toBe(false); expect(value.controller.floorCandidateReady).toBe(false);
    expect(useApp.getState().alignmentFloor).toMatchObject({ phase: 'failed', candidate: null });
    expect(useApp.getState().summary).toEqual(before); expect(value.native().floor).toBeNull();
    expect(value.controller.scene).toBe(value.base); expect(value.renderer.allocateScene).not.toHaveBeenCalled();
    expect(requested(value, 'summary')).toHaveLength(1); expect(requested(value, 'beginTransaction')).toHaveLength(0);
    expect(value.ledger.usage.bytes).toBe(value.baselineBytes + FLOOR_VIEW_BOOKKEEPING_BYTES);
    expect(requested(value, 'cancelFloor')).toHaveLength(1); value.controller.cancelAlignment();
  });
  it.each(['metadata', 'work', 'heap'] as const)('preserves the original scene, frame and executable Redo after %s admission refusal', async kind => {
    const value = fixture(kind === 'metadata' ? 8492 : kind === 'work' ? 8492 + FLOOR_VIEW_BOOKKEEPING_BYTES : 256 * MiB);
    const before = structuredClone(useApp.getState().summary); if (kind === 'heap') value.fail('heap');
    expect(await value.start()).toBe(false); expect(value.native()).toEqual(before); expect(useApp.getState().summary).toEqual(before);
    expect(value.native().canRedo).toBe(true); expect(value.controller.scene).toBe(value.base); expect(value.camera.set).not.toHaveBeenCalled();
    expect(value.renderer.allocateScene).not.toHaveBeenCalled(); expect(value.client.readMasks).not.toHaveBeenCalled();
    expect(requested(value, 'beginTransaction')).toHaveLength(0); value.controller.cancelAlignment();
    await vi.waitFor(() => expect(value.ledger.usage.bytes).toBe(value.baselineBytes));
  });
});

describe('Floor explicit confirmation and joined lifetime', () => {
  it('joins late Floor retirement created after a held irreversible commit before Close reaches its source boundary', async () => {
    const value = fixture(), held = await heldUnverifiedFloorCommit(value), boundary = value.controller as unknown as BoundaryInternals;
    // Observes Close admission to navigation; it does not fabricate document
    // closure or take credit for storage/renderer/native-module teardown.
    const navigate = vi.spyOn(boundary, 'navigate').mockResolvedValue(undefined), closing = value.controller.closeScene();
    try {
      expect(requested(value, 'cancelFloor')).toHaveLength(0); held.commit.resolve(); expect(await held.confirmation).toBe(false);
      await vi.waitFor(() => expect(requested(value, 'cancelFloor')).toHaveLength(1));
      expect(requested(value, 'cancelFloor')[0][0]).toEqual({ command: 'cancelFloor', id: 1 });
      expect(navigate).not.toHaveBeenCalled(); expect(value.client.retireNativeMemory).not.toHaveBeenCalled();
      expect(value.ledger.owns(value.sceneLease)).toBe(true); expect(value.ledger.owns(value.history)).toBe(true);
      expect(value.events).not.toContain('floor-retired-1'); expect(value.camera.set).not.toHaveBeenCalled();
      expect(requested(value, 'rollbackTransaction')).toHaveLength(0);
    } finally { held.commit.resolve(); held.retirement.resolve(); await closing; }
    expect(navigate).toHaveBeenCalledOnce(); expect(value.events).toContain('floor-retired-1');
    expect(value.ledger.usage.bytes).toBe(value.baselineBytes);
  });
  it('joins late Floor retirement created after a held irreversible commit before recovery reconciles selection owners', async () => {
    const value = fixture(), held = await heldUnverifiedFloorCommit(value), boundary = value.controller as unknown as BoundaryInternals;
    // Stop at the recovery boundary before any startup core, renderer
    // allocation or numerical work. The real control flow must join cleanup.
    boundary.canvas = value.renderer.canvas as unknown as HTMLCanvasElement;
    vi.spyOn(boundary, 'ensureStartupCore').mockResolvedValue(undefined);
    const reconcile = vi.spyOn(boundary.selectionMaps, 'invalidate').mockRejectedValue(new Error('Stop after observed recovery boundary'));
    const recovery = value.controller.retryRenderer();
    try {
      held.commit.resolve(); expect(await held.confirmation).toBe(false);
      await vi.waitFor(() => expect(requested(value, 'cancelFloor')).toHaveLength(1));
      expect(requested(value, 'cancelFloor')[0][0]).toEqual({ command: 'cancelFloor', id: 1 });
      expect(reconcile).not.toHaveBeenCalled(); expect(value.client.retireNativeMemory).not.toHaveBeenCalled();
      expect(value.ledger.owns(value.sceneLease)).toBe(true); expect(value.ledger.owns(value.history)).toBe(true);
      expect(value.camera.set).not.toHaveBeenCalled(); expect(requested(value, 'rollbackTransaction')).toHaveLength(0);
    } finally { held.commit.resolve(); held.retirement.resolve(); expect(await recovery).toBe(false); }
    expect(reconcile).toHaveBeenCalledOnce(); expect(value.events).toContain('floor-retired-1');
    expect(value.ledger.usage.bytes).toBe(value.baselineBytes);
  });
  it('joins late Floor retirement created after a held irreversible commit before Dispose retires native/source credits', async () => {
    const value = fixture(), held = await heldUnverifiedFloorCommit(value); value.controller.dispose();
    try {
      held.commit.resolve(); expect(await held.confirmation).toBe(false);
      await vi.waitFor(() => expect(requested(value, 'cancelFloor')).toHaveLength(1));
      expect(requested(value, 'cancelFloor')[0][0]).toEqual({ command: 'cancelFloor', id: 1 });
      expect(value.client.retireNativeMemory).not.toHaveBeenCalled();
      expect(value.ledger.owns(value.sceneLease)).toBe(true); expect(value.ledger.owns(value.history)).toBe(true);
      expect(value.ledger.usage.bytes).toBeGreaterThan(value.baselineBytes);
      expect(value.camera.set).not.toHaveBeenCalled(); expect(requested(value, 'rollbackTransaction')).toHaveLength(0);
    } finally { held.commit.resolve(); held.retirement.resolve(); }
    await vi.waitFor(() => expect(value.client.retireNativeMemory).toHaveBeenCalledOnce());
    expect(value.ledger.usage.bytes).toBe(0);
  });
  it('stages one captured candidate, carries its native frame/WorldUpright cameras and consumes it only after commit', async () => {
    const value = fixture(); await ready(value); value.controller.setAlignmentFlip(true); value.camera.orbit(); value.camera.pan();
    const input = value.camera.state, defaultInput = [...CAMERA]; const fence = value.gate();
    value.renderer.device.queue.onSubmittedWorkDone.mockImplementationOnce(() => fence.promise);
    const confirmation = value.controller.confirmAlignment(); await vi.waitFor(() => expect(value.renderer.allocateScene).toHaveBeenCalledOnce());
    expect(value.controller.scene).toBe(value.base); expect(value.camera.set).not.toHaveBeenCalled();
    expect(requested(value, 'commitTransaction')).toHaveLength(0); expect(useApp.getState().alignmentFloor?.phase).toBe('candidate');
    fence.resolve(); expect(await confirmation).toBe(true);
    expect(requested(value, 'alignFloor')[0][0]).toEqual({ command: 'alignFloor', id: 1, flip: true, camera: input, defaultCamera: defaultInput });
    expect(value.camera.frameChange).toHaveBeenCalledWith(BEFORE_FRAME, AFTER_FRAME);
    expect(value.camera.state.slice(0, 3)).toEqual([input[0], input[1] - 2, input[2]]); expect(value.camera.state[9]).toBe(0);
    expect(value.native().alignment).toEqual(alignment(AFTER_FRAME, 3));
    expect(value.controller.scene).toBe(value.staged[0]); expect(value.events.indexOf('camera-publication')).toBeGreaterThan(value.events.indexOf('commitTransaction'));
    expect(value.base.dispose).toHaveBeenCalledOnce(); expect(useApp.getState()).toMatchObject({ alignmentTool: null, alignmentFloor: null, alignmentFlip: false });
    value.controller.resetCamera(); expect(value.camera.state.slice(0, 3)).toEqual([CAMERA[0], CAMERA[1] - 2, CAMERA[2]]);
    expect(value.camera.state[9]).toBe(0);
  });
  it.each(['allocation', 'upload', 'fence', 'coverage', 'commit'] as const)('keeps candidate/Flip/frame/camera/Redo usable after a proven %s rollback', async failure => {
    const value = fixture(); await ready(value); value.controller.setAlignmentFlip(true);
    const owner = useApp.getState().alignmentFloor, before = value.native(), camera = value.camera.state, rollback = value.gate();
    value.holdRollback(rollback.promise); value.fail(failure); let settled = false;
    const confirmation = value.controller.confirmAlignment().then(result => { settled = true; return result; });
    await vi.waitFor(() => expect(requested(value, 'rollbackTransaction')).toHaveLength(1));
    expect(settled).toBe(false); expect(value.controller.scene).toBe(value.base); expect(value.camera.state).toEqual(camera);
    expect(useApp.getState().alignmentFloor).toBe(owner); expect(requested(value, 'cancelFloor')).toHaveLength(0);
    rollback.resolve(); expect(await confirmation).toBe(false); expect(value.native()).toEqual(before);
    expect(useApp.getState().alignmentFloor).toEqual(owner); expect(useApp.getState().alignmentFlip).toBe(true);
    expect(value.controller.floorCandidateReady).toBe(true); expect(value.camera.set).not.toHaveBeenCalled();
    expect(value.history.bytes).toBe(300); expect(value.controller.editingAvailable).toBe(true);
    expect(await value.controller.confirmAlignment()).toBe(true); expect(requested(value, 'detectFloor')).toHaveLength(1);
  });
  it('preserves the candidate when Reset camera or native contributor focus changes only navigation', async () => {
    const value = fixture(); await ready(value); value.controller.setAlignmentFlip(true); value.camera.orbit();
    const candidate = useApp.getState().alignmentFloor?.candidate, calls = value.client.command.mock.calls.length;
    value.controller.resetCamera(); expect(value.camera.state).toEqual(CAMERA.map(Math.fround));
    expect(useApp.getState()).toMatchObject({ alignmentTool: 'floor', alignmentFlip: true });
    expect(useApp.getState().alignmentFloor?.candidate).toBe(candidate); expect(value.client.command).toHaveBeenCalledTimes(calls);
    await value.controller.focusPixel(30, 40); expect(value.camera.focus).toHaveBeenCalledWith([9, 8, 7]);
    expect(requested(value, 'point')).toHaveLength(1); expect(requested(value, 'cancelFloor')).toHaveLength(0);
    expect(useApp.getState().alignmentFloor?.candidate).toBe(candidate); expect(value.controller.floorCandidateReady).toBe(true);
  });
  it('waits for cancelled confirmation rollback before retiring its native candidate or releasing metadata', async () => {
    const value = fixture(); await ready(value); const stream = value.gate(), rollback = value.gate(); value.holdStream(stream.promise); value.holdRollback(rollback.promise);
    const confirmation = value.controller.confirmAlignment(); await vi.waitFor(() => expect(value.client.stream).toHaveBeenCalledOnce());
    value.controller.cancelAlignment(); expect(value.controller.cameraNavigationEnabled).toBe(false);
    expect(requested(value, 'cancelFloor')).toHaveLength(0); expect(value.ledger.usage.bytes).toBeGreaterThan(value.baselineBytes + FLOOR_VIEW_BOOKKEEPING_BYTES);
    stream.resolve(); await vi.waitFor(() => expect(requested(value, 'rollbackTransaction')).toHaveLength(1));
    expect(requested(value, 'cancelFloor')).toHaveLength(0); expect(value.camera.set).not.toHaveBeenCalled();
    rollback.resolve(); expect(await confirmation).toBe(false); await vi.waitFor(() => expect(requested(value, 'cancelFloor')).toHaveLength(1));
    expect(value.events.indexOf('floor-retired-1')).toBeGreaterThan(value.events.indexOf('rollback-acknowledged'));
    expect(value.native().floor).toBeNull(); expect(value.native().canRedo).toBe(true);
    await vi.waitFor(() => expect(value.ledger.usage.bytes).toBe(value.baselineBytes));
  });
  it('does not cancel or retire a candidate while an irreversible commit acknowledgement is held', async () => {
    const value = fixture(); await ready(value); value.controller.setAlignmentFlip(true); const commit = value.gate(); value.holdCommit(commit.promise);
    const confirmation = value.controller.confirmAlignment(); await vi.waitFor(() => expect(requested(value, 'commitTransaction')).toHaveLength(1));
    value.controller.cancelAlignment(); expect(value.client.cancel).not.toHaveBeenCalled(); expect(requested(value, 'cancelFloor')).toHaveLength(0);
    expect(useApp.getState()).toMatchObject({ alignmentTool: 'floor', alignmentFlip: true });
    expect(value.controller.cameraNavigationEnabled).toBe(false); commit.resolve(); expect(await confirmation).toBe(true);
    expect(requested(value, 'rollbackTransaction')).toHaveLength(0); expect(useApp.getState().alignmentFloor).toBeNull();
  });
  it('requires reopen after an unverified durable commit instead of presenting the candidate as a rolled-back retry', async () => {
    const value = fixture(); await ready(value); value.commitWire(result => ({ ...result, alignment: alignment(AFTER_FRAME, 99) }));
    expect(await value.controller.confirmAlignment()).toBe(false); expect(value.native().transaction).toBe(false);
    expect(requested(value, 'rollbackTransaction')).toHaveLength(0); expect(value.camera.set).not.toHaveBeenCalled();
    expect(value.controller.scene).toBe(value.base); expect(value.controller.editingAvailable).toBe(false);
    expect(value.controller.floorCandidateReady).toBe(false);
    await vi.waitFor(() => expect(value.events).toContain('floor-retired-1'));
    expect(requested(value, 'cancelFloor')).toHaveLength(1);
    expect(requested(value, 'cancelFloor')[0][0]).toEqual({ command: 'cancelFloor', id: 1 });
    const calls = value.client.command.mock.calls.length;
    expect(await value.controller.confirmAlignment()).toBe(false); expect(value.client.command).toHaveBeenCalledTimes(calls);
  });
  it.each(['close', 'dispose'] as const)('joins a pending detection before %s releases native/source owners and rejects late UI publication', async action => {
    const value = fixture(), held = value.gate(); value.holdDetection(held.promise); const task = value.start();
    await vi.waitFor(() => expect(requested(value, 'detectFloor')).toHaveLength(1)); const work = workLeases(value)[0];
    let closing: Promise<unknown> | undefined;
    if (action === 'close') closing = value.controller.closeScene(); else value.controller.dispose();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(value.ledger.owns(work)).toBe(true); expect(value.ledger.owns(value.sceneLease)).toBe(true);
    expect(value.client.retireNativeMemory).not.toHaveBeenCalled();
    held.resolve(); expect(await task).toBe(false); await closing;
    await vi.waitFor(() => expect(value.client.retireNativeMemory).toHaveBeenCalledOnce());
    expect(useApp.getState().alignmentFloor).toBeNull(); expect(value.ledger.usage.bytes).toBe(0);
    expect(value.camera.set).not.toHaveBeenCalled(); expect(value.renderer.allocateScene).not.toHaveBeenCalled();
  });
});
