import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppController } from '../src/app/controller';
import { setApp, useApp } from '../src/app/store';
import type { CoreClient } from '../src/document/coreClient';
import { MiB, ResourceLedger, type ResourceLease } from '../src/document/resources';
import type { NativeSummary, Revision } from '../src/document/types';
import type { SceneExportOptions, SceneExportPlan } from '../src/document/spz4Export';

// Pure controller regression tests: color settlement may legitimately publish
// a replacement GPU-scene identity before the export snapshot is taken.
// No renderer, native module, worker, codec, browser or GPU is started.
type OwnedController = {
  generation: number;
  ledger: ResourceLedger;
  outputReceipt?: { documentId: string; contentRevision: number; scope: number };
  cancelSelectionGesture(): Promise<boolean>;
  settleColorSession(): Promise<boolean>;
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const flush = async () => { for (let index = 0; index < 16; index++) await Promise.resolve(); };
const initial = useApp.getState();
function summary(contentRevision = 1, revision = 2): NativeSummary {
  return { ok: true, duplicateRange: null, loaded: true, kind: 0, count: 3, sourceCount: 3, selected: 1, visible: 3, shDegree: 0,
    format: 'PLY', canUndo: true, canRedo: true, revision, contentRevision, transaction: false,
    selectionDraft: false, sceneChanged: false, pending: false, progress: 1, floor: null, filter: null, transformSession: null, opacitySession: null,
    center: [0, 0, 0], radius: 1, yUp: false, camera: [0, 0, 0, 0, 0, 3, 1, 45, 0, 0, 1],
    memoryBytes: 528, exportBytes: 0, exportOutputBytes: 0, selectionMapId: null, pendingSelectionMapId: null,
    selectionMapBytes: 0, selectionMapRetainedIds: [] };
}
class SettlingClient {
  readonly revision: Revision = { documentId: 'settled-export', sourceGeneration: 1, contentRevision: 1,
    selectionRevision: 2, draftRevision: 0 };
  readonly encoded = deferred<ArrayBuffer>();
  readonly plan: SceneExportPlan = { format: 0, scope: 0, count: 3, shDegree: 0, outputCapacity: 64, nativeWorkBytes: 1024 };
  signal?: AbortSignal;
  readonly assertNativeAdmission = vi.fn();
  readonly sceneExportPlan = vi.fn(async (format: SceneExportPlan['format'], scope: number, _signal?: AbortSignal) => ({ ...this.plan, format, scope }));
  readonly exportPlan = vi.fn();
  readonly exportSpz4 = vi.fn();
  readonly export = vi.fn(async (_format: number, _scope: number, signal?: AbortSignal) => {
    this.signal = signal; return this.encoded.promise;
  });
  readonly exportOwned = vi.fn(async (format: number, scope: number, plan: SceneExportPlan, options: SceneExportOptions) => {
    expect(plan).toMatchObject({ format, scope });
    this.signal = options.signal;
    let work: ResourceLease | undefined, output: ResourceLease | undefined;
    try {
      options.current(); work = options.admitNative(plan.nativeWorkBytes);
      output = options.admitOutput(2 * plan.outputCapacity); options.current(); options.onAccepted();
      const bytes = await this.encoded.promise;
      const owner = output; output = undefined; owner.resize(2 * bytes.byteLength);
      let disposed = false, retainedBlob = false;
      return { bytes,
        retainBlob() { if (!disposed && !retainedBlob) { retainedBlob = true; owner.resize(bytes.byteLength); } },
        dispose() { if (!disposed) { disposed = true; owner(); } },
      };
    } finally { work?.(); output?.(); }
  });
}
type Anchor = { click: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn>; href: string; download: string };
let browserWindow: EventTarget, anchors: Anchor[], createUrl: ReturnType<typeof vi.fn<(value: Blob | MediaSource) => string>>,
  revokeUrl: ReturnType<typeof vi.fn<(value: string) => void>>;
beforeEach(() => {
  browserWindow = new EventTarget(); anchors = [];
  vi.stubGlobal('window', browserWindow);
  vi.stubGlobal('document', { hidden: true, title: '', body: { append: vi.fn() }, createElement: () => {
    const anchor = { click: vi.fn(), remove: vi.fn(), href: '', download: '' }; anchors.push(anchor); return anchor;
  } });
  createUrl = vi.fn<(value: Blob | MediaSource) => string>(() => 'blob:settled-export');
  revokeUrl = vi.fn<(value: string) => void>();
  vi.spyOn(URL, 'createObjectURL').mockImplementation(value => createUrl(value));
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(value => { revokeUrl(value); });
  setApp({ ...initial, ready: true, rendererState: 'ready', busy: false, dirty: true, error: null,
    selectionRecovery: 'idle', memoryOverageBytes: 0, navigationPrompt: false, outputPending: false,
    exportOpen: true, sourceName: 'settled.ply' }, true);
});
afterEach(async () => {
  browserWindow.dispatchEvent(new Event('pagehide')); await flush();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); setApp(initial, true);
});
function fixture() {
  const controller = new AppController(), owned = controller as unknown as OwnedController,
    ledger = new ResourceLedger(16 * MiB), client = new SettlingClient();
  owned.ledger = ledger; owned.generation = 7; controller.client = client as unknown as CoreClient;
  const originalScene = { kind: 'gaussian', setDuplicateRange: vi.fn(), dispose: vi.fn(async () => {}) },
    settledScene = { kind: 'gaussian', setDuplicateRange: vi.fn(), dispose: vi.fn(async () => {}) };
  controller.scene = originalScene as unknown as NonNullable<AppController['scene']>;
  vi.spyOn(owned, 'cancelSelectionGesture').mockResolvedValue(true);
  vi.spyOn(owned, 'settleColorSession').mockImplementation(async () => {
    await originalScene.dispose();
    controller.scene = settledScene as unknown as NonNullable<AppController['scene']>;
    client.revision.contentRevision = 2; client.revision.selectionRevision = 3;
    setApp({ summary: summary(2, 3) }); return true;
  });
  setApp({ summary: summary() });
  return { controller, owned, ledger, client, originalScene, settledScene };
}
const formats = [
  { format: 0, extension: 'ply' }, { format: 1, extension: 'spz' }, { format: 2, extension: 'splat' },
  { format: 3, extension: 'compressed.ply' }, { format: 4, extension: 'ksplat' },
  { format: 5, extension: 'csv' }, { format: 6, extension: 'sog' }, { format: 7, extension: 'sogs' }, { format: 8, extension: 'spz' },
] as const;
const encodedBytes = () => new Uint8Array([4, 3, 2, 1]).buffer;

