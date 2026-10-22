import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppController } from '../src/app/controller';
import { setApp, useApp } from '../src/app/store';
import type { CoreClient } from '../src/document/coreClient';
import { MiB, ResourceLedger } from '../src/document/resources';
import { ownRgbaImage } from '../src/io/image';
import type { SavedViewOperation } from '../src/io/thumbnail';

// Real controller/image/ledger owners, with browser encoder and renderer
// transport doubles. Actual PNG/JPEG/IndexedDB outcomes are exercised in E2E.
const initial = useApp.getState();
const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type Internals = {
  ledger: ResourceLedger;
  updateThumbnailUnobserved(): Promise<boolean>;
  cancelCandidateLoad(): void;
};
let encoding: (() => Promise<Blob>)[], anchors: { click: ReturnType<typeof vi.fn>; remove(): void }[];
let browserWindow: EventTarget;
beforeEach(() => {
  vi.useFakeTimers(); encoding = []; anchors = []; browserWindow = new EventTarget();
  vi.stubGlobal('window', browserWindow); vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('document', { hidden: true, title: '', body: { append: vi.fn() }, createElement: () => {
    const anchor = { click: vi.fn(), remove: vi.fn(), href: '', download: '' }; anchors.push(anchor); return anchor;
  } });
  vi.stubGlobal('ImageData', class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} });
  vi.stubGlobal('OffscreenCanvas', class {
    constructor(public width: number, public height: number) {}
    getContext() { return { putImageData: vi.fn() }; }
    convertToBlob() { return encoding.shift()!(); }
  });
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:feedback-image'); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  setApp({ ...initial, toolbarFeedback: { save: null, capture: null, thumbnail: null }, ready: true, rendererState: 'ready', busy: false, error: null }, true);
});
afterEach(async () => {
  browserWindow.dispatchEvent(new Event('pagehide')); await flush();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); setApp(initial, true);
});
function fixture() {
  const app = new AppController(), owned = app as unknown as Internals, ledger = new ResourceLedger(4 * MiB);
  owned.ledger = ledger;
  const client = { revision: { documentId: 'feedback-original', sourceGeneration: 1 }, assertNativeAdmission: vi.fn(), dispose: vi.fn(), retireNativeMemory: vi.fn(async () => {}) };
  app.client = client as unknown as CoreClient;
  app.scene = { kind: 'gaussian', setDuplicateRange: vi.fn(), dispose: vi.fn(async () => {}) } as unknown as NonNullable<AppController['scene']>;
  app.camera = { dispose: vi.fn(), clearInput: vi.fn() } as unknown as NonNullable<AppController['camera']>;
  const captureRgba = vi.fn(async (_scene: unknown, _camera: unknown, operation: SavedViewOperation) => {
    operation.current?.(); const release = operation.admit(4);
    return ownRgbaImage(1, 1, new Uint8ClampedArray([12, 34, 56, 255]), release);
  });
  app.renderer = { lost: false, captureRgba, dispose: vi.fn(), setHistogramEnabled: vi.fn(), resetHistogram: vi.fn() } as unknown as NonNullable<AppController['renderer']>;
  return { app, owned, ledger, client, captureRgba };
}
const jpeg = () => new Blob(['encoded browser adapter'], { type: 'image/jpeg' });

