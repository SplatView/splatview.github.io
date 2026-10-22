import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppController } from '../src/app/controller';
import { setApp, useApp } from '../src/app/store';
import type { CoreClient } from '../src/document/coreClient';
import type { NativeSummary } from '../src/document/types';

const initial = useApp.getState();
const flush = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function summary(): NativeSummary {
  return { ok: true, duplicateRange: null, loaded: true, kind: 0, count: 3, sourceCount: 3, selected: 1, visible: 3, shDegree: 0,
    format: 'PLY', canUndo: true, canRedo: true, revision: 2, contentRevision: 1, transaction: false,
    selectionDraft: false, sceneChanged: false, pending: false, progress: 1, floor: null, filter: null,
    transformSession: null, opacitySession: null, center: [0, 0, 0], radius: 1, yUp: false,
    camera: [0, 0, 0, 0, 0, 3, 1, 45, 0, 0, 1], memoryBytes: 528,
    selectionMapId: null, pendingSelectionMapId: null, selectionMapBytes: 0, selectionMapRetainedIds: [] };
}
type Internal = {
  savedContent: number; generation: number; floorCleanup: Promise<void>;
  committedGraphicsRecovery?: object; candidate?: CoreClient; selectionCleanupOwner?: object; filterOwner?: object;
  outputReceipt?: { documentId: string; contentRevision: number; scope: number };
  pendingNavigation?: { run(): Promise<void>; retire?(): Promise<void> };
  beginIntake(ownsCollection: boolean): object; retireIntake(owner: object): Promise<void>;
  closeToleranceSelection(): Promise<void>; settleColorSession(): Promise<boolean>;
};
function fixture(dirty = false) {
  const controller = new AppController(), internal = controller as unknown as Internal;
  const client = { revision: { documentId: 'offline-document', sourceGeneration: 1, contentRevision: 1, selectionRevision: 2, draftRevision: 0 },
    operationOwner: undefined as object | undefined, dispose: vi.fn(), cancel: vi.fn() };
  const scene = { kind: 'gaussian', setDuplicateRange: vi.fn(), dispose: vi.fn(async () => {}) }, renderer = { lost: false, dispose: vi.fn() },
    camera = { clearInput: vi.fn(), dispose: vi.fn() };
  controller.client = client as unknown as CoreClient;
  controller.scene = scene as unknown as NonNullable<AppController['scene']>;
  controller.renderer = renderer as unknown as NonNullable<AppController['renderer']>;
  controller.camera = camera as unknown as NonNullable<AppController['camera']>;
  internal.savedContent = dirty ? 0 : 1;
  setApp({ summary: summary(), dirty, sourceName: 'kept.ply' });
  vi.spyOn(controller, 'invalidate').mockImplementation(() => {});
  return { controller, internal, client, scene, renderer, camera };
}
beforeEach(() => {
  vi.stubGlobal('document', { hidden: true, title: '' });
  setApp({ ...initial, ready: true, bootstrapState: 'ready', rendererState: 'ready', settingsOpen: true,
    busy: false, summary: null, dirty: false, operationRecovery: 'idle', operationRecoveryCommitted: false,
    selectionRecovery: 'idle', navigationPrompt: false, navigationIntent: null, outputPending: false,
    exportOpen: false, thumbnailPending: false, viewTransferPending: false, pendingSelectionCount: 0,
    savedViewChoices: [], error: null, memoryOverageBytes: 0 }, true);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); setApp(initial, true); });

