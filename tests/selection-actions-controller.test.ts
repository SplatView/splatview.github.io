import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppController } from '../src/app/controller';
import { setApp, useApp, type SelectionTool } from '../src/app/store';
import type { NativeSummary, SceneCommand } from '../src/document/types';

// Exercise the public command boundary with independent settlement/refusal
// seams. These tests do not start a worker, native module, renderer or GPU.
type OwnedController = {
  selection?: { session: { closed: boolean } };
  selectionBarriers: number;
  closeToleranceSelection(): Promise<void>;
  settleColorSession(): Promise<boolean>;
  executeCommand(command: SceneCommand): Promise<boolean>;
};
const initial = useApp.getState();
const baseline = { kind: 0, count: 5, sourceCount: 5, duplicateRange: null, visible: 4, selected: 1,
  selectionDraft: false, pending: false, shDegree: 3, revision: 8, contentRevision: 3 } as NativeSummary;
const normalActions = ['selectAll', 'selectNone', 'invert', 'delete', 'crop', 'restore'] as const;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const flush = async () => { for (let index = 0; index < 16; index++) await Promise.resolve(); };
function navigation() {
  const state = useApp.getState();
  // The actual canvas uses this same existing fly/orbit representation.
  return { tool: state.tool, mode: state.fly ? 'look' : 'orbit', autoOrbit: state.autoOrbit };
}
function fixture() {
  const controller = new AppController(), owned = controller as unknown as OwnedController;
  controller.client = { revision: { documentId: 'selection-actions', sourceGeneration: 1,
    contentRevision: 3, selectionRevision: 8, draftRevision: 0 } } as NonNullable<AppController['client']>;
  const scene = { kind: 'gaussian', count: 5, duplicateSelectionGuarded: false, setDuplicateRange: vi.fn() } as unknown as NonNullable<AppController['scene']>;
  controller.scene = scene;
  controller.renderer = { lost: false } as NonNullable<AppController['renderer']>;
  const clearInput = vi.fn(), reset = vi.fn();
  controller.camera = { clearInput, reset } as unknown as NonNullable<AppController['camera']>;
  const invalidate = vi.spyOn(controller, 'invalidate').mockImplementation(() => {});
  vi.spyOn(controller, 'cancelAlignment').mockImplementation(() => {});
  const trace: string[] = [];
  const close = vi.spyOn(owned, 'closeToleranceSelection').mockImplementation(async () => { trace.push('end tolerance'); });
  const cancel = vi.spyOn(controller, 'cancelSelectionGesture').mockImplementation(async () => {
    trace.push('restore manual baseline');
    owned.selection = undefined;
    setApp({ summary: { ...baseline } });
    return true;
  });
  const settle = vi.spyOn(owned, 'settleColorSession').mockImplementation(async () => { trace.push('settle color'); return true; });
  const execute = vi.spyOn(owned, 'executeCommand').mockImplementation(async command => {
    trace.push(command.command);
    expect(useApp.getState().summary).toMatchObject({ selected: 1, selectionDraft: false });
    return true;
  });
  return { controller, owned, scene, close, cancel, settle, execute, clearInput, reset, invalidate, trace };
}
beforeEach(() => setApp({ ...initial, ready: true, rendererState: 'ready', busy: false,
  summary: { ...baseline }, selectionRecovery: 'idle', memoryOverageBytes: 0,
  navigationPrompt: false, settingsOpen: false, exportOpen: false, outputPending: false,
  savedViewChoices: [], tool: 'brush', fly: true, autoOrbit: true, mode: 'pro' }, true));
afterEach(() => { vi.restoreAllMocks(); setApp(initial, true); });

