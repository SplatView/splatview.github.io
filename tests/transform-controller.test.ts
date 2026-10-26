import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppController, type TransformGizmoGestureToken } from '../src/app/controller';
import { setApp, switchToolsMode, useApp } from '../src/app/store';
import { transformDefaults, type TransformDefinition, type TransformSessionSummary } from '../src/document/transformProtocol';
import type { CoreClient } from '../src/document/coreClient';
import type { NativeSummary, SceneCommand } from '../src/document/types';
import { GaussianRenderer } from '../src/renderer/webgpu/renderer';
import { ResourceLedger, type ResourceLease } from '../src/document/resources';
import type { OperationOwner } from '../src/document/operationProtocol';
import type { Revision } from '../src/document/types';

// Controller scheduling/ownership only. Native numerical/reference tests own
// composition, sequential covariance rounding and unchanged directional SH.
const initial = useApp.getState(), controllers: AppController[] = [];
const flush = async () => { for (let index = 0; index < 50; index++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function summary(transformSession: TransformSessionSummary | null = null): NativeSummary {
  return { ok: true, duplicateRange: null, loaded: true, kind: 0, count: 3, sourceCount: 3, selected: 1, visible: 2, shDegree: 0,
    format: 'PLY', canUndo: true, canRedo: true, revision: 2, contentRevision: 1, selectionCommitRevision: 0, transaction: false,
    selectionDraft: false, sceneChanged: false, pending: false, progress: 1, floor: null, filter: null, transformSession, opacitySession: null,
    center: [3, 4, 5], radius: 1, yUp: false, camera: [0, 0, 0, 0, 0, 3, 1, 45, 0, 0, 1], memoryBytes: 528,
    selectionMapId: null, pendingSelectionMapId: null, selectionMapBytes: 0, selectionMapRetainedIds: [],
    alignment: { version: 2, branchId: 0, frame: transformDefaults().matrix, canReset: false, retainedBranchIds: [0] } };
}
type Internal = { [name: string]: unknown;
  executeEditCommand(command: SceneCommand, current?: () => boolean): Promise<boolean>;
  executeCommand(command: SceneCommand): Promise<boolean>; closeToleranceSelection(): Promise<void>; settleColorSession(): Promise<boolean>;
  ensureStartupCore(): Promise<void>; synchronizeViewport(): boolean; observeCanvas(): void; shrinkNativeHistory(client: CoreClient, summary: NativeSummary): void;
  watchTransformPivot(): void; transformPivotUnsubscribe?: () => void; queueTransformPivotSynchronization(): void;
};
beforeEach(() => {
  vi.stubGlobal('document', { hidden: true, title: '' }); vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('window', { devicePixelRatio: 1 });
  setApp({ ...initial, ready: true, rendererState: 'ready', toolsOpen: true, busy: false, mode: 'pro', operation: 0,
    summary: summary(), transform: null, transformPreview: null, transformParameters: transformDefaults(), transformGizmoMode: null,
    transformGizmoDragging: false, filter: null, navigationPrompt: false, settingsOpen: false, exportOpen: false,
    outputPending: false, viewTransferPending: false, thumbnailPending: false, savedViewChoices: [], selectionRecovery: 'idle' }, true);
});
afterEach(() => {
  for (const controller of controllers.splice(0)) {
    const internal = controller as unknown as Internal;
    internal.transformPivotUnsubscribe?.(); internal.transformPivotUnsubscribe = undefined;
    controller.cancelTransformGizmoGesture(undefined, true);
  }
  vi.restoreAllMocks(); vi.unstubAllGlobals(); setApp(initial, true);
});
// The typed lifecycle delegates dynamically to each test's existing command
// model, including replaced refusal and inconsistent-metadata implementations.
function ownedTransactions<T extends { revision: Revision; command(command: SceneCommand): Promise<NativeSummary> }>(client: T) {
  let sequence = 0, active: OperationOwner | undefined;
  const check = (owner: OperationOwner) => { expect(owner).toBe(active); };
  const result = Object.assign(client, {
    createOperation: vi.fn(() => {
      expect(active).toBeUndefined();
      active = Object.freeze({ version: 1 as const, documentId: client.revision.documentId,
        sourceGeneration: client.revision.sourceGeneration, clientGeneration: 'cc000007-0000-4000-8000-000000000007', operationId: ++sequence });
      return active;
    }),
    beginOperation: vi.fn((owner: OperationOwner) => { check(owner); return client.command({ command: 'beginTransaction' }); }),
    commitOperation: vi.fn((owner: OperationOwner) => { check(owner); return client.command({ command: 'commitTransaction' }); }),
    rollbackOperation: vi.fn((owner: OperationOwner) => { check(owner); return client.command({ command: 'rollbackTransaction' }); }),
    finishOperation: vi.fn(async (owner: OperationOwner) => { check(owner); active = undefined; }),
  });
  Object.defineProperty(result, 'operationOwner', { get: () => active }); return result;
}
function fixture() {
  const controller = new AppController(), internal = controller as unknown as Internal; controllers.push(controller);
  const client = ownedTransactions({ revision: { documentId: 'cc000008-0000-4000-8000-000000000008', sourceGeneration: 1, contentRevision: 1, selectionRevision: 2, draftRevision: 0 },
    assertNativeAdmission: vi.fn(), cancel: vi.fn(), command: vi.fn(), stream: vi.fn(),
    setNativeWork: vi.fn(), updateNativeCoverage: vi.fn(), releaseNativeCoverage: vi.fn((lease: ResourceLease) => lease()),
    transformFocus: vi.fn(async (scope: string, _base: unknown, _signal?: AbortSignal): Promise<[number, number, number] | null> => scope === 'scene' ? [3, 4, 5] : [9, 8, 7]) });
  const scene = { kind: 'gaussian', setDuplicateRange: vi.fn(), count: 3, sourceRevision: 1, allocationBytes: 100, dispose: vi.fn(async () => {}) };
  const viewport = { x: 0, y: 0, width: 400, height: 300 };
  const renderer = { lost: false, deviceEpoch: 1, canvas: { width: 400, height: 300, getBoundingClientRect: vi.fn(() => ({ ...viewport })) },
    device: { queue: { onSubmittedWorkDone: vi.fn(async () => {}) } }, finish(): Promise<void> { return this.device.queue.onSubmittedWorkDone(); }, setHistogramEnabled: vi.fn(),
    setRenderSettings: vi.fn(), steadySnapshot: { status: 'sorted' }, resetHistogram: vi.fn(), dispose: vi.fn() };
  const compose = (definition: TransformDefinition) => {
    const matrix = transformDefaults().matrix;
    if (definition.mode === 'matrix') { matrix[12] = definition.matrix[3]; matrix[13] = definition.matrix[7]; matrix[14] = definition.matrix[11]; }
    else for (let axis = 0; axis < 3; axis++) {
      const scale = definition.scale[axis] * (definition.flips[axis] ? -1 : 1);
      matrix[axis * 5] = scale; matrix[12 + axis] = definition.translation[axis] + (1 - scale) * definition.pivot[axis];
    }
    return { matrix, pivot: [...definition.pivot] as [number, number, number] };
  };
  const camera = { revision: 2, clearInput: vi.fn(), state: [0, 0, 0, 0, 0, 3, 1, 45, 0, 0, 1], composeTransform: vi.fn(compose) };
  controller.client = client as unknown as CoreClient; controller.scene = scene as unknown as NonNullable<AppController['scene']>;
  controller.renderer = renderer as unknown as GaussianRenderer; controller.camera = camera as unknown as NonNullable<AppController['camera']>;
  vi.spyOn(controller, 'invalidate').mockImplementation(() => {});
  vi.spyOn(controller, 'cancelSelectionGesture').mockResolvedValue(true);
  vi.spyOn(internal, 'closeToleranceSelection').mockResolvedValue(); vi.spyOn(internal, 'settleColorSession').mockResolvedValue(true);
  const ordinary = vi.spyOn(internal, 'executeCommand').mockResolvedValue(true);
  const commands: SceneCommand[] = []; let id = 0, baseId = 100, gizmoAt = 0, gizmoHistory: number[] = [], held: ReturnType<typeof deferred<boolean>> | undefined;
  const execute = vi.spyOn(internal, 'executeEditCommand').mockImplementation(async (command, current) => {
    commands.push(structuredClone(command));
    if (command.command === 'beginTransform') {
      if (command.kind === 'gizmo') { gizmoHistory = []; gizmoAt = 0; }
      setApp({ summary: { ...useApp.getState().summary!, transformSession: {
      id: ++id, baseId: ++baseId, epoch: 0, appliedEpoch: null, kind: command.kind as 'numeric' | 'gizmo', selectedOnly: command.selectedOnly as boolean,
      gizmo: command.kind === 'gizmo' ? { cancelBaseId: null, cancelContentRevision: null, canUndo: false, canRedo: false } : null,
      appliedMatrix: transformDefaults().matrix, pivot: [3, 4, 5] } } });
    } else if (command.command === 'rebaseTransform' || command.command === 'undoTransform' || command.command === 'redoTransform' || command.command === 'cancelTransform') {
      const wait = held; held = undefined; setApp({ busy: true });
      if (wait && !await wait.promise || current && !current()) { setApp({ busy: false }); return false; }
      const before = useApp.getState().summary!, owner = before.transformSession!;
      if (command.command === 'cancelTransform') {
        setApp({ summary: { ...before, revision: before.revision + Number(gizmoAt !== 0),
          contentRevision: owner.gizmo!.cancelContentRevision ?? before.contentRevision, transformSession: null }, busy: false });
      } else {
        if (command.command === 'undoTransform') gizmoAt--;
        if (command.command === 'redoTransform') gizmoAt++;
        setApp({ summary: { ...before, revision: before.revision + Number(command.command !== 'rebaseTransform'),
          contentRevision: gizmoHistory[gizmoAt] ?? before.contentRevision, transformSession: { ...owner, baseId: ++baseId, epoch: Number(command.epoch),
            appliedEpoch: null, appliedMatrix: transformDefaults().matrix,
            selectedOnly: command.command === 'rebaseTransform' ? command.selectedOnly as boolean : owner.selectedOnly,
            gizmo: { ...owner.gizmo!, canUndo: gizmoAt > 0, canRedo: gizmoAt < gizmoHistory.length - 1 } } }, busy: false });
      }
    } else if (command.command === 'applyTransform' || command.command === 'resetTransform') {
      const wait = held; held = undefined; setApp({ busy: true });
      if (wait && !await wait.promise || current && !current()) { setApp({ busy: false }); return false; }
      const before = useApp.getState().summary!, definition = command.parameters as TransformDefinition;
      const owner = before.transformSession!, gizmo = owner.kind === 'gizmo';
      if (gizmo) {
        if (!gizmoHistory.length) gizmoHistory = [before.contentRevision];
        gizmoHistory = gizmoHistory.slice(0, gizmoAt + 1); gizmoHistory.push(before.contentRevision + 1); gizmoAt++;
      }
      setApp({ summary: { ...before, contentRevision: before.contentRevision + 1, revision: before.revision + 1, transformSession: {
        ...owner, epoch: command.epoch as number, appliedEpoch: gizmo ? null : command.epoch as number,
        baseId: gizmo ? ++baseId : owner.baseId,
        gizmo: gizmo ? { cancelBaseId: owner.gizmo?.cancelBaseId ?? owner.baseId,
          cancelContentRevision: owner.gizmo?.cancelContentRevision ?? before.contentRevision, canUndo: true, canRedo: false } : null,
        appliedMatrix: gizmo ? transformDefaults().matrix : definition ? compose(definition).matrix : transformDefaults().matrix,
        pivot: definition ? definition.pivot : [0, 0, 0] } }, busy: false });
    } else if (command.command === 'endTransform') {
      const wait = held; held = undefined;
      if (wait && !await wait.promise || current && !current()) return false;
      setApp({ summary: { ...useApp.getState().summary!, transformSession: null, opacitySession: null } });
    }
    return true;
  });
  return { controller, internal, client, scene, renderer, camera, viewport, commands, execute, ordinary,
    hold() { held = deferred<boolean>(); return held; } };
}
async function numeric() { const f = fixture(); f.controller.setTransformParameters({ translation: [2, 3, 4] }); await flush(); return f; }
async function gizmo() { const f = fixture(); expect(await f.controller.setTransformGizmoMode('move')).toBe(true); const token = f.controller.beginTransformGizmoGesture()!; expect(token).not.toBeNull(); await flush(); return { ...f, token }; }
function pose(x = 7) {
  const deltaMatrix = transformDefaults().matrix, widgetMatrix = transformDefaults().matrix, rowMajorDelta = transformDefaults().matrix;
  deltaMatrix[12] = x; widgetMatrix[12] = x + 3; widgetMatrix[13] = 4; widgetMatrix[14] = 5; rowMajorDelta[3] = x;
  return { deltaMatrix, widgetMatrix, rowMajorDelta };
}

async function automaticPivot() {
  const f = fixture(); f.internal.watchTransformPivot(); await flush(); return f;
}
function selectionCommit(f: ReturnType<typeof fixture>, selected = 1) {
  const before = useApp.getState().summary!;
  f.client.revision.selectionRevision++;
  setApp({ summary: { ...before, selected, revision: before.revision + 1,
    selectionCommitRevision: before.selectionCommitRevision! + 1 } });
}

describe('committed selection pivot synchronization', () => {
  it('primes a worker counter without changing the initial reference', async () => {
    const f = await automaticPivot();
    expect(f.client.transformFocus).not.toHaveBeenCalled();
    expect(useApp.getState()).toMatchObject({ transformPivotMode: 'scene', transformPivotChosen: false });
  });
  it.each(['custom', 'origin', 'scene'] as const)('chooses Selection after a same-count membership change from %s', async mode => {
    const f = await automaticPivot();
    setApp({ transformPivotMode: mode, transformPivotChosen: true });
    selectionCommit(f); await flush();
    expect(useApp.getState()).toMatchObject({ transformPivotMode: 'selection', transformPivotChosen: true,
      transformParameters: { pivot: [9, 8, 7] }, dirty: false });
    expect(f.client.transformFocus).toHaveBeenCalledTimes(1); expect(f.commands).toEqual([]);
  });
  it('ignores preview/cancel revisions and provisional transaction counters', async () => {
    const f = await automaticPivot(), before = useApp.getState().summary!;
    setApp({ summary: { ...before, revision: 3, selectionDraft: true, selected: 2 } }); await flush();
    setApp({ summary: { ...before, revision: 4 } }); await flush();
    setApp({ summary: { ...before, revision: 5, transaction: true, selectionCommitRevision: 1 } }); await flush();
    setApp({ summary: { ...before, revision: 6 } }); await flush();
    expect(f.client.transformFocus).not.toHaveBeenCalled();
    selectionCommit(f); await flush(); expect(f.client.transformFocus).toHaveBeenCalledTimes(1);
  });
  it.each(['custom', 'origin', 'scene'] as const)('preserves %s when committed selection becomes empty', async mode => {
    const f = await automaticPivot();
    setApp({ transformPivotMode: mode, transformPivotChosen: true });
    selectionCommit(f, 0); await flush();
    expect(useApp.getState()).toMatchObject({ transformPivotMode: mode, transformPivotChosen: true });
    expect(f.client.transformFocus).not.toHaveBeenCalled();
  });
  it('changes an empty Selection reference to Origin without native work', async () => {
    const f = await automaticPivot(); setApp({ transformPivotMode: 'selection', transformPivotChosen: true });
    selectionCommit(f, 0); await flush();
    expect(useApp.getState()).toMatchObject({ transformPivotMode: 'origin', transformPivotChosen: true,
      transformParameters: { pivot: [0, 0, 0] } });
    expect(f.client.transformFocus).not.toHaveBeenCalled();
  });
  it('defers across numeric fields and ignores an older field blur', async () => {
    const f = await automaticPivot(), a = {}, b = {};
    f.controller.setTransformNumericFocus(a, true); selectionCommit(f); await flush();
    f.controller.setTransformNumericFocus(b, true); f.controller.setTransformNumericFocus(a, false); await flush();
    expect(f.client.transformFocus).not.toHaveBeenCalled();
    f.controller.setTransformNumericFocus(b, false); await flush();
    expect(f.client.transformFocus).toHaveBeenCalledTimes(1);
  });
  it('a successful manual pivot edit consumes a waiting default until the next commit', async () => {
    const f = await automaticPivot(), field = {};
    f.controller.setTransformNumericFocus(field, true); selectionCommit(f); await flush();
    f.controller.setTransformParameters({ pivot: [21, 22, 23] });
    f.controller.setTransformNumericFocus(field, false); await flush();
    expect(useApp.getState()).toMatchObject({ transformPivotMode: 'custom', transformParameters: { pivot: [21, 22, 23] } });
    expect(f.client.transformFocus).not.toHaveBeenCalled();
    selectionCommit(f); await flush(); expect(useApp.getState().transformPivotMode).toBe('selection');
  });
  it('preserves a settled Color/Fill click and opacity owner during the readonly query', async () => {
    const f = await automaticPivot(), tolerance = { applying: false, waitingMap: false }, opacity = { phase: 'ready' };
    f.internal.tolerance = tolerance; f.internal.opacityOwner = opacity;
    setApp({ summary: { ...useApp.getState().summary!, toleranceSessionId: 72, toleranceTool: 'color', toleranceConnected: false } });
    selectionCommit(f); await flush();
    expect(useApp.getState().transformPivotMode).toBe('selection');
    expect(f.internal.tolerance).toBe(tolerance); expect(f.internal.opacityOwner).toBe(opacity);
    expect(f.internal.closeToleranceSelection).not.toHaveBeenCalled(); expect(f.internal.settleColorSession).not.toHaveBeenCalled();
    expect(f.commands).toEqual([]);
  });
  it('waits for private selection cleanup even after busy clears', async () => {
    const f = await automaticPivot(); f.internal.tolerance = { applying: true };
    selectionCommit(f); await flush(); expect(f.client.transformFocus).not.toHaveBeenCalled();
    f.internal.tolerance = { applying: false }; f.internal.queueTransformPivotSynchronization(); await flush();
    expect(f.client.transformFocus).toHaveBeenCalledTimes(1);
  });
  it.each(['scene', 'selection', 'custom', 'origin'] as const)('content edits refresh only derived references: %s', async mode => {
    const f = await automaticPivot(); setApp({ transformPivotMode: mode, transformPivotChosen: true });
    const before = useApp.getState().summary!;
    setApp({ summary: { ...before, revision: before.revision + 1, contentRevision: before.contentRevision + 1 } }); await flush();
    expect(useApp.getState().transformPivotMode).toBe(mode);
    expect(f.client.transformFocus).toHaveBeenCalledTimes(mode === 'scene' || mode === 'selection' ? 1 : 0);
  });
  it('does not repeatedly query a retained transform base after repeated Apply', async () => {
    const f = await numeric(); f.internal.watchTransformPivot(); await flush(); f.client.transformFocus.mockClear();
    await f.controller.applyTransform(); await flush();
    f.controller.setTransformParameters({ translation: [8, 9, 10] }); await f.controller.applyTransform(); await flush();
    expect(f.client.transformFocus).not.toHaveBeenCalled();
  });
  it('joins post-bake refresh when changing an explicit Selection numeric transform to a gizmo', async () => {
    const f = await numeric(); f.internal.watchTransformPivot(); await flush();
    expect(await f.controller.cycleTransformPivot()).toBe(true);
    expect(await f.controller.applyTransform()).toBe(true); await flush();
    expect(await f.controller.setTransformGizmoMode('move')).toBe(true); await flush();
    expect(useApp.getState()).toMatchObject({ transformPivotMode: 'selection', transformPivotChosen: true, transformGizmoMode: 'move' });
    expect(f.client.transformFocus.mock.calls.some(call => call[0] === 'selection' && call[1] === null)).toBe(true);
    expect(f.controller.transformGizmoWidgetMatrix?.slice(12, 15)).toEqual([9, 8, 7]);
  });
  it.each(['custom', 'origin'] as const)('retiring a baked numeric recipe preserves the %s reference', async mode => {
    const f = await numeric();
    f.controller.setTransformParameters({ pivot: [11, 12, 13] });
    if (mode === 'origin') { await f.controller.cycleTransformPivot(); await f.controller.cycleTransformPivot(); await f.controller.cycleTransformPivot(); }
    expect(await f.controller.applyTransform()).toBe(true);
    expect(await f.controller.endTransformSession()).toBe(true);
    expect(useApp.getState()).toMatchObject({ transformPivotMode: mode, transformPivotChosen: true,
      transformParameters: { translation: [0, 0, 0], pivot: mode === 'origin' ? [0, 0, 0] : [13, 15, 17] } });
  });
  it('joins the blur-triggered default before applying staged scale', async () => {
    const f = await numeric(); f.internal.watchTransformPivot(); await flush();
    const field = {}; f.controller.setTransformNumericFocus(field, true);
    f.controller.setTransformParameters({ scale: [2, 3, 4] }); selectionCommit(f); await flush();
    f.controller.setTransformNumericFocus(field, false);
    expect(await f.controller.applyTransform()).toBe(true);
    const command = f.commands.at(-1)!;
    expect(command.command).toBe('applyTransform'); expect(command.parameters).toMatchObject({ pivot: [9, 8, 7], scale: [2, 3, 4], translation: [2, 3, 4] });
  });
  it('does not spin after refusal and retries on a later native revision', async () => {
    const f = await automaticPivot(); f.client.transformFocus.mockRejectedValueOnce(new Error('Refused center query'));
    selectionCommit(f); await flush();
    expect(f.client.transformFocus).toHaveBeenCalledTimes(1);
    setApp({}); setApp({ error: null }); await flush(); expect(f.client.transformFocus).toHaveBeenCalledTimes(1);
    const before = useApp.getState().summary!; setApp({ summary: { ...before, revision: before.revision + 1 } }); await flush();
    expect(f.client.transformFocus).toHaveBeenCalledTimes(2); expect(useApp.getState().transformPivotMode).toBe('selection');
  });
  it('primes a fresh recovered worker counter and keeps a Custom reference', async () => {
    const f = await automaticPivot(); f.controller.setTransformParameters({ pivot: [31, 32, 33] });
    f.controller.client = { ...f.client } as unknown as CoreClient;
    setApp({ summary: { ...useApp.getState().summary!, selectionCommitRevision: 0 } }); await flush();
    expect(useApp.getState()).toMatchObject({ transformPivotMode: 'custom', transformParameters: { pivot: [31, 32, 33] } });
    expect(f.client.transformFocus).not.toHaveBeenCalled();
  });
});

describe('desktop transform pivot references', () => {
  it('cycles Scene, Selection, Origin and Scene without an edit or history owner', async () => {
    const f = fixture(), before = useApp.getState().summary;
    expect(await f.controller.cycleTransformPivot()).toBe(true);
    expect(useApp.getState()).toMatchObject({ transformPivotMode: 'selection', transformPivotChosen: true,
      transformParameters: { pivot: [9, 8, 7] }, transform: null, dirty: false });
    expect(f.client.transformFocus).toHaveBeenLastCalledWith('selection', null, expect.any(AbortSignal));
    expect(await f.controller.cycleTransformPivot()).toBe(true);
    expect(useApp.getState()).toMatchObject({ transformPivotMode: 'origin', transformParameters: { pivot: [0, 0, 0] } });
    expect(f.client.transformFocus).toHaveBeenCalledTimes(1);
    expect(await f.controller.cycleTransformPivot()).toBe(true);
    expect(useApp.getState()).toMatchObject({ transformPivotMode: 'scene', transformParameters: { pivot: [3, 4, 5] }, dirty: false });
    expect(useApp.getState().summary).toBe(before); expect(f.commands).toEqual([]);
    expect(f.client.createOperation).not.toHaveBeenCalled();
    expect(useApp.getState().transformPivotPending).toBe(false);
  });
  it('skips Selection when none is selected and uses Origin if an admitted selection query is empty', async () => {
    const f = fixture(); setApp({ summary: { ...useApp.getState().summary!, selected: 0 } });
    expect(await f.controller.cycleTransformPivot()).toBe(true);
    expect(useApp.getState().transformPivotMode).toBe('origin'); expect(f.client.transformFocus).not.toHaveBeenCalled();
    setApp({ transformPivotMode: 'scene', summary: { ...useApp.getState().summary!, selected: 1 } });
    f.client.transformFocus.mockResolvedValueOnce(null);
    expect(await f.controller.cycleTransformPivot()).toBe(true);
    expect(useApp.getState()).toMatchObject({ transformPivotMode: 'origin', transformParameters: { pivot: [0, 0, 0] }, transform: null });
  });
  it('manual Pivot edits choose Custom without beginning a neutral transform; Custom cycles to Scene', async () => {
    const f = fixture(); f.controller.setTransformParameters({ pivot: [11, 12, 13] });
    expect(useApp.getState()).toMatchObject({ transformPivotMode: 'custom', transformPivotChosen: true,
      transformParameters: { pivot: [11, 12, 13] }, transform: null, dirty: false });
    expect(f.commands).toEqual([]); expect(await f.controller.cycleTransformPivot()).toBe(true);
    expect(f.client.transformFocus).toHaveBeenLastCalledWith('scene', null, expect.any(AbortSignal));
  });
  it('preserves staged translation and the original native base tuple after Apply', async () => {
    const f = await numeric(); expect(await f.controller.applyTransform()).toBe(true);
    const before = useApp.getState().summary;
    setApp({ summary: { ...before!, center: [103, 104, 105] } });
    f.controller.setTransformParameters({ translation: [7, 6, 5] });
    const desired = useApp.getState().transform!.desiredRevision;
    expect(await f.controller.cycleTransformPivot()).toBe(true);
    expect(f.client.transformFocus).toHaveBeenLastCalledWith('selection', { id: 1, baseId: 101, epoch: 1 }, expect.any(AbortSignal));
    expect(useApp.getState().transformParameters).toMatchObject({ translation: [7, 6, 5], pivot: [9, 8, 7] });
    expect(useApp.getState().transform).toMatchObject({ desiredRevision: desired, dirty: true });
    expect(f.commands.map(c => c.command)).toEqual(['beginTransform', 'applyTransform']);
    expect(await f.controller.cancelTransformPreview()).toBe(true);
    expect(useApp.getState().transformParameters).toMatchObject({ translation: [2, 3, 4], pivot: [9, 8, 7] });
    expect(useApp.getState().transform?.dirty).toBe(false);
  });
  it('keeps a clean translation owner clean for a pivot reference change', async () => {
    const f = await numeric(); await f.controller.applyTransform();
    expect(await f.controller.cycleTransformPivot()).toBe(true);
    expect(useApp.getState().transform?.dirty).toBe(false);
    expect(useApp.getState().transformPreview?.matrix.slice(12, 15)).toEqual([2, 3, 4]);
    expect(f.commands).toHaveLength(2);
  });
  it('recomputes staged scale around the chosen pivot while preserving every other field', async () => {
    const f = await numeric(); f.controller.setTransformParameters({ scale: [2, 3, 4], euler: [0, 0, 0], quaternion: [2, 0, 0, 1] });
    const previous = structuredClone(useApp.getState().transformParameters), desired = useApp.getState().transform!.desiredRevision;
    expect(await f.controller.cycleTransformPivot()).toBe(true);
    expect(useApp.getState().transformParameters).toEqual({ ...previous, pivot: [9, 8, 7] });
    expect(useApp.getState().transform!.desiredRevision).toBe(desired + 1);
    expect(useApp.getState().transformPreview?.matrix.slice(12, 15)).toEqual([-7, -13, -17]);
    expect(f.commands).toHaveLength(1);
  });
  it('fences concurrent input and joins cancellation before releasing query work', async () => {
    const f = fixture(), held = deferred<[number, number, number] | null>();
    f.client.transformFocus.mockImplementationOnce(() => held.promise);
    const pending = f.controller.cycleTransformPivot(); await flush();
    expect(useApp.getState()).toMatchObject({ transformPivotPending: true, busy: true });
    expect(f.controller.transformControlsEnabled).toBe(false);
    f.controller.setTransformParameters({ translation: [99, 0, 0] });
    expect(useApp.getState().transformParameters.translation).toEqual([0, 0, 0]);
    f.controller.cancelEdit(); expect(f.client.transformFocus.mock.calls[0][2]?.aborted).toBe(true);
    expect(f.client.releaseNativeCoverage).not.toHaveBeenCalled();
    held.resolve([9, 8, 7]); expect(await pending).toBe(false);
    expect(useApp.getState()).toMatchObject({ transformPivotPending: false, busy: false, transformPivotMode: 'scene' });
    expect(f.client.releaseNativeCoverage).toHaveBeenCalledTimes(1); expect(f.commands).toEqual([]);
  });
  it.each(['source', 'parameters'] as const)('refuses a late focus result after %s replacement', async change => {
    const f = fixture(), held = deferred<[number, number, number] | null>();
    f.client.transformFocus.mockImplementationOnce(() => held.promise);
    const pending = f.controller.cycleTransformPivot(); await flush();
    if (change === 'source') f.client.revision.sourceGeneration++;
    else setApp({ transformParameters: { ...transformDefaults(), translation: [19, 0, 0] } });
    held.resolve([9, 8, 7]); expect(await pending).toBe(false);
    expect(useApp.getState().transformPivotMode).toBe('scene'); expect(f.commands).toEqual([]);
  });
  it('moves an idle gizmo reference in place and uses it in the next gesture', async () => {
    const f = fixture(); expect(await f.controller.setTransformGizmoMode('move')).toBe(true);
    expect(await f.controller.cycleTransformPivot()).toBe(true);
    expect(f.controller.transformGizmoWidgetMatrix?.slice(12, 15)).toEqual([9, 8, 7]);
    expect(useApp.getState().transform?.dirty).toBe(false);
    const token = f.controller.beginTransformGizmoGesture()!; await flush();
    expect(f.controller.updateTransformGizmoGesture(token, pose())).toBe(true);
    expect(await f.controller.finishTransformGizmoGesture(token)).toBe(true);
    expect(f.commands.find(c => c.command === 'applyTransform')).toMatchObject({ parameters: { pivot: [9, 8, 7] } });
  });
  it('keeps the action unavailable in Basic and affine matrix mode', async () => {
    const f = fixture(); setApp({ mode: 'basic' }); expect(await f.controller.cycleTransformPivot()).toBe(false);
    setApp({ mode: 'pro', transformParameters: { ...transformDefaults(), mode: 'matrix' } });
    expect(await f.controller.cycleTransformPivot()).toBe(false); expect(f.client.transformFocus).not.toHaveBeenCalled();
  });
  it('preserves a Custom reference when switching Move to Rotate and when deactivating the gizmo', async () => {
    const f = fixture(); f.controller.setTransformParameters({ pivot: [11, 12, 13] });
    expect(await f.controller.setTransformGizmoMode('move')).toBe(true);
    expect(await f.controller.setTransformGizmoMode('rotate')).toBe(true);
    expect(f.controller.transformGizmoWidgetMatrix?.slice(12, 15)).toEqual([11, 12, 13]);
    expect(useApp.getState()).toMatchObject({ transformPivotMode: 'custom', transformPivotChosen: true });
    expect(await f.controller.setTransformGizmoMode(null)).toBe(true);
    expect(useApp.getState().transformParameters.pivot).toEqual([11, 12, 13]);
  });
  it('honors the unhighlighted Origin default after Reset when starting a gizmo', async () => {
    const f = fixture(); setApp({ summary: { ...useApp.getState().summary!, selected: 0 } });
    expect(await f.controller.resetTransform()).toBe(true);
    expect(useApp.getState()).toMatchObject({ transformPivotMode: 'origin', transformPivotChosen: false });
    expect(await f.controller.setTransformGizmoMode('rotate')).toBe(true);
    expect(f.controller.transformGizmoWidgetMatrix?.slice(12, 15)).toEqual([0, 0, 0]);
    const token = f.controller.beginTransformGizmoGesture()!; await flush();
    expect(f.controller.updateTransformGizmoGesture(token, pose())).toBe(true);
    expect(await f.controller.finishTransformGizmoGesture(token)).toBe(true);
    expect(f.commands.find(c => c.command === 'applyTransform')).toMatchObject({ parameters: { pivot: [0, 0, 0] } });
  });
  it('keeps Origin at world zero when a clean numeric transform materializes for the gizmo', async () => {
    const f = await numeric(); expect(await f.controller.applyTransform()).toBe(true);
    expect(await f.controller.cycleTransformPivot()).toBe(true);
    expect(await f.controller.cycleTransformPivot()).toBe(true);
    expect(useApp.getState().transformPivotMode).toBe('origin');
    expect(await f.controller.setTransformGizmoMode('rotate')).toBe(true);
    expect(useApp.getState()).toMatchObject({ transformPivotMode: 'origin', transformPivotChosen: true });
    expect(f.controller.transformGizmoWidgetMatrix?.slice(12, 15)).toEqual([0, 0, 0]);
  });
});

describe('absolute numeric transform owner', () => {
  it('starts one native baseline and keeps subsequent valid/invalid edits cheap until explicit Apply', async () => {
    const f = await numeric(); expect(f.commands.map(command => command.command)).toEqual(['beginTransform']);
    f.controller.setTransformParameters({ translation: [5, 6, 7] }); f.controller.setTransformParameters({ scale: [0, 1, 1] });
    expect(f.commands).toHaveLength(1); expect(useApp.getState().transform).toMatchObject({ dirty: true, kind: 'numeric' });
    expect(await f.controller.applyTransform()).toBe(false); expect(f.commands).toHaveLength(1);
    f.controller.setTransformParameters({ scale: [1, 1, 1] }); expect(await f.controller.applyTransform()).toBe(true);
    expect(f.commands.at(-1)).toMatchObject({ command: 'applyTransform', id: 1, epoch: 1, parameters: { translation: [5, 6, 7] } });
    expect(f.controller.scene).toBe(f.scene); expect(useApp.getState().transformPreview?.matrix.slice(12, 15)).toEqual([5, 6, 7]);
  });
  it('uses the same baseline for repeated absolute Apply and retains all independent mode arrays', async () => {
    const f = await numeric(); await f.controller.applyTransform();
    f.controller.setTransformParameters({ euler: [10, 20, 30], quaternion: [2, 0, 0, 1], translation: [9, 8, 7] });
    f.controller.setTransformMode('quaternion'); await f.controller.applyTransform();
    expect(f.commands.map(command => command.command)).toEqual(['beginTransform', 'applyTransform', 'applyTransform']);
    expect(f.commands.at(-1)).toMatchObject({ id: 1, epoch: 2, parameters: { mode: 'quaternion', quaternion: [2, 0, 0, 1], translation: [9, 8, 7] } });
    expect(useApp.getState().transformParameters.euler).toEqual([10, 20, 30]); expect(useApp.getState().transformPreview?.baseId).toBe(101);
  });
  it('joins an explicit later Apply and evaluates its latest requested controls', async () => {
    const f = await numeric(), held = f.hold(); const first = f.controller.applyTransform(); await flush();
    f.controller.setTransformParameters({ translation: [9, 8, 7] }); const latest = f.controller.applyTransform();
    held.resolve(true); expect(await first).toBe(true); expect(await latest).toBe(true);
    expect(f.commands.filter(command => command.command === 'applyTransform').map(command => command.epoch)).toEqual([1, 2]);
    expect(f.commands.at(-1)).toMatchObject({ parameters: { translation: [9, 8, 7] } }); expect(useApp.getState().transform?.dirty).toBe(false);
  });
  it('cannot apply an older candidate after newer desired fields become invalid', async () => {
    const f = await numeric(); await f.controller.applyTransform(); f.controller.setTransformParameters({ scale: [0, 1, 1] });
    expect(await f.controller.applyTransform()).toBe(false); expect(useApp.getState().transform?.dirty).toBe(true); expect(f.commands).toHaveLength(2);
    expect(await f.controller.endTransformSession()).toBe(false); expect(await f.controller.setTransformGizmoMode('rotate')).toBe(false);
  });
  it('Cancel preview restores last accepted controls without undoing successful Apply', async () => {
    const f = await numeric(); await f.controller.applyTransform(); const accepted = useApp.getState().summary!;
    f.controller.setTransformParameters({ translation: [9, 8, 7], flips: [true, false, false] });
    expect(await f.controller.cancelTransformPreview()).toBe(true);
    expect(useApp.getState().transformParameters.translation).toEqual([2, 3, 4]); expect(useApp.getState().summary).toBe(accepted);
    expect(useApp.getState().transform?.dirty).toBe(false); expect(f.commands).toHaveLength(2);
  });
  it('cancels a held failed draft and consumes its epoch before retry', async () => {
    const f = await numeric(), held = f.hold(); const applying = f.controller.applyTransform(); await flush();
    const cancelling = f.controller.cancelTransformPreview(); held.resolve(true);
    expect(await applying).toBe(false); expect(await cancelling).toBe(true); expect(f.client.cancel).toHaveBeenCalled();
    f.controller.setTransformParameters({ translation: [6, 7, 8] }); await f.controller.applyTransform();
    expect(f.commands.at(-1)).toMatchObject({ command: 'applyTransform', epoch: 2 });
  });
  it('Reset requests its native baseline while Cancel/end preserve accepted geometry', async () => {
    const f = await numeric(); await f.controller.applyTransform();
    expect(await f.controller.resetTransform()).toBe(true); expect(f.commands.at(-1)).toMatchObject({ command: 'resetTransform', id: 1, epoch: 2 });
    expect(useApp.getState().transformParameters).toEqual({ ...transformDefaults(), pivot: [9, 8, 7] }); expect(useApp.getState().transform?.dirty).toBe(false);
    expect(useApp.getState()).toMatchObject({ transformPivotMode: 'selection', transformPivotChosen: false });
    const revision = useApp.getState().summary!.contentRevision; expect(await f.controller.endTransformSession()).toBe(true);
    expect(useApp.getState()).toMatchObject({ transform: null, transformPreview: null, summary: { contentRevision: revision } });
  });
  it('Basic deactivation cancels the draft and ends without inventing an Apply', async () => {
    const f = await numeric(); switchToolsMode('basic'); expect(useApp.getState().mode).toBe('pro');
    expect(await f.controller.endTransformSession(true)).toBe(true); switchToolsMode('basic');
    expect(f.commands.map(command => command.command)).toEqual(['beginTransform', 'endTransform']); expect(useApp.getState().mode).toBe('basic');
  });
  it('Basic flips retain the same native baseline and require explicit Apply before baking', async () => {
    setApp({ mode: 'basic' }); const f = fixture(), before = useApp.getState().summary!;
    expect(f.controller.transformControlsEnabled).toBe(true);
    f.controller.setTransformFlip(0, true); await flush();
    expect(f.commands).toMatchObject([{ command: 'beginTransform', kind: 'numeric', selectedOnly: true }]);
    expect(useApp.getState().summary!.contentRevision).toBe(before.contentRevision);
    expect(useApp.getState().transform).toMatchObject({ kind: 'numeric', dirty: true });
    expect(await f.controller.applyTransform()).toBe(true);
    expect(f.commands.at(-1)).toMatchObject({ command: 'applyTransform', id: 1, epoch: 1,
      parameters: { flips: [true, false, false] } });
    const accepted = useApp.getState().summary!.contentRevision;
    f.controller.setTransformFlip(1, true); expect(await f.controller.cancelTransformPreview()).toBe(true);
    expect(useApp.getState().transformParameters.flips).toEqual([true, false, false]);
    expect(useApp.getState().summary!.contentRevision).toBe(accepted);
    expect(await f.controller.endTransformSession()).toBe(true);
    expect(f.commands.map(command => command.command)).toEqual(['beginTransform', 'applyTransform', 'endTransform']);
  });
  it('Basic passes flips through a retained affine representation without discarding its matrix', async () => {
    const parameters = { ...transformDefaults(), mode: 'matrix' as const };
    parameters.matrix[3] = 2;
    setApp({ mode: 'basic', transformParameters: parameters }); const f = fixture();
    f.controller.setTransformFlip(2, true); await flush(); expect(await f.controller.applyTransform()).toBe(true);
    expect(f.commands.at(-1)).toMatchObject({ command: 'applyTransform', parameters: {
      mode: 'matrix', matrix: parameters.matrix, flips: [false, false, true],
    } });
  });
  it('captures selection scope after admitted manual settlement and keeps it for later Apply', async () => {
    const f = fixture(); vi.mocked(f.controller.cancelSelectionGesture).mockImplementation(async () => {
      setApp({ summary: { ...useApp.getState().summary!, selected: 0 } }); return true;
    });
    f.controller.setTransformParameters({ translation: [1, 2, 3] }); await flush();
    expect(f.commands[0]).toMatchObject({ selectedOnly: false }); setApp({ summary: { ...useApp.getState().summary!, selected: 2 } });
    await f.controller.applyTransform(); expect(useApp.getState().transformPreview?.selectedOnly).toBe(false);
  });
  it('keeps the broader Basic header Reset available while malformed alignment and pending color remain guarded', async () => {
    const f = fixture(); setApp({ mode: 'basic' }); expect(f.controller.transformResetEnabled).toBe(true);
    expect(await f.controller.resetTransform()).toBe(true); expect(f.commands).toHaveLength(0);
    const grade = [...useApp.getState().grade]; grade[0] = 1.2; setApp({ grade });
    expect(f.controller.transformResetEnabled).toBe(false); setApp({ grade: [...useApp.getState().appliedGrade] });
    setApp({ summary: { ...useApp.getState().summary!, alignment: null } }); expect(f.controller.transformResetEnabled).toBe(false);
  });
});

describe('transform boundaries and incremental gestures', () => {
  it.each(['basic', 'pro'] as const)('%s permits the same selected native gizmo bake on release', async mode => {
    setApp({ mode }); const f = await gizmo();
    expect(f.controller.transformGizmoControlsEnabled).toBe(true);
    expect(f.controller.updateTransformGizmoGesture(f.token, pose())).toBe(true);
    // A real store publication must not retire a Basic gesture as Pro-only.
    setApp({ filterSnap: true });
    expect(f.controller.transformGizmoGestureActive).toBe(true);
    expect(await f.controller.finishTransformGizmoGesture(f.token)).toBe(true);
    expect(f.commands.map(command => command.command)).toEqual(['beginTransform', 'rebaseTransform', 'applyTransform']);
    expect(f.commands[0]).toMatchObject({ kind: 'gizmo', selectedOnly: true });
    expect(f.commands[2]).toMatchObject({ parameters: { mode: 'matrix', matrix: pose().rowMajorDelta } });
    expect(useApp.getState()).toMatchObject({ mode, transform: { kind: 'gizmo', dirty: false }, transformPreview: { matrix: transformDefaults().matrix }, transformGizmoMode: 'move', transformGizmoDragging: false });
  });
  it('Basic still cancels a gesture when a modal takes input and refuses its later release', async () => {
    setApp({ mode: 'basic' }); const f = await gizmo();
    expect(f.controller.updateTransformGizmoGesture(f.token, pose())).toBe(true);
    setApp({ settingsOpen: true });
    expect(f.controller.transformGizmoGestureActive).toBe(false);
    expect(await f.controller.finishTransformGizmoGesture(f.token)).toBe(false);
    expect(f.commands.map(command => command.command)).toEqual(['beginTransform', 'rebaseTransform']);
    expect(f.controller.transformControlsEnabled).toBe(false);
    expect(f.controller.transformGizmoModeEnabled).toBe(false);
  });
  it.each([
    ['basic', 'settingsOpen'], ['basic', 'exportOpen'], ['pro', 'settingsOpen'], ['pro', 'exportOpen'],
  ] as const)('preserves the idle %s gizmo through %s and resumes the same native owner', async (mode, modal) => {
    setApp({ mode }); const f = fixture(); expect(await f.controller.setTransformGizmoMode('move')).toBe(true);
    const native = useApp.getState().summary!.transformSession, watch = f.internal.transformGizmoUnsubscribe;
    expect(watch).toBeTypeOf('function'); expect(f.controller.transformGizmoGestureActive).toBe(false);
    const published = vi.fn(), stop = useApp.subscribe(published);
    try {
      setApp({ settingsOpen: modal === 'settingsOpen', exportOpen: modal === 'exportOpen' });
      // An idle modal does not recursively publish cancel(false) from the store subscriber.
      expect(published).toHaveBeenCalledTimes(1);
    } finally { stop(); }
    expect(useApp.getState()).toMatchObject({ mode, transformGizmoMode: 'move', transformGizmoDragging: false });
    expect(useApp.getState().summary!.transformSession).toBe(native); expect(f.internal.transformGizmoUnsubscribe).toBe(watch);
    expect(f.controller.transformGizmoControlsEnabled).toBe(false); expect(f.controller.transformGizmoFinishEnabled).toBe(false);
    expect(f.commands.map(command => command.command)).toEqual(['beginTransform']);
    setApp({ settingsOpen: false, exportOpen: false });
    expect(f.controller.transformGizmoControlsEnabled).toBe(true); expect(f.controller.transformGizmoFinishEnabled).toBe(true);
    const resumed = f.controller.beginTransformGizmoGesture()!; expect(resumed).not.toBeNull(); await flush();
    expect(f.controller.updateTransformGizmoGesture(resumed, pose())).toBe(true);
    expect(await f.controller.finishTransformGizmoGesture(resumed)).toBe(true);
    expect(useApp.getState().summary!.transformSession!.id).toBe(native!.id);
    expect(f.commands.map(command => command.command)).toEqual(['beginTransform', 'rebaseTransform', 'applyTransform']);
  });
  it.each([
    ['basic', 'settingsOpen'], ['basic', 'exportOpen'], ['pro', 'settingsOpen'], ['pro', 'exportOpen'],
  ] as const)('cancels a captured %s delta for %s while preserving its arm and rejecting the old release', async (mode, modal) => {
    setApp({ mode }); const f = await gizmo(), native = useApp.getState().summary!.transformSession;
    expect(f.controller.updateTransformGizmoGesture(f.token, pose())).toBe(true);
    setApp({ settingsOpen: modal === 'settingsOpen', exportOpen: modal === 'exportOpen' });
    expect(f.controller.transformGizmoGestureActive).toBe(false);
    expect(useApp.getState()).toMatchObject({ transformGizmoMode: 'move', transformGizmoDragging: false,
      transformPreview: { matrix: transformDefaults().matrix } });
    expect(useApp.getState().summary!.transformSession).toBe(native);
    expect(await f.controller.finishTransformGizmoGesture(f.token)).toBe(false);
    expect(f.commands.map(command => command.command)).toEqual(['beginTransform', 'rebaseTransform']);
    setApp({ settingsOpen: false, exportOpen: false });
    const resumed = f.controller.beginTransformGizmoGesture()!; expect(resumed).not.toBeNull(); await flush();
    expect(await f.controller.finishTransformGizmoGesture(f.token)).toBe(false);
    expect(f.controller.transformGizmoGestureActive).toBe(true);
    expect(f.controller.cancelTransformGizmoGesture(resumed, false)).toBe(true);
    expect(useApp.getState().transformGizmoMode).toBe('move');
    expect(f.commands.map(command => command.command)).toEqual(['beginTransform', 'rebaseTransform', 'rebaseTransform']);
  });
  it.each(['tools', 'readiness', 'renderer', 'source'] as const)('deactivates an idle modal gizmo on permanent %s loss', async loss => {
    const f = fixture(); expect(await f.controller.setTransformGizmoMode('move')).toBe(true);
    const native = useApp.getState().summary!.transformSession;
    setApp({ settingsOpen: true }); expect(useApp.getState().transformGizmoMode).toBe('move');
    if (loss === 'tools') setApp({ toolsOpen: false });
    else if (loss === 'readiness') setApp({ ready: false });
    else if (loss === 'renderer') setApp({ rendererState: 'recovering' });
    else { f.client.revision.sourceGeneration++; setApp({ filterSnap: true }); }
    expect(useApp.getState()).toMatchObject({ transformGizmoMode: null, transformGizmoDragging: false });
    expect(f.internal.transformGizmoUnsubscribe).toBeUndefined();
    expect(useApp.getState().summary!.transformSession).toBe(native);
    expect(f.commands.map(command => command.command)).toEqual(['beginTransform']);
    setApp({ settingsOpen: false, toolsOpen: true, ready: true, rendererState: 'ready' });
    expect(useApp.getState().transformGizmoMode).toBeNull();
  });
  it('coalesces clean-owner grade requests after end without baking a grade', async () => {
    const f = await numeric(); await f.controller.applyTransform(); const held = f.hold();
    const first = [...useApp.getState().grade], latest = [...first]; first[0] = 1.2; latest[0] = 1.6;
    f.controller.setGrade(first); await flush(); f.controller.setGrade(latest);
    expect(useApp.getState().grade[0]).toBe(1); held.resolve(true); await flush();
    expect(useApp.getState().grade[0]).toBe(Math.fround(1.6)); expect(f.commands.at(-1)?.command).toBe('endTransform'); expect(f.ordinary).not.toHaveBeenCalled();
  });
  it('does not replay queued color into a changed source', async () => {
    const f = await numeric(); await f.controller.applyTransform(); const held = f.hold(), grade = [...useApp.getState().grade]; grade[0] = 1.6;
    f.controller.setGrade(grade); await flush(); f.client.revision.sourceGeneration++; held.resolve(true); await flush();
    expect(useApp.getState().grade[0]).toBe(1); expect(f.ordinary).not.toHaveBeenCalled();
  });
  it('joins clean-owner materialization before activating the latest requested alignment tool', async () => {
    const f = await numeric(); await f.controller.applyTransform(); const held = f.hold();
    const center = f.controller.startCenterAlignment(); await flush(); const scale = f.controller.startScaleAlignment();
    held.resolve(true); expect(await center).toBe(false); expect(await scale).toBe(true);
    expect(useApp.getState().alignmentTool).toBe('scale'); expect(f.commands.at(-1)?.command).toBe('endTransform');
  });
  it('refuses ordinary destructive/source work while dirty, before cancelling alignment or selection', async () => {
    const f = await numeric(), alignment = vi.spyOn(f.controller, 'cancelAlignment'); alignment.mockClear();
    expect(await f.controller.command({ command: 'delete' })).toBe(false); expect(await f.controller.startCenterAlignment()).toBe(false);
    expect(await f.controller.selectFilter('sphere')).toBe(false); await f.controller.openFiles([]); await f.controller.exportScene();
    expect(alignment).not.toHaveBeenCalled(); expect(f.commands).toHaveLength(1);
  });
  it('prepares a native focus pivot and captures exact opaque references', async () => {
    const f = await gizmo(); expect(f.controller.transformGizmoWidgetMatrix?.slice(12, 15)).toEqual([3, 4, 5]);
    const copied = { ...f.token } as TransformGizmoGestureToken;
    expect(f.controller.updateTransformGizmoGesture(copied, pose())).toBe(false); expect(await f.controller.finishTransformGizmoGesture(copied)).toBe(false);
    expect(f.controller.cancelTransformGizmoGesture(copied, true)).toBe(false); expect(f.controller.cameraNavigationEnabled).toBe(false);
    const value = pose(); expect(f.controller.updateTransformGizmoGesture(f.token, value)).toBe(true); value.deltaMatrix[12] = 99;
    expect(useApp.getState().transformPreview?.matrix[12]).toBe(7); expect(f.commands).toHaveLength(2);
  });
  it('bakes native row-major delta on release and retains an identity-oriented current-geometry owner', async () => {
    const f = await gizmo(); f.internal.watchTransformPivot(); await flush(); f.controller.updateTransformGizmoGesture(f.token, pose());
    expect(await f.controller.finishTransformGizmoGesture(f.token)).toBe(true); await flush();
    expect(f.commands.map(command => command.command)).toEqual(['beginTransform', 'rebaseTransform', 'applyTransform']);
    expect(f.commands[2]).toMatchObject({ parameters: { mode: 'matrix', matrix: pose().rowMajorDelta, flips: [false, false, false] } });
    expect(useApp.getState()).toMatchObject({ transform: { kind: 'gizmo', dirty: false }, transformPreview: { matrix: transformDefaults().matrix }, transformGizmoMode: 'move', transformGizmoDragging: false });
    expect(useApp.getState().transformParameters).toEqual({ ...transformDefaults(), pivot: [3, 4, 5] });
  });
  it.each(['mode', 'camera', 'epoch', 'source', 'parameters'] as const)('refuses release after a later %s change without a bake', async change => {
    const f = await gizmo(); f.controller.updateTransformGizmoGesture(f.token, pose());
    if (change === 'mode') setApp({ transformGizmoMode: null });
    else if (change === 'camera') f.camera.revision++;
    else if (change === 'epoch') setApp({ summary: { ...useApp.getState().summary!, transformSession: { ...useApp.getState().summary!.transformSession!, epoch: useApp.getState().summary!.transformSession!.epoch + 1 } } });
    else if (change === 'parameters') setApp({ transformParameters: { ...useApp.getState().transformParameters, euler: [10, 20, 30] } });
    else f.client.revision.sourceGeneration++;
    expect(await f.controller.finishTransformGizmoGesture(f.token)).toBe(false); expect(f.commands).toHaveLength(2);
    expect(useApp.getState().transformGizmoDragging).toBe(false);
  });
  it.each(['resize', 'same-pixel-width', 'same-pixel-height', 'origin', 'dpr'] as const)(
    'cancels a %s before delayed ResizeObserver publication with no geometry/history bake', async change => {
      const f = await gizmo(), baseline = useApp.getState().summary!, revision = { ...f.client.revision };
      expect(f.controller.updateTransformGizmoGesture(f.token, pose())).toBe(true);
      if (change === 'resize') { f.viewport.width = 470; f.viewport.height = 390; }
      else if (change === 'same-pixel-width') f.viewport.width += .1;
      else if (change === 'same-pixel-height') f.viewport.height += .1;
      else if (change === 'origin') f.viewport.x = 1;
      else window.devicePixelRatio = 1.5;
      // The observer has not changed backing dimensions or camera revision.
      expect(f.renderer.canvas.width).toBe(400); expect(f.renderer.canvas.height).toBe(300); expect(f.camera.revision).toBe(2);
      if (change.startsWith('same-pixel')) {
        expect(Math.round(f.viewport.width)).toBe(400); expect(Math.round(f.viewport.height)).toBe(300);
      }
      expect(await f.controller.finishTransformGizmoGesture(f.token)).toBe(false);
      expect(f.controller.scene).toBe(f.scene); expect(useApp.getState().summary).toBe(baseline); expect(f.client.revision).toEqual(revision);
      expect(f.commands.map(command => command.command)).toEqual(['beginTransform', 'rebaseTransform']); expect(f.scene.dispose).not.toHaveBeenCalled();
      expect(useApp.getState()).toMatchObject({ transformGizmoDragging: false, transformGizmoMode: null,
        transform: { dirty: false }, transformPreview: { matrix: transformDefaults().matrix } });
    });
  it('a delayed displayed resize also cancels before accepting another pointer update', async () => {
    const f = await gizmo(), baseline = useApp.getState().summary!;
    expect(f.controller.updateTransformGizmoGesture(f.token, pose())).toBe(true); f.viewport.width += .1;
    expect(f.controller.updateTransformGizmoGesture(f.token, pose(12))).toBe(false);
    expect(await f.controller.finishTransformGizmoGesture(f.token)).toBe(false); expect(useApp.getState().summary).toBe(baseline);
    expect(f.commands.map(command => command.command)).toEqual(['beginTransform', 'rebaseTransform']);
    expect(useApp.getState().transformPreview?.matrix).toEqual(transformDefaults().matrix);
  });
  it('Escape cancellation restores the delta, preserves preferences and does not cancel a native baseline', async () => {
    const f = await gizmo(); setApp({ filterLocalAxes: true, filterSnap: true }); f.controller.updateTransformGizmoGesture(f.token, pose());
    expect(f.controller.cancelTransformGizmoGesture(f.token, true)).toBe(true);
    expect(useApp.getState()).toMatchObject({ transformGizmoMode: null, transformGizmoDragging: false, filterLocalAxes: true, filterSnap: true,
      transform: { dirty: false }, transformPreview: { matrix: transformDefaults().matrix } }); expect(f.commands).toHaveLength(2);
    expect(f.controller.transformControlsEnabled).toBe(true); expect(f.client.cancel).not.toHaveBeenCalled();
  });
  it('idle gizmo numeric/flip edits join end then begin a numeric owner with all requested fields', async () => {
    const f = fixture(); await f.controller.setTransformGizmoMode('move'); const held = f.hold();
    f.controller.setTransformParameters({ translation: [4, 5, 6] }); await flush(); f.controller.setTransformFlip(0, true); f.controller.setTransformFlip(1, true);
    held.resolve(true); await flush();
    expect(f.commands.map(command => command.command)).toEqual(['beginTransform', 'endTransform', 'beginTransform']);
    expect(useApp.getState()).toMatchObject({ transformGizmoMode: null, transform: { kind: 'numeric', dirty: true },
      transformParameters: { translation: [4, 5, 6], flips: [true, true, false] } });
  });
  it('saved-view and thumbnail work refuses dirty parameters before draining the native owner', async () => {
    const f = await numeric(); expect(await f.controller.updateThumbnail()).toBe(false);
    expect(await f.controller.importSavedView(new Blob())).toBe(false); expect(await f.controller.exportSavedView()).toBe(false);
    expect(f.commands).toHaveLength(1);
  });
});

describe('continuous gizmo session action scheduling', () => {
  it('shows armed actions before the first drag and finishes or cancels without a geometry edit', async () => {
    const f = fixture(); await f.controller.setTransformGizmoMode('move');
    expect(f.controller.transformGizmoActionsVisible).toBe(true); expect(f.controller.transformGizmoFinishEnabled).toBe(true);
    expect(f.controller.transformGizmoUndoEnabled).toBe(false); expect(f.controller.transformGizmoCancelEnabled).toBe(true);
    const before = useApp.getState().summary!; expect(await f.controller.finishTransformGizmo()).toBe(true);
    expect(f.commands.map(row => row.command)).toEqual(['beginTransform', 'endTransform']);
    expect(useApp.getState().summary!.contentRevision).toBe(before.contentRevision);
    await f.controller.setTransformGizmoMode('rotate'); expect(await f.controller.cancelTransformGizmo()).toBe(true);
    expect(f.commands.at(-1)?.command).toBe('cancelTransform'); expect(useApp.getState().transformGizmoMode).toBeNull();
    expect(useApp.getState().summary!.contentRevision).toBe(before.contentRevision);
  });
  it('keeps successive drags and their original Cancel identity in one owner, with identity-oriented idle widgets', async () => {
    const f = await gizmo(); f.controller.updateTransformGizmoGesture(f.token, pose());
    expect(await f.controller.finishTransformGizmoGesture(f.token)).toBe(true);
    const first = useApp.getState().summary!.transformSession!;
    expect(first.appliedEpoch).toBeNull(); expect(first.gizmo!.canUndo).toBe(true);
    const next = f.controller.beginTransformGizmoGesture()!; await flush(); f.controller.updateTransformGizmoGesture(next, pose(3));
    expect(await f.controller.finishTransformGizmoGesture(next)).toBe(true);
    const second = useApp.getState().summary!.transformSession!;
    expect(second.id).toBe(first.id); expect(second.baseId).not.toBe(first.baseId);
    expect(second.gizmo!.cancelBaseId).toBe(first.gizmo!.cancelBaseId);
    expect(second.gizmo!.cancelContentRevision).toBe(first.gizmo!.cancelContentRevision);
    expect(f.commands.map(row => row.command)).toEqual(['beginTransform', 'rebaseTransform', 'applyTransform', 'rebaseTransform', 'applyTransform']);
    expect(f.controller.transformGizmoWidgetMatrix?.slice(0, 12)).toEqual(transformDefaults().matrix.slice(0, 12));
    expect(useApp.getState()).toMatchObject({ transformGizmoMode: 'move', transform: { dirty: false } });
  });
  it('routes Undo/Redo through the native session and lets generic Undo fall back only at its baseline', async () => {
    const f = await gizmo(); f.controller.updateTransformGizmoGesture(f.token, pose()); await f.controller.finishTransformGizmoGesture(f.token);
    expect(await f.controller.undoTransformGizmo()).toBe(true); expect(f.commands.at(-1)?.command).toBe('undoTransform');
    expect(f.controller.transformGizmoUndoEnabled).toBe(false); expect(await f.controller.undoTransformGizmo()).toBe(false);
    expect(await f.controller.command({ command: 'redo' })).toBe(true); expect(f.commands.at(-1)?.command).toBe('redoTransform');
    expect(await f.controller.command({ command: 'undo' })).toBe(true); expect(f.commands.at(-1)?.command).toBe('undoTransform');
    expect(f.ordinary).not.toHaveBeenCalled(); expect(await f.controller.command({ command: 'undo' })).toBe(true);
    expect(f.commands.at(-1)?.command).toBe('endTransform'); expect(f.ordinary).toHaveBeenCalledWith({ command: 'undo' });
  });
  it('retains an idle transform session across both profile switches without native work', async () => {
    const f = fixture(); await f.controller.setTransformGizmoMode('scale'); const count = f.commands.length;
    switchToolsMode('basic'); expect(useApp.getState()).toMatchObject({ mode: 'basic', pendingMode: null, transformGizmoMode: 'scale' });
    switchToolsMode('pro'); expect(useApp.getState()).toMatchObject({ mode: 'pro', pendingMode: null, transformGizmoMode: 'scale' });
    expect(f.commands).toHaveLength(count); expect(f.controller.transformGizmoActionsVisible).toBe(true);
  });
  it('does not apply an identity release or invent an original Cancel baseline', async () => {
    const f = await gizmo(); f.controller.updateTransformGizmoGesture(f.token, pose(0));
    expect(await f.controller.finishTransformGizmoGesture(f.token)).toBe(true);
    expect(f.commands.map(row => row.command)).toEqual(['beginTransform', 'rebaseTransform']);
    expect(useApp.getState().summary!.transformSession!.gizmo!.cancelBaseId).toBeNull();
    expect(f.controller.transformGizmoUndoEnabled).toBe(false); expect(useApp.getState().transform?.dirty).toBe(false);
  });
  it('buffers a release until its physical press target is acknowledged, then applies once', async () => {
    const f = fixture(); await f.controller.setTransformGizmoMode('move'); const held = f.hold();
    const token = f.controller.beginTransformGizmoGesture()!; await flush();
    expect(f.controller.updateTransformGizmoGesture(token, pose())).toBe(true);
    expect(useApp.getState().transformPreview!.matrix).toEqual(transformDefaults().matrix);
    const released = f.controller.finishTransformGizmoGesture(token); await flush();
    expect(f.commands.map(row => row.command)).toEqual(['beginTransform', 'rebaseTransform']);
    held.resolve(true); expect(await released).toBe(true);
    expect(f.commands.filter(row => row.command === 'applyTransform')).toHaveLength(1);
  });
  it('cancels unfinished input before older history even if App clears capture before rebase joins', async () => {
    const f = fixture(); await f.controller.setTransformGizmoMode('move'); const held = f.hold();
    const token = f.controller.beginTransformGizmoGesture()!; await flush(); f.controller.updateTransformGizmoGesture(token, pose());
    const undone = f.controller.undoTransformGizmo(); f.controller.cancelTransformGizmoGesture(undefined, false);
    held.resolve(true); expect(await undone).toBe(true);
    expect(f.commands.map(row => row.command)).toEqual(['beginTransform', 'rebaseTransform']);
    expect(useApp.getState().transformPreview!.baseId).toBe(useApp.getState().summary!.transformSession!.baseId);
    expect(useApp.getState().transformGizmoMode).toBe('move');
  });
  it('joins a canceled in-flight later drag before restoring the original session', async () => {
    const f = await gizmo(); f.controller.updateTransformGizmoGesture(f.token, pose()); await f.controller.finishTransformGizmoGesture(f.token);
    const original = useApp.getState().summary!.transformSession!.gizmo!.cancelContentRevision;
    const token = f.controller.beginTransformGizmoGesture()!; await flush(); f.controller.updateTransformGizmoGesture(token, pose(3));
    const held = f.hold(), applying = f.controller.finishTransformGizmoGesture(token); await flush();
    expect(f.controller.transformGizmoFinishEnabled).toBe(false); expect(f.controller.transformGizmoCancelEnabled).toBe(true);
    const cancel = f.controller.cancelTransformGizmo(); held.resolve(true);
    expect(await applying).toBe(false); expect(await cancel).toBe(true); expect(f.client.cancel).toHaveBeenCalled();
    expect(f.commands.at(-1)?.command).toBe('cancelTransform'); expect(useApp.getState().summary!.contentRevision).toBe(original);
    expect(useApp.getState()).toMatchObject({ transform: null, transformGizmoMode: null });
  });
  it('fences an admitted Check again before its queued lane can touch a replacement owner', async () => {
    const f = fixture(); await f.controller.setTransformGizmoMode('move'); const pending = f.controller.finishTransformGizmo();
    f.internal.transformOwner = { ...(f.internal.transformOwner as object) };
    expect(await pending).toBe(false); expect(f.commands.map(row => row.command)).toEqual(['beginTransform']);
  });
  it('header Reset cancels the original gizmo session before its broader alignment/numeric reset', async () => {
    const f = await gizmo(); f.controller.updateTransformGizmoGesture(f.token, pose()); await f.controller.finishTransformGizmoGesture(f.token);
    expect(f.controller.transformResetEnabled).toBe(true); expect(await f.controller.resetTransform()).toBe(true);
    expect(f.commands.at(-1)?.command).toBe('cancelTransform'); expect(f.commands.some(row => row.command === 'resetTransform')).toBe(false);
    expect(useApp.getState()).toMatchObject({ transform: null, transformGizmoMode: null, transformPivotMode: 'selection', transformPivotChosen: false });
  });
  it('captures absence of a current-view target before asynchronous dispatch', async () => {
    const f = fixture(); await f.controller.setTransformGizmoMode('move'); const token = f.controller.beginTransformGizmoGesture()!;
    setApp({ currentViewOnly: true }); await flush(); expect(f.commands.at(-1)).toMatchObject({ command: 'rebaseTransform' });
    expect(f.commands.at(-1)).not.toHaveProperty('selectionView'); f.controller.cancelTransformGizmoGesture(token, false);
  });
});

function nativeTransactions(f: Awaited<ReturnType<typeof numeric>>) {
  f.execute.mockRestore(); let authoritative = useApp.getState().summary!, checkpoint = authoritative;
  const commands: string[] = [], credit = {
    updateNativeCoverage: vi.fn(), setNativeWork: vi.fn(), releaseNativeCoverage: vi.fn((lease: ResourceLease) => lease()),
    transferNativeCoverage: vi.fn((updates: { lease: ResourceLease; nextLeaseBytes: number }[]) => {
      for (const update of updates) update.lease.resize(update.nextLeaseBytes);
    }), readMasks: vi.fn(async (masks: (bytes: ArrayBuffer) => void) => { masks(new Uint8Array([1,0,2]).buffer); return authoritative; }),
  };
  Object.assign(f.scene, { stageMasks: vi.fn(async () => ({ allocationBytes: 27, retirementBytes: 27,
    retirementBuffers: [], publish: vi.fn(), dispose: vi.fn() })) });
  Object.assign(f.client, credit);
  f.client.command.mockImplementation(async (command: SceneCommand) => {
    commands.push(command.command);
    if (command.command === 'beginTransaction') { checkpoint = authoritative; authoritative = { ...authoritative, transaction: true }; }
    if (command.command === 'applyTransform') {
      const definition = command.parameters as TransformDefinition;
      const owner = authoritative.transformSession!, gizmo = owner.kind === 'gizmo';
      authoritative = { ...authoritative, revision: authoritative.revision + 1, contentRevision: authoritative.contentRevision + 1, sceneChanged: true,
        transformSession: { ...owner, epoch: command.epoch as number, appliedEpoch: gizmo ? null : command.epoch as number,
          baseId: gizmo ? owner.baseId + 1 : owner.baseId,
          gizmo: gizmo ? { cancelBaseId: owner.gizmo!.cancelBaseId ?? owner.baseId,
            cancelContentRevision: owner.gizmo!.cancelContentRevision ?? authoritative.contentRevision, canUndo: true, canRedo: false } : null,
          appliedMatrix: gizmo ? transformDefaults().matrix : f.camera.composeTransform(definition).matrix, pivot: definition.pivot } };
    }
    if (command.command === 'endTransform') authoritative = { ...authoritative, transformSession: null, opacitySession: null, sceneChanged: false };
    if (command.command === 'commitTransaction') authoritative = { ...authoritative, transaction: false };
    if (command.command === 'rollbackTransaction') authoritative = checkpoint;
    return authoritative;
  });
  return { commands, credit, get authoritative() { return authoritative; } };
}
describe('admitted transform publication and retained recovery', () => {
  it('publishes an identity gizmo preview with the new baked GPU base before old-scene retirement joins', async () => {
    const f = await gizmo(); f.controller.updateTransformGizmoGesture(f.token, pose()); const tx = nativeTransactions(f);
    const retired = deferred<void>(), staged = { count: 3, kind: 'gaussian', renderer: f.renderer, setDuplicateRange: vi.fn(), upload: vi.fn(), masks: vi.fn(),
      allocationBytes: 100, dispose: vi.fn(async () => {}),
      stagePreviewMasks: vi.fn(async () => ({ retirementBuffers: [], publish: vi.fn(), dispose: vi.fn() })) };
    Object.assign(f.renderer, { allocateScene: vi.fn(async () => staged) }); f.scene.dispose.mockImplementation(async () => retired.promise);
    f.client.stream.mockImplementation(async (_chunk: unknown, masks: (bytes: ArrayBuffer) => void) => { masks(new Uint8Array([1,0,2]).buffer); return tx.authoritative; });
    const applying = f.controller.finishTransformGizmoGesture(f.token); await flush();
    expect(useApp.getState().error).toBeNull();
    expect(f.controller.scene).toBe(staged); expect(f.scene.dispose).toHaveBeenCalledOnce();
    expect(useApp.getState().transformPreview!.matrix).toEqual(transformDefaults().matrix);
    expect(useApp.getState().transformPreview!.baseId).toBe(useApp.getState().summary!.transformSession!.baseId);
    retired.resolve(); expect(await applying).toBe(true); expect(useApp.getState().transformGizmoMode).toBe('move');
  });

  it('Apply retains the exact GPU geometry and publishes canonical masks with its separately frozen target', async () => {
    const f = await numeric(), tx = nativeTransactions(f), allocateScene = vi.fn(), stageMasks = (f.scene as unknown as { stageMasks: ReturnType<typeof vi.fn> }).stageMasks;
    Object.assign(f.renderer, { allocateScene });
    expect(await f.controller.applyTransform()).toBe(true);
    expect(tx.commands).toEqual(['beginTransaction', 'applyTransform', 'commitTransaction']);
    expect(f.controller.scene).toBe(f.scene); expect(allocateScene).not.toHaveBeenCalled(); expect(stageMasks).toHaveBeenCalledOnce();
    expect(f.client.stream).not.toHaveBeenCalled(); expect(tx.credit.readMasks).toHaveBeenCalledTimes(2);
    expect(tx.credit.setNativeWork).toHaveBeenLastCalledWith(undefined);
  });
  it('failed end upload rolls back its native owner, retains the accepted display and releases work credit', async () => {
    const f = await numeric(); await f.controller.applyTransform(); const before = useApp.getState().summary!, preview = useApp.getState().transformPreview;
    const tx = nativeTransactions(f), staged = { setDuplicateRange: vi.fn(), upload: vi.fn(), masks: vi.fn(), allocationBytes: 100, dispose: vi.fn(async () => {}) };
    Object.assign(f.renderer, { allocateScene: vi.fn(async () => staged) }); f.client.stream.mockRejectedValue(new Error('Upload refused'));
    expect(await f.controller.endTransformSession()).toBe(false);
    expect(tx.commands).toEqual(['beginTransaction', 'endTransform', 'rollbackTransaction']); expect(useApp.getState().summary).toEqual(before);
    expect(useApp.getState().transformPreview).toEqual(preview); expect(useApp.getState().transform?.phase).toBe('required');
    expect(f.controller.scene).toBe(f.scene); expect(staged.dispose).toHaveBeenCalledOnce();
    expect((f.internal.ledger as ResourceLedger).usage.bytes).toBe(0); expect(tx.credit.setNativeWork).toHaveBeenLastCalledWith(undefined);
  });
  it('publishes end materialization and removes its matrix before retiring old GPU ownership', async () => {
    const f = await numeric(); await f.controller.applyTransform(); const tx = nativeTransactions(f);
    const retired = deferred<void>(), staged = { setDuplicateRange: vi.fn(), upload: vi.fn(), masks: vi.fn(), allocationBytes: 100, dispose: vi.fn(async () => {}) };
    Object.assign(f.renderer, { allocateScene: vi.fn(async () => staged) }); f.scene.dispose.mockImplementation(async () => retired.promise);
    f.client.stream.mockImplementation(async () => tx.authoritative);
    const ending = f.controller.endTransformSession(); await flush();
    expect(f.controller.scene).toBe(staged); expect(useApp.getState().transformPreview).toBeNull(); expect(f.scene.dispose).toHaveBeenCalledOnce();
    retired.resolve(); expect(await ending).toBe(true); expect(useApp.getState().transform).toBeNull();
  });
  it('refuses an inconsistent commit without publishing candidate state or claiming rollback', async () => {
    const f = await numeric(), before = useApp.getState().summary!, tx = nativeTransactions(f), command = f.client.command.getMockImplementation()!;
    f.client.command.mockImplementation(async (value: SceneCommand) => {
      const result = await command(value); return value.command === 'commitTransaction' ?
        { ...result, transformSession: { ...result.transformSession!, epoch: result.transformSession!.epoch + 1 } } : result;
    });
    expect(await f.controller.applyTransform()).toBe(false);
    expect(tx.commands).toEqual(['beginTransaction', 'applyTransform', 'commitTransaction']); expect(useApp.getState().summary).toEqual(before);
    expect(useApp.getState().transform).toMatchObject({ id: 1, baseId: 101, phase: 'required' }); expect(f.controller.editingAvailable).toBe(false);
  });
  it('graphics recovery streams the retained native base and preserves desired controls rather than applying them', async () => {
    const f = await numeric(); await f.controller.applyTransform(); f.controller.setTransformParameters({ translation: [8, 9, 10] });
    const authoritative = useApp.getState().summary!; f.renderer.lost = true; f.internal.canvas = {};
    vi.spyOn(f.internal, 'ensureStartupCore').mockResolvedValue(); vi.spyOn(f.internal, 'synchronizeViewport').mockReturnValue(true);
    vi.spyOn(f.internal, 'observeCanvas').mockImplementation(() => {}); vi.spyOn(f.internal, 'shrinkNativeHistory').mockImplementation(() => {});
    f.client.command.mockResolvedValue(authoritative);
    const staged = { kind: 'gaussian', setDuplicateRange: vi.fn(), count: 3, allocationBytes: 112, upload: vi.fn(), masks: vi.fn(), dispose: vi.fn(async () => {}),
      stagePreviewMasks: vi.fn(async () => ({ allocationBytes: 12, retirementBytes: 0, retirementBuffers: [], publish: vi.fn(), dispose: vi.fn() })) };
    const replacement = { ...f.renderer, lost: false, allocateScene: vi.fn(async () => staged) };
    Object.assign(staged, { renderer: replacement });
    vi.spyOn(GaussianRenderer, 'create').mockResolvedValue(replacement as unknown as GaussianRenderer);
    Object.assign(f.client, { readMasks: vi.fn(async (masks: (bytes: ArrayBuffer) => void) => { masks(new Uint8Array([1,0,2]).buffer); return authoritative; }) });
    f.client.stream.mockImplementation(async (_chunk: unknown, masks: (bytes: ArrayBuffer) => void) => { masks(new Uint8Array([1,0,2]).buffer); return authoritative; });
    expect(await f.controller.retryRenderer()).toBe(true);
    expect(f.client.command).toHaveBeenCalledWith({ command: 'summary' }); expect(f.client.stream.mock.calls.at(-1)?.[2]).toBe('transformBase');
    expect(useApp.getState()).toMatchObject({ ready: true, transform: { phase: 'ready', dirty: true, id: 1, baseId: 101 },
      transformParameters: { translation: [8, 9, 10] }, transformPreview: { matrix: expect.arrayContaining([8, 9, 10]) } });
    expect(f.commands.filter(value => value.command === 'applyTransform')).toHaveLength(1);
  });
});
