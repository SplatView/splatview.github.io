import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppController } from '../src/app/controller';
import { setApp, switchToolsMode, useApp } from '../src/app/store';
import type { CoreClient } from '../src/document/coreClient';
import { filterDefaults, type SelectionFilterSummary } from '../src/document/filterProtocol';
import type { NativeSummary, SceneCommand } from '../src/document/types';
import { GaussianRenderer } from '../src/renderer/webgpu/renderer';
import { ResourceLedger, type ResourceLease } from '../src/document/resources';
import type { OperationOwner } from '../src/document/operationProtocol';
import type { Revision } from '../src/document/types';

// Host scheduling, owner fencing and recovery only. Native predicate/geometry
// contracts and real GPU publication are qualified in their own test layers.
const initial = useApp.getState();
const historyWatches = new Set<() => void>();
const flush = async () => { for (let index = 0; index < 24; index++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function summary(filter: SelectionFilterSummary | null = null): NativeSummary {
  return { ok: true, duplicateRange: null, loaded: true, kind: 0, count: 3, sourceCount: 3, selected: 1, visible: 3, shDegree: 0,
    format: 'PLY', canUndo: true, canRedo: true, revision: 2, undoSelectionRevision: 1, contentRevision: 1, transaction: false,
    selectionDraft: false, sceneChanged: false, pending: false, progress: 1, floor: null, filter, transformSession: null, opacitySession: null,
    center: [0, 0, 0], radius: 1, yUp: false, camera: [0, 0, 0, 0, 0, 3, 1, 45, 0, 0, 1],
    memoryBytes: 528, selectionMapId: null, pendingSelectionMapId: null, selectionMapBytes: 0, selectionMapRetainedIds: [],
    toleranceSessionId: null, toleranceTool: null, toleranceRange: null, toleranceRecorded: null };
}
type Internal = {
  [key: string]: unknown;
  executeEditCommand(command: SceneCommand, current?: () => boolean): Promise<boolean>;
  executeCommand(command: SceneCommand): Promise<boolean>;
  closeToleranceSelection(): Promise<void>; settleColorSession(): Promise<boolean>;
  ensureStartupCore(): Promise<void>; synchronizeViewport(): void; observeCanvas(): void;
  shrinkNativeHistory(client: CoreClient, summary: NativeSummary): void;
};
beforeEach(() => {
  vi.stubGlobal('document', { hidden: true, title: '' }); vi.stubGlobal('cancelAnimationFrame', vi.fn());
  setApp({ ...initial, ready: true, rendererState: 'ready', busy: false, mode: 'pro', operation: 0, summary: summary(),
    filter: null, filterParameters: filterDefaults(), filterCenterPicking: false, filterCenterPending: false,
    navigationPrompt: false, settingsOpen: false, exportOpen: false, outputPending: false, viewTransferPending: false,
    thumbnailPending: false, savedViewChoices: [], selectionRecovery: 'idle', selectionDragging: false, pendingSelectionCount: 0 }, true);
});
afterEach(() => { for (const unwatch of historyWatches) unwatch(); historyWatches.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); setApp(initial, true); });
// Adapt lifecycle transport without replacing the independent predicate,
// refusal, mask-publication or command-order models below.
function ownedTransactions<T extends { revision: Revision; command(command: SceneCommand): Promise<NativeSummary> }>(client: T) {
  let sequence = 0, active: OperationOwner | undefined;
  const check = (owner: OperationOwner) => { expect(owner).toBe(active); };
  const result = Object.assign(client, {
    createOperation: vi.fn(() => {
      expect(active).toBeUndefined();
      active = Object.freeze({ version: 1 as const, documentId: client.revision.documentId,
        sourceGeneration: client.revision.sourceGeneration, clientGeneration: 'cc000003-0000-4000-8000-000000000003', operationId: ++sequence });
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
  const controller = new AppController(), internal = controller as unknown as Internal;
  const client = ownedTransactions({ revision: { documentId: 'cc000004-0000-4000-8000-000000000004', sourceGeneration: 1, contentRevision: 1, selectionRevision: 2, draftRevision: 0 },
    assertNativeAdmission: vi.fn(), cancel: vi.fn(), command: vi.fn(), stream: vi.fn() });
  const scene = { kind: 'gaussian', setDuplicateRange: vi.fn(), count: 3, sourceRevision: 1, dispose: vi.fn(async () => {}) };
  const renderer = { lost: false, deviceEpoch: 1, canvas: { width: 400, height: 300, getBoundingClientRect: () => ({ width: 400 }) },
    device: { queue: { onSubmittedWorkDone: vi.fn(async () => {}) } }, finish(): Promise<void> { return this.device.queue.onSubmittedWorkDone(); }, setHistogramEnabled: vi.fn(),
    setRenderSettings: vi.fn(), steadySnapshot: { status: 'sorted' }, render: vi.fn(), pick: vi.fn(), dispose: vi.fn() };
  const camera = { revision: 2, clearInput: vi.fn(), state: [0, 0, 0, 0, 0, 3, 1, 45, 0, 0, 1],
    filterView: vi.fn(() => ({ center: [1, 2, 3], rotation: [0, 90, 0], fov: 45, aspect: 4 / 3, near: .01, far: 30 })) };
  controller.client = client as unknown as CoreClient; controller.scene = scene as unknown as NonNullable<AppController['scene']>;
  controller.renderer = renderer as unknown as GaussianRenderer; controller.camera = camera as unknown as NonNullable<AppController['camera']>;
  historyWatches.add(controller.trackManualSelectionHistory());
  vi.spyOn(controller, 'invalidate').mockImplementation(() => {});
  const cancelGesture = vi.spyOn(controller, 'cancelSelectionGesture').mockResolvedValue(true);
  const closeTolerance = vi.spyOn(internal, 'closeToleranceSelection').mockResolvedValue();
  const settleColor = vi.spyOn(internal, 'settleColorSession').mockResolvedValue(true);
  const commands: SceneCommand[] = []; let id = 0, baseline = summary(), held: ReturnType<typeof deferred<boolean>> | undefined;
  const execute = vi.spyOn(internal, 'executeEditCommand').mockImplementation(async (command, current) => {
    commands.push(structuredClone(command));
    if (command.command === 'beginFilter') {
      baseline = { ...useApp.getState().summary!, filter: null };
      setApp({ summary: { ...baseline, filter: { id: ++id, kind: command.kind as SelectionFilterSummary['kind'], epoch: 0, previewEpoch: null, changed: false } } });
    } else if (command.command === 'previewFilter') {
      const wait = held; held = undefined; setApp({ busy: true });
      if (wait && !await wait.promise || current && !current()) { setApp({ busy: false }); return false; }
      const before = useApp.getState().summary!;
      setApp({ summary: { ...before, selected: 2, revision: before.revision + 1,
        filter: { id: command.id as number, kind: command.kind as SelectionFilterSummary['kind'], epoch: command.epoch as number, previewEpoch: command.epoch as number, changed: true } }, busy: false });
    } else if (command.command === 'confirmFilter') {
      setApp({ summary: { ...useApp.getState().summary!, filter: null, canRedo: false } });
    } else if (command.command === 'cancelFilter') setApp({ summary: { ...baseline, filter: null }, busy: false });
    return true;
  });
  const executeOrdinary = vi.spyOn(internal, 'executeCommand').mockImplementation(async command => {
    if (command.command === 'confirmFilter') return internal.executeEditCommand(command);
    if (command.command === 'selectNone') {
      const before = useApp.getState().summary!, revision = before.revision + Number(before.selected > 0);
      setApp({ summary: { ...before, selected: 0, revision, undoSelectionRevision: before.selected > 0 ? revision : before.undoSelectionRevision } });
    } else if (command.command === 'undo') {
      const before = useApp.getState().summary!; setApp({ summary: { ...before, revision: before.revision + 1, undoSelectionRevision: 1 } });
    }
    return true;
  });
  return { controller, internal, client, scene, renderer, camera, commands, execute, executeOrdinary, cancelGesture, closeTolerance, settleColor,
    holdPreview: () => { held = deferred<boolean>(); return held; } };
}

describe('floating selection actions', () => {
  it('keeps X enabled for an accepted empty filter draft, but fences actions during confirmation', async () => {
    const f = fixture(); await f.controller.selectFilter('sphere');
    setApp({ summary: { ...useApp.getState().summary!, selected: 0 } });
    expect(f.controller.filterClearEnabled).toBe(true);
    (f.internal.filterOwner as { phase: string }).phase = 'confirming';
    expect(f.controller.filterClearEnabled).toBe(false); expect(f.controller.filterUndoEnabled).toBe(false);
  });
  it('keeps a recorded completed Remove owner reachable when it leaves no selected splats', () => {
    const f = fixture(); setApp({ tool: 'color' });
    setApp({ summary: { ...summary(), revision: 3, undoSelectionRevision: 3, selected: 0, toleranceSessionId: 5, toleranceRecorded: true } });
    f.internal.tolerance = { id: 5, client: f.client, scene: f.scene, tool: 'color', active: true };
    expect(f.controller.manualSelectionActionsVisible).toBe(true);
    setApp({ summary: { ...useApp.getState().summary!, toleranceRecorded: false, undoSelectionRevision: 1 } });
    expect(f.controller.manualSelectionActionsVisible).toBe(false);
  });
  it('Undo discards a changed same-count filter preview and keeps its dirty enclosure paused', async () => {
    const f = fixture(); await f.controller.selectFilter('sphere');
    const value = useApp.getState().summary!;
    setApp({ summary: { ...value, selected: 1, filter: { ...value.filter!, changed: true } } });
    f.controller.setFilterParameters({ radius: -1 }); f.controller.setFilterOperation(2);
    expect(await f.controller.undoFilterSelection()).toBe(true);
    expect(f.commands.map(item => item.command)).toEqual(['beginFilter', 'previewFilter', 'cancelFilter', 'beginFilter']);
    expect(f.executeOrdinary).not.toHaveBeenCalled();
    expect(useApp.getState().filter).toMatchObject({ kind: 'sphere', operation: 2, parameters: { radius: -1 }, previewRevision: null });
    expect(useApp.getState().summary?.filter).toMatchObject({ changed: false, previewEpoch: null });
  });
  it('Undo of an unchanged filter preview cancels its draft before undoing committed history', async () => {
    const f = fixture(); await f.controller.selectFilter('box');
    setApp({ summary: { ...useApp.getState().summary!, filter: { ...useApp.getState().summary!.filter!, changed: false } } });
    expect(await f.controller.undoFilterSelection()).toBe(true);
    expect(f.executeOrdinary).toHaveBeenCalledWith({ command: 'undo' }, expect.any(Function));
    expect(f.commands.map(item => item.command)).toEqual(['beginFilter', 'previewFilter', 'cancelFilter', 'beginFilter']);
    expect(useApp.getState().filter).toMatchObject({ kind: 'box', previewRevision: null });
  });
  it('Clear records the visible filter epoch before clearing and never evaluates invalid dirty parameters', async () => {
    const f = fixture(); await f.controller.selectFilter('sphere'); f.controller.setFilterParameters({ radius: -7 });
    expect(await f.controller.clearFilterSelection()).toBe(true);
    expect(f.commands.map(item => item.command)).toEqual(['beginFilter', 'previewFilter', 'confirmFilter', 'beginFilter']);
    expect(f.commands[2]).toMatchObject({ id: 1, epoch: 1 });
    expect(f.executeOrdinary).toHaveBeenCalledWith({ command: 'selectNone' }, expect.any(Function));
    expect(useApp.getState()).toMatchObject({ selectionActionPending: false, summary: { selected: 0 },
      filter: { phase: 'ready', parameters: { radius: -7 }, previewRevision: null } });
  });
  it('keeps an action fenced until a held preview retires, then clears only its acknowledged epoch', async () => {
    const f = fixture(); await f.controller.selectFilter('sphere'); const held = f.holdPreview();
    f.controller.setFilterParameters({ radius: 4 }); const preview = f.controller.previewFilter(); await flush();
    const clear = f.controller.clearFilterSelection(); await flush();
    expect(useApp.getState().selectionActionPending).toBe(true);
    expect(await f.controller.undoFilterSelection()).toBe(false);
    expect(await f.controller.command({ command: 'selectAll' })).toBe(false);
    held.resolve(false); expect(await preview).toBe(false); expect(await clear).toBe(true);
    expect(f.commands.find(item => item.command === 'confirmFilter')).toMatchObject({ epoch: 1 });
    expect(useApp.getState().selectionActionPending).toBe(false);
  });
  it('refuses to restart or clear after failed filter restoration', async () => {
    const f = fixture(); await f.controller.selectFilter('sphere');
    vi.spyOn(f.controller, 'cancelFilter').mockResolvedValue(false);
    expect(await f.controller.undoFilterSelection()).toBe(false);
    expect(f.executeOrdinary).not.toHaveBeenCalled(); expect(f.commands.filter(item => item.command === 'beginFilter')).toHaveLength(1);
  });
  it('manual Clear keeps the tool and its Undo reachable after the highlights disappear', async () => {
    const f = fixture(); setApp({ tool: 'brush' });
    expect(await f.controller.clearManualSelection()).toBe(true);
    expect(useApp.getState()).toMatchObject({ tool: 'brush', summary: { selected: 0 }, selectionActionPending: false });
    expect(f.controller.manualSelectionActionsVisible).toBe(true);
    expect(await f.controller.undoManualSelection()).toBe(true);
    expect(f.executeOrdinary).toHaveBeenLastCalledWith({ command: 'undo' }, expect.any(Function));
    expect(f.controller.manualSelectionActionsVisible).toBe(false);
  });
  it('manual Check waits for accepted clicks and exits only after native owner retirement', async () => {
    const f = fixture(), held = deferred<void>(); setApp({ tool: 'color' });
    f.internal.pendingTolerancePicks = new Set([held.promise]);
    const finish = f.controller.finishManualSelection(); await flush();
    expect(useApp.getState()).toMatchObject({ tool: 'color', selectionActionPending: true });
    expect(await f.controller.clearManualSelection()).toBe(false);
    held.resolve(); expect(await finish).toBe(true);
    expect(useApp.getState()).toMatchObject({ tool: null, summary: { selected: 1 }, selectionActionPending: false });
  });
  it('manual Check retains its tool when the native completed owner did not retire', async () => {
    const f = fixture(); setApp({ tool: 'fill', summary: { ...summary(), toleranceSessionId: 4, toleranceRecorded: true } });
    expect(await f.controller.finishManualSelection()).toBe(false); expect(useApp.getState().tool).toBe('fill');
  });
  it('manual Undo cancels only the newest queued click and preserves earlier released work', async () => {
    const f = fixture(), held = deferred<void>(), first = new AbortController(), tail = new AbortController(); setApp({ tool: 'color' });
    tail.signal.addEventListener('abort', () => held.resolve(), { once: true });
    f.internal.releasedSelections = [{ cancel: first }, { cancel: tail, settled: held.promise }];
    expect(await f.controller.undoManualSelection()).toBe(true);
    expect(tail.signal.aborted).toBe(true); expect(first.signal.aborted).toBe(false);
    expect(f.executeOrdinary).not.toHaveBeenCalled(); expect(f.closeTolerance).not.toHaveBeenCalled();
  });
  it('a source replaced during manual Check cannot receive a late exit or edit', async () => {
    const f = fixture(), held = deferred<void>(); setApp({ tool: 'color' }); f.internal.pendingTolerancePicks = new Set([held.promise]);
    const finish = f.controller.finishManualSelection(); await flush(); f.client.revision.sourceGeneration++;
    held.resolve(); expect(await finish).toBe(false);
    expect(useApp.getState().tool).toBe('color'); expect(f.closeTolerance).not.toHaveBeenCalled();
    expect(f.executeOrdinary).not.toHaveBeenCalled();
  });
  it.each(['clearManualSelection', 'undoManualSelection'] as const)('%s refuses unretired native owners', async method => {
    const f = fixture(); setApp({ tool: 'color', summary: { ...summary(), toleranceSessionId: 9, toleranceRecorded: false } });
    expect(await f.controller[method]()).toBe(false); expect(f.executeOrdinary).not.toHaveBeenCalled();
    expect(useApp.getState().tool).toBe('color'); expect(useApp.getState().selectionActionPending).toBe(false);
  });
  it.each(['clearManualSelection', 'undoManualSelection'] as const)('%s joins color materialization before its native edit', async method => {
    const f = fixture(), held = deferred<boolean>(); setApp({ tool: 'brush' }); f.settleColor.mockReturnValue(held.promise);
    const action = f.controller[method](); await flush();
    expect(f.executeOrdinary).not.toHaveBeenCalled(); expect(useApp.getState().selectionActionPending).toBe(true);
    held.resolve(true); expect(await action).toBe(true); expect(f.executeOrdinary).toHaveBeenCalled();
  });
});

describe('explicit filter owner scheduling', () => {
  it('begins once, computes one initial preview, and keeps later parameter edits cheap', async () => {
    const f = fixture(); expect(await f.controller.selectFilter('sphere')).toBe(true);
    expect(f.commands.map(command => command.command)).toEqual(['beginFilter', 'previewFilter']);
    expect(useApp.getState().filter).toMatchObject({ kind: 'sphere', phase: 'ready', dirty: false, id: 1, previewRevision: 0 });
    expect(await f.controller.selectFilter('sphere')).toBe(true);
    f.controller.setFilterParameters({ radius: 2 }); f.controller.setFilterParameters({ radius: 3 });
    expect(f.commands).toHaveLength(2); expect(useApp.getState().filter).toMatchObject({ dirty: true, desiredRevision: 2, parameters: { radius: 3 } });
    expect(await f.controller.previewFilter()).toBe(true);
    expect(f.commands[2]).toMatchObject({ command: 'previewFilter', epoch: 2, parameters: { radius: 3 }, operation: 0 });
  });
  it('Confirm joins a held preview, then evaluates the latest desired parameters before committing', async () => {
    const f = fixture(), held = f.holdPreview(); const entering = f.controller.selectFilter('sphere'); await flush();
    expect(useApp.getState().filter?.phase).toBe('previewing');
    f.controller.setFilterParameters({ radius: 2 }); const confirming = f.controller.confirmFilter();
    expect(f.commands.filter(command => command.command === 'confirmFilter')).toHaveLength(0);
    held.resolve(true); expect(await entering).toBe(true); expect(await confirming).toBe(true);
    expect(f.commands.map(command => command.command)).toEqual(['beginFilter', 'previewFilter', 'previewFilter', 'confirmFilter']);
    expect(f.commands[2]).toMatchObject({ epoch: 2, parameters: { radius: 2 } }); expect(f.commands[3]).toMatchObject({ id: 1, epoch: 2 });
    expect(f.controller.filterActive).toBe(false); expect(useApp.getState().summary?.canRedo).toBe(false);
  });
  it('explicit Cancel joins a held preview and restores the baseline without accepting its late result', async () => {
    const f = fixture(); await f.controller.selectFilter('sphere'); const held = f.holdPreview();
    f.controller.setFilterParameters({ radius: 9 }); const preview = f.controller.previewFilter(); await flush();
    const cancelling = f.controller.cancelFilter(); await flush();
    expect(f.commands.filter(command => command.command === 'cancelFilter')).toHaveLength(0);
    expect(useApp.getState().filter?.phase).toBe('cancelling'); held.resolve(true);
    expect(await preview).toBe(false); expect(await cancelling).toBe(true);
    expect(useApp.getState()).toMatchObject({ filter: null, selectionRecovery: 'idle', summary: { selected: 1, canRedo: true, filter: null } });
    expect(f.client.cancel).toHaveBeenCalled();
  });
  it('a failed preview retains its last accepted epoch and desired state for an explicit retry', async () => {
    const f = fixture(); await f.controller.selectFilter('sphere'); f.controller.setFilterParameters({ radius: 4 });
    const held = f.holdPreview(), preview = f.controller.previewFilter(); await flush(); held.resolve(false);
    expect(await preview).toBe(false);
    expect(useApp.getState().filter).toMatchObject({ phase: 'ready', dirty: true, previewRevision: 0 });
    expect(useApp.getState().summary?.filter).toMatchObject({ epoch: 1, previewEpoch: 1 });
    expect(await f.controller.previewFilter()).toBe(true); expect(f.commands.at(-1)).toMatchObject({ epoch: 3, parameters: { radius: 4 } });
  });
  it('kind switching cancels the previous native baseline and retains shared parameters', async () => {
    const f = fixture(); await f.controller.selectFilter('sphere'); f.controller.setFilterParameters({ center: [2, 3, 4], radius: 7 });
    expect(await f.controller.selectFilter('box')).toBe(true);
    expect(f.commands.map(command => command.command)).toEqual(['beginFilter', 'previewFilter', 'cancelFilter', 'beginFilter', 'previewFilter']);
    expect(f.commands.at(-1)).toMatchObject({ id: 2, parameters: { center: [2, 3, 4], size: [1, 1, 1] } });
    expect(useApp.getState().filterParameters.radius).toBe(7);
  });
  it('Basic cannot hide an owned draft; explicit joined Cancel permits the switch', async () => {
    const f = fixture(); await f.controller.selectFilter('opacity'); switchToolsMode('basic');
    expect(useApp.getState()).toMatchObject({ mode: 'pro', pendingMode: 'basic' });
    expect(await f.controller.cancelFilter()).toBe(true); switchToolsMode('basic');
    expect(useApp.getState()).toMatchObject({ mode: 'basic', pendingMode: null, filter: null });
  });
  it('Reset changes only active filter parameters, retains Combine, and captures native Frustum view', async () => {
    const f = fixture(); await f.controller.selectFilter('opacity');
    f.controller.setFilterOperation(2); f.controller.setFilterParameters({ minOpacity: .2, maxOpacity: .8, radius: 7 });
    f.controller.resetFilter(); expect(useApp.getState().filter).toMatchObject({ operation: 2, parameters: { minOpacity: 0, maxOpacity: 1, radius: 7 } });
    expect(await f.controller.selectFilter('frustum')).toBe(true);
    expect(f.camera.filterView).not.toHaveBeenCalled();
    f.controller.resetFilter(); expect(f.camera.filterView).toHaveBeenCalledOnce();
    expect(useApp.getState().filter).toMatchObject({ parameters: { center: [1, 2, 3], rotation: [0, 90, 0], near: .01, far: 30 } });
  });
  it('choosing Frustum retains shared parameters and defaults without capturing the current camera', async () => {
    const f = fixture(); expect(await f.controller.selectFilter('frustum')).toBe(true);
    expect(f.camera.filterView).not.toHaveBeenCalled();
    expect(f.commands.at(-1)).toMatchObject({ parameters: { center: [0, 0, 0], rotation: [0, 0, 0], fov: 60, aspect: 1, near: Math.fround(.1), far: 100 } });
    await f.controller.cancelFilter(); setApp({ filterParameters: { ...filterDefaults(), center: [4, 5, 6], rotation: [1, 2, 3], fov: 80 } });
    expect(await f.controller.selectFilter('frustum')).toBe(true); expect(f.camera.filterView).not.toHaveBeenCalled();
    expect(f.commands.at(-1)).toMatchObject({ parameters: { center: [4, 5, 6], rotation: [1, 2, 3], fov: 80 } });
  });
  it('retains invalid finite desired input and refuses to confirm its older accepted preview', async () => {
    const f = fixture(); await f.controller.selectFilter('opacity'); f.controller.setFilterParameters({ minOpacity: .7, maxOpacity: .3 });
    expect(useApp.getState().filter).toMatchObject({ dirty: true, parameters: { minOpacity: .7, maxOpacity: .3 } });
    expect(await f.controller.confirmFilter()).toBe(false); expect(f.commands).toHaveLength(2);
    expect(useApp.getState()).toMatchObject({ filter: { phase: 'ready', dirty: true, previewRevision: 0 }, summary: { filter: { previewEpoch: 1 } } });
    expect(useApp.getState().error).toContain('filter values are invalid');
    f.controller.setFilterParameters({ maxOpacity: .9 }); expect(useApp.getState().error).toBeNull();
    expect(await f.controller.previewFilter()).toBe(true);
    expect(f.commands.at(-1)).toMatchObject({ command: 'previewFilter', epoch: 2, parameters: { minimum: Math.fround(.7), maximum: Math.fround(.9) } });
    expect(f.controller.filterActive).toBe(true); expect(await f.controller.confirmFilter()).toBe(true);
  });
  it('queued Confirm cannot commit a held valid preview when newer desired parameters become invalid', async () => {
    const f = fixture(); await f.controller.selectFilter('sphere'); const held = f.holdPreview();
    f.controller.setFilterParameters({ radius: 2 }); const preview = f.controller.previewFilter(); await flush();
    f.controller.setFilterParameters({ radius: -1 }); const confirming = f.controller.confirmFilter(); held.resolve(true);
    expect(await preview).toBe(false); expect(await confirming).toBe(false);
    expect(f.commands.map(command => command.command)).toEqual(['beginFilter', 'previewFilter', 'previewFilter']);
    expect(useApp.getState()).toMatchObject({ filter: { phase: 'ready', dirty: true, parameters: { radius: -1 } }, summary: { filter: { previewEpoch: 2 } } });
  });
  it('retained invalid parameters can enter a filter so their controls remain available for correction', async () => {
    const f = fixture(); setApp({ filterParameters: { ...filterDefaults(), size: [0, 1, 1] } });
    expect(await f.controller.selectFilter('ellipsoid')).toBe(false);
    expect(f.commands.map(command => command.command)).toEqual(['beginFilter']);
    expect(useApp.getState().filter).toMatchObject({ kind: 'ellipsoid', phase: 'ready', id: 1, dirty: true, parameters: { size: [0, 1, 1] } });
    expect(f.controller.filterControlsEnabled).toBe(true); f.controller.setFilterParameters({ size: [1, 1, 1] });
    expect(await f.controller.confirmFilter()).toBe(true); expect(f.commands.at(-1)?.command).toBe('confirmFilter');
  });
  it('rejects malformed/nonfinite parameter patches without invoking getters and detaches finite vector input', async () => {
    const f = fixture(); await f.controller.selectFilter('sphere'); const getter = vi.fn(() => 3), invalid = Object.defineProperty({}, 'radius', { enumerable: true, get: getter });
    f.controller.setFilterParameters(invalid); f.controller.setFilterParameters({ radius: Number.NaN });
    f.controller.setFilterParameters({ center: [1, 2] as unknown as [number, number, number] });
    expect(getter).not.toHaveBeenCalled(); expect(useApp.getState().filter?.desiredRevision).toBe(0);
    const center: [number, number, number] = [1, 2, 3]; f.controller.setFilterParameters({ center }); center[0] = 99;
    expect(useApp.getState().filterParameters.center).toEqual([1, 2, 3]);
  });
  it('right-click clear starts an empty fresh baseline without automatically recomputing the same predicate', async () => {
    const f = fixture(); await f.controller.selectFilter('sphere'); expect(await f.controller.rightClickFilter(true)).toBe(true);
    expect(f.commands.map(command => command.command)).toEqual(['beginFilter', 'previewFilter', 'cancelFilter', 'beginFilter']);
    expect(useApp.getState()).toMatchObject({ summary: { selected: 0 }, filter: { kind: 'sphere', id: 2, previewRevision: null } });
    expect(await f.controller.confirmFilter()).toBe(true);
    expect(f.commands.at(-2)).toMatchObject({ command: 'previewFilter', id: 2, epoch: 1 });
  });
});

describe('filter authority fences and cleanup', () => {
  it('refuses ordinary actions before draining selection or cancelling alignment, while preserving the manual draft distinction', async () => {
    const f = fixture(); await f.controller.selectFilter('sphere');
    const align = vi.spyOn(f.controller, 'cancelAlignment'); f.cancelGesture.mockClear(); f.closeTolerance.mockClear();
    const grade = [...useApp.getState().grade];
    for (const command of ['selectAll', 'selectNone', 'invert', 'delete', 'crop', 'restore', 'undo', 'redo', 'resetAlignment'])
      expect(await f.controller.command({ command })).toBe(false);
    f.controller.setGrade(grade.map(value => value + .1));
    expect(f.controller.colorControlsEnabled).toBe(false); expect(f.controller.selectionMorphologyControlsEnabled).toBe(false);
    expect(f.controller.alignmentControlsEnabled).toBe(false); expect(f.controller.beginSelectionGesture()).toBe(false);
    expect(useApp.getState().summary?.selectionDraft).toBe(false); expect(useApp.getState().grade).toEqual(grade);
    expect(align).not.toHaveBeenCalled(); expect(f.cancelGesture).not.toHaveBeenCalled(); expect(f.closeTolerance).not.toHaveBeenCalled();
  });
  it('refuses source intake, export, capture and saved-view work without ending the draft', async () => {
    const f = fixture(); await f.controller.selectFilter('sphere'); const count = f.commands.length;
    await f.controller.openFiles([]); await f.controller.openFolder([]); await f.controller.exportScene();
    expect(await f.controller.chooseSavedView('other')).toBe(false); expect(await f.controller.updateThumbnail()).toBe(false);
    expect(await f.controller.importSavedView(new Blob())).toBe(false); expect(await f.controller.exportSavedView()).toBe(false);
    await expect(f.controller.capture()).rejects.toThrow('Confirm or cancel the filter');
    await expect(f.controller.selectionMap()).rejects.toThrow('Confirm or cancel the filter');
    expect(f.commands).toHaveLength(count); expect(f.controller.filterActive).toBe(true);
  });
  it('Cleanup Reset and explicit manual tool activation join filter cancellation before their actions', async () => {
    const f = fixture(); await f.controller.selectFilter('sphere');
    expect(await f.controller.command({ command: 'resetCleanup' })).toBe(true);
    expect(f.commands.at(-1)?.command).toBe('cancelFilter'); expect(f.executeOrdinary).toHaveBeenCalledWith({ command: 'resetCleanup' });
    await f.controller.selectFilter('box'); expect(await f.controller.activateSelectionTool('rectangle')).toBe(true);
    expect(f.controller.filterActive).toBe(false); expect(useApp.getState().tool).toBe('rectangle');
  });
  it('retains failed cancellation authority and joins an explicit retry without implicit drains', async () => {
    const f = fixture(); await f.controller.selectFilter('sphere'); const original = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async (command, current) => command.command === 'cancelFilter' ? false : original(command, current));
    expect(await f.controller.cancelFilter()).toBe(false);
    expect(useApp.getState()).toMatchObject({ selectionRecovery: 'required', filter: { phase: 'required', id: 1 } });
    expect(await f.controller.command({ command: 'invert' })).toBe(false); expect(f.controller.filterControlsEnabled).toBe(false);
    const held = deferred<boolean>(); let cancellations = 0;
    f.execute.mockImplementation(async (command, current) => { if (command.command === 'cancelFilter') { cancellations++; await held.promise; } return original(command, current); });
    const first = f.controller.retrySelectionCleanup(), second = f.controller.retrySelectionCleanup(); await flush();
    expect(cancellations).toBe(1); held.resolve(true); expect(await first).toBe(true); expect(await second).toBe(true);
    expect(useApp.getState()).toMatchObject({ selectionRecovery: 'idle', filter: null });
  });
  it('rejects foreign filter metadata and source generations instead of cancelling a different owner', async () => {
    const f = fixture(); await f.controller.selectFilter('sphere');
    setApp({ summary: { ...useApp.getState().summary!, filter: { id: 99, kind: 'box', epoch: 0, previewEpoch: null, changed: false } } });
    expect(await f.controller.cancelFilter()).toBe(false); expect(f.commands.filter(command => command.command === 'cancelFilter')).toHaveLength(0);
    expect(useApp.getState().filter?.phase).toBe('required');
    f.client.revision.sourceGeneration++; expect(await f.controller.retrySelectionCleanup()).toBe(false);
  });
  it('a manual cleanup refusal during entry keeps its existing restoration authority', async () => {
    const f = fixture(); f.cancelGesture.mockImplementation(async () => {
      f.internal.selectionCleanupOwner = {}; setApp({ selectionRecovery: 'required' }); return false;
    });
    expect(await f.controller.selectFilter('sphere')).toBe(false); expect(f.commands).toHaveLength(0);
    expect(useApp.getState()).toMatchObject({ filter: null, selectionRecovery: 'required' });
  });
  it('unknown commit failure retains the exact filter ID and never reports a rolled-back success', async () => {
    const f = fixture(); await f.controller.selectFilter('sphere'); const original = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async (command, current) => {
      if (command.command === 'confirmFilter') { f.internal.editingFailed = true; return false; }
      return original(command, current);
    });
    expect(await f.controller.confirmFilter()).toBe(false);
    expect(useApp.getState()).toMatchObject({ filter: { phase: 'required', id: 1 }, selectionRecovery: 'required' });
    expect(f.controller.editingAvailable).toBe(false);
  });
  it('the actual edit transaction rolls back a failed filter mask upload and releases its work credit', async () => {
    const f = fixture(); await f.controller.selectFilter('sphere'); f.execute.mockRestore();
    const ledger = f.internal.ledger as ResourceLedger, before = useApp.getState().summary!, commands: string[] = [];
    let authoritative = before, checkpoint = before;
    const credit = {
      updateNativeCoverage: vi.fn(), setNativeWork: vi.fn(),
      releaseNativeCoverage: vi.fn((lease: ResourceLease) => lease()),
      transferNativeCoverage: vi.fn((updates: { lease: ResourceLease; nextLeaseBytes: number }[]) => { for (const update of updates) update.lease.resize(update.nextLeaseBytes); }),
      readMasks: vi.fn(async (receive: (bytes: ArrayBuffer) => void) => receive(new Uint8Array([0, 1, 1]).buffer)),
    };
    Object.assign(f.client, credit);
    Object.assign(f.scene, { stageMasks: vi.fn(async () => { throw new Error('Mask upload refused'); }) });
    f.client.command.mockImplementation(async (command: SceneCommand) => {
      commands.push(command.command);
      if (command.command === 'beginTransaction') { checkpoint = authoritative; authoritative = { ...authoritative, transaction: true }; }
      if (command.command === 'previewFilter') authoritative = { ...authoritative, selected: 3, revision: authoritative.revision + 1,
        filter: { ...authoritative.filter!, epoch: command.epoch as number, previewEpoch: command.epoch as number } };
      if (command.command === 'rollbackTransaction') authoritative = checkpoint;
      return authoritative;
    });
    f.controller.setFilterParameters({ radius: 8 }); expect(await f.controller.previewFilter()).toBe(false);
    expect(commands).toEqual(['beginTransaction', 'previewFilter', 'rollbackTransaction']);
    expect(useApp.getState().summary).toEqual(before); expect(useApp.getState().filter).toMatchObject({ phase: 'ready', dirty: true, previewRevision: 0 });
    expect(ledger.usage.bytes).toBe(0); expect(credit.setNativeWork).toHaveBeenLastCalledWith(undefined);
  });
  it('the actual edit transaction rejects inconsistent committed metadata without publishing masks or claiming rollback', async () => {
    const f = fixture(); await f.controller.selectFilter('sphere'); f.execute.mockRestore();
    const before = useApp.getState().summary!, commands: string[] = [], publish = vi.fn(), dispose = vi.fn(); let authoritative = before;
    Object.assign(f.client, { updateNativeCoverage: vi.fn(), setNativeWork: vi.fn(),
      releaseNativeCoverage: vi.fn((lease: ResourceLease) => lease()),
      transferNativeCoverage: vi.fn((updates: { lease: ResourceLease; nextLeaseBytes: number }[]) => { for (const update of updates) update.lease.resize(update.nextLeaseBytes); }),
      readMasks: vi.fn(async (receive: (bytes: ArrayBuffer) => void) => receive(new Uint8Array([0, 1, 1]).buffer)) });
    Object.assign(f.scene, { stageMasks: vi.fn(async () => ({ allocationBytes: 12, publish, dispose })) });
    f.client.command.mockImplementation(async (command: SceneCommand) => {
      commands.push(command.command);
      if (command.command === 'beginTransaction') authoritative = { ...authoritative, transaction: true };
      if (command.command === 'previewFilter') authoritative = { ...authoritative, selected: 3, revision: authoritative.revision + 1,
        filter: { ...authoritative.filter!, epoch: command.epoch as number, previewEpoch: command.epoch as number } };
      if (command.command === 'commitTransaction') return { ...authoritative, transaction: false,
        filter: { ...authoritative.filter!, epoch: authoritative.filter!.epoch + 1 } };
      return authoritative;
    });
    f.controller.setFilterParameters({ radius: 8 }); expect(await f.controller.previewFilter()).toBe(false);
    expect(commands).toEqual(['beginTransaction', 'previewFilter', 'commitTransaction']);
    expect(publish).not.toHaveBeenCalled(); expect(dispose).toHaveBeenCalledOnce();
    expect(useApp.getState().summary).toEqual(before);
    expect(useApp.getState()).toMatchObject({ filter: { phase: 'required', id: 1 }, selectionRecovery: 'required' });
    expect(f.controller.editingAvailable).toBe(false);
  });
  it('center picking discards late hits when the camera changes and keeps parameter updates explicit', async () => {
    const f = fixture(); await f.controller.selectFilter('sphere'); expect(f.controller.startFilterCenterPick()).toBe(true);
    const hit = deferred<{ index: number; deviceEpoch: number }>(); f.renderer.pick.mockReturnValue(hit.promise);
    const picking = f.controller.pickFilterCenter(12, 15); await flush(); f.camera.revision++; hit.resolve({ index: 1, deviceEpoch: 1 });
    expect(await picking).toBe(false); expect(f.client.command).not.toHaveBeenCalled(); expect(useApp.getState().filterParameters.center).toEqual([0, 0, 0]);
    f.renderer.pick.mockResolvedValue({ index: 1, deviceEpoch: 1 }); f.client.command.mockResolvedValue({ ...summary(), point: [2, 4, 6] });
    expect(await f.controller.pickFilterCenter(12, 15)).toBe(true);
    expect(useApp.getState()).toMatchObject({ filterCenterPicking: false, filter: { dirty: true, parameters: { center: [2, 4, 6] } } });
    expect(f.commands).toHaveLength(2);
  });
  it('graphics recovery cancels a native filter despite manual selectionDraft=false and clears authority only after baseline upload', async () => {
    const f = fixture(); await f.controller.selectFilter('sphere'); f.renderer.lost = true;
    f.internal.canvas = {}; vi.spyOn(f.internal, 'ensureStartupCore').mockResolvedValue();
    vi.spyOn(f.internal, 'synchronizeViewport').mockImplementation(() => {}); vi.spyOn(f.internal, 'observeCanvas').mockImplementation(() => {});
    vi.spyOn(f.internal, 'shrinkNativeHistory').mockImplementation(() => {});
    let authoritative = useApp.getState().summary!;
    f.client.command.mockImplementation(async (command: SceneCommand) => {
      if (command.command === 'cancelFilter') authoritative = summary();
      return authoritative;
    });
    const upload = deferred<void>(), staged = { setDuplicateRange: vi.fn(), upload: vi.fn(async () => {}), masks: vi.fn(), dispose: vi.fn(async () => {}) };
    const replacement = { ...f.renderer, lost: false, allocateScene: vi.fn(async () => staged) };
    vi.spyOn(GaussianRenderer, 'create').mockResolvedValue(replacement as unknown as GaussianRenderer);
    f.client.stream.mockImplementation(async () => { await upload.promise; return authoritative; });
    const recovering = f.controller.retryRenderer(); await flush();
    expect(f.client.command).toHaveBeenCalledWith({ command: 'cancelFilter', id: 1 });
    expect(f.controller.filterActive).toBe(true); expect(useApp.getState().filter?.phase).toBe('cancelling');
    upload.resolve(); expect(await recovering).toBe(true);
    expect(f.controller.filterActive).toBe(false); expect(useApp.getState()).toMatchObject({ filter: null, ready: true, summary: { selected: 1, canRedo: true, selectionDraft: false } });
  });
  it('failed recovery retains cleanup after native cancellation and the retry rebuilds baseline without reusing its retired ID', async () => {
    const f = fixture(); await f.controller.selectFilter('sphere'); f.renderer.lost = true; f.internal.canvas = {};
    vi.spyOn(f.internal, 'ensureStartupCore').mockResolvedValue(); vi.spyOn(f.internal, 'synchronizeViewport').mockImplementation(() => {});
    vi.spyOn(f.internal, 'observeCanvas').mockImplementation(() => {}); vi.spyOn(f.internal, 'shrinkNativeHistory').mockImplementation(() => {});
    let authoritative = useApp.getState().summary!;
    f.client.command.mockImplementation(async (command: SceneCommand) => { if (command.command === 'cancelFilter') authoritative = summary(); return authoritative; });
    const allocateScene = vi.fn().mockRejectedValueOnce(new Error('Replacement unavailable')).mockResolvedValue({ setDuplicateRange: vi.fn(), upload: vi.fn(), masks: vi.fn(), dispose: vi.fn() });
    const replacement = { ...f.renderer, lost: false, allocateScene };
    vi.spyOn(GaussianRenderer, 'create').mockResolvedValue(replacement as unknown as GaussianRenderer);
    f.client.stream.mockImplementation(async () => authoritative);
    expect(await f.controller.retryRenderer()).toBe(false);
    expect(useApp.getState()).toMatchObject({ ready: false, filter: { phase: 'required', id: 1 }, selectionRecovery: 'required' });
    expect(f.controller.filterActive).toBe(true); expect(authoritative.filter).toBeNull();
    expect(await f.controller.retryRenderer()).toBe(true);
    expect(f.client.command.mock.calls.filter(([command]) => (command as SceneCommand).command === 'cancelFilter')).toHaveLength(1);
    expect(useApp.getState()).toMatchObject({ ready: true, filter: null, selectionRecovery: 'idle', summary: { canRedo: true, selected: 1 } });
  });
});
