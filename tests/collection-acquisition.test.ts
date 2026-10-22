import { describe, expect, it } from 'vitest';
import { ResourceLedger, bindResourceLeaseCredit, type ResourceLease } from '../src/document/resources';
import { acquireSceneCollectionFromDrop, acquireSceneCollectionFromFiles, acquireSceneCollectionFromFolderFiles,
  snapshotSceneCollectionDrop } from '../src/io/collectionAcquisition';
import type { SceneCollectionOptions } from '../src/io/sceneCollection';

function account() {
  const ledger = new ResourceLedger(128 * 1024 * 1024); let active = true;
  const options: SceneCollectionOptions = { admit: bytes => ledger.reserve('source', bytes), current() { if (!active) throw new Error('Intake cancelled.'); } };
  return { ledger, options, cancel() { active = false; } };
}
type Entry = { name: string; isFile: boolean; isDirectory: boolean; file?: (yes: (file: File) => void) => void;
  createReader?: () => { readEntries(yes: (entries: Entry[]) => void, no: (error: DOMException) => void): void } };
function fileEntry(name: string, acquired: string[]) {
  return { name, isFile: true, isDirectory: false, file(yes: (file: File) => void) { acquired.push(name); yes(new File(['data'], name)); } } satisfies Entry;
}
function directory(name: string, batches: Entry[][], requests: string[]) {
  return { name, isFile: false, isDirectory: true, createReader() {
    let offset = 0; return { readEntries(yes: (entries: Entry[]) => void) { requests.push(name); yes(batches[offset++] ?? []); } };
  } } satisfies Entry;
}
function transfer(entries: Entry[]): DataTransfer {
  return { items: entries.map(entry => ({ kind: 'file', webkitGetAsEntry: () => entry, getAsFile() { throw new Error('Directory fallback must not be used.'); } })) } as unknown as DataTransfer;
}
function folderFile(path: string) {
  const file = new File(['body'], path.slice(path.lastIndexOf('/') + 1)); Object.defineProperty(file, 'webkitRelativePath', { value: path }); return file;
}

