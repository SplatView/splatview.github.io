import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppController } from '../src/app/controller';
import { setApp, switchToolsMode, useApp } from '../src/app/store';
import type { NativeSummary, Revision } from '../src/document/types';
import type { SelectionRangeFields } from '../src/document/selectionRange';

const initial = useApp.getState();
type Request = SelectionRangeFields & { tolerance: number; connected: boolean; sequence: number };
type Internal = { tolerance?: unknown; releasedSelections: unknown[]; startReleasedDrain(): void; invalidate(): void;
  amendTolerance(owner: unknown, request: Request): Promise<boolean>; executeCommand(...args: unknown[]): Promise<boolean> };
function fixture() {
  const controller = new AppController(), internal = controller as unknown as Internal;
  const revision: Revision = { documentId: 'de000001-0000-4000-8000-000000000001', sourceGeneration: 1, contentRevision: 0, selectionRevision: 0, draftRevision: 0 };
  const client = { revision, assertNativeAdmission: vi.fn() };
  const renderer = { lost: false, canvas: { width: 400, height: 200, clientWidth: 200 } };
  const scene = { kind: 'gaussian', sourceRevision: 1, count: 3 };
  const camera = { revision: 7, state: [0, 0, 0, 0, 0, 3, 1, 45, 0, 0, 1] };
  Object.assign(controller, { client, renderer, scene, camera });
  vi.spyOn(controller, 'invalidate').mockImplementation(() => {});
  const update = vi.fn(), retire = vi.fn();
  const request: Request = { tolerance: .01, connected: false, rangeEnabled: false, rangeRadius: 2, sequence: 0 };
  const owner = { id: 1, client, renderer, scene, camera, sourceRevision: 1, cameraRevision: 7, width: 400, height: 200,
    tool: 'color', optionsRevision: useApp.getState().selectionOptionsRevision, active: true, applying: false,
    revision: { ...revision }, request, waitingMap: false, mapReady: false, session: { update, retire } };
  internal.tolerance = owner;
  return { controller, internal, owner, update, renderer, camera };
}
beforeEach(() => {
  vi.stubGlobal('document', { hidden: true });
  setApp({ ...initial, ready: true, rendererState: 'ready', tool: 'color', mode: 'pro', busy: false,
    colorRange: { enabled: false, radius: null }, fillRange: { enabled: false, radius: null },
    summary: { ok: true, loaded: true, kind: 0, count: 3, sourceCount: 3, selected: 1, visible: 3,
      revision: 0, contentRevision: 0, selectionDraft: false, pending: false,
      duplicateRange: null, shDegree: 0, format: 'PLY', canUndo: true, canRedo: false,
      transaction: false, sceneChanged: false, progress: 1, center: [0, 0, 0], radius: 1,
      yUp: false, camera: [0, 0, 0, 0, 0, 3, 1, 45, 0, 0, 1], memoryBytes: 432,
      selectionMapId: null, pendingSelectionMapId: null, selectionMapBytes: 0, selectionMapRetainedIds: [],
      floor: null, filter: null, transformSession: null, opacitySession: null,
      toleranceSessionId: 1, toleranceTool: 'color', toleranceRange: { enabled: false, radius: 2, center: [1, 2, 3] },
      morphologyRange: { version: 1, minimum: .125, maximum: 64, default: 2 } } as NativeSummary }, true);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); setApp(initial, true); });

