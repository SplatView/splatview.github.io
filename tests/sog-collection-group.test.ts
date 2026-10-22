import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MiB, ResourceLedger } from '../src/document/resources';
import { NATIVE_LOAD_BUDGET_BYTES } from '../src/document/sceneInputLimits';
import { groupWorkerBytes, type GroupSourceDescriptor } from '../src/document/sourceGroup';
import { compareUtf8Paths } from '../src/io/paths';
import { MAX_SOURCE_READ_BYTES } from '../src/io/readBroker';
import { prepareSceneCollection, type OwnedSceneCollection, type SceneCollectionResource } from '../src/io/sceneCollection';
import { assertPreparedSogGroup, MAX_SOG_GROUP_METADATA_BYTES,
  prepareSogCollectionGroup, prepareSogGroup, type PreparedSogGroup } from '../src/io/sogGroup';
import { stageGroupSourceInput } from '../src/workers/groupSourceInput';
import { GroupHashModule } from './fixtures/group-source';

// This suite qualifies acquisition, original-byte identity and wire staging.
// The hash module is a transport double, with no Gaussian/WebP numerical claim.
const names = ['appearance.webp', 'declared-extra.bin', 'positions-high.webp', 'positions-low.webp', 'rotations.webp'];
const collections: OwnedSceneCollection[] = [], groups: PreparedSogGroup[] = [], ledgers: ResourceLedger[] = [];
function ledger() { const value = new ResourceLedger(256 * MiB); ledgers.push(value); return value; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function owner() {
  const budget = ledger(); let current = true;
  return { budget, cancel() { current = false; }, options: { admit: (bytes: number) => budget.reserve('source', bytes),
    current() { if (!current) throw new DOMException('The selected source changed.', 'AbortError'); } } };
}
function collection(resources: SceneCollectionResource[]) {
  const budget = ledger(), value = prepareSceneCollection(resources, { admit: bytes => budget.reserve('source', bytes), current() {} });
  collections.push(value); return { value, budget };
}
function watchedFile(name: string, bytes: Uint8Array | string) {
  const file = new File([typeof bytes === 'string' ? bytes : new Uint8Array(bytes)], name), ranges: number[][] = [];
  const slice = file.slice;
  Object.defineProperty(file, 'slice', { value(start: number, end: number) { ranges.push([start, end]); return slice.call(file, start, end); } });
  return { file, ranges };
}
function resource(path: string, file: File) {
  const getFile = vi.fn(async () => file);
  return { path, kind: 'file' as const, getFile };
}
function packet(version: 1 | 2, degree: 0 | 1 | 2 | 3, root = 'selected-root', referencePrefix = '../shared/') {
  const fixture = degree === 0 ? `tests/fixtures/sog-group-v${version}/collection/asset` :
    `tests/fixtures/sog-group-sh/packets/v${version}-sh${degree}/collection/asset`;
  const files = degree === 0 ? names : [...names, 'centroids.webp', 'labels.webp'];
  const original = readFileSync(`${fixture}/meta.json`, 'utf8');
  let text = original;
  // Substitute only original filename tokens. Original numeric lexemes,
  // including signed zeros, remain unchanged.
  for (const name of files) text = text.replaceAll(`"${name}"`, `"${referencePrefix}${name}"`);
  const primaryPath = `${root}/asset/meta.json`, primary = watchedFile('meta.json', text);
  const textures = files.map(name => ({ name, ...watchedFile(name, new Uint8Array(readFileSync(`${fixture}/${name}`))) }));
  const resources = [resource(primaryPath, primary.file), ...textures.map(item => resource(`${root}/shared/${item.name}`, item.file))];
  return { primaryPath, primary, textures, resources, text };
}
async function prepare(value: OwnedSceneCollection, path: string, owned = owner()) {
  const group = await prepareSogCollectionGroup(value, path, owned.options); groups.push(group); return { group, owned };
}
async function originalBytes(group: PreparedSogGroup) {
  return new Map(await Promise.all(group.sources.map(async item => [item.resourceId, new Uint8Array(await item.blob.arrayBuffer())] as const)));
}
function independentKey(source: GroupSourceDescriptor, bytes: ReadonlyMap<string, Uint8Array>, prefix: string) {
  const count = Buffer.alloc(4); count.writeUInt32BE(source.resources.length);
  const chunks = [Buffer.from('SplatViewSource\0v1\0', 'ascii'), Buffer.from([1]), count];
  for (const resource of [...source.resources].sort((a, b) => compareUtf8Paths(a.path, b.path))) {
    const path = Buffer.from(resource.path.slice(prefix.length), 'utf8'), framing = Buffer.alloc(5), length = Buffer.alloc(8);
    framing[0] = resource.role === 'primary' ? 1 : 0; framing.writeUInt32BE(path.length, 1); length.writeBigUInt64BE(BigInt(resource.byteLength));
    chunks.push(framing, path, length, createHash('sha256').update(bytes.get(resource.resourceId)!).digest());
  }
  return createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
}
async function stage(group: PreparedSogGroup, bytes: Map<string, Uint8Array>) {
  const source = group.descriptor, budget = new ResourceLedger(groupWorkerBytes(source)), module = new GroupHashModule();
  ledgers.push(budget);
  const value = await stageGroupSourceInput(module, source, { current() {}, admit: amount => budget.reserve('source', amount),
    async read(id, offset, length) {
      let live = true;
      return { bytes: bytes.get(id)!.slice(offset, offset + length).buffer,
        consume() { expect(live).toBe(true); live = false; }, release() { live = false; } };
    } });
  return { value, module, budget };
}
afterEach(async () => {
  for (const group of groups.splice(0)) group.dispose();
  for (const value of collections.splice(0)) await value.dispose();
  for (const value of ledgers.splice(0)) { expect(value.usage.bytes).toBe(0); expect(value.usage.allocations).toBe(0); }
  vi.restoreAllMocks();
});

describe('owned nested unpacked SOG acquisition and original graph staging', () => {
  it('matches the independent literal mixed-directory META.JSON key before and after an outer-root rename', async () => {
    const base = 'tests/fixtures/scene-collection-nested-v1', expected = JSON.parse(readFileSync(`${base}/expected-source-key.json`, 'utf8')) as {
      primaryPath: string; resourceCount: number; totalBytes: number; assetDigest: string;
      resources: { path: string; bytes: number; sha256: string; role: 'primary' | 'referenced' }[];
    };
    for (const root of ['', 'renamed-selected-root/']) {
      const files = expected.resources.map(item => ({ ...item,
        ...watchedFile(item.path.split('/').at(-1)!, new Uint8Array(readFileSync(`${base}/collection/${item.path}`))) }));
      const unrelated = vi.fn(async () => { throw new Error('Unrelated literal fixture resource was acquired.'); });
      const catalog = collection([...files.map(item => resource(root + item.path, item.file)),
        { path: root + 'private/unrelated-neighbor.bin', kind: 'file', getFile: unrelated }]);
      const { group } = await prepare(catalog.value, root + expected.primaryPath), bytes = await originalBytes(group);
      expect(group.descriptor.resources.map(item => item.path)).toEqual(expected.resources.map(item => root + item.path));
      expect(group.descriptor.byteLength).toBe(expected.totalBytes); expect(group.shDegree).toBe(3);
      for (const item of group.descriptor.resources) {
        const oracle = expected.resources.find(resource => root + resource.path === item.path)!;
        expect(item.byteLength).toBe(oracle.bytes);
        expect(createHash('sha256').update(bytes.get(item.resourceId)!).digest('hex')).toBe(oracle.sha256);
      }
      const staged = await stage(group, bytes);
      try {
        expect(staged.value.summary).toMatchObject({ resourceCount: expected.resourceCount, totalBytes: expected.totalBytes });
        expect(Buffer.from(staged.value.assetDigest).toString('hex')).toBe(expected.assetDigest);
        expect(independentKey(group.descriptor, bytes, root)).toBe(expected.assetDigest);
      } finally { staged.value.dispose(); }
      expect(unrelated).not.toHaveBeenCalled(); expect(files.slice(1).every(item => item.ranges.length === 0)).toBe(true);
    }
  });

  for (const version of [1, 2] as const) for (const degree of [0, 1, 2, 3] as const)
    it(`authenticates nested v${version} SH${degree} and stages its rebased complete original key`, async () => {
      const input = packet(version, degree), catalog = collection(input.resources), { group } = await prepare(catalog.value, input.primaryPath);
      assertPreparedSogGroup(group);
      expect(Object.isFrozen(group)).toBe(true); expect(Object.isFrozen(group.descriptor)).toBe(true);
      expect(Object.isFrozen(group.descriptor.resources)).toBe(true); expect(Object.isFrozen(group.sources)).toBe(true);
      expect(group.descriptor.resources.every(Object.isFrozen)).toBe(true); expect(group.sources.every(Object.isFrozen)).toBe(true);
      expect(group.descriptor.path).toBe(input.primaryPath); expect(group.descriptor.resources[0].path).toBe(input.primaryPath);
      expect(group.descriptor.resources.slice(1).map(item => item.path)).toEqual(input.resources.slice(1).map(item => item.path).sort(compareUtf8Paths));
      expect(group.shDegree).toBe(version === 1 && degree > 0 ? null : degree); expect(group.version).toBe(version); expect(group.sourceCount).toBe(3);
      expect(input.resources.every(item => item.getFile.mock.calls.length === 1)).toBe(true);
      expect(input.primary.ranges).toEqual([[0, input.primary.file.size]]); expect(input.textures.every(item => item.ranges.length === 0)).toBe(true);
      const bytes = await originalBytes(group);
      expect(new TextDecoder().decode(bytes.get(group.descriptor.resourceId))).toBe(input.text);
      const staged = await stage(group, bytes);
      try {
        expect(Buffer.from(staged.value.assetDigest).toString('hex')).toBe(independentKey(group.descriptor, bytes, 'selected-root/'));
        expect(staged.value.shDegree).toBe(group.shDegree); expect(staged.value.sourceCount).toBe(3);
        expect(Buffer.from(staged.module.HEAPU8.slice(staged.value.pointer, staged.value.pointer + staged.value.byteLength)))
          .toEqual(Buffer.concat([...group.descriptor.resources, group.descriptor.decoder].map(item => Buffer.from(bytes.get(item.resourceId)!))));
      } finally { staged.value.dispose(); }
    });

  it('reads only the chosen metadata and unique declarations, including aliases/extras but no unrelated multi-GiB provider', async () => {
    const input = packet(2, 0), metadata = JSON.parse(input.text);
    metadata.means.files.push('../shared/./declared-extra.bin');
    metadata.scales.files.push('..\\shared\\declared-extra.bin');
    const primary = watchedFile('meta.json', JSON.stringify(metadata)); input.resources[0] = resource(input.primaryPath, primary.file);
    const otherMetadata = vi.fn(async () => { throw new Error('Unselected metadata must stay unread.'); });
    const hugeNeighbor = vi.fn(async () => { throw new Error('An unrelated 5-GiB neighbor must never be acquired or sized.'); });
    const catalog = collection([...input.resources, { path: 'selected-root/other/meta.json', kind: 'file', getFile: otherMetadata },
      { path: 'selected-root/other/huge.bin', kind: 'file', getFile: hugeNeighbor }]);
    expect(catalog.value.entries.filter(item => item.kind === 'sog-group')).toHaveLength(2);
    const { group } = await prepare(catalog.value, input.primaryPath);
    expect(otherMetadata).not.toHaveBeenCalled(); expect(hugeNeighbor).not.toHaveBeenCalled();
    expect(input.resources.every(item => item.getFile.mock.calls.length === 1)).toBe(true);
    expect(group.descriptor.resources).toHaveLength(6);
    expect(group.descriptor.byteLength).toBe(primary.file.size + input.textures.reduce((sum, item) => sum + item.file.size, 0));
    group.dispose(); catalog.value.assertCurrent();
    expect(input.textures.every(item => item.ranges.length === 0)).toBe(true);
  });

  it('retains flat selected-files behavior without reading an unrelated neighbor body or its shadowed size', async () => {
    const input = packet(2, 0, 'root', ''), unrelated = new File(['unrelated'], 'unrelated.bin');
    const size = vi.fn(() => { throw new Error('Unrelated shadowed size must not be consulted.'); });
    Object.defineProperty(unrelated, 'size', { get: size });
    const slice = vi.spyOn(unrelated, 'slice'), owned = owner();
    const group = await prepareSogGroup([input.primary.file, ...input.textures.map(item => item.file), unrelated], owned.options);
    groups.push(group);
    expect(group.descriptor.path).toBe('meta.json'); expect(group.descriptor.resources).toHaveLength(6);
    expect(group.descriptor.resources.some(item => item.path === 'unrelated.bin')).toBe(false);
    expect(group.sources.some(item => item.blob === unrelated)).toBe(false); expect(slice).not.toHaveBeenCalled(); expect(size).not.toHaveBeenCalled();
  });

  it('removes only the common selected root from the key while retaining acquisition paths in the DTO', async () => {
    const keys: string[] = [];
    for (const root of ['original-name', 'renamed-root']) {
      const input = packet(2, 3, root), catalog = collection(input.resources), { group } = await prepare(catalog.value, input.primaryPath);
      const bytes = await originalBytes(group), staged = await stage(group, bytes);
      try { keys.push(Buffer.from(staged.value.assetDigest).toString('hex')); expect(keys.at(-1)).toBe(independentKey(group.descriptor, bytes, `${root}/`)); }
      finally { staged.value.dispose(); }
    }
    expect(keys[0]).toBe(keys[1]);
  });

  it('includes original reference spelling in identity even when rewritten aliases are byte-identical', async () => {
    const keys: string[] = [], rewritten: Uint8Array[] = [];
    for (const prefix of ['../shared/', '../shared/./']) {
      const input = packet(2, 0, 'root', prefix), catalog = collection(input.resources), { group } = await prepare(catalog.value, input.primaryPath);
      const bytes = await originalBytes(group), staged = await stage(group, bytes);
      try {
        keys.push(Buffer.from(staged.value.assetDigest).toString('hex'));
        rewritten.push(bytes.get(group.descriptor.decoder.resourceId)!);
        expect(keys.at(-1)).toBe(independentKey(group.descriptor, bytes, 'root/'));
      } finally { staged.value.dispose(); }
    }
    expect(rewritten[0]).toEqual(rewritten[1]); expect(keys[0]).not.toBe(keys[1]);
  });

  it('authenticates an in-root parent-and-back alias even when all final resources share the primary directory', async () => {
    const input = packet(1, 0, 'root', '../asset/');
    const resources = input.resources.map(item => ({ ...item, path: item.path.replace('/shared/', '/asset/') }));
    const catalog = collection(resources), { group } = await prepare(catalog.value, input.primaryPath);
    const bytes = await originalBytes(group), staged = await stage(group, bytes);
    try { expect(Buffer.from(staged.value.assetDigest).toString('hex')).toBe(independentKey(group.descriptor, bytes, 'root/asset/')); }
    finally { staged.value.dispose(); }
  });

  it.each(['Meta.JSON', 'META.JSON'])('keeps UTF-8 ordering and authenticates the actual %s metadata basename', async basename => {
    const input = packet(1, 0), metadata = JSON.parse(input.text);
    metadata.quats.files.push('../shared/\ue000.bin', '../shared/\u{10000}.bin');
    const path = input.primaryPath.replace('meta.json', basename);
    input.resources[0] = resource(path, new File([JSON.stringify(metadata)], basename));
    const catalog = collection([...input.resources, resource('selected-root/shared/\u{10000}.bin', new File(['a'], '\u{10000}.bin')),
      resource('selected-root/shared/\ue000.bin', new File(['b'], '\ue000.bin'))]);
    const { group } = await prepare(catalog.value, path);
    expect(group.descriptor.path).toBe(path); expect(group.descriptor.resources.slice(-2).map(item => item.path))
      .toEqual(['selected-root/shared/\ue000.bin', 'selected-root/shared/\u{10000}.bin']);
    const bytes = await originalBytes(group), staged = await stage(group, bytes);
    try { expect(Buffer.from(staged.value.assetDigest).toString('hex')).toBe(independentKey(group.descriptor, bytes, 'selected-root/')); }
    finally { staged.value.dispose(); }
  });

  it('reads a nested metadata snapshot only through sequential ranges of at most one MiB', async () => {
    const input = packet(2, 0), primary = watchedFile('meta.json', input.text + ' '.repeat(2 * MiB));
    input.resources[0] = resource(input.primaryPath, primary.file);
    const catalog = collection(input.resources), { group } = await prepare(catalog.value, input.primaryPath);
    expect(primary.ranges).toEqual([[0, MAX_SOURCE_READ_BYTES], [MAX_SOURCE_READ_BYTES, 2 * MAX_SOURCE_READ_BYTES],
      [2 * MAX_SOURCE_READ_BYTES, primary.file.size]]);
    expect(await group.sources.find(item => item.resourceId === group.descriptor.resourceId)!.blob.text())
      .toBe(input.text + ' '.repeat(2 * MiB));
    expect(input.textures.every(item => item.ranges.length === 0)).toBe(true);
  });

  it('refuses oversized nested original metadata before the first slice or a resource provider', async () => {
    const input = packet(2, 0), primary = new File([new Blob(Array(17).fill(new Blob([new Uint8Array(MiB)])))], 'meta.json');
    const slice = vi.spyOn(primary, 'slice'); input.resources[0] = resource(input.primaryPath, primary);
    const catalog = collection(input.resources), owned = owner();
    await expect(prepareSogCollectionGroup(catalog.value, input.primaryPath, owned.options)).rejects.toThrow(/16 MiB/);
    expect(slice).not.toHaveBeenCalled(); expect(input.resources.slice(1).every(item => item.getFile.mock.calls.length === 0)).toBe(true);
    expect(owned.budget.usage.bytes).toBe(0);
  });

  it('refuses nested decoder expansion beyond sixteen MiB before retaining output arrays', async () => {
    const input = packet(2, 0), metadata = JSON.parse(input.text), shortNames = ['a', 'b', 'c', 'd', 'e'];
    metadata.means.files = shortNames.slice(0, 2); metadata.scales.files = [shortNames[2]];
    metadata.quats.files = [shortNames[3]]; metadata.sh0.files = [shortNames[4]];
    const text = JSON.stringify(metadata), primary = watchedFile('meta.json', text + ' '.repeat(MAX_SOG_GROUP_METADATA_BYTES - text.length));
    const files = shortNames.map(name => watchedFile(name, name)), catalog = collection([
      resource(input.primaryPath, primary.file), ...files.map(item => resource(`selected-root/asset/${item.file.name}`, item.file))]);
    const owned = owner();
    await expect(prepareSogCollectionGroup(catalog.value, input.primaryPath, owned.options)).rejects.toThrow(/rewritten metadata exceeds/);
    expect(files.every(item => item.ranges.length === 0)).toBe(true); expect(owned.budget.usage.bytes).toBe(0);
  });

  it('counts declared aliases once and requires decode headroom beyond rewritten metadata and the native descriptor', async () => {
    const input = packet(2, 0), metadata = JSON.parse(input.text);
    metadata.means.files.push('../shared/large.bin', '../shared/./large.bin'); metadata.quats.files.push('..\\shared\\large.bin');
    const primary = watchedFile('meta.json', JSON.stringify(metadata)), otherBytes = primary.file.size + input.textures.reduce((sum, item) => sum + item.file.size, 0);
    // Calibrate only the bounded rewrite length; the independent stage oracle
    // below charges all original bytes, the rewrite and 20 + 4 * (N - 1) descriptor bytes.
    const probe = collection([resource(input.primaryPath, primary.file), ...input.resources.slice(1),
      resource('selected-root/shared/large.bin', new File(['x'], 'large.bin'))]);
    const { group: prepared } = await prepare(probe.value, input.primaryPath);
    const decoderBytes = prepared.descriptor.decoder.byteLength,
      descriptorBytes = 20 + 4 * (prepared.descriptor.resources.length - 1);
    prepared.dispose();
    const large = new Blob(Array(512).fill(new Blob([new Uint8Array(MiB)])));
    for (const headroom of [1, 0, -1]) {
      const originalBytes = NATIVE_LOAD_BUDGET_BYTES - headroom - decoderBytes - descriptorBytes;
      const extra = new File([large.slice(0, originalBytes - otherBytes)], 'large.bin'), slice = vi.spyOn(extra, 'slice');
      const catalog = collection([resource(input.primaryPath, primary.file), ...input.resources.slice(1), resource('selected-root/shared/large.bin', extra)]);
      const owned = owner();
      expect(originalBytes).toBeLessThan(NATIVE_LOAD_BUDGET_BYTES);
      if (headroom === 1) {
        const { group } = await prepare(catalog.value, input.primaryPath, owned);
        expect(group.descriptor.byteLength).toBe(originalBytes);
        expect(group.descriptor.byteLength + group.descriptor.decoder.byteLength + descriptorBytes).toBe(NATIVE_LOAD_BUDGET_BYTES - 1);
        expect(group.descriptor.resources.filter(item => item.path.endsWith('/large.bin'))).toHaveLength(1);
      } else {
        await expect(prepareSogCollectionGroup(catalog.value, input.primaryPath, owned.options))
          .rejects.toThrow('The scene source does not fit within the available decode memory budget.');
        expect(owned.budget.usage.bytes).toBe(0);
      }
      expect(slice).not.toHaveBeenCalled();
    }
  });

  it.each(['../../../outside.webp', '/outside.webp', 'https://example.test/a.webp', '../shared/MISSING.webp', '../shared/Appearance.webp', 'meta.json'])
    ('refuses a bad declaration %s before any texture body read', async reference => {
      const input = packet(2, 0), metadata = JSON.parse(input.text); metadata.means.files[0] = reference;
      input.resources[0] = resource(input.primaryPath, new File([JSON.stringify(metadata)], 'meta.json'));
      const catalog = collection(input.resources), owned = owner();
      await expect(prepareSogCollectionGroup(catalog.value, input.primaryPath, owned.options)).rejects.toThrow();
      expect(input.textures.every(item => item.ranges.length === 0)).toBe(true);
      // References resolve completely before any body read. Missing providers
      // can be discovered after earlier getFiles; those remain metadata-only.
      expect(owned.budget.usage.bytes).toBe(0);
    });

  it('refuses an unauthenticated collection without invoking duck-typed hooks', async () => {
    const hook = vi.fn(), forged = { entries: [], assertCurrent: hook, acquireResource: hook, dispose: hook } as unknown as OwnedSceneCollection;
    await expect(prepareSogCollectionGroup(forged, 'asset/meta.json', owner().options)).rejects.toThrow(/factory-owned/);
    expect(hook).not.toHaveBeenCalled();
  });

  it('refuses a nonmetadata primary without calling its provider or parsing another catalog candidate', async () => {
    const input = packet(2, 0), catalog = collection(input.resources), owned = owner();
    await expect(prepareSogCollectionGroup(catalog.value, 'selected-root/shared/appearance.webp', owned.options)).rejects.toThrow(/basename/);
    expect(input.resources.every(item => item.getFile.mock.calls.length === 0)).toBe(true);
    await expect(prepareSogCollectionGroup(catalog.value, 'selected-root/absent/meta.json', owned.options)).rejects.toThrow(/not acquired/);
    expect(owned.budget.usage.bytes).toBe(0);
  });

  it.each(['primary', 'referenced'] as const)('joins a held actual %s getFile before releasing cancelled acquisition credits', async kind => {
    const input = packet(2, 0), held = deferred<File>(), entered = deferred<void>();
    const index = kind === 'primary' ? 0 : 1, chosen = input.resources[index]!;
    const resources: SceneCollectionResource[] = input.resources.map((item, i) => i !== index ? item :
      { ...item, getFile: () => { entered.resolve(); return held.promise; } });
    const catalog = collection(resources), owned = owner();
    let settled = false;
    const pending = prepareSogCollectionGroup(catalog.value, input.primaryPath, owned.options);
    void pending.then(() => { settled = true; }, () => { settled = true; });
    const refusal = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await entered.promise; owned.cancel(); await Promise.resolve();
    expect(settled).toBe(false); expect(owned.budget.usage.bytes).toBeGreaterThan(0);
    held.resolve(await chosen.getFile()); await refusal;
    expect(owned.budget.usage.bytes).toBe(0); catalog.value.assertCurrent();
  });

  it('joins collection retirement and a held resource before releasing either owner', async () => {
    const input = packet(1, 0), held = deferred<File>(), entered = deferred<void>();
    const resources: SceneCollectionResource[] = input.resources.map((item, index) => index !== 1 ? item :
      { ...item, getFile: () => { entered.resolve(); return held.promise; } });
    const catalog = collection(resources), owned = owner(), pending = prepareSogCollectionGroup(catalog.value, input.primaryPath, owned.options);
    const refusal = expect(pending).rejects.toThrow(/disposed/);
    await entered.promise; const retirement = catalog.value.dispose(); await Promise.resolve();
    expect(owned.budget.usage.bytes).toBeGreaterThan(0); expect(catalog.budget.usage.bytes).toBeGreaterThan(0);
    held.resolve(input.textures[0]!.file); await refusal; await retirement;
    expect(owned.budget.usage.bytes).toBe(0); expect(catalog.budget.usage.bytes).toBe(0);
  });
});