describe('bounded selected folder and drop metadata acquisition', () => {
  it('strips one verified picker root, counts inferred directories, and acquires only the selected provider', async () => {
    const owner = account(), files = [folderFile('chosen/asset10/meta.json'), folderFile('chosen/asset2/meta.json'),
      folderFile('chosen/asset10/positions.webp'), folderFile('chosen/scene2.ply'), folderFile('chosen/scene10.ply')];
    const collection = await acquireSceneCollectionFromFolderFiles(files, owner.options);
    expect(collection.entries.map(entry => entry.path)).toEqual(['asset10/meta.json', 'asset2/meta.json', 'scene2.ply', 'scene10.ply']);
    expect(await collection.acquireResource('asset10/positions.webp', () => undefined)).toBe(files[2]);
    owner.cancel(); collection.assertCurrent(); await collection.dispose(); expect(owner.ledger.usage.bytes).toBe(0);
  });

  it('keeps ordinary flat-file input without directory discovery', async () => {
    const owner = account(), file = new File(['data'], 'scene.ply');
    const collection = await acquireSceneCollectionFromFiles([file, new File([], 'neighbor.bin')], owner.options);
    expect(collection.entries.map(entry => entry.path)).toEqual(['scene.ply']); expect(await collection.acquireResource('scene.ply', () => undefined)).toBe(file);
    await collection.dispose(); expect(owner.ledger.usage.bytes).toBe(0);
  });

  it('captures drop authority synchronously and scans every directory batch without eager getFile', async () => {
    const owner = account(), acquired: string[] = [], requests: string[] = [];
    const nested = directory('asset', [[fileEntry('meta.json', acquired)], [fileEntry('positions.webp', acquired)], []], requests);
    const source = transfer([directory('chosen', [[nested], [fileEntry('scene.ply', acquired)], []], requests)]);
    const snapshot = snapshotSceneCollectionDrop(source, owner.options);
    expect(snapshot.itemCount).toBe(1); expect(owner.ledger.usage.bytes).toBeGreaterThan(0);
    (source.items as unknown as { length: number }).length = 0;
    const collection = await acquireSceneCollectionFromDrop(snapshot, owner.options);
    expect(requests).toEqual(['chosen', 'chosen', 'chosen', 'asset', 'asset', 'asset']); expect(acquired).toEqual([]);
    expect(collection.entries.map(entry => entry.path)).toEqual(['chosen/asset/meta.json', 'chosen/scene.ply']);
    await collection.acquireResource('chosen/asset/positions.webp', () => undefined); expect(acquired).toEqual(['positions.webp']);
    await snapshot.dispose(); await collection.dispose(); expect(owner.ledger.usage.bytes).toBe(0);
  });

  it('disposes unused admitted snapshots idempotently on Stay', async () => {
    const owner = account(), snapshot = snapshotSceneCollectionDrop(transfer([fileEntry('a.ply', [])]), owner.options);
    await snapshot.dispose(); await snapshot.dispose(); expect(owner.ledger.usage.bytes).toBe(0);
    await expect(acquireSceneCollectionFromDrop(snapshot, owner.options)).rejects.toThrow(/unused/);
  });

  it('joins a held actual readEntries callback on cancellation before releasing snapshot/work credits', async () => {
    const owner = account(); let complete!: (entries: Entry[]) => void, calls = 0;
    const entry: Entry = { name: 'root', isFile: false, isDirectory: true, createReader() { return { readEntries(yes) { calls++; complete = yes; } }; } };
    const snapshot = snapshotSceneCollectionDrop(transfer([entry]), owner.options);
    const acquiring = acquireSceneCollectionFromDrop(snapshot, owner.options).catch(error => error as Error);
    expect(calls).toBe(1); const retained = owner.ledger.usage.bytes;
    let disposed = false; const retiring = snapshot.dispose().then(() => { disposed = true; }); owner.cancel();
    await Promise.resolve(); expect(disposed).toBe(false); expect(owner.ledger.usage.bytes).toBe(retained);
    complete([]); expect(await acquiring).toBeInstanceOf(Error); await retiring; expect(owner.ledger.usage.bytes).toBe(0); expect(calls).toBe(1);
  });

  it('fails closed on a denied directory rather than issuing a partial collection', async () => {
    const owner = account(), reads: string[] = [];
    const denied: Entry = { name: 'denied', isFile: false, isDirectory: true, createReader() { return { readEntries(_yes, no) { no(new DOMException('Denied', 'NotAllowedError')); } }; } };
    const snapshot = snapshotSceneCollectionDrop(transfer([fileEntry('good.ply', reads), denied]), owner.options);
    await expect(acquireSceneCollectionFromDrop(snapshot, owner.options)).rejects.toThrow('Denied');
    expect(reads).toEqual([]); expect(owner.ledger.usage.bytes).toBe(0);
  });

  it('supports ordinary-file fallback when no directory entry API exists', async () => {
    const owner = account(), file = new File([], 'a.ply');
    const source = { items: [{ kind: 'file', getAsFile: () => file }] } as unknown as DataTransfer;
    const snapshot = snapshotSceneCollectionDrop(source, owner.options), collection = await acquireSceneCollectionFromDrop(snapshot, owner.options);
    expect(await collection.acquireResource('a.ply', () => undefined)).toBe(file);
    await collection.dispose(); expect(owner.ledger.usage.bytes).toBe(0);
  });

  for (const paths of [['one/a.ply', 'two/b.ply'], ['chosen/../a.ply'], ['chosen/a\\b.ply'], ['chosen/A/a.ply', 'chosen/a/b.ply'],
    ['chosen/a.ply', 'chosen/a.ply'], ['a.ply']])
    it(`refuses invalid folder acquisition ${JSON.stringify(paths)} without retained credits`, async () => {
      const owner = account(); await expect(acquireSceneCollectionFromFolderFiles(paths.map(folderFile), owner.options)).rejects.toThrow();
      expect(owner.ledger.usage.bytes).toBe(0);
    });

  it('counts directories against the entry ceiling and caps depth before queue path allocation', async () => {
    const owner = account();
    await expect(acquireSceneCollectionFromFolderFiles([folderFile('root/one/two/a.ply')], { ...owner.options, limits: { maxEntries: 2 } })).rejects.toThrow(/limit/);
    expect(owner.ledger.usage.bytes).toBe(0);
    const requests: string[] = [], deep = directory('root', [[directory('child', [[fileEntry('a.ply', [])], []], requests)], []], requests);
    const snapshot = snapshotSceneCollectionDrop(transfer([deep]), owner.options);
    await expect(acquireSceneCollectionFromDrop(snapshot, { ...owner.options, limits: { maxDepth: 1 } })).rejects.toThrow(/limit/);
    expect(requests).toEqual(['root']); expect(owner.ledger.usage.bytes).toBe(0);
  });

  it('counts every directory in an empty dropped subtree before scanning more descendants', async () => {
    const owner = account(), requests: string[] = [];
    const empty = directory('root', [[directory('child', [[directory('grandchild', [[]], requests)], []], requests)], []], requests);
    const snapshot = snapshotSceneCollectionDrop(transfer([fileEntry('a.ply', []), empty]), owner.options);
    await expect(acquireSceneCollectionFromDrop(snapshot, { ...owner.options, limits: { maxEntries: 3 } })).rejects.toThrow(/limit/);
    expect(requests).toEqual(['root', 'root', 'child']); expect(owner.ledger.usage.bytes).toBe(0);
  });

  it('fails closed when a returned directory batch changes while its entry names are captured', async () => {
    const owner = account(), batch: Entry[] = [], acquired: string[] = [], requests: string[] = [];
    const child = fileEntry('a.ply', acquired);
    Object.defineProperty(child, 'name', { get() { batch.push(fileEntry('b.ply', acquired)); return 'a.ply'; } });
    batch.push(child);
    const snapshot = snapshotSceneCollectionDrop(transfer([directory('root', [batch, []], requests)]), owner.options);
    await expect(acquireSceneCollectionFromDrop(snapshot, owner.options)).rejects.toThrow(/changed/);
    expect(requests).toEqual(['root']); expect(acquired).toEqual([]); expect(owner.ledger.usage.bytes).toBe(0);
  });

  for (const mode of ['files', 'drop'] as const)
    it(`retires a prepared ${mode} catalog when an earlier construction credit has an asynchronous release verdict`, async () => {
      const owner = account(); let admissions = 0, releases = 0;
      const options: SceneCollectionOptions = { ...owner.options, admit(bytes) {
        const first = admissions++ === 0, raw = owner.ledger.reserve('source', bytes);
        const lease = (() => {
          releases++; raw(); if (first) return Promise.reject(new Error('Async handoff retirement.'));
        }) as unknown as ResourceLease;
        lease.resize = next => raw.resize(next); return bindResourceLeaseCredit(lease, raw);
      } };
      const acquiring = mode === 'files' ? acquireSceneCollectionFromFiles([new File([], 'a.ply')], options) :
        acquireSceneCollectionFromDrop(snapshotSceneCollectionDrop(transfer([fileEntry('a.ply', [])]), options), options);
      await expect(acquiring).rejects.toThrow(/synchronously/);
      expect(releases).toBe(mode === 'files' ? 2 : 3); expect(owner.ledger.usage.bytes).toBe(0);
    });

  it('does not publish when intake is cancelled by the final construction retirement', async () => {
    const owner = account(); let admissions = 0;
    const options: SceneCollectionOptions = { ...owner.options, admit(bytes) {
      const first = admissions++ === 0, raw = owner.ledger.reserve('source', bytes), lease = (() => {
        raw(); if (first) owner.cancel();
      }) as ResourceLease;
      lease.resize = next => raw.resize(next); return bindResourceLeaseCredit(lease, raw);
    } };
    await expect(acquireSceneCollectionFromFiles([new File([], 'a.ply')], options)).rejects.toThrow('Intake cancelled.');
    expect(owner.ledger.usage.bytes).toBe(0);
  });

  it('refuses forged or already consumed drop snapshots', async () => {
    const owner = account();
    await expect(acquireSceneCollectionFromDrop({ itemCount: 1, dispose: async () => undefined }, owner.options)).rejects.toThrow(/factory-owned/);
    const snapshot = snapshotSceneCollectionDrop(transfer([fileEntry('a.ply', [])]), owner.options), collection = await acquireSceneCollectionFromDrop(snapshot, owner.options);
    await expect(acquireSceneCollectionFromDrop(snapshot, owner.options)).rejects.toThrow(/unused/);
    await collection.dispose(); expect(owner.ledger.usage.bytes).toBe(0);
  });
});
