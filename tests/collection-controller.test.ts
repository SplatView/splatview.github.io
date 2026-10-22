import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppController } from '../src/app/controller';
import { setApp, useApp } from '../src/app/store';
import { ResourceLedger } from '../src/document/resources';
import type { NativeHeapAccounting } from '../src/document/nativeMemory';
import { NATIVE_LOAD_BUDGET_BYTES } from '../src/document/sceneInputLimits';
import { prepareSceneCollection, type OwnedSceneCollection, type SceneCollectionResource } from '../src/io/sceneCollection';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const tick = () => new Promise<void>(yes => setTimeout(yes, 0));
type Intake = { collection?: OwnedSceneCollection; cancel: AbortController; cleanup?: Promise<void>; barrier: boolean };
type Private = { ledger: ResourceLedger; collection?: OwnedSceneCollection; currentFile: number; intake?: Intake;
  exporting: boolean; selectionBarriers: number; colorBoundary?: Promise<boolean>;
  selectionCleanupOwner?: object; floorCleanup: Promise<void>;
  sourceLoads: Set<Promise<void>>; collectionCleanup: Set<Promise<void>>;
  collectionLoads: WeakMap<OwnedSceneCollection, Set<Promise<void>>>;
  beginIntake(owns: boolean): Intake; open(source: { collection: OwnedSceneCollection; index: number; intake: Intake; file?: File }): Promise<boolean>;
  retireCollection(collection: OwnedSceneCollection): Promise<void>; createNativeMemory(): NativeHeapAccounting;
  closeToleranceSelection(): Promise<void>; settleColorSession(): Promise<boolean>; cancelSelectionGesture(): Promise<boolean> };
const initial = useApp.getState();
beforeEach(() => { vi.stubGlobal('document', { hidden: true, title: '' }); vi.stubGlobal('cancelAnimationFrame', vi.fn()); setApp({ ...initial, busy: false, ready: true,
  error: null, dirty: false, navigationPrompt: false, outputPending: false, summary: null }, true); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); setApp(initial, true); });
function fixture(resources: readonly SceneCollectionResource[] = []) {
  const controller = new AppController(), owned = controller as unknown as Private;
  owned.ledger = new ResourceLedger(128 * 1024 * 1024);
  const options = { admit: (bytes: number) => owned.ledger.reserve('source', bytes), current: () => undefined };
  const collection = resources.length ? prepareSceneCollection(resources, options) : undefined;
  owned.collection = collection;
  controller.renderer = { lost: false, setHistogramEnabled: vi.fn(), resetHistogram: vi.fn(), dispose: vi.fn() } as unknown as NonNullable<AppController['renderer']>;
  controller.camera = { clearInput: vi.fn(), dispose: vi.fn() } as unknown as NonNullable<AppController['camera']>;
  controller.scene = { kind: 'gaussian', setDuplicateRange: vi.fn(), dispose: vi.fn(async () => {}) } as unknown as NonNullable<AppController['scene']>;
  vi.spyOn(owned, 'closeToleranceSelection').mockResolvedValue();
  vi.spyOn(owned, 'cancelSelectionGesture').mockResolvedValue(true);
  vi.spyOn(owned, 'settleColorSession').mockResolvedValue(true);
  return { controller, owned, collection };
}
const resource = (path: string): SceneCollectionResource => ({ path, kind: 'file',
  getFile: async () => new File(['not decoded in the ownership fixture'], path.slice(path.lastIndexOf('/') + 1)) });