describe('Range preference and completed-click ownership', () => {
  it('deduplicates repeated acknowledged native operands while allowing raw preferences to change', async () => {
    const f = fixture(), acceptedRequest = { ...f.owner.request };
    Object.assign(f.owner, { acceptedRequest });
    setApp({ summary: { ...useApp.getState().summary!, toleranceConnected: false } });
    const execute = vi.spyOn(f.internal, 'executeCommand');
    expect(await f.internal.amendTolerance(f.owner, { ...acceptedRequest, sequence: 2 })).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    f.controller.setSelectionRangeRadius(2.0000000000000004);
    expect(useApp.getState().colorRange.radius).toBe(2.0000000000000004);
    expect(f.update.mock.lastCall?.[0]).toMatchObject({ rangeRadius: 2 });
    expect(await f.internal.amendTolerance(f.owner, f.update.mock.lastCall![0] as Request)).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
  it('retries a refused identical request, then suppresses a duplicate only after acknowledgement', async () => {
    const f = fixture(), request = { ...f.owner.request, rangeEnabled: true, rangeRadius: 4, sequence: 1 };
    Object.assign(f.owner, { acceptedRequest: { ...f.owner.request } });
    const execute = vi.spyOn(f.internal, 'executeCommand').mockResolvedValueOnce(false).mockImplementation(async () => {
      setApp({ summary: { ...useApp.getState().summary!, toleranceConnected: false,
        toleranceRange: { enabled: true, radius: 4, center: [1, 2, 3] } } }); return true;
    });
    expect(await f.internal.amendTolerance(f.owner, request)).toBe(false);
    expect(await f.internal.amendTolerance(f.owner, request)).toBe(true);
    expect(await f.internal.amendTolerance(f.owner, { ...request, sequence: 2 })).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it('amends only the active tool and retains independent raw preferences across profiles and source metadata', () => {
    const f = fixture();
    f.controller.setSelectionRangeRadius(.3333333333333); f.controller.setSelectionRangeEnabled(true);
    expect(f.update.mock.lastCall?.[0]).toMatchObject({ rangeEnabled: true, rangeRadius: Math.fround(.3333333333333), tolerance: .01, connected: false });
    expect(useApp.getState().colorRange).toEqual({ enabled: true, radius: .3333333333333 });
    expect(useApp.getState().fillRange).toEqual({ enabled: false, radius: null });
    switchToolsMode('basic'); setApp({ sourceName: 'next.ply', summary: null });
    expect(useApp.getState().colorRange).toEqual({ enabled: true, radius: .3333333333333 });
  });
  it('targets the live FIFO tail without changing the preceding completed owner', () => {
    const f = fixture();
    const tail = { tool: 'color', cancel: new AbortController(), request: { ...f.owner.request, sequence: 1 } };
    f.internal.releasedSelections.push(tail);
    f.controller.setSelectionRangeEnabled(true); f.controller.setSelectionRangeRadius(8);
    expect(tail.request).toMatchObject({ rangeEnabled: true, rangeRadius: 8, tolerance: .01 });
    expect(f.update).not.toHaveBeenCalled(); expect(f.owner.request.rangeEnabled).toBe(false);
  });
  it('does not transfer a missed other-tool tail amendment to the older owner', () => {
    const f = fixture(), tail = { tool: 'fill', cancel: new AbortController(), request: { ...f.owner.request } };
    f.internal.releasedSelections.push(tail);
    f.controller.setSelectionRangeEnabled(true);
    expect(f.update).not.toHaveBeenCalled(); expect(tail.request.rangeEnabled).toBe(false);
  });
  it('keeps the pending Range operand when tolerance and Connected change before it settles', () => {
    const f = fixture(); f.controller.setSelectionRangeEnabled(true); f.controller.setSelectionRangeRadius(8);
    f.controller.setSelectionTolerance(.5); f.controller.setConnectedColor(true);
    expect(f.update.mock.lastCall?.[0]).toMatchObject({ tolerance: .5, connected: true, rangeEnabled: true, rangeRadius: 8 });
  });
  it('uses only the acknowledged frozen center and expires feedback after camera or tool changes', () => {
    const f = fixture(); f.controller.setSelectionRangeEnabled(true); f.controller.setSelectionRangeRadius(8);
    expect(f.controller.selectionRangePreview).toEqual({ center: [1, 2, 3], radius: 8 });
    f.camera.revision++; expect(f.controller.selectionRangePreview).toBeUndefined();
    f.camera.revision--; setApp({ tool: 'fill' }); expect(f.controller.selectionRangePreview).toBeUndefined();
  });
  it.each([0, -1, NaN, Infinity, -Infinity])('ignores invalid raw radius %s without changing accepted or desired state', radius => {
    const f = fixture(); f.controller.setSelectionRangeRadius(radius);
    expect(useApp.getState().colorRange).toEqual({ enabled: false, radius: null }); expect(f.update).not.toHaveBeenCalled();
  });
});
