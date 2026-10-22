import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppController, type FilterGizmoGestureToken } from '../src/app/controller';
import { setApp, switchToolsMode, useApp } from '../src/app/store';
import type { CoreClient } from '../src/document/coreClient';
import { filterDefaults, type SelectionFilterKind, type SelectionFilterSummary } from '../src/document/filterProtocol';
import type { NativeSummary, SceneCommand } from '../src/document/types';
import type { GaussianRenderer } from '../src/renderer/webgpu/renderer';

// These tests qualify definition/owner scheduling, not native gizmo math or GPU
// publication. Native commands are observed so a drag cannot hide a Preview job.
const initial = useApp.getState();
const controllers: AppController[] = [];
function summary(filter: SelectionFilterSummary | null = null): NativeSummary {
  return { ok: true, duplicateRange: null, toleranceRecorded: null, toleranceRange: null, toleranceSessionId: null, toleranceTool: null,
    loaded: true, kind: 0, count: 3, sourceCount: 3, selected: 1, visible: 3, shDegree: 0,
    format: 'PLY', canUndo: true, canRedo: true, revision: 2, contentRevision: 1, transaction: false,
    selectionDraft: false, sceneChanged: false, pending: false, progress: 1, floor: null, filter, transformSession: null, opacitySession: null,
    center: [0, 0, 0], radius: 1, yUp: false, camera: [0, 0, 0, 0, 0, 3, 1, 45, 0, 0, 1],
    memoryBytes: 528, selectionMapId: null, pendingSelectionMapId: null, selectionMapBytes: 0, selectionMapRetainedIds: [] };
}
type Internal = {
  executeEditCommand(command: SceneCommand, current?: () => boolean): Promise<boolean>;
  closeToleranceSelection(): Promise<void>; settleColorSession(): Promise<boolean>;
  synchronizeViewport(): boolean;
  canvas?: HTMLCanvasElement; viewport?: { width: number; height: number };
  filterOwner?: { nextEpoch: number; desiredRevision: number; parameterRevision: number; cancelRequested: boolean; phase: string };
  requireFilterCleanup(owner: NonNullable<Internal['filterOwner']>): void;
};
beforeEach(() => {
  vi.stubGlobal('document', { hidden: true, title: '' }); vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('window', { devicePixelRatio: 1 });
  setApp({ ...initial, ready: true, rendererState: 'ready', toolsOpen: true, busy: false, mode: 'pro', operation: 0,
    summary: summary(), filter: null, filterParameters: filterDefaults(), filterCenterPicking: false, filterCenterPending: false,
    filterGizmoMode: null, filterGizmoDragging: false, navigationPrompt: false, settingsOpen: false, exportOpen: false,
    outputPending: false, viewTransferPending: false, thumbnailPending: false, savedViewChoices: [], selectionRecovery: 'idle' }, true);
});
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.cancelFilterGizmoGesture(undefined, true);
  vi.restoreAllMocks(); vi.unstubAllGlobals(); setApp(initial, true);
});
function fixture() {
  const controller = new AppController(), internal = controller as unknown as Internal;
  controllers.push(controller);
  const client = { revision: { documentId: 'gizmo-host', sourceGeneration: 1, contentRevision: 1, selectionRevision: 2, draftRevision: 0 },
    assertNativeAdmission: vi.fn(), cancel: vi.fn(), command: vi.fn(), stream: vi.fn() };
  const scene = { kind: 'gaussian', setDuplicateRange: vi.fn(), count: 3, sourceRevision: 1 };
  const renderer = { lost: false, deviceEpoch: 1, render: vi.fn(), pick: vi.fn(),
    canvas: { width: 400, height: 300, getBoundingClientRect: () => ({ width: 400, height: 300 }) } };
  const camera = { revision: 2, clearInput: vi.fn(), aspect: vi.fn(),
    filterView: vi.fn(() => ({ center: [1, 2, 3], rotation: [0, 90, 0], fov: 45, aspect: 4 / 3, near: .01, far: 30 })) };
  controller.client = client as unknown as CoreClient; controller.scene = scene as unknown as NonNullable<AppController['scene']>;
  controller.renderer = renderer as unknown as GaussianRenderer; controller.camera = camera as unknown as NonNullable<AppController['camera']>;
  vi.spyOn(controller, 'invalidate').mockImplementation(() => {});
  vi.spyOn(controller, 'cancelSelectionGesture').mockResolvedValue(true);
  vi.spyOn(internal, 'closeToleranceSelection').mockResolvedValue(); vi.spyOn(internal, 'settleColorSession').mockResolvedValue(true);
  const commands: SceneCommand[] = []; let id = 0, baseline = summary(), release: (() => void) | undefined;
  let held: Promise<void> | undefined;
  vi.spyOn(internal, 'executeEditCommand').mockImplementation(async (command, current) => {
    commands.push(structuredClone(command));
    if (command.command === 'beginFilter') {
      baseline = { ...useApp.getState().summary!, filter: null };
      setApp({ summary: { ...baseline, filter: { id: ++id, kind: command.kind as SelectionFilterKind, epoch: 0, previewEpoch: null, changed: false } } });
    } else if (command.command === 'previewFilter') {
      const wait = held; held = undefined; setApp({ busy: true }); if (wait) await wait;
      if (current && !current()) { setApp({ busy: false }); return false; }
      const before = useApp.getState().summary!;
      setApp({ summary: { ...before, selected: 2, revision: before.revision + 1,
        filter: { id: command.id as number, kind: command.kind as SelectionFilterKind, epoch: command.epoch as number, previewEpoch: command.epoch as number, changed: true } }, busy: false });
    } else if (command.command === 'confirmFilter') setApp({ summary: { ...useApp.getState().summary!, filter: null } });
    else if (command.command === 'cancelFilter') setApp({ summary: { ...baseline, filter: null }, busy: false });
    return true;
  });
  return { controller, internal, client, scene, renderer, camera, commands,
    holdPreview() { held = new Promise<void>(resolve => { release = resolve; }); return () => release!(); } };
}
async function dragging(kind: SelectionFilterKind = 'box') {
  const f = fixture(); expect(await f.controller.selectFilter(kind)).toBe(true);
  expect(f.controller.setFilterGizmoMode('move')).toBe(true);
  const token = f.controller.beginFilterGizmoGesture(); expect(token).not.toBeNull(); return { ...f, token: token! };
}
const flush = async () => { for (let index = 0; index < 24; index++) await Promise.resolve(); };