describe('controller owned collection intake and navigation lifetime', () => {
  it.each(['required', 'restoring'] as const)('preserves %s cleanup authority without touching replacement inputs or credits', async recovery => {
    const f = fixture([resource('kept.ply')]), owner = {}, retained = f.owned.ledger.usage.bytes;
    f.owned.selectionCleanupOwner = owner; setApp({ selectionRecovery: recovery, error: 'Owned restoration refusal.' });
    const reserve = vi.spyOn(f.owned.ledger, 'reserve'), open = vi.spyOn(f.owned, 'open'); let reads = 0;
    const files = { get length(): number { reads++; throw new Error('Blocked file input was touched.'); } } as ArrayLike<File>;
    const transfer = { get items(): DataTransferItemList { reads++; throw new Error('Blocked drop was touched.'); } } as DataTransfer;
    await f.controller.openFiles(files); await f.controller.openFolder(files);
    expect(f.controller.snapshotDrop(transfer)).toBeUndefined();
    expect(reads).toBe(0); expect(reserve).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
    expect(f.owned.cancelSelectionGesture).not.toHaveBeenCalled(); expect(f.owned.intake).toBeUndefined();
    expect(f.owned.selectionCleanupOwner).toBe(owner); expect(f.owned.selectionBarriers).toBe(0);
    expect(useApp.getState()).toMatchObject({ selectionRecovery: recovery, error: 'Owned restoration refusal.', busy: false });
    f.collection!.assertCurrent(); expect(f.owned.ledger.usage.bytes).toBe(retained); await f.collection!.dispose();
  });

  it('retires a captured drop without scanning when cleanup becomes required before its asynchronous intake', async () => {
    const f = fixture([resource('kept.ply')]), retained = f.owned.ledger.usage.bytes;
    const reader = vi.fn(), directory = { name: 'selected', isFile: false, isDirectory: true, createReader: reader };
    const drop = f.controller.snapshotDrop({ items: [{ kind: 'file', webkitGetAsEntry: () => directory }] } as unknown as DataTransfer)!;
    expect(f.owned.ledger.usage.bytes).toBeGreaterThan(retained); expect(f.owned.selectionBarriers).toBe(1);
    const owner = {}; f.owned.selectionCleanupOwner = owner; setApp({ selectionRecovery: 'required', error: 'Retained cleanup.' });
    await f.controller.openDrop(drop);
    expect(reader).not.toHaveBeenCalled(); expect(f.owned.intake).toBeUndefined(); expect(f.owned.selectionBarriers).toBe(0);
    expect(f.owned.selectionCleanupOwner).toBe(owner); expect(useApp.getState().error).toBe('Retained cleanup.');
    expect(f.owned.ledger.usage.bytes).toBe(retained); f.collection!.assertCurrent(); await f.collection!.dispose();
  });

  it('checks the chosen intrinsic source against decode memory before a dirty prompt and preserves its incumbent catalog', async () => {
    const block = new Blob([new Uint8Array(1024 * 1024)]);
    const large = new File(Array<Blob>(512).fill(block), 'z-large.ply');
    expect(large.size).toBe(NATIVE_LOAD_BUDGET_BYTES);
    Object.defineProperty(large, 'size', { value: 1 });
    const selected = vi.fn(async () => large), unselected = vi.fn(async () => new File(['kept'], 'a-kept.ply'));
    const f = fixture([{ path: 'a-kept.ply', kind: 'file', getFile: unselected }, { path: 'z-large.ply', kind: 'file', getFile: selected }]);
    setApp({ dirty: true }); const retained = f.owned.ledger.usage.bytes, open = vi.spyOn(f.owned, 'open');
    const slice = vi.spyOn(large, 'slice'), arrayBuffer = vi.spyOn(large, 'arrayBuffer');
    await f.controller.adjacent(1);
    expect(selected).toHaveBeenCalledOnce(); expect(unselected).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
    expect(slice).not.toHaveBeenCalled(); expect(arrayBuffer).not.toHaveBeenCalled();
    expect(useApp.getState()).toMatchObject({ dirty: true, navigationPrompt: false, busy: false,
      error: 'The scene source does not fit within the available decode memory budget.' });
    expect(f.owned.currentFile).toBe(0); expect(f.owned.collection).toBe(f.collection); expect(f.owned.intake).toBeUndefined();
    expect(f.owned.selectionBarriers).toBe(0); expect(f.owned.ledger.usage.bytes).toBe(retained);
    f.collection!.assertCurrent(); await f.collection!.dispose();
  });

  it('hands the one acquired File through a dirty prompt without asking a mutable provider for another snapshot', async () => {
    const first = new File(['first snapshot'], 'b-next.ply'), provider = vi.fn(async () => first);
    const f = fixture([resource('a-kept.ply'), { path: 'b-next.ply', kind: 'file', getFile: provider }]);
    setApp({ dirty: true }); const open = vi.spyOn(f.owned, 'open');
    const native = vi.spyOn(f.owned, 'createNativeMemory').mockImplementation(() => { throw new Error('Stopped at native candidate boundary.'); });
    await f.controller.adjacent(1);
    expect(provider).toHaveBeenCalledOnce(); expect(useApp.getState().navigationPrompt).toBe(true); expect(open).not.toHaveBeenCalled();
    provider.mockImplementation(async () => { throw new Error('A second provider snapshot was requested.'); });
    await f.controller.discardAndContinue();
    expect(provider).toHaveBeenCalledOnce(); expect(open).toHaveBeenCalledOnce(); expect(open.mock.calls[0][0].file).toBe(first);
    expect(native).toHaveBeenCalledOnce(); expect(useApp.getState().error).toBe('Stopped at native candidate boundary.');
    expect(f.owned.selectionBarriers).toBe(0); expect(f.owned.sourceLoads.size).toBe(0); await f.collection!.dispose();
  });

  it('fences export through discovery and floor cleanup, then hands the barrier into the registered busy source load', async () => {
    const f = fixture([resource('a-kept.ply'), resource('b-next.ply')]), floor = deferred<void>();
    f.owned.floorCleanup = floor.promise;
    f.controller.client = { revision: { documentId: 'kept' }, assertNativeAdmission() {} } as unknown as NonNullable<AppController['client']>;
    const native = vi.spyOn(f.owned, 'createNativeMemory').mockImplementation(() => {
      expect(f.owned.selectionBarriers).toBe(0); expect(f.owned.sourceLoads.size).toBe(1); expect(useApp.getState().busy).toBe(true);
      throw new Error('Stopped at registered candidate boundary.');
    });
    const opening = f.controller.adjacent(1); await tick();
    expect(f.owned.selectionBarriers).toBe(1); expect(f.owned.sourceLoads.size).toBe(0); expect(useApp.getState().busy).toBe(false);
    let exportSettled = false; const exporting = f.controller.exportScene().then(() => { exportSettled = true; });
    await Promise.resolve(); await Promise.resolve(); expect(exportSettled).toBe(true); expect(f.owned.exporting).toBe(false);
    floor.resolve(); await opening; await exporting;
    expect(native).toHaveBeenCalledOnce(); expect(f.owned.selectionBarriers).toBe(0); expect(f.owned.sourceLoads.size).toBe(0);
    await f.collection!.dispose();
  });

  it('tracks an old catalog load fence independently while the new catalog remains usable for navigation', async () => {
    const f = fixture([resource('old.ply')]), old = f.collection!, fence = deferred<void>();
    f.owned.collectionLoads.set(old, new Set([fence.promise]));
    const next = prepareSceneCollection([resource('new-a.ply'), resource('new-b.ply')], {
      current() {}, admit: bytes => f.owned.ledger.reserve('source', bytes) });
    f.owned.collection = next; const retained = f.owned.ledger.usage.bytes;
    let settled = false; const retirement = f.owned.retireCollection(old).then(() => { settled = true; });
    await tick(); expect(settled).toBe(false); expect(f.owned.collectionCleanup.size).toBe(1);
    old.assertCurrent(); next.assertCurrent(); expect(f.owned.ledger.usage.bytes).toBe(retained);
    expect(f.controller.collectionNavigationAvailable).toBe(true);
    const open = vi.spyOn(f.owned, 'open').mockResolvedValue(false); await f.controller.adjacent(1); expect(open).toHaveBeenCalledOnce();
    expect(settled).toBe(false); fence.resolve(); await retirement; await tick();
    expect(() => old.assertCurrent()).toThrow(); next.assertCurrent(); expect(f.owned.collectionCleanup.size).toBe(0);
    await next.dispose(); expect(f.owned.ledger.usage.bytes).toBe(0);
  });

  it('keeps a cancelled directory callback credited without letting its obsolete barrier block the new winner', async () => {
    const f = fixture([resource('incumbent.ply')]), incumbentBytes = f.owned.ledger.usage.bytes; let complete!: (entries: unknown[]) => void;
    const directory = { name: 'held', isFile: false, isDirectory: true,
      createReader: () => ({ readEntries(yes: typeof complete) { complete = yes; } }) };
    const drop = f.controller.snapshotDrop({ items: [{ kind: 'file', webkitGetAsEntry: () => directory }] } as unknown as DataTransfer)!;
    const older = f.controller.openDrop(drop), retained = f.owned.ledger.usage.bytes; expect(complete).toBeTypeOf('function');
    const open = vi.spyOn(f.owned, 'open').mockImplementation(async source => {
      const old = f.owned.collection; f.owned.collection = source.collection; f.owned.currentFile = source.index;
      if (old && old !== source.collection) void f.owned.retireCollection(old);
      return true;
    });
    await f.controller.openFiles([new File(['new'], 'new.ply')]); await tick();
    expect(open).toHaveBeenCalledOnce(); expect(f.owned.collection!.entries[0].path).toBe('new.ply');
    expect(f.owned.collectionCleanup.size).toBeGreaterThan(0); expect(f.owned.ledger.usage.bytes).toBeGreaterThan(retained - incumbentBytes);
    expect(f.owned.selectionBarriers).toBe(0); expect(f.controller.collectionNavigationAvailable).toBe(true);
    complete([]); await older; await tick(); expect(useApp.getState().error).toBeNull();
    await f.owned.collection!.dispose(); expect(f.owned.ledger.usage.bytes).toBe(0);
  });

  it.each(['close', 'dispose'] as const)('joins a late old-catalog retirement created by a captured source fence before %s releases owners', async action => {
    const file = deferred<File>(), entered = deferred<void>(), fence = deferred<void>();
    const f = fixture([{ path: 'old.ply', kind: 'file', getFile: () => { entered.resolve(); return file.promise; } }]);
    const old = f.collection!, acquiring = old.acquireResource('old.ply', () => undefined);
    const refused = expect(acquiring).rejects.toThrow(/disposed/); await entered.promise;
    const next = prepareSceneCollection([resource('new.ply')], { current() {}, admit: bytes => f.owned.ledger.reserve('source', bytes) });
    f.owned.collection = next;
    // A captured source operation registers this catalog cleanup only after
    // its old scene's deliberately held upload/retirement boundary returns.
    const source = fence.promise.then(() => { void f.owned.retireCollection(old); f.owned.sourceLoads.delete(source); });
    f.owned.sourceLoads.add(source);
    const renderer = f.controller.renderer!, retained = f.owned.ledger.usage.bytes;
    let settled = false;
    const closing = action === 'close' ? f.controller.closeScene().then(() => { settled = true; }) : undefined;
    if (action === 'dispose') f.controller.dispose();
    await tick(); expect(f.owned.collectionCleanup.size).toBe(0); expect(renderer.dispose).not.toHaveBeenCalled();
    fence.resolve(); await source; await tick();
    expect(f.owned.collectionCleanup.size).toBe(1); expect(f.owned.ledger.usage.bytes).toBe(retained);
    expect(settled).toBe(false); expect(renderer.dispose).not.toHaveBeenCalled();
    file.resolve(new File(['original'], 'old.ply')); await refused; await closing;
    await vi.waitFor(() => expect(f.owned.ledger.usage.bytes).toBe(0));
    expect(f.owned.collectionCleanup.size).toBe(0);
    if (action === 'dispose') expect(renderer.dispose).toHaveBeenCalledOnce();
    else expect(f.controller.renderer).toBe(renderer);
  });

  it('starts replacement ownership before settling gestures and retires the superseded staged catalog', async () => {
    const f = fixture(), gesture = deferred<void>();
    vi.mocked(f.owned.closeToleranceSelection).mockImplementationOnce(() => gesture.promise);
    const opens = vi.spyOn(f.owned, 'open').mockResolvedValue(false);
    const first = f.controller.openFiles([new File(['one'], 'old.ply')]); await tick();
    const old = f.owned.intake!, catalog = old.collection!; expect(catalog.entries[0].path).toBe('old.ply');
    const next = f.controller.openFiles([new File(['two'], 'new.ply')]); await next;
    expect(old.cancel.signal.aborted).toBe(true); expect(() => catalog.assertCurrent()).toThrow();
    gesture.resolve(); await first;
    expect(opens).toHaveBeenCalledTimes(1); expect(opens.mock.calls[0][0].collection.entries[0].path).toBe('new.ply');
    expect(f.owned.ledger.usage.bytes).toBe(0); expect(useApp.getState().error).toBeNull();
  });

  it('Stay retires only the new dirty-prompt catalog, keeping the incumbent and its index usable', async () => {
    const f = fixture([resource('kept/scene.ply')]); setApp({ dirty: true });
    const retained = f.owned.ledger.usage.bytes;
    const open = vi.spyOn(f.owned, 'open').mockResolvedValue(false);
    await f.controller.openFiles([new File(['new'], 'new.ply')]);
    const staged = f.owned.intake!.collection!;
    expect(useApp.getState().navigationPrompt).toBe(true); expect(open).not.toHaveBeenCalled();
    f.controller.stay(); await Promise.allSettled(f.owned.collectionCleanup);
    expect(() => staged.assertCurrent()).toThrow(); f.collection!.assertCurrent();
    expect(f.owned.collection).toBe(f.collection); expect(f.owned.currentFile).toBe(0);
    expect(f.owned.ledger.usage.bytes).toBe(retained); await f.collection!.dispose();
  });

  it('an adjacent failure and Stay reuse the accepted catalog without binding it to a retired intake', async () => {
    const f = fixture([resource('a.ply'), resource('b.ply')]);
    const open = vi.spyOn(f.owned, 'open').mockResolvedValue(false);
    await f.controller.adjacent(1); expect(open).toHaveBeenCalledTimes(1);
    expect(f.owned.currentFile).toBe(0); f.collection!.assertCurrent();
    setApp({ dirty: true }); await f.controller.adjacent(1); f.controller.stay();
    await Promise.allSettled(f.owned.collectionCleanup); f.collection!.assertCurrent();
    setApp({ dirty: false }); await f.controller.adjacent(1);
    expect(open).toHaveBeenCalledTimes(2); expect(open.mock.calls[1][0].collection).toBe(f.collection);
    await f.collection!.dispose(); expect(f.owned.ledger.usage.bytes).toBe(0);
  });

  it('holds selected getFile and its catalog credits through actual cancelled callback delivery', async () => {
    const held = deferred<File>(), entered = deferred<void>();
    const f = fixture([{ path: 'held.ply', kind: 'file', getFile: () => { entered.resolve(); return held.promise; } }]);
    const owner = f.owned.beginIntake(false); owner.collection = f.collection;
    const opening = f.owned.open({ collection: f.collection!, index: 0, intake: owner }); await entered.promise;
    const retained = f.owned.ledger.usage.bytes; f.controller.cancelLoad();
    expect(f.owned.sourceLoads.size).toBe(1); expect(f.owned.ledger.usage.bytes).toBe(retained);
    let retired = false; const retiring = f.collection!.dispose().then(() => { retired = true; }); await tick();
    expect(retired).toBe(false); expect(f.owned.ledger.usage.bytes).toBe(retained);
    held.resolve(new File(['source'], 'held.ply')); expect(await opening).toBe(false); await retiring;
    expect(f.owned.sourceLoads.size).toBe(0); expect(f.owned.ledger.usage.bytes).toBe(0);
  });

  it('nonwrapping adjacent navigation does not create an intake for an absent neighbor or invalid direction', async () => {
    const f = fixture([resource('only.ply')]); const open = vi.spyOn(f.owned, 'open');
    await f.controller.adjacent(-1); await f.controller.adjacent(1); await f.controller.adjacent(2);
    expect(open).not.toHaveBeenCalled(); expect(f.owned.intake).toBeUndefined();
    await f.collection!.dispose();
  });

  it('captures drop handles synchronously and joins a cancelled directory callback before returning its credits', async () => {
    const f = fixture(); let complete!: (entries: unknown[]) => void, snapshots = 0;
    const directory = { name: 'selected', isFile: false, isDirectory: true,
      createReader: () => ({ readEntries(yes: typeof complete) { complete = yes; } }) };
    const transfer = { items: [{ kind: 'file', webkitGetAsEntry() { snapshots++; return directory; } }] } as unknown as DataTransfer;
    const drop = f.controller.snapshotDrop(transfer)!; expect(snapshots).toBe(1);
    const intake = f.controller.openDrop(drop); expect(complete).toBeTypeOf('function');
    const retained = f.owned.ledger.usage.bytes; expect(retained).toBeGreaterThan(0);
    f.controller.cancelOperation(); let joined = false; void intake.then(() => { joined = true; }); await tick();
    expect(joined).toBe(false); expect(f.owned.ledger.usage.bytes).toBe(retained);
    complete([]); await intake; await Promise.allSettled(f.owned.collectionCleanup);
    expect(f.owned.ledger.usage.bytes).toBe(0); expect(useApp.getState().error).toBeNull();
  });

  it('blocks Page/adjacent admission for the complete Save owner before its busy telemetry is published', async () => {
    const f = fixture([resource('a.ply'), resource('b.ply')]); const open = vi.spyOn(f.owned, 'open').mockResolvedValue(false);
    f.owned.exporting = true; expect(useApp.getState().busy).toBe(false);
    expect(f.controller.collectionNavigationAvailable).toBe(false); await f.controller.adjacent(1);
    expect(open).not.toHaveBeenCalled(); expect(f.owned.intake).toBeUndefined();
    f.owned.exporting = false; expect(f.controller.collectionNavigationAvailable).toBe(true);
    await f.collection!.dispose();
  });

  it('blocks Page admission during private settlement barriers and released selection processing while telemetry is idle', async () => {
    const f = fixture([resource('a.ply'), resource('b.ply')]);
    const open = vi.spyOn(f.owned, 'open').mockResolvedValue(false), held = deferred<void>();
    vi.mocked(f.owned.closeToleranceSelection).mockImplementationOnce(() => held.promise);
    const navigation = f.controller.adjacent(1); await tick();
    expect(useApp.getState().busy).toBe(false); expect(f.owned.selectionBarriers).toBe(1);
    expect(f.controller.collectionNavigationAvailable).toBe(false); await f.controller.adjacent(1);
    held.resolve(); await navigation; expect(open).toHaveBeenCalledOnce();
    setApp({ pendingSelectionCount: 1 }); expect(f.controller.collectionNavigationAvailable).toBe(false);
    setApp({ pendingSelectionCount: 0 }); f.owned.colorBoundary = Promise.resolve(true);
    expect(f.controller.collectionNavigationAvailable).toBe(false);
    f.owned.colorBoundary = undefined; expect(f.controller.collectionNavigationAvailable).toBe(true);
    await f.collection!.dispose();
  });

  it('supersedes a dirty staged collection and leaves the incumbent owned through the replacement prompt', async () => {
    const f = fixture([resource('incumbent.ply')]); setApp({ dirty: true });
    const open = vi.spyOn(f.owned, 'open').mockResolvedValue(false), retained = f.owned.ledger.usage.bytes;
    await f.controller.openFiles([new File(['first'], 'first.ply')]); const first = f.owned.intake!.collection!;
    await f.controller.openFiles([new File(['second'], 'second.ply')]);
    await Promise.allSettled(f.owned.collectionCleanup);
    expect(() => first.assertCurrent()).toThrow(); f.collection!.assertCurrent();
    expect(f.owned.intake!.collection!.entries[0].path).toBe('second.ply'); expect(open).not.toHaveBeenCalled();
    f.controller.stay(); await Promise.allSettled(f.owned.collectionCleanup);
    expect(f.owned.collection).toBe(f.collection); expect(f.owned.ledger.usage.bytes).toBe(retained);
    await f.collection!.dispose();
  });

  it.each(['close', 'dispose'] as const)('joins an actual directory callback before %s returns collection credit and clears navigation ownership', async action => {
    const f = fixture([resource('incumbent.ply')]); let complete!: (entries: unknown[]) => void;
    const renderer = f.controller.renderer!, camera = f.controller.camera!;
    const directory = { name: 'held', isFile: false, isDirectory: true,
      createReader: () => ({ readEntries(yes: typeof complete) { complete = yes; } }) };
    const drop = f.controller.snapshotDrop({ items: [{ kind: 'file', webkitGetAsEntry: () => directory }] } as unknown as DataTransfer)!;
    const intake = f.controller.openDrop(drop); expect(complete).toBeTypeOf('function');
    const retained = f.owned.ledger.usage.bytes;
    let finished = false;
    const closing = action === 'close' ? f.controller.closeScene().then(() => { finished = true; }) : undefined;
    if (action === 'dispose') f.controller.dispose();
    await tick();
    expect(f.owned.intake).toBeUndefined(); expect(f.owned.collection).toBeUndefined();
    expect(useApp.getState()).toMatchObject({ collectionCount: 0, collectionPath: '', navigationPrompt: false, summary: null, sourceName: '' });
    expect(f.owned.ledger.usage.bytes).toBe(retained); expect(renderer.dispose).not.toHaveBeenCalled();
    if (action === 'close') expect(finished).toBe(false);
    else { expect(f.controller.client).toBeUndefined(); expect(f.controller.renderer).toBeUndefined(); expect(f.controller.camera).toBeUndefined(); expect(camera.dispose).toHaveBeenCalledOnce(); }
    complete([]); await intake; await closing;
    await vi.waitFor(() => expect(f.owned.ledger.usage.bytes).toBe(0));
    expect(f.owned.sourceLoads.size).toBe(0); expect(f.owned.collectionCleanup.size).toBe(0);
    if (action === 'dispose') await vi.waitFor(() => expect(renderer.dispose).toHaveBeenCalledOnce());
    else { expect(f.controller.renderer).toBe(renderer); expect(f.controller.camera).toBe(camera); }
  });
});
