import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppController } from '../src/app/controller';
import { setApp, switchToolsMode, useApp } from '../src/app/store';
import type { NativeSummary } from '../src/document/types';
import { isSelectionMorphologyCommand, selectionSigma } from '../src/input/selectionMorphology';

const initial = useApp.getState();
const summary = { kind: 0, duplicateRange: null, selected: 1, visible: 3, selectionDraft: false, pending: false } as NativeSummary;
const command = { command: 'morphology', mode: 'grow', sigma: 1 };
function fixture() {
  const controller = new AppController();
  controller.client = { revision: { documentId: 'draft', sourceGeneration: 1, contentRevision: 0,
    selectionRevision: 0, draftRevision: 0 } } as NonNullable<AppController['client']>;
  controller.scene = { kind: 'gaussian', setDuplicateRange: vi.fn() } as unknown as NonNullable<AppController['scene']>;
  controller.renderer = { lost: false } as NonNullable<AppController['renderer']>;
  const internal = controller as unknown as {
    closeToleranceSelection(): Promise<void>; settleColorSession(): Promise<boolean>; executeCommand(): Promise<boolean>;
    [key: string]: unknown;
  };
  const close = vi.spyOn(internal, 'closeToleranceSelection').mockResolvedValue();
  const execute = vi.spyOn(internal, 'executeCommand').mockResolvedValue(true);
  const cancel = vi.spyOn(controller, 'cancelSelectionGesture').mockResolvedValue(true);
  return { controller, internal, close, execute, cancel };
}
beforeEach(() => setApp({ ...initial, ready: true, busy: false, summary: { ...summary }, selectionSigma: 1,
  rendererState: 'ready', selectionDragging: false, pendingSelectionCount: 0, mode: 'basic',
  settingsOpen: false, exportOpen: false, outputPending: false, navigationPrompt: false, savedViewChoices: [] }, true));
afterEach(() => { vi.restoreAllMocks(); setApp(initial, true); });

describe('desktop morphology command boundary', () => {
  it('clamps and rounds sigma using the desktop half-step rule and rejects malformed bridge commands', () => {
    expect([-.1, .5, .74, .75, 1, 9.9, 50].map(selectionSigma)).toEqual([.5, .5, .5, 1, 1, 10, 10]);
    expect(selectionSigma(Number.NaN)).toBeNull(); expect(selectionSigma(Infinity)).toBeNull();
    for (const bad of [{ ...command, mode: 'dilate' }, { ...command, sigma: '1' },
      { ...command, sigma: .75 }, { ...command, sigma: 0 }, { ...command, sigma: 10.5 }])
      expect(isSelectionMorphologyCommand(bad)).toBe(false);
    expect(isSelectionMorphologyCommand(command)).toBe(true);
  });
  it.each([
    ['busy', () => setApp({ busy: true })], ['drag', () => setApp({ selectionDragging: true })],
    ['draft', () => setApp({ summary: { ...summary, selectionDraft: true } })],
    ['native pending', () => setApp({ summary: { ...summary, pending: true } })],
    ['released count', () => setApp({ pendingSelectionCount: 1 })],
    ['active gesture', (internals: Record<string, unknown>) => { internals.selection = { session: { closed: false } }; }],
    ['released queue', (internals: Record<string, unknown>) => { internals.releasedSelections = [{}]; }],
    ['drain retirement', (internals: Record<string, unknown>) => { internals.releasedDrain = Promise.resolve(); }],
    ['pending pick', (internals: Record<string, unknown>) => { internals.pendingTolerancePicks = new Set([Promise.resolve()]); }],
    ['tolerance amendment', (internals: Record<string, unknown>) => { internals.tolerance = { active: true, applying: true }; }],
    ['selection barrier', (internals: Record<string, unknown>) => { internals.selectionBarriers = 1; }],
    ['export ownership', (internals: Record<string, unknown>) => { internals.exporting = true; }],
  ] as const)('refuses %s before cancelling or draining owned selection input', async (_name, block) => {
    const { controller, internal, close, execute, cancel } = fixture(); block(internal);
    expect(controller.selectionMorphologyControlsEnabled).toBe(false);
    controller.setSelectionSigma(2); expect(useApp.getState().selectionSigma).toBe(1);
    expect(await controller.command(command)).toBe(false);
    expect(close).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });
  it.each([0, 3])('keeps sigma adjustable when selected=%d but refuses a command without a mixed live boundary', async selected => {
    setApp({ summary: { ...summary, selected } }); const { controller, close } = fixture();
    expect(controller.selectionMorphologyControlsEnabled).toBe(true);
    controller.setSelectionSigma(2); expect(useApp.getState().selectionSigma).toBe(2);
    expect(await controller.command(command)).toBe(false); expect(close).not.toHaveBeenCalled();
  });
  it('closes completed tolerance ownership and executes without cancelling the selection tool', async () => {
    const { controller, close, execute, cancel } = fixture();
    expect(await controller.command(command)).toBe(true);
    expect(close).toHaveBeenCalledOnce(); expect(execute).toHaveBeenCalledWith(command);
    expect(cancel).not.toHaveBeenCalled();
  });
  it.each(['source', 'revision', 'queue', 'all-selected'] as const)('rechecks %s after awaited tolerance cleanup', async change => {
    const { controller, internal, close, execute, cancel } = fixture();
    close.mockImplementation(async () => {
      if (change === 'source') controller.scene = { kind: 'gaussian', setDuplicateRange: vi.fn() } as unknown as NonNullable<AppController['scene']>;
      else if (change === 'revision') controller.client!.revision.selectionRevision++;
      else if (change === 'queue') internal.releasedSelections = [{}];
      else setApp({ summary: { ...summary, selected: 3 } });
    });
    expect(await controller.command(command)).toBe(false); expect(execute).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
  });
  it('shares sigma across Basic/Pro profiles and resets only through the explicit value action', () => {
    const { controller } = fixture(); controller.setSelectionSigma(4.5);
    switchToolsMode('pro'); expect(useApp.getState().selectionSigma).toBe(4.5);
    switchToolsMode('basic'); expect(useApp.getState().selectionSigma).toBe(4.5);
    controller.setSelectionSigma(1); expect(useApp.getState().selectionSigma).toBe(1);
  });
  it('requires authoritative volume bounds before cleanup and rechecks them after color settlement', async () => {
    const { controller, internal, close, execute } = fixture();
    const volume = { command: 'morphology', mode: 'grow', method: 'volume', distance: 1 };
    expect(await controller.command(volume)).toBe(false); expect(close).not.toHaveBeenCalled();
    setApp({ summary: { ...summary, loaded: true, morphologyRange: { version: 1, minimum: .125, maximum: 8, default: 1 } } });
    const settle = vi.spyOn(internal, 'settleColorSession').mockImplementation(async () => {
      setApp({ summary: { ...summary, loaded: true, morphologyRange: { version: 1, minimum: 2, maximum: 8, default: 4 } } });
      return true;
    });
    expect(await controller.command(volume)).toBe(false); expect(settle).toHaveBeenCalledOnce(); expect(execute).not.toHaveBeenCalled();
    settle.mockRestore();
  });
});