describe('filter gizmo definition lifecycle', () => {
  it('keeps detached drag writes cheap and makes release wait for explicit Preview', async () => {
    const f = await dragging(); const center: [number, number, number] = [2, 3, 4];
    expect(f.controller.updateFilterGizmoGesture(f.token, { center, rotation: [0, 15, 0], size: [2, 3, 4] })).toBe(true);
    center[0] = 99; expect(useApp.getState().filterParameters.center).toEqual([2, 3, 4]);
    expect(f.controller.updateFilterGizmoGesture(f.token, { center: [3, 4, 5] })).toBe(true);
    expect(f.commands.map(command => command.command)).toEqual(['beginFilter', 'previewFilter']);
    expect(f.client.command).not.toHaveBeenCalled(); expect(f.client.cancel).not.toHaveBeenCalled();
    expect(f.controller.filterPreviewEnabled).toBe(false); expect(f.controller.filterFinishEnabled).toBe(false);
    expect(await f.controller.previewFilter()).toBe(false); expect(await f.controller.confirmFilter()).toBe(false);
    expect(f.controller.finishFilterGizmoGesture(f.token)).toBe(true);
    expect(useApp.getState()).toMatchObject({ filterGizmoMode: 'move', filterGizmoDragging: false, filter: { dirty: true, desiredRevision: 2 } });
    expect(f.controller.filterPreviewEnabled).toBe(true); expect(f.controller.filterFinishEnabled).toBe(true);
    expect(await f.controller.previewFilter()).toBe(true);
    expect(f.commands.at(-1)).toMatchObject({ command: 'previewFilter', epoch: 2, parameters: { center: [3, 4, 5], rotation: [0, 15, 0], size: [2, 3, 4] } });
  });
  it('restores a clean candidate without rewinding revisions or native epochs', async () => {
    const f = await dragging();
    f.controller.updateFilterGizmoGesture(f.token, { center: [2, 3, 4] });
    f.controller.updateFilterGizmoGesture(f.token, { size: [5, 6, 7] });
    const before = useApp.getState().filter!.desiredRevision;
    expect(f.controller.cancelFilterGizmoGesture(f.token)).toBe(true);
    expect(useApp.getState()).toMatchObject({ filterGizmoMode: 'move', filterGizmoDragging: false,
      filter: { dirty: false, desiredRevision: before + 1, previewRevision: before + 1, parameters: { center: [0, 0, 0], size: [1, 1, 1] } },
      summary: { filter: { epoch: 1, previewEpoch: 1 } } });
    expect(f.internal.filterOwner?.nextEpoch).toBe(2); expect(f.commands).toHaveLength(2);
    expect(await f.controller.confirmFilter()).toBe(true);
    expect(f.commands.map(command => command.command)).toEqual(['beginFilter', 'previewFilter', 'confirmFilter']);
    expect(f.commands.at(-1)).toMatchObject({ epoch: 1 });
  });
  it('keeps an initially dirty definition dirty after pose cancellation', async () => {
    const f = fixture(); await f.controller.selectFilter('sphere'); f.controller.setFilterParameters({ radius: 3 });
    f.controller.setFilterGizmoMode('scale'); const token = f.controller.beginFilterGizmoGesture()!;
    f.controller.updateFilterGizmoGesture(token, { radius: 6 });
    f.controller.cancelFilterGizmoGesture(token, true);
    expect(useApp.getState()).toMatchObject({ filterGizmoMode: null, filter: { dirty: true, desiredRevision: 3, previewRevision: 0, parameters: { radius: 3 } } });
    expect(await f.controller.confirmFilter()).toBe(true);
    expect(f.commands.at(-2)).toMatchObject({ command: 'previewFilter', epoch: 2, parameters: { radius: 3 } });
  });
  it('retains interleaved Combine changes, admits later token writes, and requires a fresh preview', async () => {
    const f = await dragging(); f.controller.updateFilterGizmoGesture(f.token, { center: [4, 5, 6] });
    f.controller.setFilterOperation(2);
    expect(f.controller.updateFilterGizmoGesture(f.token, { size: [2, 2, 2] })).toBe(true);
    expect(f.controller.cancelFilterGizmoGesture(f.token, true)).toBe(true);
    expect(useApp.getState()).toMatchObject({ operation: 2, filter: { operation: 2, dirty: true, desiredRevision: 4,
      parameters: { center: [0, 0, 0], size: [1, 1, 1] } } });
    expect(f.commands).toHaveLength(2); expect(await f.controller.confirmFilter()).toBe(true);
    expect(f.commands.at(-2)).toMatchObject({ command: 'previewFilter', operation: 2, epoch: 2 });
  });
  it('proves the full original operation match when Combine returns to its captured value', async () => {
    const f = await dragging(); f.controller.updateFilterGizmoGesture(f.token, { center: [1, 2, 3] });
    f.controller.setFilterOperation(1); f.controller.setFilterOperation(0);
    f.controller.cancelFilterGizmoGesture(f.token);
    expect(useApp.getState().filter).toMatchObject({ dirty: false, desiredRevision: 4, previewRevision: 4 });
    expect(f.commands).toHaveLength(2);
  });
  it('preserves non-pose changes and refuses a token to overwrite a non-token parameter write', async () => {
    const f = await dragging('frustum'); f.controller.updateFilterGizmoGesture(f.token, { center: [4, 5, 6] });
    f.controller.setFilterParameters({ fov: 75, near: .25, maxOpacity: .6 });
    expect(f.controller.updateFilterGizmoGesture(f.token, { center: [8, 9, 10] })).toBe(false);
    expect(f.controller.cancelFilterGizmoGesture(f.token)).toBe(true);
    expect(useApp.getState().filter).toMatchObject({ dirty: true, parameters: { center: [0, 0, 0], fov: 75, near: .25, maxOpacity: .6 } });
    expect(f.commands).toHaveLength(2);
  });
  it('does not regain clean merely because an unrelated pose write later returns to the same values', async () => {
    const f = await dragging(); f.controller.setFilterParameters({ center: [1, 2, 3] });
    f.controller.setFilterParameters({ center: [0, 0, 0] });
    f.controller.cancelFilterGizmoGesture(f.token);
    expect(useApp.getState().filter).toMatchObject({ dirty: true, desiredRevision: 2, previewRevision: 0 });
  });
  it('detects unrevisioned full-definition mutation when proving cancellation cleanliness', async () => {
    const f = await dragging(); useApp.getState().filterParameters.fov = 80;
    expect(f.controller.cancelFilterGizmoGesture(f.token)).toBe(true);
    expect(useApp.getState().filter).toMatchObject({ dirty: true, desiredRevision: 1, parameters: { fov: 80 } });
    expect(f.commands).toHaveLength(2);
  });
  it('rejects non-pose, accessor, malformed and nonfinite token patches without invoking getters', async () => {
    const f = await dragging(), getter = vi.fn(() => [1, 2, 3]);
    const accessor = Object.defineProperty({}, 'center', { enumerable: true, get: getter });
    expect(f.controller.updateFilterGizmoGesture(f.token, accessor)).toBe(false);
    expect(f.controller.updateFilterGizmoGesture(f.token, { center: [1, 2] as unknown as [number, number, number] })).toBe(false);
    expect(f.controller.updateFilterGizmoGesture(f.token, { radius: Number.NaN })).toBe(false);
    expect(f.controller.updateFilterGizmoGesture(f.token, { near: .5 } as never)).toBe(false);
    expect(getter).not.toHaveBeenCalled(); expect(useApp.getState().filter?.desiredRevision).toBe(0);
  });
  it.each(['candidate', 'native-revision', 'definition', 'pose', 'combine'] as const)('refuses release after a later %s change and restores only captured pose', async change => {
    const f = await dragging('frustum'); f.controller.updateFilterGizmoGesture(f.token, { center: [3, 4, 5] });
    if (change === 'candidate') {
      const before = useApp.getState().summary!;
      setApp({ summary: { ...before, filter: { ...before.filter!, epoch: 2, previewEpoch: 2 } } });
    } else if (change === 'native-revision') f.client.revision.selectionRevision++;
    else if (change === 'definition') f.controller.setFilterParameters({ fov: 75, minOpacity: .4 });
    else if (change === 'pose') f.controller.setFilterParameters({ center: [8, 9, 10] });
    else f.controller.setFilterOperation(2);
    expect(f.controller.finishFilterGizmoGesture(f.token)).toBe(false);
    expect(useApp.getState()).toMatchObject({ filterGizmoMode: 'move', filterGizmoDragging: false,
      filter: { dirty: true, parameters: { center: [0, 0, 0] } } });
    if (change === 'definition') expect(useApp.getState().filterParameters).toMatchObject({ fov: 75, minOpacity: .4 });
    if (change === 'combine') expect(useApp.getState().filter?.operation).toBe(2);
    expect(f.controller.filterGizmoGestureActive).toBe(false); expect(f.commands).toHaveLength(2); expect(f.client.cancel).not.toHaveBeenCalled();
  });
  it('admits release after a later mouse update explicitly observes an interleaved Combine change', async () => {
    const f = await dragging(); f.controller.updateFilterGizmoGesture(f.token, { center: [3, 4, 5] });
    f.controller.setFilterOperation(2);
    expect(f.controller.updateFilterGizmoGesture(f.token, { center: [3, 4, 5] })).toBe(true);
    expect(f.controller.finishFilterGizmoGesture(f.token)).toBe(true);
    expect(useApp.getState().filter).toMatchObject({ operation: 2, dirty: true, parameters: { center: [3, 4, 5] } });
    expect(f.commands).toHaveLength(2);
  });
  it('requires the published full definition to agree before releasing or restoring clean', async () => {
    const f = await dragging(); const before = useApp.getState().filter!;
    setApp({ filter: { ...before, parameters: { ...before.parameters, fov: 80 } } });
    expect(f.controller.finishFilterGizmoGesture(f.token)).toBe(false);
    expect(useApp.getState().filter).toMatchObject({ dirty: true, desiredRevision: 1, parameters: { fov: 60 } });
    expect(f.commands).toHaveLength(2);
  });
});

