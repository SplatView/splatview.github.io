import { describe, expect, it } from 'vitest';
import { ResourceLedger, bindResourceLeaseCredit, type ResourceLease } from '../src/document/resources';
import { assertOwnedSceneCollection, compareNaturalSceneNames, prepareSceneCollection,
  type SceneCollectionOptions, type SceneCollectionResource } from '../src/io/sceneCollection';

function account() {
  const ledger = new ResourceLedger(128 * 1024 * 1024); let current = true;
  const options: SceneCollectionOptions = { admit: bytes => ledger.reserve('source', bytes), current() { if (!current) throw new Error('Intake changed.'); } };
  return { ledger, options, cancel() { current = false; } };
}
function resource(path: string): SceneCollectionResource {
  const file = new File(['body'], path.slice(path.lastIndexOf('/') + 1));
  Object.defineProperty(file, 'arrayBuffer', { value() { throw new Error('Catalog must not read bodies.'); } });
  return { path, kind: 'file', getFile: async () => file };
}
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

describe('owned selected scene collection metadata and lazy acquisition', () => {
  it('lists six ordinary formats and each nested case-insensitive metadata candidate, retaining other resources privately', async () => {
    const owner = account(), selected = ['f.ply', 'e.spz', 'd.splat', 'c.ksplat', 'b.sog', 'a.sogs',
      'asset/Meta.JSON', 'asset/positions.webp', 'asset/extra.bin', 'other/meta.json'].map(resource);
    const collection = prepareSceneCollection(selected, owner.options);
    expect(collection.entries).toHaveLength(8);
    expect(collection.entries.filter(entry => entry.kind === 'sog-group').map(entry => entry.path)).toEqual(['asset/Meta.JSON', 'other/meta.json']);
    expect(collection.entries.some(entry => entry.path.endsWith('.webp') || entry.path.endsWith('.bin'))).toBe(false);
    expect(Object.isFrozen(collection)).toBe(true); expect(Object.isFrozen(collection.entries)).toBe(true);
    expect(collection.entries.every(Object.isFrozen)).toBe(true);
    expect(new Set(collection.entries.map(entry => entry.id)).size).toBe(8);
    assertOwnedSceneCollection(collection);
    expect((await collection.acquireResource('asset/extra.bin', () => undefined)).name).toBe('extra.bin');
    await collection.dispose(); expect(owner.ledger.usage.bytes).toBe(0);
  });

  it('does not call an unselected provider or inspect its arbitrary size/body metadata', async () => {
    const owner = account(); let reads = 0;
    const collection = prepareSceneCollection([resource('scene.ply'), { path: 'unrelated.bin', kind: 'file', getFile() {
      reads++; throw new Error('Unrelated 4+ GiB resource must remain lazy.');
    } }], owner.options);
    expect(collection.entries.map(entry => entry.path)).toEqual(['scene.ply']);
    await collection.acquireResource('scene.ply', () => undefined); expect(reads).toBe(0);
    await collection.dispose(); expect(owner.ledger.usage.bytes).toBe(0);
  });

  it('survives its intake generation and uses a fresh selected-resource guard', async () => {
    const owner = account(), collection = prepareSceneCollection([resource('asset/meta.json')], owner.options);
    owner.cancel(); assertOwnedSceneCollection(collection);
    const active = await collection.acquireResource('asset/meta.json', () => undefined); expect(active.name).toBe('meta.json');
    expect(() => collection.acquireResource('asset/meta.json', () => { throw new Error('Selection changed.'); })).toThrow('Selection changed.');
    await collection.dispose(); expect(owner.ledger.usage.bytes).toBe(0);
  });

  it('joins an actual held provider before retiring credits and rejects late publication after disposal', async () => {
    const owner = account(), hold = gate<File>(); let started = 0;
    const collection = prepareSceneCollection([{ path: 'a.ply', kind: 'file', getFile() { started++; return hold.promise; } }], owner.options);
    const loading = collection.acquireResource('a.ply', () => undefined).then(value => value, error => error as Error);
    expect(started).toBe(1); const retained = owner.ledger.usage.bytes;
    let settled = false; const disposing = collection.dispose().then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false); expect(owner.ledger.usage.bytes).toBe(retained);
    expect(() => assertOwnedSceneCollection(collection)).toThrow(/disposed/);
    hold.resolve(new File(['actual body'], 'a.ply')); expect(await loading).toBeInstanceOf(Error);
    await disposing; expect(owner.ledger.usage.bytes).toBe(0); await collection.dispose();
  });

  it('joins caller cancellation after real completion without disposing the reusable catalog', async () => {
    const owner = account(), hold = gate<File>(); let selection = true;
    const collection = prepareSceneCollection([{ path: 'a.ply', kind: 'file', getFile: () => hold.promise }], owner.options);
    const loading = collection.acquireResource('a.ply', () => { if (!selection) throw new Error('Older selection.'); }).catch(error => error as Error);
    selection = false; const bytes = owner.ledger.usage.bytes; await Promise.resolve(); expect(owner.ledger.usage.bytes).toBe(bytes);
    hold.resolve(new File([], 'a.ply')); expect(await loading).toMatchObject({ message: 'Older selection.' });
    assertOwnedSceneCollection(collection); expect((await collection.acquireResource('a.ply', () => undefined)).name).toBe('a.ply');
    await collection.dispose(); expect(owner.ledger.usage.bytes).toBe(0);
  });

  it('limits actual pending resource callbacks to four', async () => {
    const owner = account(), holds = [0, 1, 2, 3, 4].map(() => gate<File>());
    const collection = prepareSceneCollection(holds.map((hold, i) => ({ path: `${i}.ply`, kind: 'file', getFile: () => hold.promise })), owner.options);
    const reads = holds.slice(0, 4).map((_, i) => collection.acquireResource(`${i}.ply`, () => undefined));
    expect(() => collection.acquireResource('4.ply', () => undefined)).toThrow(/outstanding/);
    holds.slice(0, 4).forEach((hold, i) => hold.resolve(new File([], `${i}.ply`))); await Promise.all(reads);
    await collection.dispose(); expect(owner.ledger.usage.bytes).toBe(0);
  });

  it('captures provider ownership before a reentrant disposal and joins its completion', async () => {
    const owner = account(), hold = gate<File>(); let disposal: Promise<void> | undefined;
    let collection: ReturnType<typeof prepareSceneCollection>;
    collection = prepareSceneCollection([{ path: 'a.ply', kind: 'file', getFile() { disposal = collection.dispose(); return hold.promise; } }], owner.options);
    const loading = collection.acquireResource('a.ply', () => undefined).catch(error => error as Error);
    expect(owner.ledger.usage.bytes).toBeGreaterThan(0); hold.resolve(new File([], 'a.ply'));
    expect(await loading).toBeInstanceOf(Error); await disposal; expect(owner.ledger.usage.bytes).toBe(0);
  });

  it('refuses a provider file whose intrinsic basename changed', async () => {
    const owner = account(), collection = prepareSceneCollection([{ path: 'asset/a.ply', kind: 'file', getFile: async () => new File([], 'b.ply') }], owner.options);
    await expect(collection.acquireResource('asset/a.ply', () => undefined)).rejects.toThrow(/match/);
    expect(() => collection.acquireResource('../a.ply', () => undefined)).toThrow();
    expect(() => collection.acquireResource('missing.ply', () => undefined)).toThrow(/not acquired/);
    await collection.dispose(); expect(owner.ledger.usage.bytes).toBe(0);
  });

  for (const paths of [['a.ply', 'a.ply'], ['a.ply', 'A.ply'], ['a.ply', 'a.ply/b.ply'], ['A/a.ply', 'a/b.ply'],
    ['/a.ply'], ['a\\b.ply'], ['C:/a.ply'], ['https://example.test/a.ply'], ['a/../b.ply'], ['a/\ud800.ply']])
    it(`refuses ambiguous or noncanonical paths ${JSON.stringify(paths)} without leaked credits`, () => {
      const owner = account(); expect(() => prepareSceneCollection(paths.map(resource), owner.options)).toThrow(); expect(owner.ledger.usage.bytes).toBe(0);
    });

  it('preserves Unicode spelling and keeps deterministic basename/full-path ties', async () => {
    const owner = account(), collection = prepareSceneCollection(['other/meta.json', 'asset/meta.json', 'e\u0301.ply', 'é.ply'].map(resource), owner.options);
    expect(collection.entries.map(entry => entry.path)).toEqual(['e\u0301.ply', 'asset/meta.json', 'other/meta.json', 'é.ply']);
    await collection.dispose();
  });

  for (const limits of [{ maxEntries: 1 }, { maxPathUnits: 4 }, { maxPathComponents: 1 }, { maxDepth: 1 }])
    it(`refuses tightened census ${JSON.stringify(limits)} before issuing a partial catalog`, () => {
      const owner = account(); expect(() => prepareSceneCollection([resource('a/b.ply'), resource('c.ply')], { ...owner.options, limits })).toThrow();
      expect(owner.ledger.usage.bytes).toBe(0);
    });

  it('counts implicit parent directories even when a provider-only caller omits directory rows', () => {
    const owner = account();
    expect(() => prepareSceneCollection([resource('asset/a.ply')], { ...owner.options, limits: { maxEntries: 1 } })).toThrow(/directories/);
    expect(owner.ledger.usage.bytes).toBe(0);
  });

  it('refuses an intake that expands after admission instead of exceeding the entry census', () => {
    const owner = account(), resources = [resource('a.ply')];
    expect(() => prepareSceneCollection(resources, { ...owner.options, limits: { maxEntries: 1 }, admit(bytes) {
      const lease = owner.ledger.reserve('source', bytes); resources.push(resource('b.ply')); return lease;
    } })).toThrow(/changed/);
    expect(owner.ledger.usage.bytes).toBe(0);
  });

  for (const directories of [['empty', 'empty'], ['Empty', 'empty'], ['Asset']])
    it(`refuses duplicate or case-aliased directory rows ${JSON.stringify(directories)}`, () => {
      const owner = account(), resources: SceneCollectionResource[] = [resource('asset/a.ply'),
        ...directories.map(path => ({ path, kind: 'directory' as const }))];
      expect(() => prepareSceneCollection(resources, owner.options)).toThrow(/[Dd]uplicate|[Cc]ase-aliased/);
      expect(owner.ledger.usage.bytes).toBe(0);
    });

  it('counts a wholly empty directory subtree against the same entry census as files', () => {
    const owner = account();
    expect(() => prepareSceneCollection([resource('a.ply'), { path: 'empty', kind: 'directory' },
      { path: 'empty/child', kind: 'directory' }], { ...owner.options, limits: { maxEntries: 2 } })).toThrow(/entry count/);
    expect(owner.ledger.usage.bytes).toBe(0);
  });

  it('requires factory authority and genuine independently owned credits', async () => {
    const fake = Object.freeze({ get entries() { throw new Error('Must not inspect a forged collection.'); } });
    expect(() => assertOwnedSceneCollection(fake)).toThrow(/factory-owned/);
    const owner = account(); let original: ResourceLease | undefined;
    const options = { ...owner.options, admit(bytes: number) { return original ??= owner.ledger.reserve('source', bytes); } };
    const collection = prepareSceneCollection([resource('a.ply')], options);
    const wrapper = (() => original!()) as ResourceLease; wrapper.resize = bytes => original!.resize(bytes); bindResourceLeaseCredit(wrapper, original!);
    expect(() => prepareSceneCollection([resource('b.ply')], { ...owner.options, admit: () => wrapper })).toThrow(/reused/);
    assertOwnedSceneCollection(collection); expect(owner.ledger.usage.bytes).toBeGreaterThan(0);
    await collection.dispose(); expect(owner.ledger.usage.bytes).toBe(0);
  });

  it('refuses async intake/selection guards instead of publishing before their verdict', async () => {
    const owner = account();
    expect(() => prepareSceneCollection([resource('a.ply')], { ...owner.options, current: async () => undefined })).toThrow(/synchronously/);
    expect(owner.ledger.usage.bytes).toBe(0);
    const collection = prepareSceneCollection([resource('a.ply')], owner.options);
    expect(() => collection.acquireResource('a.ply', async () => undefined)).toThrow(/synchronously/);
    await collection.dispose(); expect(owner.ledger.usage.bytes).toBe(0);
  });

  it('drains and refuses a thenable admission after capturing its genuine credit', () => {
    const owner = account(); let drained = 0;
    expect(() => prepareSceneCollection([resource('a.ply')], { ...owner.options, admit(bytes) {
      const raw = owner.ledger.reserve('source', bytes), lease = (() => raw()) as ResourceLease;
      lease.resize = next => raw.resize(next); bindResourceLeaseCredit(lease, raw);
      Object.defineProperty(lease, 'then', { value(_yes: unknown, no: (error: Error) => void) { drained++; no(new Error('Async admission.')); } });
      return lease;
    } })).toThrow(/synchronously/);
    expect(drained).toBe(1); expect(owner.ledger.usage.bytes).toBe(0);
  });

  it('refuses a resize that reserves genuine credit synchronously but returns a rejected promise', () => {
    const owner = account();
    expect(() => prepareSceneCollection([resource('a.ply')], { ...owner.options, admit(bytes) {
      const raw = owner.ledger.reserve('source', bytes), lease = (() => raw()) as ResourceLease;
      lease.resize = next => { raw.resize(next); return Promise.reject(new Error('Async resize.')); };
      return bindResourceLeaseCredit(lease, raw);
    } })).toThrow(/synchronously/);
    expect(owner.ledger.usage.bytes).toBe(0);
  });

  it('joins its actual provider before refusing an asynchronous retirement verdict', async () => {
    const owner = account(), hold = gate<File>(); let releases = 0;
    const collection = prepareSceneCollection([{ path: 'a.ply', kind: 'file', getFile: () => hold.promise }], {
      ...owner.options, admit(bytes) {
        const raw = owner.ledger.reserve('source', bytes), lease = (() => {
          releases++; raw(); return Promise.reject(new Error('Async retirement.'));
        }) as unknown as ResourceLease;
        lease.resize = next => raw.resize(next); return bindResourceLeaseCredit(lease, raw);
      },
    });
    const loading = collection.acquireResource('a.ply', () => undefined).catch(error => error as Error);
    const retirement = collection.dispose().catch(error => error as Error);
    await Promise.resolve(); expect(releases).toBe(0); expect(owner.ledger.usage.bytes).toBeGreaterThan(0);
    hold.resolve(new File([], 'a.ply')); expect(await loading).toBeInstanceOf(Error);
    expect(await retirement).toMatchObject({ message: 'Source ownership hooks must complete synchronously.' });
    expect(releases).toBe(1); expect(owner.ledger.usage.bytes).toBe(0);
  });
});

describe('portable natural scene order', () => {
  for (const [left, right] of [['asset2.ply', 'asset10.ply'], ['a1.ply', 'a01.ply'], ['a01.ply', 'a001.ply'],
    ['a999999999999999999999.ply', 'a1000000000000000000000.ply'], ['A2.ply', 'a2.ply'], ['a2.ply', 'A10.ply'], ['\ue000', '\u{10000}']])
    it(`${left} precedes ${right}`, () => { expect(compareNaturalSceneNames(left, right)).toBeLessThan(0); expect(compareNaturalSceneNames(right, left)).toBeGreaterThan(0); });
});