describe('export snapshot after color settlement', () => {
  it.each(formats)('downloads format $format from the legitimately replaced settled scene and revision', async ({ format, extension }) => {
    const f = fixture(), accepted = vi.fn();
    const exporting = f.controller.exportScene(format, 0, accepted); await flush();
    expect(f.originalScene.dispose).toHaveBeenCalledOnce(); expect(f.controller.scene).toBe(f.settledScene);
    expect(f.client.exportOwned).toHaveBeenCalledOnce(); expect(accepted).toHaveBeenCalledExactlyOnceWith(format);
    expect(f.client.sceneExportPlan).toHaveBeenCalledExactlyOnceWith(format, 0, f.client.signal);
    expect(f.client.sceneExportPlan.mock.invocationCallOrder[0]).toBeGreaterThan(f.originalScene.dispose.mock.invocationCallOrder[0]);
    expect(f.client.exportPlan).not.toHaveBeenCalled(); expect(f.client.exportSpz4).not.toHaveBeenCalled(); expect(f.client.export).not.toHaveBeenCalled();
    f.client.encoded.resolve(encodedBytes()); await exporting;
    expect(createUrl).toHaveBeenCalledOnce(); expect(anchors).toHaveLength(1); expect(anchors[0].click).toHaveBeenCalledOnce();
    expect(anchors[0].download).toBe(`settled-edited.${extension}`);
    expect(f.owned.outputReceipt).toEqual({ documentId: 'settled-export', contentRevision: 2, scope: 0 });
    expect(useApp.getState()).toMatchObject({ dirty: true, error: null, outputPending: true, busy: false,
      summary: { contentRevision: 2, revision: 3, canRedo: true } });
    browserWindow.dispatchEvent(new Event('pagehide')); await flush();
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith('blob:settled-export'); expect(f.ledger.usage.bytes).toBe(0);
  });

  for (const boundary of ['generation', 'client', 'cancel'] as const) {
    it.each(formats)('refuses format $format when ' + boundary + ' changes while color settlement is queued', async ({ format }) => {
      const f = fixture(), held = deferred<boolean>(), accepted = vi.fn();
      vi.mocked(f.owned.settleColorSession).mockReturnValue(held.promise);
      const exporting = f.controller.exportScene(format, 0, accepted); await flush();
      expect(f.owned.settleColorSession).toHaveBeenCalledOnce();
      if (boundary === 'generation') f.owned.generation++;
      else if (boundary === 'client') f.controller.client = { revision: { ...f.client.revision, documentId: 'replacement' } } as unknown as CoreClient;
      else f.controller.cancelOperation();
      held.resolve(true); await exporting;
      expect(f.client.sceneExportPlan).not.toHaveBeenCalled(); expect(f.client.exportOwned).not.toHaveBeenCalled();
      expect(f.client.exportPlan).not.toHaveBeenCalled(); expect(f.client.export).not.toHaveBeenCalled();
      expect(f.client.exportSpz4).not.toHaveBeenCalled(); expect(accepted).not.toHaveBeenCalled();
      expect(createUrl).not.toHaveBeenCalled(); expect(anchors).toHaveLength(0); expect(f.ledger.usage.bytes).toBe(0);
      expect(useApp.getState()).toMatchObject({ dirty: true, error: null, outputPending: false });
    });
  }

  it.each(formats)('discards late format $format bytes if the settled scene changes while encoding', async ({ format }) => {
    const f = fixture(), receipt = { documentId: 'settled-export', contentRevision: 1, scope: 0 }; f.owned.outputReceipt = receipt;
    const exporting = f.controller.exportScene(format); await flush();
    expect(f.client.exportOwned).toHaveBeenCalledOnce(); expect(f.controller.scene).toBe(f.settledScene);
    const laterScene = { kind: 'gaussian', setDuplicateRange: vi.fn(), dispose: vi.fn(async () => {}) };
    f.controller.scene = laterScene as unknown as NonNullable<AppController['scene']>;
    f.client.encoded.resolve(encodedBytes()); await exporting;
    expect(createUrl).not.toHaveBeenCalled(); expect(anchors).toHaveLength(0); expect(f.owned.outputReceipt).toBe(receipt);
    expect(f.ledger.usage.bytes).toBe(0); expect(useApp.getState()).toMatchObject({ dirty: true, error: null, outputPending: false, busy: false });
  });
});