describe('filter gizmo authority and transitions', () => {
  it('requires the exact token reference and rejects retired tokens against a new gesture', async () => {
    const f = await dragging(), forged = { ...f.token } as FilterGizmoGestureToken;
    expect(Object.isFrozen(f.token)).toBe(true);
    expect(f.controller.updateFilterGizmoGesture(forged, { center: [1, 2, 3] })).toBe(false);
    expect(f.controller.finishFilterGizmoGesture(forged)).toBe(false);
    expect(f.controller.cancelFilterGizmoGesture(forged, true)).toBe(false);
    expect(useApp.getState().filterGizmoDragging).toBe(true);
    f.controller.finishFilterGizmoGesture(f.token); const next = f.controller.beginFilterGizmoGesture()!;
    expect(next.id).toBeGreaterThan(f.token.id);
    expect(f.controller.cancelFilterGizmoGesture(f.token, true)).toBe(false);
    expect(f.controller.updateFilterGizmoGesture(f.token, { radius: 3 })).toBe(false);
    expect(f.controller.filterGizmoGestureActive).toBe(true);
    expect(f.controller.cancelFilterGizmoGesture(next, true)).toBe(true);
  });
  it.each(['opacity', 'scale'] as const)('has no gizmo for %s range filtering', async kind => {
    const f = fixture(); await f.controller.selectFilter(kind);
    expect(f.controller.filterGizmoControlsEnabled).toBe(false); expect(f.controller.setFilterGizmoMode('move')).toBe(false);
    expect(f.controller.beginFilterGizmoGesture()).toBeNull(); expect(f.commands).toHaveLength(2);
  });
  it('refuses Frustum Scale and preserves all lens values across pose cancellation', async () => {
    const f = fixture(); await f.controller.selectFilter('frustum'); f.controller.setFilterParameters({ fov: 75, aspect: 2, near: .25, far: 25 });
    expect(f.controller.setFilterGizmoMode('scale')).toBe(false);
    expect(f.controller.setFilterGizmoMode('rotate')).toBe(true); const token = f.controller.beginFilterGizmoGesture()!;
    f.controller.updateFilterGizmoGesture(token, { rotation: [0, 45, 0] }); f.controller.cancelFilterGizmoGesture(token);
    expect(useApp.getState().filterParameters).toMatchObject({ rotation: [0, 0, 0], fov: 75, aspect: 2, near: .25, far: 25 });
  });
  it('toggles idle modes without parameter writes and retains local/snap/outline preferences', async () => {
    const f = fixture(); await f.controller.selectFilter('sphere'); setApp({ filterLocalAxes: true, filterSnap: true, filterVolumeVisible: false });
    expect(f.controller.setFilterGizmoMode('rotate')).toBe(true); expect(f.controller.setFilterGizmoMode('rotate')).toBe(true);
    expect(useApp.getState()).toMatchObject({ filterGizmoMode: null, filterLocalAxes: true, filterSnap: true, filterVolumeVisible: false,
      filter: { desiredRevision: 0, dirty: false } }); expect(f.commands).toHaveLength(2);
  });
  it('restores the captured pose before a mode change and keeps the new mode parameter-neutral', async () => {
    const f = await dragging(); f.controller.updateFilterGizmoGesture(f.token, { center: [2, 3, 4] });
    expect(f.controller.setFilterGizmoMode('rotate')).toBe(true);
    expect(useApp.getState()).toMatchObject({ filterGizmoMode: 'rotate', filterGizmoDragging: false,
      filter: { dirty: false, desiredRevision: 2, parameters: { center: [0, 0, 0] } } });
    expect(f.controller.finishFilterGizmoGesture(f.token)).toBe(false); expect(f.commands).toHaveLength(2);
  });
  it.each([null, 'rotate'] as const)('settles a direct store mode change to %s before another update or release', async mode => {
    const f = await dragging(); f.controller.updateFilterGizmoGesture(f.token, { center: [2, 3, 4] });
    setApp({ filterGizmoMode: mode });
    expect(useApp.getState()).toMatchObject({ filterGizmoMode: null, filterGizmoDragging: false,
      filter: { dirty: false, parameters: { center: [0, 0, 0] } } });
    expect(f.controller.filterGizmoGestureActive).toBe(false);
    expect(f.controller.updateFilterGizmoGesture(f.token, { center: [5, 6, 7] })).toBe(false);
    expect(f.controller.finishFilterGizmoGesture(f.token)).toBe(false);
    expect(f.commands).toHaveLength(2); expect(f.client.cancel).not.toHaveBeenCalled();
  });
  it.each(['busy', 'pending', 'transaction', 'settings', 'picker-pending', 'invalid'] as const)('refuses capture while %s', async fence => {
    const f = fixture(); await f.controller.selectFilter('box'); f.controller.setFilterGizmoMode('move');
    if (fence === 'busy') setApp({ busy: true });
    else if (fence === 'pending') setApp({ summary: { ...useApp.getState().summary!, pending: true } });
    else if (fence === 'transaction') setApp({ summary: { ...useApp.getState().summary!, transaction: true } });
    else if (fence === 'settings') setApp({ settingsOpen: true });
    else if (fence === 'picker-pending') setApp({ filterCenterPending: true });
    else f.controller.setFilterParameters({ size: [-1, 1, 1] });
    expect(f.controller.beginFilterGizmoGesture()).toBeNull();
    expect(useApp.getState().filterGizmoDragging).toBe(false); expect(f.commands).toHaveLength(2);
  });
  it('refuses native Preview/Confirm while picking and settles a drag before center-pick entry', async () => {
    const f = await dragging(); f.controller.updateFilterGizmoGesture(f.token, { center: [2, 3, 4] });
    expect(f.controller.startFilterCenterPick()).toBe(true);
    expect(useApp.getState()).toMatchObject({ filterGizmoMode: null, filterGizmoDragging: false, filterCenterPicking: true,
      filter: { dirty: false, parameters: { center: [0, 0, 0] } } });
    expect(f.controller.beginFilterGizmoGesture()).toBeNull(); expect(f.controller.filterGizmoControlsEnabled).toBe(false);
    expect(await f.controller.previewFilter()).toBe(false); expect(await f.controller.confirmFilter()).toBe(false);
    expect(f.commands).toHaveLength(2); f.controller.cancelFilterCenterPick(); expect(f.controller.filterFinishEnabled).toBe(true);
  });
  it('allows choosing a mode from an armed idle picker while capture still refuses the picker', async () => {
    const f = fixture(); await f.controller.selectFilter('box'); f.controller.startFilterCenterPick();
    expect(f.controller.filterGizmoModeEnabled).toBe(true); expect(f.controller.filterGizmoControlsEnabled).toBe(false);
    expect(f.controller.beginFilterGizmoGesture()).toBeNull();
    expect(f.controller.setFilterGizmoMode('move')).toBe(true);
    expect(useApp.getState()).toMatchObject({ filterGizmoMode: 'move', filterCenterPicking: false, filterCenterPending: false });
    expect(f.controller.beginFilterGizmoGesture()).not.toBeNull(); expect(f.commands).toHaveLength(2);
  });
  it('retains a pending picker query until joined and rejects its late point after cancellation', async () => {
    const f = fixture(); await f.controller.selectFilter('box'); f.controller.startFilterCenterPick();
    let release!: (value: { index: number; deviceEpoch: number }) => void;
    f.renderer.pick.mockReturnValue(new Promise(resolve => { release = resolve; }));
    const picking = f.controller.pickFilterCenter(10, 20);
    expect(useApp.getState().filterCenterPending).toBe(true); expect(f.controller.filterGizmoModeEnabled).toBe(false);
    expect(f.controller.setFilterGizmoMode('move')).toBe(false); expect(useApp.getState().filterCenterPicking).toBe(true);
    f.controller.cancelFilterCenterPick();
    expect(f.controller.setFilterGizmoMode('move')).toBe(false); expect(f.controller.beginFilterGizmoGesture()).toBeNull();
    release({ index: 1, deviceEpoch: 1 }); expect(await picking).toBe(false);
    expect(f.client.command).not.toHaveBeenCalled(); expect(useApp.getState().filterParameters.center).toEqual([0, 0, 0]);
    expect(f.controller.filterGizmoModeEnabled).toBe(true); expect(f.controller.setFilterGizmoMode('move')).toBe(true);
    expect(f.commands).toHaveLength(2);
  });
  it('retains the selected mode across a same-owner native Preview while capture is disabled', async () => {
    const f = fixture(); await f.controller.selectFilter('box'); f.controller.setFilterGizmoMode('move');
    const release = f.holdPreview(); f.controller.setFilterParameters({ size: [2, 2, 2] });
    const preview = f.controller.previewFilter(); await flush();
    expect(f.controller.filterGizmoControlsEnabled).toBe(false); expect(f.controller.beginFilterGizmoGesture()).toBeNull();
    expect(useApp.getState().filterGizmoMode).toBe('move'); release(); expect(await preview).toBe(true);
    expect(useApp.getState().filterGizmoMode).toBe('move'); expect(f.controller.filterGizmoControlsEnabled).toBe(true);
  });
  it('restores pose and retains mode when an external same-owner phase becomes pending', async () => {
    const f = await dragging(); f.controller.updateFilterGizmoGesture(f.token, { center: [3, 4, 5] });
    f.internal.filterOwner!.phase = 'previewing'; setApp({ busy: true });
    expect(useApp.getState()).toMatchObject({ filterGizmoMode: 'move', filterGizmoDragging: false, filterParameters: { center: [0, 0, 0] } });
    expect(f.controller.finishFilterGizmoGesture(f.token)).toBe(false); expect(f.controller.beginFilterGizmoGesture()).toBeNull();
    f.internal.filterOwner!.phase = 'ready'; setApp({ busy: false });
    expect(f.controller.beginFilterGizmoGesture()).not.toBeNull(); expect(f.commands).toHaveLength(2);
  });
  it('disables controller camera navigation during capture and reenables it on settlement', async () => {
    const f = await dragging(); expect(f.controller.cameraNavigationEnabled).toBe(false);
    expect(f.controller.finishFilterGizmoGesture(f.token)).toBe(true); expect(f.controller.cameraNavigationEnabled).toBe(true);
  });
  it.each(['tools', 'basic', 'recovering', 'unavailable', 'cleanup'] as const)('settles before the %s transition without cancelling the native baseline', async transition => {
    const f = await dragging(); f.controller.updateFilterGizmoGesture(f.token, { center: [3, 4, 5] });
    if (transition === 'tools') setApp({ toolsOpen: false });
    else if (transition === 'basic') setApp({ mode: 'basic' });
    else if (transition === 'recovering') setApp({ rendererState: 'recovering', ready: false });
    else if (transition === 'unavailable') { f.renderer.lost = true; setApp({ rendererState: 'unavailable' }); }
    else f.internal.requireFilterCleanup(f.internal.filterOwner!);
    expect(useApp.getState()).toMatchObject({ filterGizmoMode: null, filterGizmoDragging: false, filterParameters: { center: [0, 0, 0] } });
    expect(f.controller.filterGizmoGestureActive).toBe(false); expect(f.commands).toHaveLength(2);
    expect(f.controller.filterActive).toBe(true); expect(f.client.cancel).not.toHaveBeenCalled();
  });
  it('Reset restores active defaults, settles the token and retains Combine and preferences', async () => {
    const f = await dragging(); setApp({ filterLocalAxes: true, filterSnap: true, filterVolumeVisible: false });
    f.controller.updateFilterGizmoGesture(f.token, { center: [3, 4, 5], size: [6, 7, 8] });
    f.controller.setFilterOperation(3); f.controller.resetFilter();
    expect(useApp.getState()).toMatchObject({ filterGizmoMode: null, filterGizmoDragging: false, filterLocalAxes: true, filterSnap: true,
      filterVolumeVisible: false, filter: { operation: 3, dirty: true, parameters: { center: [0, 0, 0], size: [1, 1, 1] } } });
    expect(f.controller.updateFilterGizmoGesture(f.token, { center: [8, 9, 10] })).toBe(false); expect(f.commands).toHaveLength(2);
  });
  it('restores pose before changing filter kind and refuses the old owner token', async () => {
    const f = await dragging(); f.controller.updateFilterGizmoGesture(f.token, { center: [3, 4, 5] });
    expect(await f.controller.selectFilter('sphere')).toBe(true);
    expect(f.commands.map(command => command.command)).toEqual(['beginFilter', 'previewFilter', 'cancelFilter', 'beginFilter', 'previewFilter']);
    expect(f.commands.at(-1)).toMatchObject({ id: 2, parameters: { center: [0, 0, 0] } });
    expect(useApp.getState()).toMatchObject({ filterGizmoMode: null, filterGizmoDragging: false });
    expect(f.controller.cancelFilterGizmoGesture(f.token, true)).toBe(false); expect(useApp.getState().filter?.id).toBe(2);
  });
  it('manual activation and Basic switch settle the drag before joined native baseline cancellation', async () => {
    const f = await dragging(); f.controller.updateFilterGizmoGesture(f.token, { center: [3, 4, 5] });
    expect(await f.controller.activateSelectionTool('rectangle')).toBe(true);
    expect(useApp.getState()).toMatchObject({ tool: 'rectangle', filter: null, filterGizmoMode: null, filterGizmoDragging: false,
      filterParameters: { center: [0, 0, 0] } }); expect(f.commands.at(-1)?.command).toBe('cancelFilter');
    await f.controller.selectFilter('box'); f.controller.setFilterGizmoMode('move'); const token = f.controller.beginFilterGizmoGesture()!;
    f.controller.updateFilterGizmoGesture(token, { center: [5, 6, 7] }); switchToolsMode('basic');
    expect(useApp.getState().mode).toBe('pro'); await f.controller.cancelFilter(); switchToolsMode('basic');
    expect(useApp.getState()).toMatchObject({ mode: 'basic', filterGizmoMode: null, filterGizmoDragging: false });
  });
  it('restores a resize-interrupted gesture while retaining its mode before the viewport callback', async () => {
    const f = await dragging(); f.controller.updateFilterGizmoGesture(f.token, { center: [3, 4, 5] });
    f.internal.canvas = f.renderer.canvas as unknown as HTMLCanvasElement; f.internal.viewport = { width: 200, height: 150 };
    const callback = vi.fn(() => {
      expect(useApp.getState()).toMatchObject({ filterGizmoMode: 'move', filterGizmoDragging: false, filterParameters: { center: [0, 0, 0] } });
    }); f.controller.onViewportResize = callback;
    expect(f.internal.synchronizeViewport()).toBe(true); expect(callback).toHaveBeenCalledOnce(); expect(f.commands).toHaveLength(2);
  });
  it('refuses changed candidate epochs and keeps cancellation dirty without issuing native cancellation', async () => {
    const f = await dragging(); f.controller.updateFilterGizmoGesture(f.token, { center: [3, 4, 5] });
    const before = useApp.getState().summary!;
    setApp({ summary: { ...before, filter: { ...before.filter!, epoch: 2, previewEpoch: 2 } } });
    expect(f.controller.updateFilterGizmoGesture(f.token, { center: [6, 7, 8] })).toBe(false);
    expect(f.controller.cancelFilterGizmoGesture(f.token)).toBe(true);
    expect(useApp.getState().filter).toMatchObject({ dirty: true, parameters: { center: [0, 0, 0] } });
    expect(f.commands).toHaveLength(2); expect(f.client.cancel).not.toHaveBeenCalled();
  });
  it('retires a stale source token without writing its pose into a replacement source', async () => {
    const f = await dragging(); f.controller.updateFilterGizmoGesture(f.token, { center: [3, 4, 5] });
    f.client.revision.sourceGeneration++; setApp({ filterParameters: { ...filterDefaults(), center: [90, 91, 92] } });
    expect(f.controller.updateFilterGizmoGesture(f.token, { center: [6, 7, 8] })).toBe(false);
    expect(f.controller.cancelFilterGizmoGesture(f.token, true)).toBe(false);
    expect(useApp.getState()).toMatchObject({ filterGizmoMode: null, filterGizmoDragging: false, filterParameters: { center: [90, 91, 92] } });
    expect(f.commands).toHaveLength(2);
  });
  it('settles a drag before disposal retires its native client and preserves gizmo preferences', async () => {
    const f = await dragging(); setApp({ filterLocalAxes: true, filterSnap: true, filterVolumeVisible: false });
    f.controller.updateFilterGizmoGesture(f.token, { center: [3, 4, 5] });
    const dispose = vi.fn(() => expect(useApp.getState().filterParameters.center).toEqual([0, 0, 0]));
    Object.assign(f.client, { dispose, retireNativeMemory: vi.fn(async () => {}) });
    Object.assign(f.renderer, { setHistogramEnabled: vi.fn(), resetHistogram: vi.fn(), dispose: vi.fn() });
    Object.assign(f.scene, { dispose: vi.fn(async () => {}) }); Object.assign(f.camera, { dispose: vi.fn() });
    f.controller.dispose(); await flush();
    expect(dispose).toHaveBeenCalledOnce(); expect(f.controller.filterGizmoGestureActive).toBe(false);
    expect(useApp.getState()).toMatchObject({ filter: null, filterGizmoMode: null, filterGizmoDragging: false,
      filterLocalAxes: true, filterSnap: true, filterVolumeVisible: false });
    expect(f.commands).toHaveLength(2); expect(f.controller.updateFilterGizmoGesture(f.token, { center: [6, 7, 8] })).toBe(false);
  });
});