describe('current-document toolbar result feedback', () => {
  it('confirms Capture after the joined download handoff for exactly three seconds without releasing its download owner', async () => {
    const f = fixture(), held = deferred<Blob>(); encoding.push(() => held.promise);
    const pending = f.app.snapshot(); await flush();
    expect(useApp.getState().toolbarFeedback.capture).toBeNull(); expect(anchors).toHaveLength(0);
    expect(f.ledger.usage.bytes).toBeGreaterThan(4);
    held.resolve(jpeg()); await pending;
    expect(anchors[0].click).toHaveBeenCalledOnce();
    expect(useApp.getState().toolbarFeedback.capture?.message).toBe('Download prepared');
    const retained = f.ledger.usage.bytes; expect(retained).toBe(jpeg().size);
    await vi.advanceTimersByTimeAsync(2999); expect(useApp.getState().toolbarFeedback.capture).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1); expect(useApp.getState().toolbarFeedback.capture).toBeNull();
    expect(f.ledger.usage.bytes).toBe(retained); expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    browserWindow.dispatchEvent(new Event('pagehide')); expect(f.ledger.usage.bytes).toBe(0);
  });

  it('clears the previous result on a failed new attempt and never confirms failed encoding', async () => {
    const f = fixture(); encoding.push(async () => jpeg()); await f.app.snapshot();
    expect(useApp.getState().toolbarFeedback.capture).not.toBeNull();
    encoding.push(async () => { throw new Error('Encoder refused'); }); await f.app.snapshot();
    expect(useApp.getState().toolbarFeedback.capture).toBeNull(); expect(useApp.getState().error).toBe('Encoder refused');
    expect(anchors).toHaveLength(1);
    // Encoding alone is insufficient: a refused browser download handoff
    // must dispose the image and cannot produce a success receipt either.
    vi.mocked(URL.createObjectURL).mockImplementationOnce(() => { throw new Error('Download handoff refused'); });
    encoding.push(async () => jpeg()); await f.app.snapshot();
    expect(useApp.getState().toolbarFeedback.capture).toBeNull(); expect(useApp.getState().error).toBe('Download handoff refused');
    expect(anchors).toHaveLength(1);
  });

  it('does not let an older held completion replace or prolong a newer successful result', async () => {
    const f = fixture(), older = deferred<Blob>(); encoding.push(() => older.promise, async () => jpeg());
    const pending = f.app.snapshot(); await flush(); await f.app.snapshot();
    const accepted = useApp.getState().toolbarFeedback.capture; expect(accepted).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1500); older.resolve(jpeg()); await pending;
    expect(useApp.getState().toolbarFeedback.capture).toBe(accepted);
    await vi.advanceTimersByTimeAsync(1500); expect(useApp.getState().toolbarFeedback.capture).toBeNull();
    expect(anchors).toHaveLength(2);
  });

  it('joins a stale encoder while source replacement suppresses its late receipt and download', async () => {
    const f = fixture(), held = deferred<Blob>(); encoding.push(() => held.promise);
    let settled = false; const pending = f.app.snapshot().then(() => { settled = true; }); await flush();
    const retained = f.ledger.usage.bytes; f.owned.cancelCandidateLoad(); await flush();
    expect(settled).toBe(false); expect(f.ledger.usage.bytes).toBe(retained);
    held.resolve(jpeg()); await pending;
    expect(anchors).toHaveLength(0); expect(useApp.getState().toolbarFeedback.capture).toBeNull();
    expect(f.ledger.usage.bytes).toBe(0); expect(useApp.getState().error).toBeNull();
  });

  it('clears a receipt on disposal and keeps held image credit until the encoder really joins', async () => {
    const f = fixture(), held = deferred<Blob>(); encoding.push(async () => jpeg(), () => held.promise);
    await f.app.snapshot(); const pending = f.app.snapshot(); await flush();
    f.app.dispose(); await flush();
    expect(useApp.getState().toolbarFeedback.capture).toBeNull(); expect(f.ledger.usage.bytes).toBeGreaterThan(0);
    held.resolve(jpeg()); await pending; await flush();
    expect(f.ledger.usage.bytes).toBe(0); expect(f.client.retireNativeMemory).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3000); expect(useApp.getState().toolbarFeedback.capture).toBeNull();
  });

  it('keeps thumbnail and capture timers independent and accepts only a successful thumbnail outcome', async () => {
    const f = fixture(), thumbnail = vi.spyOn(f.owned, 'updateThumbnailUnobserved');
    thumbnail.mockResolvedValueOnce(true); expect(await f.app.updateThumbnail()).toBe(true);
    const saved = useApp.getState().toolbarFeedback.thumbnail; expect(saved?.message).toContain('saved in this browser');
    await vi.advanceTimersByTimeAsync(1000); encoding.push(async () => jpeg()); await f.app.snapshot();
    await vi.advanceTimersByTimeAsync(2000); expect(useApp.getState().toolbarFeedback.thumbnail).toBeNull();
    expect(useApp.getState().toolbarFeedback.capture?.message).toBe('Download prepared');
    thumbnail.mockResolvedValueOnce(false); expect(await f.app.updateThumbnail()).toBe(false);
    expect(useApp.getState().toolbarFeedback.thumbnail).toBeNull();
    await vi.advanceTimersByTimeAsync(1000); expect(useApp.getState().toolbarFeedback.capture).toBeNull();
  });

  it('ignores a successful but stale thumbnail outcome after client replacement or a newer failed attempt', async () => {
    const f = fixture(), held = deferred<boolean>(), thumbnail = vi.spyOn(f.owned, 'updateThumbnailUnobserved');
    thumbnail.mockReturnValueOnce(held.promise).mockResolvedValueOnce(false);
    const pending = f.app.updateThumbnail(); expect(await f.app.updateThumbnail()).toBe(false);
    held.resolve(true); expect(await pending).toBe(true); expect(useApp.getState().toolbarFeedback.thumbnail).toBeNull();
    const replaced = deferred<boolean>(); thumbnail.mockReturnValueOnce(replaced.promise);
    const next = f.app.updateThumbnail(); f.app.client = { ...f.client, revision: { ...f.client.revision, documentId: 'replacement' } } as unknown as CoreClient;
    replaced.resolve(true); await next; expect(useApp.getState().toolbarFeedback.thumbnail).toBeNull();
  });
});
