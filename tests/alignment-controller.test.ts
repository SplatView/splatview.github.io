import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppController } from '../src/app/controller';
import { setApp, useApp } from '../src/app/store';
import { NEUTRAL_COLOR, type NativeSummary, type Revision, type SceneCommand } from '../src/document/types';
import { IDENTITY_ALIGNMENT_FRAME, alignmentFrameChange, type AlignmentFrame } from '../src/document/alignment';
import type { AlignmentSummary } from '../src/document/alignmentProtocol';
import type { AlignmentViewCheckpoints } from '../src/document/alignmentViews';
import { AdmissionError, ResourceLedger, type ResourceLease } from '../src/document/resources';
import type { SavedViewRecord } from '../src/io/savedView';
import { SOURCE_FINGERPRINT_SCHEME, type SourceFingerprint } from '../src/io/fingerprint';
import type { OperationOwner } from '../src/document/operationProtocol';

vi.mock('../src/io/thumbnail', () => ({ createSavedThumbnail: vi.fn(async () => ({
  image: new Blob(['thumb'], { type: 'image/png' }),
  thumbnail: { type: 'image/png', width: 256, height: 256, byteLength: 5, sha256: 'b'.repeat(64) },
  dispose: vi.fn(),
})) }));

// This file isolates controller ownership/publication using transport and GPU
// doubles. Native geometry, contributor math and camera parity have linked and
// browser fixtures elsewhere; no editable Gaussian model exists in this fake.
const initial = useApp.getState();
const DEFAULT_CAMERA = [0, 0, 0, .25, .125, 6, 2, 45, 0, .375, 2];
const PICKED: [number, number, number] = [2, 3, 4];
function frame(x = 0, y = 0, z = 0): AlignmentFrame {
  const result = [...IDENTITY_ALIGNMENT_FRAME]; result[12] = x; result[13] = y; result[14] = z;
  return result as unknown as AlignmentFrame;
}
function alignment(value = frame(), branchId = 0, canReset = false, retainedBranchIds = branchId ? [0, branchId] : [0]): AlignmentSummary {
  return { version: 2, frame: value, branchId, canReset, retainedBranchIds };
}
function summary(patch: Partial<NativeSummary> = {}): NativeSummary {
  return { ok: true, duplicateRange: null, loaded: true, count: 3, sourceCount: 3, shDegree: 0, format: 'ply', kind: 0,
    selected: 0, visible: 3, canUndo: true, canRedo: true, revision: 1, contentRevision: 0,
    transaction: false, selectionDraft: false, sceneChanged: false, pending: false, progress: 1,
    center: [0, 0, 0], radius: 2, yUp: false, camera: [...DEFAULT_CAMERA], memoryBytes: 500,
    selectionMapId: null, pendingSelectionMapId: null, selectionMapBytes: 0, selectionMapRetainedIds: [],
    alignment: alignment(), floor: null, filter: null, transformSession: null, opacitySession: null, ...patch };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
type Internals = {
  generation: number; ledger: ResourceLedger; releaseHistory?: ResourceLease; savedViewRecord?: SavedViewRecord;
  alignmentOwner?: { point?: readonly [number, number, number]; scene: unknown; revision: Revision };
  alignmentDefaultCamera?: number[]; fingerprint?: Readonly<SourceFingerprint>;
  alignmentViews: AlignmentViewCheckpoints; alignmentViewsLease?: ResourceLease;
  viewStorage: { put(record: SavedViewRecord, image: Blob, operation: unknown): Promise<void> };
  editingFailed: boolean;
};
function fixture(start = summary()) {
  const controller = new AppController(), internal = controller as unknown as Internals;
  let native = structuredClone(start), checkpoint: NativeSummary | undefined;
  let terminal: Partial<NativeSummary> | undefined, onStream: (() => void) | undefined;
  let commitReply: ((value: NativeSummary) => NativeSummary) | undefined;
  let failure: 'upload' | 'allocation' | 'fence' | 'admission' | 'commit' | undefined;
  let rollbackJoin: Promise<void> | undefined, pointJoin: Promise<NativeSummary['point']> | undefined;
  let normalJoin: Promise<NativeSummary['point']> | undefined;
  const events: string[] = [];
  let cameraValues = [...DEFAULT_CAMERA];
  const camera = { revision: 1, clearInput: vi.fn(), background: 'black' as 'black' | 'gray' | 'white',
    get state() { return [...cameraValues]; },
    // Transport double only. Actual camera reconstruction is qualified by the
    // linked camera boundary and browser fixtures, rather than this fake.
    frameChange: vi.fn((before: readonly number[], after: readonly number[]) => [...alignmentFrameChange(before, after)]),
    orientationFrameChange: vi.fn((_before: readonly number[], _after: readonly number[]) => [...IDENTITY_ALIGNMENT_FRAME]),
    transformState: vi.fn((state: readonly number[], matrix: readonly number[]) => state.map((value, index) =>
      index < 3 ? Math.fround(Math.fround(value) * matrix[index * 5] + matrix[12 + index]) :
        index === 5 || index === 6 ? Math.fround(value * matrix[0]) : value)),
    set: vi.fn((values: number[]) => { events.push('camera-publication'); cameraValues = values.map(Math.fround); camera.revision++; }),
    orbit: vi.fn(() => { cameraValues[3] = -.75; cameraValues[4] = .5; camera.revision++; }),
    pan: vi.fn(() => { cameraValues[0] += 4; cameraValues[1] -= 2; cameraValues[2] += 1; camera.revision++; }),
    aspect: vi.fn((aspect: number) => { cameraValues[10] = Math.fround(aspect); camera.revision++; }),
    navigate(values: number[]) { cameraValues = [...values]; camera.revision++; },
  };
  const makeScene = (name: string) => ({ kind: 'gaussian', setDuplicateRange: vi.fn(), count: 3, degree: 0, sourceRevision: 1, allocationBytes: 800,
    upload: vi.fn(async () => { events.push(`${name}-upload`); if (failure === 'upload') { failure = undefined; throw new Error('Injected upload failure'); } }),
    masks: vi.fn(), stageMasks: vi.fn(),
    dispose: vi.fn(async () => { events.push(`${name}-dispose`); }),
  });
  const base = makeScene('base'), staged: ReturnType<typeof makeScene>[] = [];
  const renderer = { lost: false, deviceEpoch: 8,
    canvas: { width: 800, height: 400, getBoundingClientRect: () => ({ width: 400, height: 200 }) },
    render: vi.fn(), pick: vi.fn(async () => ({ index: 1 as number | null, deviceEpoch: renderer.deviceEpoch })),
    captureRgba: vi.fn(async () => ({ width: 1, height: 1, pixels: new Uint8ClampedArray(4), dispose: vi.fn() })),
    device: { queue: { onSubmittedWorkDone: vi.fn(async () => {
      events.push('gpu-fence');
      if (failure === 'fence') { failure = undefined; throw new Error('Injected completion fence failure'); }
    }) } },
    allocateScene: vi.fn(async () => {
      events.push('gpu-allocation');
      if (failure === 'allocation') { failure = undefined; throw new AdmissionError('Injected candidate admission failure'); }
      const scene = makeScene(`candidate-${staged.length}`); staged.push(scene); return scene;
    }),
  };
  const revision: Revision = { documentId: 'alignment-units', sourceGeneration: 1,
    contentRevision: 0, selectionRevision: 0, draftRevision: 0 };
  const command = vi.fn(async (request: SceneCommand): Promise<NativeSummary> => {
    events.push(request.command);
    const previousRevision = native.revision, previousContent = native.contentRevision;
    if (request.command === 'beginTransaction') { checkpoint = structuredClone(native); native = { ...native, transaction: true }; }
    else if (request.command === 'commitTransaction') {
      // This fixture models an explicit prepublication commit refusal whose
      // checkpoint remains executable; unknown durable acknowledgements have
      // separate operation-reconciliation requirements.
      if (failure === 'commit') { failure = undefined; throw new Error('Injected native commit refusal'); }
      checkpoint = undefined; native = { ...native, transaction: false, sceneChanged: false };
    } else if (request.command === 'rollbackTransaction') {
      await rollbackJoin; native = checkpoint!; checkpoint = undefined; events.push('rollback-acknowledged');
    } else if (request.command === 'point') {
      const point: NativeSummary['point'] = pointJoin ? await pointJoin : [...PICKED]; return { ...native, point };
    } else if (request.command === 'planeNormal') {
      const point: NativeSummary['point'] = normalJoin ? await normalJoin : [0, 1, 0]; return { ...native, point };
    } else if (request.command === 'grade') {
      const values = request.values as number[];
      native = { ...native, revision: native.revision + 1, contentRevision: native.contentRevision + 1, sceneChanged: true,
        canRedo: false, colorSession: { version: 1, active: true, sessionId: 1, baseId: 2, epochId: 3,
          selectedOnly: false, values: [...values], applied: [...values], pending: false } };
    } else if (request.command === 'endColor') native = { ...native, colorSession: null };
    else if (['alignCenter', 'alignScale', 'alignPlane', 'resetAlignment', 'undo', 'redo'].includes(request.command)) {
      const scaled = [...frame(-3, -3, -4)]; scaled[0] = scaled[5] = scaled[10] = 2;
      native = { ...native, revision: native.revision + 1, contentRevision: native.contentRevision + 1, sceneChanged: true,
        memoryBytes: 950, canRedo: false,
        alignment: request.command === 'resetAlignment' ? alignment() : request.command === 'alignScale' ?
          alignment(scaled as unknown as AlignmentFrame, 2, true) : request.command === 'alignPlane' ?
            alignment(frame(-2, -3, -4), 3, true) : alignment(frame(-2, -3, -4), 1, true), ...terminal };
      terminal = undefined;
    }
    // Reconciliation counters remain monotone even when native content/history
    // returns to a checkpoint, matching the real client's owner invalidation.
    if (native.revision !== previousRevision) revision.selectionRevision++;
    if (native.contentRevision !== previousContent) revision.contentRevision++;
    if (request.command === 'commitTransaction' && commitReply) return commitReply(native);
    return native;
  });
  const stream = vi.fn(async (chunk: (first: number, count: number, bytes: ArrayBuffer) => Promise<void>, masks: (bytes: ArrayBuffer) => void) => {
    events.push('stream'); onStream?.(); await chunk(0, 3, new ArrayBuffer(144)); masks(new ArrayBuffer(3)); return native;
  });
  let operationSequence = 0, operationOwner: OperationOwner | undefined;
  let operationPhase: 'created' | 'active' | 'terminal' | undefined;
  const owned = (owner: OperationOwner) => {
    if (owner !== operationOwner) throw new Error('The fixture operation owner changed.');
  };
  // Route the typed lifecycle through the same command model so existing
  // refusal, rollback and held-acknowledgement observations remain executable.
  // This transport double does not manufacture a durable native receipt.
  const client = { command, stream, revision, operationResolution: undefined,
    createOperation: vi.fn((): OperationOwner => {
      if (operationOwner) throw new Error('Finish the fixture operation first.');
      operationOwner = { version: 1, documentId: revision.documentId, sourceGeneration: revision.sourceGeneration,
        clientGeneration: '11111111-1111-4111-8111-111111111111', operationId: ++operationSequence };
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
    cancel: vi.fn(), readMasks: vi.fn(),
    assertNativeAdmission: vi.fn(), updateNativeCoverage: vi.fn(), setNativeWork: vi.fn(),
    transferNativeCoverage: vi.fn(() => {
      events.push('coverage-transfer');
      if (failure === 'admission') { failure = undefined; throw new AdmissionError('Injected retained-history admission failure'); }
    }), releaseNativeCoverage: vi.fn((lease: () => void) => lease()) };
  controller.client = client as unknown as NonNullable<AppController['client']>;
  controller.scene = base as unknown as NonNullable<AppController['scene']>;
  controller.renderer = renderer as unknown as NonNullable<AppController['renderer']>;
  controller.camera = camera as unknown as NonNullable<AppController['camera']>;
  setApp({ summary: structuredClone(start) });
  return { controller, internal, camera, renderer, client, base, staged, events, native: () => native,
    next: (patch: Partial<NativeSummary>) => { terminal = patch; }, fail: (kind: typeof failure) => { failure = kind; },
    joinRollback: (promise: Promise<void>) => { rollbackJoin = promise; },
    joinPoint: (promise: Promise<NativeSummary['point']>) => { pointJoin = promise; },
    joinNormal: (promise: Promise<NativeSummary['point']>) => { normalJoin = promise; },
    alterCommitReply: (callback: (value: NativeSummary) => NativeSummary) => { commitReply = callback; },
    onStream: (callback: () => void) => { onStream = callback; } };
}
type Fixture = ReturnType<typeof fixture>;
beforeEach(() => {
  vi.stubGlobal('document', { title: '', hidden: true });
  setApp({ ...initial, ready: true, busy: false, rendererState: 'ready', summary: summary(), dirty: false,
    grade: [...NEUTRAL_COLOR], appliedGrade: [...NEUTRAL_COLOR], colorSession: null, colorSelectedOnly: false,
    gradeRevision: 0, settingsOpen: false, exportOpen: false, outputPending: false, navigationPrompt: false,
    selectionRecovery: 'idle', memoryOverageBytes: 0, pendingSelectionCount: 0, selectionDragging: false,
    alignmentTool: null, alignmentPoint: null, alignmentSecondPoint: null, alignmentThirdPoint: null,
    alignmentNormal: null, alignmentFlip: false, alignmentPicking: false }, true);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); setApp(initial, true); });
async function picked(value: Fixture) {
  expect(await value.controller.startCenterAlignment()).toBe(true);
  expect(await value.controller.pickAlignmentPoint(120, 80)).toBe(true);
  expect(useApp.getState().alignmentPoint).toEqual(PICKED);
}

async function scalePicked(value: Fixture) {
  expect(await value.controller.startScaleAlignment()).toBe(true);
  expect(await value.controller.pickAlignmentPoint(120, 80)).toBe(true);
  value.joinPoint(Promise.resolve([4, 3, 4]));
  expect(await value.controller.pickAlignmentPoint(200, 80)).toBe(true);
  expect(useApp.getState()).toMatchObject({ alignmentTool: 'scale', alignmentPoint: PICKED,
    alignmentSecondPoint: [4, 3, 4], alignmentTargetDistance: 2 });
}

describe('two-point Scale controller ownership', () => {
  it('initializes the native float32 measured target and edits it without baking or moving the popup point owner', async () => {
    const value = fixture(); await scalePicked(value);
    const first = useApp.getState().alignmentPoint, second = useApp.getState().alignmentSecondPoint;
    const calls = value.client.command.mock.calls.length;
    value.controller.setAlignmentTargetDistance(4);
    expect(useApp.getState().alignmentTargetDistance).toBe(4);
    expect(useApp.getState().alignmentPoint).toBe(first); expect(useApp.getState().alignmentSecondPoint).toBe(second);
    expect(value.client.command).toHaveBeenCalledTimes(calls); expect(value.renderer.allocateScene).not.toHaveBeenCalled();
  });
  it('retains the rounded initial target that produces a nonidentity native scale factor', async () => {
    const value = fixture(); expect(await value.controller.startScaleAlignment()).toBe(true);
    value.joinPoint(Promise.resolve([0, 0, 0])); expect(await value.controller.pickAlignmentPoint(1, 1)).toBe(true);
    value.joinPoint(Promise.resolve([1, 1, 4])); expect(await value.controller.pickAlignmentPoint(2, 2)).toBe(true);
    expect(useApp.getState().alignmentTargetDistance).toBe(4.242640495300293);
    // This value is separately emitted by actual captured scaleFromPoints, rather than a unit fake.
    expect(Math.fround(useApp.getState().alignmentTargetDistance! / Math.sqrt(18))).toBe(.9999999403953552);
  });
  it('removes only the last duplicate point, retains a typed target, and ignores a distinct third point', async () => {
    const value = fixture(); await scalePicked(value); value.controller.setAlignmentTargetDistance(4);
    value.joinPoint(Promise.resolve([8, 3, 4])); expect(await value.controller.pickAlignmentPoint(250, 80)).toBe(false);
    expect(useApp.getState().alignmentSecondPoint).toEqual([4, 3, 4]);
    value.joinPoint(Promise.resolve([4, 3, 4])); expect(await value.controller.pickAlignmentPoint(200, 80)).toBe(false);
    expect(useApp.getState()).toMatchObject({ alignmentPoint: PICKED, alignmentSecondPoint: null, alignmentTargetDistance: 4 });
    expect(useApp.getState().error).toBe('Pick a different point.');
    value.joinPoint(Promise.resolve(PICKED)); expect(await value.controller.pickAlignmentPoint(120, 80)).toBe(false);
    expect(useApp.getState()).toMatchObject({ alignmentPoint: null, alignmentSecondPoint: null, alignmentTargetDistance: 4 });
  });
  it('Backspace retains the target while right-click clearing removes the pair and target without exiting', async () => {
    const value = fixture(); await scalePicked(value); value.controller.setAlignmentTargetDistance(4);
    value.controller.clearAlignmentPoint();
    expect(useApp.getState()).toMatchObject({ alignmentTool: 'scale', alignmentPoint: PICKED, alignmentSecondPoint: null, alignmentTargetDistance: 4 });
    value.controller.clearAlignmentPoints();
    expect(useApp.getState()).toMatchObject({ alignmentTool: 'scale', alignmentPoint: null, alignmentSecondPoint: null, alignmentTargetDistance: null });
    expect(await value.controller.confirmAlignment()).toBe(false);
    value.controller.cancelAlignment(); expect(useApp.getState().alignmentTool).toBeNull();
  });
  it('refuses incomplete or invalid targets, then publishes only after the native frame and GPU fence', async () => {
    const value = fixture(); expect(await value.controller.startScaleAlignment()).toBe(true);
    expect(await value.controller.pickAlignmentPoint(120, 80)).toBe(true);
    expect(await value.controller.confirmAlignment()).toBe(false);
    value.joinPoint(Promise.resolve([4, 3, 4])); expect(await value.controller.pickAlignmentPoint(200, 80)).toBe(true);
    for (const target of [null, 0, -1, NaN, Infinity, 1e40]) {
      value.controller.setAlignmentTargetDistance(target); expect(await value.controller.confirmAlignment()).toBe(false);
    }
    expect(value.renderer.allocateScene).not.toHaveBeenCalled();
    value.controller.setAlignmentTargetDistance(4); expect(await value.controller.confirmAlignment()).toBe(true);
    expect(value.client.command.mock.calls.find(([request]) => request.command === 'alignScale')?.[0]).toMatchObject({
      points: [PICKED, [4, 3, 4]], target: 4, camera: DEFAULT_CAMERA, defaultCamera: DEFAULT_CAMERA });
    expect(value.camera.frameChange).toHaveBeenCalledTimes(2);
    expect(value.events.indexOf('camera-publication')).toBeGreaterThan(value.events.indexOf('commitTransaction'));
    expect(value.events.indexOf('commitTransaction')).toBeGreaterThan(value.events.indexOf('gpu-fence'));
    expect(useApp.getState()).toMatchObject({ alignmentTool: null, alignmentPoint: null, alignmentSecondPoint: null, alignmentTargetDistance: null });
  });
  it.each(['upload', 'allocation', 'fence', 'admission', 'commit'] as const)('preserves the pair, target, camera and executable Redo after %s refusal', async failure => {
    const value = fixture(); await scalePicked(value); value.controller.setAlignmentTargetDistance(4);
    const before = structuredClone(value.native()), camera = value.camera.state;
    value.fail(failure); expect(await value.controller.confirmAlignment()).toBe(false);
    expect(value.native()).toEqual(before); expect(value.camera.state).toEqual(camera);
    expect(value.camera.set).not.toHaveBeenCalled(); expect(value.controller.scene).toBe(value.base);
    expect(useApp.getState()).toMatchObject({ alignmentTool: 'scale', alignmentPoint: PICKED,
      alignmentSecondPoint: [4, 3, 4], alignmentTargetDistance: 4 });
    expect(await value.controller.confirmAlignment()).toBe(true);
  });
  it('joins cancellation rollback without publishing a Scale camera or discarding its retained pair', async () => {
    const value = fixture(); await scalePicked(value); value.controller.setAlignmentTargetDistance(4);
    const before = structuredClone(value.native()), camera = value.camera.state;
    value.onStream(() => value.controller.cancelEdit());
    expect(await value.controller.confirmAlignment()).toBe(false);
    expect(value.native()).toEqual(before); expect(value.camera.state).toEqual(camera);
    expect(value.camera.set).not.toHaveBeenCalled();
    expect(useApp.getState()).toMatchObject({ alignmentTool: 'scale', alignmentPoint: PICKED,
      alignmentSecondPoint: [4, 3, 4], alignmentTargetDistance: 4 });
  });
});

async function planePair(value: Fixture) {
  expect(await value.controller.startPlaneAlignment()).toBe(true);
  expect(await value.controller.pickAlignmentPoint(120, 80)).toBe(true);
  value.joinPoint(Promise.resolve([4, 3, 4]));
  expect(await value.controller.pickAlignmentPoint(200, 80)).toBe(true);
}
async function planePicked(value: Fixture) {
  await planePair(value); value.joinPoint(Promise.resolve([2, 3, 6]));
  expect(await value.controller.pickAlignmentPoint(120, 160)).toBe(true);
}
describe('three-point Align plane controller ownership', () => {
  it('queries a native normal only for the third point and keeps Flip/navigation free of scene work', async () => {
    const value = fixture(); await planePair(value);
    expect(value.client.command.mock.calls.some(([request]) => request.command === 'planeNormal')).toBe(false);
    value.joinPoint(Promise.resolve([2, 3, 6])); expect(await value.controller.pickAlignmentPoint(120, 160)).toBe(true);
    const state = useApp.getState(), calls = value.client.command.mock.calls.length, before = structuredClone(value.native());
    expect(state).toMatchObject({ alignmentTool: 'align', alignmentThirdPoint: [2, 3, 6], alignmentNormal: [0, 1, 0], alignmentFlip: false });
    expect(value.client.command).toHaveBeenCalledWith({ command: 'planeNormal', points: [PICKED, [4, 3, 4], [2, 3, 6]] });
    value.controller.setAlignmentFlip(true); value.camera.orbit(); value.camera.pan(); value.controller.invalidate();
    expect(useApp.getState().alignmentNormal).toBe(state.alignmentNormal);
    expect(useApp.getState().alignmentThirdPoint).toBe(state.alignmentThirdPoint);
    expect(useApp.getState().alignmentFlip).toBe(true);
    expect(value.client.command).toHaveBeenCalledTimes(calls); expect(value.native()).toEqual(before);
    expect(value.renderer.allocateScene).not.toHaveBeenCalled(); expect(value.camera.set).not.toHaveBeenCalled();
  });
  it('rejects a degenerate third point while preserving two picks and permits a later valid candidate', async () => {
    const value = fixture(); await planePair(value);
    const normal = deferred<NativeSummary['point']>(); value.joinNormal(normal.promise);
    value.joinPoint(Promise.resolve([6, 3, 4])); const picking = value.controller.pickAlignmentPoint(250, 80);
    await vi.waitFor(() => expect(value.client.command.mock.calls.at(-1)?.[0].command).toBe('planeNormal'));
    normal.reject(new Error('Pick three non-collinear points.')); expect(await picking).toBe(false);
    expect(useApp.getState()).toMatchObject({ alignmentPoint: PICKED, alignmentSecondPoint: [4, 3, 4],
      alignmentThirdPoint: null, alignmentNormal: null, alignmentPicking: false });
    expect(await value.controller.confirmAlignment()).toBe(false);
    value.joinNormal(Promise.resolve([0, 1, 0])); value.joinPoint(Promise.resolve([2, 3, 6]));
    expect(await value.controller.pickAlignmentPoint(120, 160)).toBe(true);
    expect(value.native().alignment?.branchId).toBe(0); expect(value.renderer.allocateScene).not.toHaveBeenCalled();
  });
  it.each(['camera', 'viewport', 'device', 'edit', 'source', 'cancel', 'backspace'] as const)(
    'discards a late normal when the %s owner changes without installing the third point', async boundary => {
      const value = fixture(); await planePair(value); const normal = deferred<NativeSummary['point']>();
      value.joinNormal(normal.promise); value.joinPoint(Promise.resolve([2, 3, 6]));
      const picking = value.controller.pickAlignmentPoint(120, 160);
      await vi.waitFor(() => expect(value.client.command.mock.calls.at(-1)?.[0].command).toBe('planeNormal'));
      if (boundary === 'camera') value.camera.pan();
      else if (boundary === 'viewport') value.renderer.canvas.width++;
      else if (boundary === 'device') value.renderer.deviceEpoch++;
      else if (boundary === 'edit') value.client.revision.contentRevision++;
      else if (boundary === 'source') value.internal.generation++;
      else if (boundary === 'backspace') value.controller.clearAlignmentPoint();
      else value.controller.cancelAlignment();
      normal.resolve([0, 1, 0]); expect(await picking).toBe(false);
      expect(useApp.getState()).toMatchObject({ alignmentThirdPoint: null, alignmentNormal: null, alignmentPicking: false });
      expect(value.renderer.allocateScene).not.toHaveBeenCalled(); expect(value.camera.set).not.toHaveBeenCalled();
    });
  it('ignores extra distinct picks, pops the latest duplicate and retains Flip through clear until cancellation', async () => {
    const value = fixture(); await planePicked(value); value.controller.setAlignmentFlip(true);
    value.joinPoint(Promise.resolve([8, 7, 6])); expect(await value.controller.pickAlignmentPoint(300, 180)).toBe(false);
    expect(useApp.getState().alignmentThirdPoint).toEqual([2, 3, 6]);
    value.joinPoint(Promise.resolve([2, 3, 6])); expect(await value.controller.pickAlignmentPoint(120, 160)).toBe(false);
    expect(useApp.getState()).toMatchObject({ alignmentPoint: PICKED, alignmentSecondPoint: [4, 3, 4],
      alignmentThirdPoint: null, alignmentNormal: null, alignmentFlip: true });
    value.controller.clearAlignmentPoint(); expect(useApp.getState().alignmentSecondPoint).toBeNull();
    value.controller.clearAlignmentPoints(); expect(useApp.getState()).toMatchObject({ alignmentTool: 'align', alignmentPoint: null, alignmentFlip: true });
    value.controller.cancelAlignment(); expect(useApp.getState()).toMatchObject({ alignmentTool: null, alignmentFlip: false });
  });
  it('publishes upright active/default rolls and checkpoints only after the GPU fence and native commit', async () => {
    const value = fixture(); await planePicked(value); value.controller.setAlignmentFlip(true);
    const before = value.internal.alignmentViews, fence = deferred<void>();
    value.renderer.device.queue.onSubmittedWorkDone.mockImplementationOnce(() => fence.promise);
    const confirming = value.controller.confirmAlignment();
    await vi.waitFor(() => expect(value.renderer.device.queue.onSubmittedWorkDone).toHaveBeenCalledOnce());
    expect(value.internal.alignmentViews).toBe(before); expect(value.camera.set).not.toHaveBeenCalled();
    fence.resolve(); expect(await confirming).toBe(true);
    expect(value.client.command.mock.calls.find(([request]) => request.command === 'alignPlane')?.[0]).toMatchObject({
      points: [PICKED, [4, 3, 4], [2, 3, 6]], flip: true, camera: DEFAULT_CAMERA, defaultCamera: DEFAULT_CAMERA });
    expect(value.camera.state[9]).toBe(0); expect(value.internal.alignmentDefaultCamera?.[9]).toBe(0);
    expect(value.internal.alignmentViews.get(0)).toMatchObject({ activeRoll: .375, defaultRoll: .375, corrected: false });
    expect(value.internal.alignmentViews.get(3)).toMatchObject({ activeRoll: 0, defaultRoll: 0, corrected: true });
    expect(value.events.indexOf('camera-publication')).toBeGreaterThan(value.events.indexOf('commitTransaction'));
    expect(useApp.getState()).toMatchObject({ alignmentTool: null, alignmentThirdPoint: null, alignmentNormal: null, alignmentFlip: false });
  });
  it('refuses Reset camera while a released native commit acknowledgement awaits publication', async () => {
    const value = fixture(); await planePicked(value);
    const original = value.client.command.getMockImplementation()!, acknowledgement = deferred<void>();
    let released = false;
    value.client.command.mockImplementation(async request => {
      const result = await original(request);
      if (request.command === 'commitTransaction') { released = true; await acknowledgement.promise; }
      return result;
    });
    const camera = value.camera.state, checkpoints = value.internal.alignmentViews;
    const confirmation = value.controller.confirmAlignment();
    await vi.waitFor(() => expect(released).toBe(true));
    expect(value.native().transaction).toBe(false); expect(useApp.getState().busy).toBe(true);
    value.controller.resetCamera();
    expect(value.camera.state).toEqual(camera); expect(value.camera.set).not.toHaveBeenCalled();
    expect(value.internal.alignmentViews).toBe(checkpoints);
    acknowledgement.resolve(); expect(await confirmation).toBe(true);
    expect(value.camera.state[9]).toBe(0); expect(value.internal.alignmentViews.get(3)?.corrected).toBe(true);
  });
  it('joins metadata-admission refusal without replacing the previous roll-map lease', async () => {
    const value = fixture(); await planePicked(value); expect(await value.controller.confirmAlignment()).toBe(true);
    await planePicked(value);
    const before = structuredClone(value.native()), camera = value.camera.state;
    const checkpoints = value.internal.alignmentViews, lease = value.internal.alignmentViewsLease!, usage = value.internal.ledger.usage.bytes;
    value.next({ alignment: alignment(frame(-5, -6, -7), 4, true, [0, 3, 4]) });
    const reserve = value.internal.ledger.reserve.bind(value.internal.ledger); let refused = false;
    vi.spyOn(value.internal.ledger, 'reserve').mockImplementation((category, bytes) => {
      if (!refused && category === 'history' && bytes === 34 * 1024) { refused = true; throw new AdmissionError('Roll metadata admission refused'); }
      return reserve(category, bytes);
    });
    expect(await value.controller.confirmAlignment()).toBe(false); expect(refused).toBe(true);
    expect(value.native()).toEqual(before); expect(value.camera.state).toEqual(camera);
    expect(value.internal.alignmentViews).toBe(checkpoints); expect(value.internal.alignmentViewsLease).toBe(lease);
    expect(lease.bytes).toBe(34 * 1024); expect(value.internal.ledger.usage.bytes).toBe(usage);
  });
  it.each(['upload', 'allocation', 'fence', 'admission', 'commit'] as const)(
    'retains the candidate, roll checkpoints and camera after %s refusal, then permits retry', async failure => {
      const value = fixture(); await planePicked(value); value.controller.setAlignmentFlip(true);
      const native = structuredClone(value.native()), camera = value.camera.state, checkpoints = value.internal.alignmentViews;
      const resources = value.internal.ledger.usage.bytes;
      value.fail(failure); expect(await value.controller.confirmAlignment()).toBe(false);
      expect(value.native()).toEqual(native); expect(value.camera.state).toEqual(camera);
      expect(value.internal.alignmentViews).toBe(checkpoints); expect(value.internal.alignmentViewsLease).toBeUndefined();
      expect(value.internal.ledger.usage.bytes).toBe(resources);
      expect(useApp.getState()).toMatchObject({ alignmentTool: 'align', alignmentThirdPoint: [2, 3, 6], alignmentNormal: [0, 1, 0], alignmentFlip: true });
      expect(value.native().canRedo).toBe(true); expect(await value.controller.confirmAlignment()).toBe(true);
    });
  it('restores intentional rolls through Undo/Redo while carrying current navigation and starts active roll lineage from Reset camera', async () => {
    const value = fixture(); await planePicked(value); expect(await value.controller.confirmAlignment()).toBe(true);
    value.camera.navigate([8, 9, 10, -.75, .5, 12, 3, 70, 0, -.625, 2]);
    value.next({ alignment: alignment(frame(), 0, false, [0, 3]) });
    expect(await value.controller.command({ command: 'undo' })).toBe(true);
    expect(value.camera.state).toEqual([10, 12, 14, -.75, .5, 12, 3, 70, 0, .375, 2]);
    expect(value.internal.alignmentDefaultCamera?.[9]).toBe(.375);
    value.camera.navigate([20, 30, 40, .75, -.5, 18, 4, 63, 0, .875, 2]);
    value.next({ alignment: alignment(frame(-2, -3, -4), 3, true, [0, 3]) });
    expect(await value.controller.command({ command: 'redo' })).toBe(true);
    expect(value.camera.state).toEqual([18, 27, 36, .75, -.5, 18, 4, 63, 0, 0, 2]);
    const entries = new Map(value.internal.alignmentViews);
    entries.set(0, Object.freeze({ ...entries.get(0)!, activeRoll: -.5, defaultRoll: .25 }));
    entries.set(3, Object.freeze({ ...entries.get(3)!, activeRoll: .75, defaultRoll: -.25 }));
    value.internal.alignmentViews = entries; value.controller.resetCamera();
    expect(value.internal.alignmentViews.get(0)?.activeRoll).toBe(.25);
    expect(value.internal.alignmentViews.get(3)?.activeRoll).toBe(-.25);
    expect(entries.get(0)?.activeRoll).toBe(-.5); expect(entries.get(3)?.activeRoll).toBe(.75);
  });
  it('prepares all default-roll replacements before storage and leaves defaults/checkpoints unchanged on orientation refusal', async () => {
    const value = fixture(); await planePicked(value); expect(await value.controller.confirmAlignment()).toBe(true);
    value.internal.fingerprint = { scheme: SOURCE_FINGERPRINT_SCHEME, assetDigest: 'a'.repeat(64), resourceCount: 1, totalBytes: 3, sourceKindHint: 'ply' };
    const put = vi.fn(async () => {}); value.internal.viewStorage = { put };
    const checkpoints = value.internal.alignmentViews, defaultCamera = value.internal.alignmentDefaultCamera, usage = value.internal.ledger.usage.bytes;
    value.camera.orientationFrameChange.mockImplementationOnce(() => { throw new Error('Orientation reconstruction refused'); });
    expect(await value.controller.updateThumbnail()).toBe(false);
    expect(put).not.toHaveBeenCalled(); expect(value.renderer.captureRgba).not.toHaveBeenCalled();
    expect(value.internal.alignmentViews).toBe(checkpoints); expect(value.internal.alignmentDefaultCamera).toBe(defaultCamera);
    expect(value.internal.ledger.usage.bytes).toBe(usage);
    value.camera.navigate([8, 9, 10, -.75, .5, 12, 3, 70, 0, -.625, 2]);
    expect(await value.controller.updateThumbnail()).toBe(true); expect(put).toHaveBeenCalledOnce();
    expect([...value.internal.alignmentViews.values()].map(entry => entry.defaultRoll)).toEqual([-.625, -.625]);
    expect([...value.internal.alignmentViews.values()].map(entry => entry.activeRoll)).toEqual([.375, 0]);
    expect([...checkpoints.values()].map(entry => entry.defaultRoll)).toEqual([.375, 0]);
  });
});

describe('unpublished native camera transform results', () => {
  it('publishes the separately prepared active and default native poses after commit', async () => {
    const value = fixture(); await picked(value);
    const active = [-2, -3, -4, .625, -.375, 8, 2.5, 61, 1, .75, 2].map(Math.fround);
    const savedDefault = [-5, -6, -7, -.625, .375, 9, 3.5, 63, 0, -.75, 2].map(Math.fround);
    value.camera.transformState.mockReturnValueOnce(active).mockReturnValueOnce(savedDefault);
    expect(await value.controller.confirmAlignment()).toBe(true);
    expect(value.camera.state).toEqual(active);
    expect(value.internal.alignmentDefaultCamera).toEqual(savedDefault);
    expect(value.camera.transformState).toHaveBeenCalledTimes(2);
    expect(value.events.indexOf('commitTransaction')).toBeLessThan(value.events.indexOf('camera-publication'));
  });
  it('joins rollback when native camera preparation refuses before publishing either camera', async () => {
    const value = fixture(); await picked(value);
    const before = structuredClone(useApp.getState().summary), active = value.camera.state;
    const savedDefault = [...DEFAULT_CAMERA]; value.internal.alignmentDefaultCamera = savedDefault;
    value.camera.transformState.mockImplementationOnce(() => { throw new Error('Native camera reconstruction refused'); });
    expect(await value.controller.confirmAlignment()).toBe(false);
    expect(value.events).toContain('rollback-acknowledged'); expect(value.events).not.toContain('commitTransaction');
    expect(value.controller.scene).toBe(value.base); expect(value.camera.state).toEqual(active);
    expect(value.internal.alignmentDefaultCamera).toBe(savedDefault);
    expect(useApp.getState().summary).toEqual(before); expect(useApp.getState().alignmentPoint).toEqual(PICKED);
    expect(value.internal.editingFailed).toBe(false); expect(value.native().canRedo).toBe(true);
    expect(value.staged.every(scene => scene.dispose.mock.calls.length === 1)).toBe(true);
  });
});

describe('Center contributor point ownership', () => {
  it.each(['camera', 'viewport', 'device', 'edit', 'source', 'scene', 'cancel'] as const)(
    'retires an awaited GPU result when its %s owner changes', async boundary => {
      const value = fixture(); expect(await value.controller.startCenterAlignment()).toBe(true);
      const hit = deferred<{ index: number; deviceEpoch: number }>(); value.renderer.pick.mockReturnValueOnce(hit.promise);
      const query = value.controller.pickAlignmentPoint(120, 80);
      expect(useApp.getState().alignmentPicking).toBe(true);
      if (boundary === 'camera') value.camera.orbit();
      else if (boundary === 'viewport') value.renderer.canvas.width++;
      else if (boundary === 'device') value.renderer.deviceEpoch++;
      else if (boundary === 'edit') value.client.revision.selectionRevision++;
      else if (boundary === 'source') value.internal.generation++;
      else if (boundary === 'scene') value.controller.scene = { ...value.base } as unknown as NonNullable<AppController['scene']>;
      else value.controller.cancelAlignment();
      hit.resolve({ index: 1, deviceEpoch: 8 }); expect(await query).toBe(false);
      expect(value.client.command).not.toHaveBeenCalled(); expect(useApp.getState().alignmentPoint).toBeNull();
      expect(useApp.getState().alignmentPicking).toBe(false); expect(value.camera.set).not.toHaveBeenCalled();
    });
  it.each(['camera', 'edit', 'cancel'] as const)('rejects a late native point after %s changes', async boundary => {
    const value = fixture(); expect(await value.controller.startCenterAlignment()).toBe(true);
    const point = deferred<NativeSummary['point']>(); value.joinPoint(point.promise);
    const query = value.controller.pickAlignmentPoint(120, 80);
    await vi.waitFor(() => expect(value.client.command).toHaveBeenCalledWith({ command: 'point', index: 1 }));
    if (boundary === 'camera') value.camera.pan();
    else if (boundary === 'edit') value.client.revision.contentRevision++;
    else value.controller.cancelAlignment();
    point.resolve([...PICKED]); expect(await query).toBe(false);
    expect(useApp.getState().alignmentPoint).toBeNull(); expect(useApp.getState().alignmentPicking).toBe(false);
  });
  it('uses the rendered contributor and copies its native world point through later orbit and pan', async () => {
    const value = fixture(); await picked(value);
    expect(value.renderer.render).toHaveBeenCalledBefore(value.renderer.pick);
    expect(value.renderer.pick).toHaveBeenCalledWith(value.base, 120, 80, 16);
    expect(value.client.command).toHaveBeenCalledWith({ command: 'point', index: 1 });
    const retained = value.internal.alignmentOwner!.point;
    expect(Object.isFrozen(retained)).toBe(true);
    value.camera.orbit(); value.camera.pan(); value.controller.invalidate();
    expect(value.internal.alignmentOwner!.point).toBe(retained); expect(useApp.getState().alignmentPoint).toEqual(PICKED);
    const currentCamera = value.camera.state;
    expect(await value.controller.confirmAlignment()).toBe(true);
    const request = value.client.command.mock.calls.find(([candidate]) => candidate.command === 'alignCenter')![0];
    expect(request.point).toEqual(PICKED); expect(request.camera).toEqual(currentCamera);
    expect(value.camera.state).toEqual([2, -5, -3, ...currentCamera.slice(3)]);
    expect(value.controller.scene).toBe(value.staged[0]); expect(value.base.dispose).toHaveBeenCalledOnce();
    expect(useApp.getState()).toMatchObject({ alignmentTool: null, alignmentPoint: null, alignmentPicking: false });
  });
  it('retires accepted points after edit/source changes and refuses picks before native admission', async () => {
    const value = fixture(); await picked(value);
    value.client.revision.selectionRevision++; value.controller.invalidate();
    expect(useApp.getState().alignmentPoint).toBeNull(); expect(useApp.getState().alignmentTool).toBeNull();
    expect(await value.controller.startCenterAlignment()).toBe(true);
    value.client.assertNativeAdmission.mockImplementationOnce(() => { throw new AdmissionError('No native headroom'); });
    expect(await value.controller.pickAlignmentPoint(1, 1)).toBe(false);
    expect(value.renderer.pick).toHaveBeenCalledOnce();
    value.internal.generation++; value.controller.invalidate(); expect(useApp.getState().alignmentTool).toBeNull();
  });
});

describe('Center publication and joined rollback', () => {
  it.each(['missing', 'null', 'branch', 'frame', 'reset'] as const)(
    'refuses a committed %s metadata acknowledgement after checkpoint release without publishing or claiming rollback', async mismatch => {
      const value = fixture(); await picked(value);
      const before = structuredClone(useApp.getState().summary), camera = value.camera.state;
      const defaultOwner = [.009999999776482582, 7, 8, ...DEFAULT_CAMERA.slice(3)];
      value.internal.alignmentDefaultCamera = defaultOwner;
      const history = value.internal.ledger.reserve('history', 64); value.internal.releaseHistory = history;
      value.alterCommitReply(committed => {
        if (mismatch === 'missing') { const copy = { ...committed }; delete copy.alignment; return copy; }
        if (mismatch === 'null') return { ...committed, alignment: null };
        if (mismatch === 'branch') return { ...committed, alignment: { ...committed.alignment!, branchId: 999 } };
        if (mismatch === 'frame') return { ...committed, alignment: { ...committed.alignment!, frame: frame(-3, -3, -4) } };
        return { ...committed, alignment: { ...committed.alignment!, canReset: false } };
      });
      expect(await value.controller.confirmAlignment()).toBe(false);
      // This transport double reports a malformed terminal after the native
      // checkpoint was actually released. Reopen recovery is required; a
      // fabricated successful rollback would conceal mismatched owners.
      expect(value.native().transaction).toBe(false); expect(value.native().alignment?.branchId).toBe(1);
      expect(value.events).toContain('commitTransaction'); expect(value.events).not.toContain('rollbackTransaction');
      expect(value.events).not.toContain('camera-publication'); expect(value.controller.scene).toBe(value.base);
      expect(value.base.dispose).not.toHaveBeenCalled(); expect(value.staged[0].dispose).toHaveBeenCalledOnce();
      expect(value.camera.state).toEqual(camera); expect(value.internal.alignmentDefaultCamera).toBe(defaultOwner);
      expect(value.internal.releaseHistory).toBe(history); expect(useApp.getState().summary).toEqual(before);
      expect(value.internal.editingFailed).toBe(true); expect(useApp.getState().error).toContain('Reopen the source');
      const requests = value.client.command.mock.calls.length;
      expect(await value.controller.confirmAlignment()).toBe(false);
      expect(await value.controller.startCenterAlignment()).toBe(false);
      expect(value.client.command).toHaveBeenCalledTimes(requests); history();
    });
  it.each(['upload', 'allocation', 'fence', 'admission'] as const)(
    'joins native rollback after %s refusal while retaining data/camera/history/point and Redo', async failure => {
      const value = fixture(); await picked(value);
      const rollback = deferred<void>(); value.joinRollback(rollback.promise); value.fail(failure);
      const history = value.internal.ledger.reserve('history', 64); value.internal.releaseHistory = history;
      const before = structuredClone(useApp.getState().summary), camera = value.camera.state, owner = value.internal.alignmentOwner;
      let settled = false;
      const confirmation = value.controller.confirmAlignment().then(result => { settled = true; return result; });
      await vi.waitFor(() => expect(value.client.command.mock.calls.at(-1)?.[0].command).toBe('rollbackTransaction'));
      expect(settled).toBe(false); expect(useApp.getState().busy).toBe(true);
      expect(value.controller.scene).toBe(value.base); expect(value.camera.state).toEqual(camera);
      expect(value.camera.set).not.toHaveBeenCalled(); expect(value.base.dispose).not.toHaveBeenCalled();
      expect(value.internal.releaseHistory).toBe(history); expect(useApp.getState().summary).toEqual(before);
      expect(useApp.getState().alignmentPoint).toEqual(PICKED);
      expect(value.client.command.mock.calls.some(([request]) => request.command === 'commitTransaction')).toBe(false);
      rollback.resolve(); expect(await confirmation).toBe(false);
      expect(value.native().canRedo).toBe(true); expect(useApp.getState().summary?.canRedo).toBe(true);
      expect(useApp.getState().summary).toEqual(before); expect(value.internal.alignmentOwner).toBe(owner);
      expect(owner!.revision).toEqual(value.client.revision); expect(value.internal.editingFailed).toBe(false);
      expect(useApp.getState()).toMatchObject({ alignmentTool: 'center', alignmentPoint: PICKED, busy: false });
      for (const staged of value.staged) expect(staged.dispose).toHaveBeenCalledOnce();
      // A joined rollback advances transport revisions; the retained point is
      // still usable for an explicit retry, without another contributor pick.
      expect(await value.controller.confirmAlignment()).toBe(true);
      expect(value.renderer.pick).toHaveBeenCalledOnce(); history();
    });
  it('rejects an unsupported camera frame before native/GPU commit and keeps the picked point', async () => {
    const value = fixture(); await picked(value);
    const nonuniform: AlignmentFrame = [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    value.next({ alignment: alignment(nonuniform, 9, true) });
    const camera = value.camera.state;
    expect(await value.controller.confirmAlignment()).toBe(false);
    expect(value.events).toContain('gpu-fence'); expect(value.events).toContain('rollback-acknowledged');
    expect(value.events).not.toContain('commitTransaction'); expect(value.events).not.toContain('camera-publication');
    expect(value.controller.scene).toBe(value.base); expect(value.camera.state).toEqual(camera);
    expect(value.native().alignment?.branchId).toBe(0); expect(value.native().canRedo).toBe(true);
    expect(useApp.getState().alignmentPoint).toEqual(PICKED); expect(useApp.getState().error).toContain('uniform');
  });
  it('holds geometry/camera/history publication until the GPU completion fence acknowledges', async () => {
    const value = fixture(); await picked(value); const fence = deferred<void>();
    value.renderer.device.queue.onSubmittedWorkDone.mockImplementationOnce(() => fence.promise);
    const confirmation = value.controller.confirmAlignment();
    await vi.waitFor(() => expect(value.renderer.device.queue.onSubmittedWorkDone).toHaveBeenCalledOnce());
    expect(value.controller.scene).toBe(value.base); expect(value.camera.set).not.toHaveBeenCalled();
    expect(value.events).not.toContain('commitTransaction'); expect(value.base.dispose).not.toHaveBeenCalled();
    fence.resolve(); expect(await confirmation).toBe(true);
    expect(value.events.indexOf('commitTransaction')).toBeLessThan(value.events.indexOf('camera-publication'));
    expect(value.controller.scene).toBe(value.staged[0]);
  });
});

describe('color preview and modal boundaries around Center', () => {
  it('retires an accepted point when a manual grade actually changes without mutating native content or history', async () => {
    const value = fixture(summary({ alignment: alignment(frame(1, 2, 3), 8, true) })); await picked(value);
    const before = structuredClone(useApp.getState().summary), native = structuredClone(value.native());
    const camera = value.camera.state, requests = value.client.command.mock.calls.length;
    const warm = [...NEUTRAL_COLOR]; warm[0] = 1.25;
    value.controller.setGrade(warm);
    expect(useApp.getState()).toMatchObject({ alignmentTool: null, alignmentPoint: null, alignmentPicking: false, dirty: true });
    expect(value.internal.alignmentOwner).toBeUndefined(); expect(value.controller.colorPending).toBe(true);
    expect(useApp.getState().grade).toEqual(warm); expect(useApp.getState().summary).toEqual(before);
    expect(value.native()).toEqual(native); expect(value.native().canRedo).toBe(true);
    expect(value.client.command).toHaveBeenCalledTimes(requests);
    expect(value.camera.state).toEqual(camera); expect(value.renderer.allocateScene).not.toHaveBeenCalled();
    expect(await value.controller.confirmAlignment()).toBe(false);
    expect(value.client.command).toHaveBeenCalledTimes(requests);
  });
  it('retires a held contributor pick when a manual grade changes before its GPU result', async () => {
    const value = fixture(); expect(await value.controller.startCenterAlignment()).toBe(true);
    const hit = deferred<{ index: number; deviceEpoch: number }>(); value.renderer.pick.mockReturnValueOnce(hit.promise);
    const before = structuredClone(value.native()), query = value.controller.pickAlignmentPoint(1, 1);
    expect(useApp.getState().alignmentPicking).toBe(true);
    const warm = [...NEUTRAL_COLOR]; warm[0] = 1.25; value.controller.setGrade(warm);
    expect(useApp.getState()).toMatchObject({ alignmentTool: null, alignmentPoint: null, alignmentPicking: false });
    hit.resolve({ index: 1, deviceEpoch: 8 }); expect(await query).toBe(false);
    expect(value.client.command).not.toHaveBeenCalled(); expect(value.native()).toEqual(before);
    expect(useApp.getState().summary?.canRedo).toBe(true); expect(value.renderer.allocateScene).not.toHaveBeenCalled();
  });
  it('preserves the accepted point when all fifteen submitted values round to the current f32 grade', async () => {
    const value = fixture(); await picked(value); const owner = value.internal.alignmentOwner, point = owner!.point;
    const equivalent = [...NEUTRAL_COLOR]; equivalent[0] = 1 + Number.EPSILON;
    expect(equivalent[0]).not.toBe(NEUTRAL_COLOR[0]);
    value.controller.setGrade(equivalent);
    expect(useApp.getState().grade).toEqual(NEUTRAL_COLOR); expect(value.controller.colorPending).toBe(false);
    expect(value.internal.alignmentOwner).toBe(owner); expect(value.internal.alignmentOwner!.point).toBe(point);
    expect(useApp.getState()).toMatchObject({ alignmentTool: 'center', alignmentPoint: PICKED });
    expect(await value.controller.confirmAlignment()).toBe(true);
    expect(value.renderer.pick).toHaveBeenCalledOnce();
  });
  it('refuses Confirm and both Reset entry points for an injected pending preview without forwarding native alignment', async () => {
    const value = fixture(summary({ alignment: alignment(frame(1, 2, 3), 8, true) })); await picked(value);
    const before = structuredClone(value.native()), requests = value.client.command.mock.calls.length;
    const warm = [...NEUTRAL_COLOR]; warm[0] = 1.25;
    setApp({ grade: warm, gradeRevision: useApp.getState().gradeRevision + 1 });
    expect(value.controller.colorPending).toBe(true);
    expect(await value.controller.confirmAlignment()).toBe(false);
    expect(await value.controller.resetAlignment()).toBe(false);
    expect(await value.controller.command({ command: 'resetAlignment' })).toBe(false);
    expect(value.client.command).toHaveBeenCalledTimes(requests); expect(value.native()).toEqual(before);
    expect(useApp.getState().alignmentPoint).toEqual(PICKED); expect(value.renderer.allocateScene).not.toHaveBeenCalled();
  });
  it('refuses Confirm while a settled native color session still owns its active baseline', async () => {
    const value = fixture(); await picked(value); const requests = value.client.command.mock.calls.length;
    setApp({ colorSession: { version: 1, active: true, sessionId: 1, baseId: 2, epochId: 3, selectedOnly: false,
      values: [...NEUTRAL_COLOR], applied: [...NEUTRAL_COLOR], pending: false } });
    expect(value.controller.colorPending).toBe(false); expect(await value.controller.confirmAlignment()).toBe(false);
    expect(value.client.command).toHaveBeenCalledTimes(requests); expect(useApp.getState().alignmentPoint).toEqual(PICKED);
  });
  it('restores Reset eligibility when an unbaked preview returns to applied values and the native baseline stays current', async () => {
    const value = fixture(summary({ alignment: alignment(frame(1, 2, 3), 8, true) }));
    const before = structuredClone(value.native()), warm = [...NEUTRAL_COLOR]; warm[0] = 1.25;
    value.controller.setGrade(warm); expect(await value.controller.resetAlignment()).toBe(false);
    expect(value.client.command).not.toHaveBeenCalled(); expect(value.native()).toEqual(before);
    expect(useApp.getState().summary?.alignment?.canReset).toBe(true);
    value.controller.setGrade([...NEUTRAL_COLOR]);
    expect(value.controller.colorPending).toBe(false); expect(useApp.getState().dirty).toBe(false);
    expect(value.native()).toEqual(before); expect(await value.controller.resetAlignment()).toBe(true);
    expect(value.client.command.mock.calls.map(([request]) => request.command))
      .toEqual(['beginTransaction', 'resetAlignment', 'commitTransaction']);
    expect(useApp.getState().summary?.alignment?.canReset).toBe(false);
  });
  it.each(['settings', 'saved-choices', 'view-transfer'] as const)('refuses alignment actions while the %s modal owns the viewer', async modal => {
    const value = fixture(summary({ alignment: alignment(frame(1, 2, 3), 8, true) })); await picked(value);
    const requests = value.client.command.mock.calls.length;
    if (modal === 'settings') setApp({ settingsOpen: true });
    else if (modal === 'saved-choices') setApp({ savedViewChoices: [{} as SavedViewRecord] });
    else setApp({ viewTransferPending: true });
    expect(value.controller.alignmentControlsEnabled).toBe(false);
    expect(await value.controller.startCenterAlignment()).toBe(false);
    expect(await value.controller.confirmAlignment()).toBe(false);
    expect(await value.controller.resetAlignment()).toBe(false);
    expect(value.client.command).toHaveBeenCalledTimes(requests); expect(useApp.getState().alignmentPoint).toEqual(PICKED);
  });
});

describe('alignment history camera and session boundaries', () => {
  it('notifies Color and Alignment availability after the public command barrier closes', async () => {
    const value = fixture(), warm = [...NEUTRAL_COLOR]; warm[0] = 1.25;
    value.controller.setGrade(warm);
    const observed: { busy: boolean; color: boolean; alignment: boolean }[] = [];
    const unsubscribe = useApp.subscribe(state => observed.push({ busy: state.busy,
      color: value.controller.colorPreviewEnabled, alignment: value.controller.alignmentControlsEnabled }));
    try {
      expect(await value.controller.command({ command: 'grade', values: warm })).toBe(true);
      expect(observed.some(state => state.busy)).toBe(true);
      expect(value.controller.colorPreviewEnabled).toBe(true);
      expect(value.controller.alignmentControlsEnabled).toBe(true);
      expect(observed.at(-1)).toEqual({ busy: false, color: true, alignment: true });
    } finally { unsubscribe(); }
  });
  it('carries CURRENT navigation, zoom, lens and roll across two history frames', async () => {
    const value = fixture(summary({ alignment: alignment(frame(2, 3, -1), 10, true) }));
    value.next({ alignment: alignment(frame(-4, 1, 2), 7, true), camera: [100, 200, 300, 1, -.25, 50, 9, 20, 1, 0, 2] });
    value.onStream(() => value.camera.navigate([8, 9, 10, -.75, .5, 12, 3, 70, 0, -.625, 2]));
    expect(await value.controller.command({ command: 'undo' })).toBe(true);
    expect(value.camera.state).toEqual([2, 7, 13, -.75, .5, 12, 3, 70, 0, -.625, 2]);
    expect(useApp.getState().summary?.alignment?.branchId).toBe(7);
    value.camera.navigate([11, 12, 13, .875, -.5, 18, 4, 80, 1, .75, 2]);
    value.onStream(() => {}); value.next({ alignment: alignment(frame(2, 3, -1), 10, true), camera: [...DEFAULT_CAMERA] });
    expect(await value.controller.command({ command: 'redo' })).toBe(true);
    expect(value.camera.state).toEqual([17, 14, 10, .875, -.5, 18, 4, 80, 1, .75, 2]);
    expect(useApp.getState().summary?.alignment?.branchId).toBe(10);
    expect(value.camera.set).toHaveBeenCalledTimes(2);
  });
  it('publishes distinct branch metadata for equal frames without restoring a historical camera', async () => {
    const value = fixture(); await picked(value); const camera = value.camera.state;
    value.next({ alignment: alignment(frame(), 101, true) });
    expect(await value.controller.confirmAlignment()).toBe(true);
    expect(value.camera.state).toEqual(camera); expect(value.camera.set).toHaveBeenCalledOnce();
    expect(useApp.getState().summary?.alignment).toEqual(alignment(frame(), 101, true));
    value.next({ alignment: alignment(frame(), 0, false) });
    expect(await value.controller.command({ command: 'undo' })).toBe(true);
    expect(value.camera.state).toEqual(camera); expect(useApp.getState().summary?.alignment?.branchId).toBe(0);
    expect(value.camera.set).toHaveBeenCalledTimes(2);
  });
  it('settles the active color preview and GPU base before capturing the alignment owner', async () => {
    const value = fixture(), warm = [...NEUTRAL_COLOR]; warm[0] = 1.25; value.controller.setGrade(warm);
    const fence = deferred<void>(); value.renderer.device.queue.onSubmittedWorkDone.mockImplementationOnce(() => fence.promise);
    const starting = value.controller.startCenterAlignment();
    await vi.waitFor(() => expect(value.renderer.device.queue.onSubmittedWorkDone).toHaveBeenCalledOnce());
    expect(value.internal.alignmentOwner).toBeUndefined(); expect(useApp.getState().alignmentTool).toBeNull();
    expect(value.events).toContain('grade'); expect(value.events).toContain('endColor');
    fence.resolve(); expect(await starting).toBe(true);
    expect(value.client.command.mock.calls.map(([request]) => request.command))
      .toEqual(['beginTransaction', 'grade', 'endColor', 'commitTransaction']);
    expect(value.internal.alignmentOwner?.scene).toBe(value.staged[0]);
    expect(value.internal.alignmentOwner?.revision).toEqual(value.client.revision);
    expect(useApp.getState().grade).toEqual(NEUTRAL_COLOR); expect(useApp.getState().appliedGrade).toEqual(NEUTRAL_COLOR);
    expect(useApp.getState().colorSession).toBeNull(); expect(await value.controller.pickAlignmentPoint(1, 1)).toBe(true);
  });
  it('routes raw Reset through current active and original-source saved default camera payloads', async () => {
    const value = fixture(summary({ alignment: alignment(frame(2, -1, 3), 20, true) }));
    value.camera.navigate([10, 20, 30, -.75, .5, 12, 3, 70, 0, -.625, 2]);
    value.internal.savedViewRecord = { view: { target: [1, 2, 3], yaw: .5, pitch: -.25, distance: 8, radius: 3,
      fov: 57, yUp: true, roll: .125, background: 'gray' } } as unknown as SavedViewRecord;
    expect(await value.controller.command({ command: 'resetAlignment' })).toBe(true);
    const request = value.client.command.mock.calls.find(([candidate]) => candidate.command === 'resetAlignment')![0];
    expect(request.camera).toEqual([10, 20, 30, -.75, .5, 12, 3, 70, 0, -.625, 2]);
    expect(request.defaultCamera).toEqual([3, 1, 6, .5, -.25, 8, 2, 57, 1, .125, 2]);
    for (const state of [request.camera, request.defaultCamera]) {
      expect(state).toHaveLength(11); expect((state as number[]).every(Number.isFinite)).toBe(true);
    }
    expect(value.camera.state).toEqual([8, 21, 27, -.75, .5, 12, 3, 70, 0, -.625, 2]);
    expect(useApp.getState().summary?.alignment).toEqual(alignment());
  });
  it('uses the native Reset gate to refuse a missing operation baseline before opening a transaction', async () => {
    const value = fixture(); expect(await value.controller.command({ command: 'resetAlignment' })).toBe(false);
    expect(value.client.command).not.toHaveBeenCalled(); expect(value.renderer.allocateScene).not.toHaveBeenCalled();
  });
  it('carries the mutable decimal default through Center and Undo before Reset camera', async () => {
    // These concrete f32 values expose the irreversible rounding in a carried
    // default. Undo must preserve that current value rather than reload its
    // historical serialized default target .009999999776482582.
    const priorFrame = frame(-.20000000298023224), nextFrame = frame(-.30000001192092896);
    const originalDefault = [.009999999776482582, 0, 0, ...DEFAULT_CAMERA.slice(3)];
    const value = fixture(summary({ alignment: alignment(priorFrame, 2, true), camera: originalDefault }));
    value.internal.alignmentDefaultCamera = [...originalDefault];
    value.joinPoint(Promise.resolve([.10000001639127731, 0, 0]));
    expect(await value.controller.startCenterAlignment()).toBe(true);
    expect(await value.controller.pickAlignmentPoint(1, 1)).toBe(true);
    value.next({ alignment: alignment(nextFrame, 3, true), camera: [-.09000001102685928, 0, 0, ...DEFAULT_CAMERA.slice(3)] });
    expect(await value.controller.confirmAlignment()).toBe(true);
    expect(value.internal.alignmentDefaultCamera?.[0]).toBe(-.09000001102685928);
    value.camera.navigate([4, 5, 6, -.75, .5, 12, 3, 70, 0, -.625, 2]);
    value.next({ alignment: alignment(priorFrame, 2, true), camera: originalDefault });
    expect(await value.controller.command({ command: 'undo' })).toBe(true);
    expect(value.internal.alignmentDefaultCamera?.[0]).toBe(.009999997913837433);
    expect(useApp.getState().summary?.camera[0]).toBe(.009999999776482582);
    value.controller.resetCamera();
    expect(value.camera.state).toEqual([.009999997913837433, 0, 0, ...DEFAULT_CAMERA.slice(3)]);
    expect(value.camera.state[0]).not.toBe(useApp.getState().summary?.camera[0]);
  });
  it('retains the exact default owner when native commit refuses and joins rollback', async () => {
    const value = fixture(); await picked(value);
    const defaultOwner = [.009999999776482582, 7, 8, ...DEFAULT_CAMERA.slice(3)];
    value.internal.alignmentDefaultCamera = defaultOwner;
    const rollback = deferred<void>(); value.joinRollback(rollback.promise); value.fail('commit');
    const confirmation = value.controller.confirmAlignment();
    await vi.waitFor(() => expect(value.events).toContain('rollbackTransaction'));
    expect(value.internal.alignmentDefaultCamera).toBe(defaultOwner);
    expect(value.camera.set).not.toHaveBeenCalled(); expect(value.controller.scene).toBe(value.base);
    rollback.resolve(); expect(await confirmation).toBe(false);
    expect(value.internal.alignmentDefaultCamera).toBe(defaultOwner);
    expect(value.internal.alignmentDefaultCamera).toEqual(defaultOwner);
    expect(value.native().canRedo).toBe(true); expect(useApp.getState().alignmentPoint).toEqual(PICKED);
  });
  it('stores the original-source thumbnail view while retaining its captured edited-coordinate default', async () => {
    const value = fixture(summary({ alignment: alignment(frame(-.30000001192092896), 3, true) }));
    const captured = [-.09000001102685928, 5, 6, -.75, .5, 12, 3, 70, 0, -.625, 2];
    value.camera.navigate(captured);
    value.internal.alignmentDefaultCamera = [...DEFAULT_CAMERA];
    value.internal.fingerprint = { scheme: SOURCE_FINGERPRINT_SCHEME, assetDigest: 'a'.repeat(64),
      resourceCount: 1, totalBytes: 3, sourceKindHint: 'ply' };
    const put = vi.fn(async (_record: SavedViewRecord, _image: Blob, _operation: unknown) => {}); value.internal.viewStorage = { put };
    expect(await value.controller.updateThumbnail()).toBe(true);
    const record = put.mock.calls[0][0] as SavedViewRecord;
    expect(record.view.target).toEqual([.21000000834465027, 5, 6]);
    expect(value.internal.alignmentDefaultCamera).toEqual(captured);
    expect(value.internal.alignmentDefaultCamera).not.toBe(captured);
    expect(value.internal.alignmentDefaultCamera?.[0]).toBe(-.09000001102685928);
    value.camera.navigate([...DEFAULT_CAMERA]); value.controller.resetCamera();
    // defaultCamera overlays the current scene radius on the retained view.
    expect(value.camera.state).toEqual([-.09000001102685928, 5, 6, -.75, .5, 12, 2, 70, 0, -.625, 2]);
  });
});