describe('offline application update navigation', () => {
  it('allows a verified empty ready viewer without destroying its renderer or camera', async () => {
    const f = fixture(); f.controller.client = undefined; f.controller.scene = undefined; setApp({ summary: null });
    const action = vi.fn(async () => { expect(f.controller.appUpdateNavigationCurrent).toBe(true); });
    await expect(f.controller.requestAppUpdate(action)).resolves.toBe(true);
    expect(action).toHaveBeenCalledOnce(); expect(f.renderer.dispose).not.toHaveBeenCalled(); expect(f.camera.dispose).not.toHaveBeenCalled();
    expect(f.controller.appUpdateNavigationCurrent).toBe(false); expect(f.controller.appUpdateAvailable).toBe(true);
  });
  it.each(['unknown operation', 'committed graphics recovery', 'failed selection cleanup', 'graphics recovery', 'candidate', 'output'])(
    'refuses %s before changing document or draft owners', async kind => {
      const f = fixture(true), action = vi.fn(async () => {}), cancel = vi.spyOn(f.controller, 'cancelTransformPreview');
      if (kind === 'unknown operation') f.client.operationOwner = {};
      if (kind === 'committed graphics recovery') f.internal.committedGraphicsRecovery = {};
      if (kind === 'failed selection cleanup') f.internal.selectionCleanupOwner = {};
      if (kind === 'graphics recovery') setApp({ rendererState: 'recovering' });
      if (kind === 'candidate') f.internal.candidate = {} as CoreClient;
      if (kind === 'output') setApp({ outputPending: true });
      await expect(f.controller.requestAppUpdate(action)).resolves.toBe(false);
      expect(action).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled(); expect(f.client.dispose).not.toHaveBeenCalled();
      expect(useApp.getState().dirty).toBe(true); expect(useApp.getState().navigationPrompt).toBe(false);
    });
  it('joins floor retirement, refuses duplicate clicks, and fences a changed source after the join', async () => {
    const f = fixture(), held = deferred(), action = vi.fn(async () => {}); f.internal.floorCleanup = held.promise;
    const first = f.controller.requestAppUpdate(action); await flush();
    await expect(f.controller.requestAppUpdate(action)).resolves.toBe(false);
    expect(action).not.toHaveBeenCalled(); expect(useApp.getState().navigationPrompt).toBe(false);
    f.client.revision.sourceGeneration++; held.resolve(); await expect(first).resolves.toBe(false);
    expect(action).not.toHaveBeenCalled(); expect(f.controller.appUpdateAvailable).toBe(true); expect(f.scene.dispose).not.toHaveBeenCalled();
  });
  it('requires successful filter cancellation and retains the current scene when cleanup refuses', async () => {
    const f = fixture(true), action = vi.fn(async () => {}); f.internal.filterOwner = {};
    const filter = vi.spyOn(f.controller, 'cancelFilter').mockResolvedValue(false), transform = vi.spyOn(f.controller, 'cancelTransformPreview');
    await expect(f.controller.requestAppUpdate(action)).resolves.toBe(false);
    expect(filter).toHaveBeenCalledOnce(); expect(transform).not.toHaveBeenCalled(); expect(action).not.toHaveBeenCalled();
    expect(f.controller.scene).toBe(f.scene); expect(f.scene.dispose).not.toHaveBeenCalled(); expect(useApp.getState().dirty).toBe(true);
  });
  it('lets a new source request supersede update cleanup even when that intake retires before the cleanup joins', async () => {
    const f = fixture(), held = deferred(), action = vi.fn(async () => {}); f.internal.floorCleanup = held.promise;
    const request = f.controller.requestAppUpdate(action); await flush();
    const intake = f.internal.beginIntake(false); await f.internal.retireIntake(intake);
    held.resolve(); await expect(request).resolves.toBe(false);
    expect(action).not.toHaveBeenCalled(); expect(f.controller.client).toBe(f.client); expect(f.controller.appUpdateAvailable).toBe(true);
  });
  it.each(['transform draft', 'opacity draft', 'selection cleanup', 'color settlement'])(
    'does not open the dirty prompt after failed %s', async kind => {
      const f = fixture(true), action = vi.fn(async () => {});
      if (kind === 'transform draft') vi.spyOn(f.controller, 'cancelTransformPreview').mockResolvedValue(false);
      if (kind === 'opacity draft') vi.spyOn(f.controller, 'cancelOpacityPreview').mockResolvedValue(false);
      if (kind === 'selection cleanup') vi.spyOn(f.controller, 'cancelSelectionGesture').mockResolvedValue(false);
      if (kind === 'color settlement') vi.spyOn(f.internal, 'settleColorSession').mockResolvedValue(false);
      await expect(f.controller.requestAppUpdate(action)).resolves.toBe(false);
      expect(action).not.toHaveBeenCalled(); expect(useApp.getState()).toMatchObject({ dirty: true, navigationPrompt: false });
      expect(f.controller.client).toBe(f.client); expect(f.scene.dispose).not.toHaveBeenCalled();
    });
  it('refuses an unretired native tolerance checkpoint even when its cleanup promise fulfilled', async () => {
    const f = fixture(true), action = vi.fn(async () => {});
    setApp({ summary: { ...summary(), toleranceSessionId: 7, toleranceTool: 'color' } });
    vi.spyOn(f.internal, 'closeToleranceSelection').mockResolvedValue();
    await expect(f.controller.requestAppUpdate(action)).resolves.toBe(false);
    expect(action).not.toHaveBeenCalled(); expect(useApp.getState()).toMatchObject({ dirty: true, navigationPrompt: false });
    expect(f.scene.dispose).not.toHaveBeenCalled();
  });
  it('restores applied draft values and settles color before Save/Discard/Stay, preserving Redo on Stay', async () => {
    const f = fixture(true), events: string[] = [], action = vi.fn(async () => {});
    vi.spyOn(f.controller, 'cancelTransformPreview').mockImplementation(async () => { events.push('transform-applied'); return true; });
    vi.spyOn(f.controller, 'cancelOpacityPreview').mockImplementation(async () => { events.push('opacity-applied'); return true; });
    vi.spyOn(f.controller, 'endTransformSession').mockImplementation(async cancel => { expect(cancel).toBe(true); events.push('end-transform'); return true; });
    vi.spyOn(f.controller, 'endOpacitySession').mockImplementation(async cancel => { expect(cancel).toBe(true); events.push('end-opacity'); return true; });
    vi.spyOn(f.internal, 'settleColorSession').mockImplementation(async () => { events.push('bake-color'); return true; });
    const reset = vi.spyOn(f.controller, 'resetColorPreview');
    await expect(f.controller.requestAppUpdate(action)).resolves.toBe(true);
    expect(events).toEqual(['transform-applied', 'opacity-applied', 'end-transform', 'end-opacity', 'bake-color']);
    expect(reset).not.toHaveBeenCalled(); expect(useApp.getState()).toMatchObject({ dirty: true, navigationPrompt: true, navigationIntent: 'replace' });
    f.controller.stay(); await flush();
    expect(action).not.toHaveBeenCalled(); expect(f.controller.appUpdateAvailable).toBe(true);
    expect(useApp.getState()).toMatchObject({ dirty: true, navigationPrompt: false, summary: { canUndo: true, canRedo: true } });
    expect(f.controller.client).toBe(f.client); expect(f.scene.dispose).not.toHaveBeenCalled();
  });
  it('continues Save only after an acknowledged All receipt for the exact current document and content', async () => {
    const f = fixture(true), action = vi.fn(async () => { expect(f.controller.appUpdateNavigationCurrent).toBe(true); });
    await f.controller.requestAppUpdate(action);
    for (const [documentId, contentRevision, scope] of [['another-document', 1, 0], [f.client.revision.documentId, 0, 0], [f.client.revision.documentId, 1, 1]] as const) {
      f.internal.outputReceipt = { documentId, contentRevision, scope }; setApp({ outputPending: true });
      f.controller.acknowledgeOutput(); await flush();
      expect(action).not.toHaveBeenCalled(); expect(useApp.getState()).toMatchObject({ dirty: true, navigationPrompt: true, outputPending: false });
    }
    f.internal.outputReceipt = { documentId: f.client.revision.documentId, contentRevision: 1, scope: 0 }; setApp({ outputPending: true });
    f.controller.acknowledgeOutput(); await flush();
    expect(action).toHaveBeenCalledOnce(); expect(useApp.getState()).toMatchObject({ dirty: false, navigationPrompt: false });
    expect(f.client.dispose).not.toHaveBeenCalled(); expect(f.scene.dispose).not.toHaveBeenCalled();
  });
  it('revalidates the exact settled revision after Discard cleanup instead of reloading over a newer edit', async () => {
    const f = fixture(true), action = vi.fn(async () => {}); await f.controller.requestAppUpdate(action);
    f.client.revision.selectionRevision++; await f.controller.discardAndContinue();
    expect(action).not.toHaveBeenCalled(); expect(f.controller.appUpdateAvailable).toBe(true);
    expect(f.controller.client).toBe(f.client); expect(useApp.getState().summary?.canRedo).toBe(true);
  });
  it('exposes loss-sensitive validation while a durable reload ticket is pending and preserves owners on failure', async () => {
    const f = fixture(), held = deferred(); let guard: boolean | undefined;
    const request = f.controller.requestAppUpdate(async () => { await held.promise; guard = f.controller.appUpdateNavigationCurrent; throw new Error('ticket unavailable'); });
    await flush(); expect(f.controller.appUpdateNavigationCurrent).toBe(true);
    f.renderer.lost = true; held.resolve(); await expect(request).resolves.toBe(false);
    expect(guard).toBe(false); expect(f.controller.client).toBe(f.client); expect(f.scene.dispose).not.toHaveBeenCalled();
    expect(useApp.getState().error).toBe('The update could not be opened. Your current scene is still available.');
  });
  it('grants a narrow unload permit only after explicit update admission without clearing dirty history', async () => {
    const f = fixture(true), held = deferred(); let release: (() => void) | undefined;
    await f.controller.requestAppUpdate(async () => {
      expect(f.controller.appUpdateNavigationCurrent).toBe(true);
      expect(f.controller.appUpdateUnloadAllowed).toBe(false);
      release = f.controller.beginAppUpdateUnload();
      expect(f.controller.appUpdateUnloadAllowed).toBe(true);
      expect(useApp.getState()).toMatchObject({ dirty: true, summary: { canRedo: true } });
      await held.promise; release();
    });
    expect(f.controller.appUpdateUnloadAllowed).toBe(false);
    const continuing = f.controller.discardAndContinue(); await flush();
    expect(f.controller.appUpdateUnloadAllowed).toBe(true); expect(useApp.getState().dirty).toBe(true);
    held.resolve(); await continuing;
    expect(f.controller.appUpdateUnloadAllowed).toBe(false);
    expect(f.client.dispose).not.toHaveBeenCalled(); expect(f.scene.dispose).not.toHaveBeenCalled();
  });
  it('revokes the unload bypass if the pinned revision changes while navigation awaits commit', async () => {
    const f = fixture(), held = deferred();
    const request = f.controller.requestAppUpdate(async () => {
      const release = f.controller.beginAppUpdateUnload(); await held.promise; release();
    });
    await flush(); expect(f.controller.appUpdateUnloadAllowed).toBe(true);
    f.client.revision.contentRevision++;
    expect(f.controller.appUpdateUnloadAllowed).toBe(false);
    held.resolve(); await request;
    expect(() => f.controller.beginAppUpdateUnload()).toThrow('The update no longer owns this document.');
  });
  it('an old unload-permit cleanup cannot clear a newer admitted update owner', async () => {
    const f = fixture(), held = deferred(); let oldRelease: (() => void) | undefined;
    await f.controller.requestAppUpdate(async () => { oldRelease = f.controller.beginAppUpdateUnload(); });
    const next = f.controller.requestAppUpdate(async () => {
      const release = f.controller.beginAppUpdateUnload(); oldRelease!();
      expect(f.controller.appUpdateUnloadAllowed).toBe(true);
      await held.promise; release();
    });
    await flush(); expect(f.controller.appUpdateUnloadAllowed).toBe(true);
    held.resolve(); await next;
    expect(f.controller.appUpdateUnloadAllowed).toBe(false);
  });
});