describe('selection and cleanup action controller boundaries', () => {
  it.each(['floorOwner', 'floorPreparing', 'alignmentOwner', 'alignmentPick', 'alignmentConfirming'])('Duplicate refuses %s before cancelling or changing its owner', async name => {
    const f = fixture(); Object.assign(f.owned, { [name]: {} });
    expect(f.controller.duplicateControlsEnabled).toBe(false);
    expect(await f.controller.command({ command: 'duplicate' })).toBe(false);
    expect(f.cancel).not.toHaveBeenCalled(); expect(f.close).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
    expect(f.clearInput).not.toHaveBeenCalled();
  });
  it('Duplicate refuses Basic, a guarded copy selection, and a mismatched mirror count', async () => {
    const f = fixture(); setApp({ mode: 'basic' });
    expect(await f.controller.command({ command: 'duplicate' })).toBe(false);
    setApp({ mode: 'pro' }); Object.assign(f.scene, { duplicateSelectionGuarded: true });
    expect(await f.controller.command({ command: 'duplicate' })).toBe(false);
    Object.assign(f.scene, { duplicateSelectionGuarded: false, count: 4 });
    expect(await f.controller.command({ command: 'duplicate' })).toBe(false); expect(f.execute).not.toHaveBeenCalled();
  });
  it.each([false, true])('Duplicate detaches its %s explicit camera before settling Color', async explicit => {
    const f = fixture(), camera = [0, 0, 0, 0, 0, 3, 100, 45, 0, 0, 1];
    Object.assign(f.controller.camera!, { state: camera }); setApp({ currentViewOnly: true });
    f.settle.mockImplementation(async () => { f.trace.push('settle color'); camera[0] = 99; setApp({ currentViewOnly: false }); return true; });
    expect(await f.controller.command(explicit ? { command: 'duplicate', selectionView: camera } : { command: 'duplicate' })).toBe(true);
    expect(f.execute).toHaveBeenCalledOnce(); const command = f.execute.mock.calls[0][0];
    expect(command.selectionView).toEqual([0, 0, 0, 0, 0, 3, 100, 45, 0, 0, 1]);
    expect(Object.isFrozen(command.selectionView)).toBe(true); expect(f.cancel).not.toHaveBeenCalled();
    expect(f.trace).toEqual(['end tolerance', 'settle color', 'duplicate']);
  });
  it.each(['brush', 'polygon', 'color'] as const)('successful Reset cleanup leaves %s for orbit navigation and stops auto orbit', async tool => {
    const f = fixture(); setApp({ tool });
    expect(await f.controller.command({ command: 'resetCleanup' })).toBe(true);
    expect(navigation()).toEqual({ tool: null, mode: 'orbit', autoOrbit: false });
    expect(f.trace).toEqual(['end tolerance', 'restore manual baseline', 'settle color', 'resetCleanup']);
    expect(f.clearInput).toHaveBeenCalledOnce(); expect(f.invalidate).toHaveBeenCalledOnce();
    expect(f.reset).not.toHaveBeenCalled(); expect(f.owned.selectionBarriers).toBe(0);
  });

  it('exits a clean armed tool even when the successful native cleanup has no mask change', async () => {
    const f = fixture();
    setApp({ tool: 'rectangle', fly: false, autoOrbit: false,
      summary: { ...baseline, selected: 0, visible: baseline.count } });
    f.cancel.mockImplementation(async () => true);
    f.execute.mockImplementation(async () => true);
    expect(await f.controller.command({ command: 'resetCleanup' })).toBe(true);
    expect(navigation()).toEqual({ tool: null, mode: 'orbit', autoOrbit: false });
    expect(f.clearInput).toHaveBeenCalledOnce(); expect(f.reset).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'color', 'execute'] as const)('%s refusal leaves the armed tool and navigation unchanged', async phase => {
    const f = fixture(), before = navigation();
    if (phase === 'cancel') f.cancel.mockResolvedValue(false);
    else if (phase === 'color') f.settle.mockResolvedValue(false);
    else f.execute.mockResolvedValue(false);
    expect(await f.controller.command({ command: 'resetCleanup' })).toBe(false);
    expect(navigation()).toEqual(before); expect(f.clearInput).not.toHaveBeenCalled();
    expect(f.invalidate).not.toHaveBeenCalled(); expect(f.owned.selectionBarriers).toBe(0);
    if (phase === 'cancel') expect(f.settle).not.toHaveBeenCalled();
    if (phase !== 'execute') expect(f.execute).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'color', 'execute'] as const)('does not publish Reset navigation while %s is still owned', async phase => {
    const f = fixture(), held = deferred<boolean>(), before = navigation();
    if (phase === 'cancel') f.cancel.mockReturnValue(held.promise);
    else if (phase === 'color') f.settle.mockReturnValue(held.promise);
    else f.execute.mockReturnValue(held.promise);
    const resetting = f.controller.command({ command: 'resetCleanup' }); await flush();
    expect(navigation()).toEqual(before); expect(f.clearInput).not.toHaveBeenCalled();
    expect(f.owned.selectionBarriers).toBe(1);
    if (phase === 'cancel') expect(f.settle).not.toHaveBeenCalled();
    if (phase !== 'execute') expect(f.execute).not.toHaveBeenCalled();
    held.resolve(true); expect(await resetting).toBe(true);
    expect(navigation()).toEqual({ tool: null, mode: 'orbit', autoOrbit: false });
    expect(f.clearInput).toHaveBeenCalledOnce(); expect(f.owned.selectionBarriers).toBe(0);
  });

  it('keeps the armed tool when native Reset rejects rather than acknowledges publication', async () => {
    const f = fixture(), before = navigation(), failure = new Error('Independent reset publication refusal');
    f.execute.mockRejectedValue(failure);
    await expect(f.controller.command({ command: 'resetCleanup' })).rejects.toBe(failure);
    expect(navigation()).toEqual(before); expect(f.clearInput).not.toHaveBeenCalled();
    expect(f.invalidate).not.toHaveBeenCalled(); expect(f.owned.selectionBarriers).toBe(0);
  });

  it.each(normalActions)('%s restores a manual preview baseline before acting and preserves its armed tool', async command => {
    const f = fixture(), tool: SelectionTool = command === 'restore' ? 'fill' : 'rectangle';
    setApp({ tool, fly: false, autoOrbit: false, summary: { ...baseline, selected: 3, selectionDraft: true } });
    f.owned.selection = { session: { closed: false } };
    expect(f.controller.selectionActive).toBe(true);
    expect(await f.controller.command({ command })).toBe(true);
    expect(f.trace).toEqual(['end tolerance', 'restore manual baseline', 'settle color', command]);
    expect(navigation()).toEqual({ tool, mode: 'orbit', autoOrbit: false });
    expect(f.cancel).toHaveBeenCalledOnce(); expect(f.execute).toHaveBeenCalledExactlyOnceWith({ command });
    expect(f.clearInput).not.toHaveBeenCalled(); expect(f.invalidate).not.toHaveBeenCalled();
    expect(f.owned.selectionBarriers).toBe(0);
  });

  it('keeps scene/camera identity and unrelated grading, selection and morphology parameters', async () => {
    const f = fixture(), grade = [...initial.grade]; grade[0] = 1.25;
    setApp({ grade, appliedGrade: [...grade], gradeRevision: 11, colorSelectedOnly: true,
      operation: 3, brushSize: 77, selectionSigma: 4.5, tolerance: .3, colorTolerance: .3,
      fillTolerance: .6, connectedColor: true, visibleOnly: false, overlap: false, live: true });
    const camera = f.controller.camera, before = useApp.getState();
    expect(await f.controller.command({ command: 'resetCleanup' })).toBe(true);
    const after = useApp.getState();
    for (const key of ['grade', 'appliedGrade', 'gradeRevision', 'colorSelectedOnly', 'operation',
      'brushSize', 'selectionSigma', 'tolerance', 'colorTolerance', 'fillTolerance',
      'connectedColor', 'visibleOnly', 'overlap', 'live'] as const) expect(after[key]).toEqual(before[key]);
    expect(f.controller.scene).toBe(f.scene); expect(f.controller.camera).toBe(camera);
    expect(after.summary).toMatchObject({ count: baseline.count, sourceCount: baseline.sourceCount,
      shDegree: baseline.shDegree, contentRevision: baseline.contentRevision });
    expect(f.reset).not.toHaveBeenCalled();
  });
});
