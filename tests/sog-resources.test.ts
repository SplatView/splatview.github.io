import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AdmissionError, bindResourceLeaseCredit, ResourceLedger, type ResourceLease } from '../src/document/resources';
import { parseSogMetadata, type PreparedSogMetadata } from '../src/io/sogMetadata';
import {
  prepareSogCatalog, prepareSogResources, SOG_CATALOG_LIMITS,
  type AcquiredSogResource, type PreparedSogCatalog, type PreparedSogResources,
  type SogResourceOptions,
} from '../src/io/sogResources';

function ownership(limit = 32 * 1024 * 1024) {
  const ledger = new ResourceLedger(limit);
  const admissions: number[] = [], resizes: number[] = [];
  let current = true, releases = 0;
  const options: SogResourceOptions = {
    current() { if (!current) throw new Error('Candidate no longer current.'); },
    admit(bytes) {
      admissions.push(bytes);
      const lease = ledger.reserve('source', bytes);
      const wrapped = (() => { releases++; lease(); }) as ResourceLease;
      Object.defineProperty(wrapped, 'bytes', { get: () => lease.bytes });
      wrapped.resize = bytes => { resizes.push(bytes); lease.resize(bytes); };
      return bindResourceLeaseCredit(wrapped, lease);
    },
  };
  return { ledger, options, admissions, resizes, get releases() { return releases; }, cancel() { current = false; } };
}
function resource(acquisitionPath: string, byteLength = 1, resourceId = acquisitionPath): AcquiredSogResource {
  return { acquisitionPath, byteLength, resourceId };
}
function document(overrides: Record<string, unknown> = {}) {
  return {
    version: 2, count: 1,
    means: { files: ['lo.webp', 'hi.webp'], mins: [0, 0, 0], maxs: [1, 1, 1] },
    scales: { files: ['scale.webp'], codebook: [0] },
    quats: { files: ['quat.webp'] },
    sh0: { files: ['color.webp'], codebook: [0] },
    ...overrides,
  };
}
function metadata(value: Record<string, unknown> = document()) {
  const owner = ownership(), bytes = new TextEncoder().encode(JSON.stringify(value));
  const prepared = parseSogMetadata(bytes, owner.options);
  return { owner, bytes, prepared };
}
const BASIC = ['lo.webp', 'hi.webp', 'scale.webp', 'quat.webp', 'color.webp'];
function fixture(value = document(), prefix = '') {
  const parsed = metadata(value), catalogOwner = ownership(), graphOwner = ownership();
  const primaryPath = `${prefix}meta.json`;
  const catalog = prepareSogCatalog([
    resource(primaryPath, parsed.bytes.byteLength, 'primary'),
    ...BASIC.map((path, index) => resource(`${prefix}${path}`, index + 1, `texture-${index}`)),
    resource(`${prefix}unrelated.bin`, 999, 'neighbor'),
  ], catalogOwner.options);
  return {
    ...parsed, catalogOwner, graphOwner, catalog, primaryPath,
    graph() { return prepareSogResources(parsed.prepared, primaryPath, catalog, graphOwner.options); },
    dispose(graph?: PreparedSogResources) { graph?.dispose(); catalog.dispose(); parsed.prepared.dispose(); },
  };
}
function cleanup(metadata: PreparedSogMetadata, catalog?: PreparedSogCatalog, graph?: PreparedSogResources) {
  graph?.dispose(); catalog?.dispose(); metadata.dispose();
}

test('catalog privately snapshots scalar descriptors and never reads resource bodies', () => {
  const owner = ownership(), input = [resource('folder/a', 3, 'a')];
  let pathReads = 0, sizeReads = 0, idReads = 0, lengthReads = 0;
  Object.defineProperties(input[0], {
    acquisitionPath: { get() { pathReads++; assert.ok(owner.admissions.length); return pathReads === 1 ? 'folder/a' : '../bad'; } },
    byteLength: { get() { sizeReads++; return sizeReads === 1 ? 3 : -1; } },
    resourceId: { get() { idReads++; return idReads === 1 ? 'a' : 'changed'; } },
    bytes: { get() { throw new Error('No file body access is authorized.'); } },
  });
  const array = new Proxy(input, { get(target, key, receiver) {
    if (key === 'length') { lengthReads++; return lengthReads === 1 ? 1 : 100; }
    if (key === Symbol.iterator) throw new Error('Do not use the acquisition iterator.');
    return Reflect.get(target, key, receiver);
  } });
  const catalog = prepareSogCatalog(array, owner.options);
  assert.deepEqual([pathReads, sizeReads, idReads, lengthReads], [1, 1, 1, 1]);
  const entry = catalog.lookup('folder/a')!;
  assert.deepEqual(entry, resource('folder/a', 3, 'a'));
  assert.ok(Object.isFrozen(entry)); assert.ok(Object.isFrozen(catalog)); assert.ok(Object.isFrozen(catalog.stats));
  assert.equal(catalog.lookup('absent'), undefined);
  assert.equal(catalog.totalBytes, 3); assert.equal(catalog.resourceCount, 1);
  assert.equal(catalog.stats.catalogBytes, owner.ledger.usage.bytes);
  assert.equal(owner.resizes.length, 1);
  catalog.dispose(); catalog.dispose();
  assert.equal(owner.releases, 1); assert.equal(owner.ledger.usage.bytes, 0);
  assert.throws(() => catalog.lookup('folder/a'), /disposed/);
  assert.throws(() => catalog.stats, /disposed/);
});

for (const paths of [['a', 'a'], ['a', 'a/b'], ['a/b', 'a']] as const) {
  test(`catalog refuses ambiguous acquisition ${JSON.stringify(paths)}`, () => {
    const owner = ownership();
    assert.throws(() => prepareSogCatalog(paths.map((path, index) => resource(path, 1, `${index}`)), owner.options), /Duplicate|directory/);
    assert.equal(owner.releases, 1); assert.equal(owner.ledger.usage.bytes, 0);
  });
}
test('catalog refuses duplicate resource IDs even when paths differ', () => {
  const owner = ownership();
  assert.throws(() => prepareSogCatalog([resource('a', 1, 'same'), resource('b', 1, 'same')], owner.options), /Duplicate.*ID/);
  assert.equal(owner.ledger.usage.bytes, 0);
});
for (const path of ['', '/a', 'a/', 'a//b', './a', 'a/../b', 'a\\b', 'a\0b', '\ud800', '\udfff']) {
  test(`catalog refuses noncanonical acquired path ${JSON.stringify(path)}`, () => {
    const owner = ownership();
    assert.throws(() => prepareSogCatalog([resource(path)], owner.options));
    assert.equal(owner.ledger.usage.bytes, 0);
  });
}
for (const size of [-1, 0.5, NaN, Infinity, 0x1_0000_0000, '1'] as const) {
  test(`catalog refuses non-uint32 byte length ${String(size)}`, () => {
    const owner = ownership();
    assert.throws(() => prepareSogCatalog([resource('a', size as number)], owner.options), /uint32/);
    assert.equal(owner.ledger.usage.bytes, 0);
  });
}
test('catalog lengths preserve zero and uint32 maximum without a codec-specific file-size gate', () => {
  const owner = ownership();
  const catalog = prepareSogCatalog([resource('a', 0), resource('b', 0xffff_ffff), resource('c', 0xffff_ffff)], owner.options);
  assert.equal(catalog.totalBytes, 2 * 0xffff_ffff);
  assert.equal(catalog.lookup('a')!.byteLength, 0);
  catalog.dispose(); assert.equal(owner.ledger.usage.bytes, 0);
});
for (const id of ['', 'x'.repeat(129), '\0', '\ud800']) {
  test(`case ${JSON.stringify(id)}: catalog refuses malformed ID of length ${id.length}`, () => {
    const owner = ownership();
    assert.throws(() => prepareSogCatalog([resource('a', 1, id)], owner.options));
    assert.equal(owner.ledger.usage.bytes, 0);
  });
}
test('catalog count refuses before admission or descriptor traversal', () => {
  const owner = ownership(), oversized = new Array(SOG_CATALOG_LIMITS.maxResources + 1) as AcquiredSogResource[];
  Object.defineProperty(oversized, 0, { get() { throw new Error('No traversal before count refusal.'); } });
  assert.throws(() => prepareSogCatalog(oversized, owner.options), /count/);
  assert.deepEqual(owner.admissions, []);
  assert.throws(() => prepareSogCatalog([], owner.options), /count/);
});
test('catalog cumulative limits include unrelated selected entries and exact component boundaries', () => {
  const owner = ownership();
  const options = { ...owner.options, limits: { maxResources: 2, maxPathUnits: 5, maxPathComponents: 3 } };
  const catalog = prepareSogCatalog([resource('a/b'), resource('cc')], options);
  assert.deepEqual(catalog.stats, { pathUnits: 5, pathComponents: 3, catalogBytes: owner.ledger.usage.bytes });
  catalog.dispose();
  for (const entries of [[resource('a/b'), resource('ccc')], [resource('a/b'), resource('c/d')], [resource('a'), resource('b'), resource('c')]]) {
    assert.throws(() => prepareSogCatalog(entries, options), /limits|count/);
    assert.equal(owner.ledger.usage.bytes, 0);
  }
  assert.deepEqual(SOG_CATALOG_LIMITS, { maxResources: 65_536, maxPathUnits: 4_194_304, maxPathComponents: 65_536 });
});
test('catalog limit overrides only tighten known positive ceilings', () => {
  for (const limits of [{ maxResources: 65_537 }, { maxPathUnits: 4_194_305 }, { maxPathComponents: 65_537 },
    { maxResources: 0 }, { maxPathUnits: NaN }, { maxPathComponents: 1.5 }]) {
    const owner = ownership();
    assert.throws(() => prepareSogCatalog([resource('a')], { ...owner.options, limits }), /tighten/);
    assert.deepEqual(owner.admissions, []);
  }
  const owner = ownership();
  assert.throws(() => prepareSogCatalog([resource('a')], { ...owner.options, limits: { unrecognized: 1 } as never }), /Unknown/);
});
test('catalog admission precedes path helper ambiguity detection and releases its census on refusal', () => {
  const count = 2, owner = ownership(64 * 1024 + 256 * count);
  assert.throws(() => prepareSogCatalog([resource('same', 1, 'a'), resource('same', 1, 'b')], owner.options), AdmissionError);
  assert.equal(owner.resizes.length, 1); assert.equal(owner.releases, 1); assert.equal(owner.ledger.usage.bytes, 0);
});

test('complete graph includes known extras, collapses aliases and excludes unreferenced neighbors', () => {
  const value = document({
    means: { files: ['t/a.webp', './t\\b.webp', 't/extra.webp'], mins: [0, 0, 0], maxs: [1, 1, 1] },
    scales: { files: ['./t/a.webp'], codebook: [0] }, quats: { files: ['t//a.webp'] },
    sh0: { files: ['t/b.webp'], codebook: [0] }, shN: null,
    futureGroup: { files: ['missing-neighbor.webp'] },
  });
  const parsed = metadata(value), catOwner = ownership(), graphOwner = ownership();
  const catalog = prepareSogCatalog([
    resource('collection/asset/t/extra.webp', 11, 'extra'), resource('collection/asset/meta.json', parsed.bytes.byteLength, 'meta'),
    resource('collection/asset/t/b.webp', 7, 'b'), resource('collection/unrelated.bin', 0xffff_ffff, 'unrelated'),
    resource('collection/asset/t/a.webp', 5, 'a'),
  ], catOwner.options);
  const graph = prepareSogResources(parsed.prepared, 'collection/asset/meta.json', catalog, graphOwner.options);
  assert.equal(graph.assetRootPrefix, 'collection/asset/'); assert.equal(graph.primaryResourceId, 'meta');
  assert.equal(graph.resourceCount, 4); assert.equal(graph.totalBytes, parsed.bytes.byteLength + 23);
  assert.deepEqual(graph.resources.map(({ resourceId, fingerprintPath, role, byteLength }) => ({ resourceId, fingerprintPath, role, byteLength })), [
    { resourceId: 'meta', fingerprintPath: 'meta.json', role: 'primary', byteLength: parsed.bytes.byteLength },
    { resourceId: 'a', fingerprintPath: 't/a.webp', role: 'referenced', byteLength: 5 },
    { resourceId: 'b', fingerprintPath: 't/b.webp', role: 'referenced', byteLength: 7 },
    { resourceId: 'extra', fingerprintPath: 't/extra.webp', role: 'referenced', byteLength: 11 },
  ]);
  assert.deepEqual(graph.bindings.map(({ group, index, reference, resourceId }) => ({ group, index, reference, resourceId })), [
    { group: 'means', index: 0, reference: 't/a.webp', resourceId: 'a' },
    { group: 'means', index: 1, reference: './t\\b.webp', resourceId: 'b' },
    { group: 'means', index: 2, reference: 't/extra.webp', resourceId: 'extra' },
    { group: 'scales', index: 0, reference: './t/a.webp', resourceId: 'a' },
    { group: 'quats', index: 0, reference: 't//a.webp', resourceId: 'a' },
    { group: 'sh0', index: 0, reference: 't/b.webp', resourceId: 'b' },
  ]);
  assert.ok(Object.isFrozen(graph) && Object.isFrozen(graph.resources) && Object.isFrozen(graph.bindings));
  assert.ok(graph.resources.every(Object.isFrozen) && graph.bindings.every(Object.isFrozen));
  assert.equal('assetDigest' in graph, false); assert.equal('bytes' in graph, false);
  assert.equal(graph.preparationBytes, graphOwner.ledger.usage.bytes);
  cleanup(parsed.prepared, catalog, graph);
  assert.deepEqual([parsed.owner.ledger.usage.bytes, catOwner.ledger.usage.bytes, graphOwner.ledger.usage.bytes], [0, 0, 0]);
});
test('known extra resources remain required even when the native decoder never consumes that position', () => {
  const f = fixture(document({ quats: { files: ['quat.webp', 'missing-extra.webp'] } }));
  assert.throws(() => f.graph(), /declared.*not acquired/);
  assert.equal(f.graphOwner.ledger.usage.bytes, 0); f.dispose();
});
test('final duplicate-key declarations replace earlier references before graph construction', () => {
  const owner = ownership(), base = JSON.stringify(document());
  const bytes = new TextEncoder().encode('{"means":{"files":["missing-first.webp"]},' + base.slice(1));
  const prepared = parseSogMetadata(bytes, owner.options), catOwner = ownership(), graphOwner = ownership();
  const catalog = prepareSogCatalog([resource('meta.json', bytes.byteLength), ...BASIC.map(path => resource(path))], catOwner.options);
  const graph = prepareSogResources(prepared, 'meta.json', catalog, graphOwner.options);
  assert.equal(graph.bindings.length, 5); assert.equal(graph.bindings[0]!.reference, 'lo.webp');
  cleanup(prepared, catalog, graph); assert.equal(owner.ledger.usage.bytes, 0);
});
test('group path derivation ignores selected outer context and selection order', () => {
  const shallow = fixture(), deep = fixture(document(), 'outer/asset/');
  const a = shallow.graph(), b = deep.graph();
  assert.deepEqual(a.resources.map(r => [r.fingerprintPath, r.role, r.byteLength]), b.resources.map(r => [r.fingerprintPath, r.role, r.byteLength]));
  assert.equal(a.assetRootPrefix, ''); assert.equal(b.assetRootPrefix, 'outer/asset/');
  assert.notEqual(a.resources[0]!.acquisitionPath, b.resources[0]!.acquisitionPath);
  shallow.dispose(a); deep.dispose(b);
});
test('in-root parent references derive a shared directory prefix without stripping partial component names', () => {
  const parsed = metadata(document({ means: { files: ['../asset-other/lo.webp', '../shared/hi.webp'], mins: [0, 0, 0], maxs: [1, 1, 1] } }));
  const catOwner = ownership(), graphOwner = ownership();
  const catalog = prepareSogCatalog([
    resource('outer/asset/meta.json', parsed.bytes.byteLength), resource('outer/asset-other/lo.webp'), resource('outer/shared/hi.webp'),
    resource('outer/asset/scale.webp'), resource('outer/asset/quat.webp'), resource('outer/asset/color.webp'),
  ], catOwner.options);
  const graph = prepareSogResources(parsed.prepared, 'outer/asset/meta.json', catalog, graphOwner.options);
  assert.equal(graph.assetRootPrefix, 'outer/');
  assert.deepEqual(graph.resources.map(r => r.fingerprintPath), [
    'asset-other/lo.webp', 'asset/color.webp', 'asset/meta.json', 'asset/quat.webp', 'asset/scale.webp', 'shared/hi.webp',
  ]);
  cleanup(parsed.prepared, catalog, graph);
});
test('graph preserves case, Unicode spellings, percent text and UTF8 path ordering', () => {
  const references = ['A.webp', 'a.webp', 'e\u0301.webp', '\u00e9.webp', '\ue000.webp', '\u{10000}.webp', '%2e%2e.webp', 'space ?#.webp'];
  const parsed = metadata(document({ means: { files: references, mins: [0, 0, 0], maxs: [1, 1, 1] },
    scales: { files: ['A.webp'], codebook: [0] }, quats: { files: ['a.webp'] }, sh0: { files: ['e\u0301.webp'], codebook: [0] } }));
  const catOwner = ownership(), graphOwner = ownership();
  const catalog = prepareSogCatalog([resource('meta.json', parsed.bytes.byteLength), ...references.toReversed().map(path => resource(path))], catOwner.options);
  const graph = prepareSogResources(parsed.prepared, 'meta.json', catalog, graphOwner.options);
  assert.deepEqual(graph.resources.map(r => r.fingerprintPath), [
    '%2e%2e.webp', 'A.webp', 'a.webp', 'e\u0301.webp', 'meta.json', 'space ?#.webp', '\u00e9.webp', '\ue000.webp', '\u{10000}.webp',
  ]);
  assert.equal(graph.resourceCount, 9); cleanup(parsed.prepared, catalog, graph);
});
for (const reference of ['meta.json', './meta.json', 'sub/../meta.json', '.\\meta.json']) {
  test(`graph refuses canonical primary self-reference ${JSON.stringify(reference)} including extras`, () => {
    const f = fixture(document({ quats: { files: ['quat.webp', reference] } }));
    assert.throws(() => f.graph(), /itself/); assert.equal(f.graphOwner.ledger.usage.bytes, 0); f.dispose();
  });
}
for (const reference of ['../outside.webp', '/lo.webp', '\\lo.webp', 'C:lo.webp', 'https://example.test/lo.webp', 'blob:lo.webp']) {
  test(`graph refuses escaped or absolute reference ${JSON.stringify(reference)}`, () => {
    const f = fixture(document({ quats: { files: [reference] } }));
    assert.throws(() => f.graph(), /escapes|absolute/); assert.equal(f.graphOwner.ledger.usage.bytes, 0); f.dispose();
  });
}
test('case and Unicode equivalence are never guessed for a missing acquired target', () => {
  for (const reference of ['LO.webp', 'l\u00f3.webp', 'l\u006f\u0301.webp']) {
    const f = fixture(document({ quats: { files: [reference] } }));
    assert.throws(() => f.graph(), /not acquired/); f.dispose();
  }
});
test('both v1 SH and v2 SH declarations include all final positions without a texture read', () => {
  for (const legacy of [false, true]) {
    const value = document({
      ...(legacy ? { version: 1, means: { files: ['lo.webp', 'hi.webp'], shape: [1, 3], mins: [0, 0, 0], maxs: [1, 1, 1] },
        scales: { files: ['scale.webp'], mins: [0, 0, 0], maxs: [1, 1, 1] }, sh0: { files: ['color.webp'], mins: [0, 0, 0, 0], maxs: [1, 1, 1, 1] } } : {}),
      shN: { files: ['centroids.webp', 'labels.webp', 'unused.webp'], ...(legacy ? { mins: -1, maxs: 1 } : { bands: 3, count: 64, codebook: [0] }) },
    });
    const parsed = metadata(value), catOwner = ownership(), graphOwner = ownership();
    const catalog = prepareSogCatalog([resource('meta.json', parsed.bytes.byteLength),
      ...[...BASIC, 'centroids.webp', 'labels.webp', 'unused.webp'].map(path => resource(path))], catOwner.options);
    const graph = prepareSogResources(parsed.prepared, 'meta.json', catalog, graphOwner.options);
    assert.equal(graph.resourceCount, 9); assert.equal(graph.bindings.length, 8);
    assert.deepEqual(graph.bindings.filter(d => d.group === 'shN').map(d => d.index), [0, 1, 2]);
    assert.equal(parsed.prepared.shDegree, legacy ? null : 3);
    cleanup(parsed.prepared, catalog, graph);
  }
});
test('graph refuses absent or wrong-length primary without taking a preparation lease', () => {
  const f = fixture();
  assert.throws(() => prepareSogResources(f.prepared, 'absent.json', f.catalog, f.graphOwner.options), /primary/);
  assert.throws(() => prepareSogResources(f.prepared, 'lo.webp', f.catalog, f.graphOwner.options), /length/);
  assert.deepEqual(f.graphOwner.admissions, []);
  f.dispose();
});
test('graph requires the immutable catalog factory rather than caller-supplied mutable lookup', () => {
  const f = fixture();
  assert.throws(() => prepareSogResources(f.prepared, 'meta.json', new Map() as unknown as PreparedSogCatalog, f.graphOwner.options), /prepared.*catalog/);
  assert.deepEqual(f.graphOwner.admissions, []); f.dispose();
});
test('graph authenticates parser-issued metadata before reading declarations or admitting graph work', () => {
  const f = fixture();
  const fabricated = { assertCurrent() {}, byteLength: f.bytes.byteLength,
    get declarations() { throw new Error('Forged declarations must not be read.'); } };
  for (const forged of [fabricated, { ...f.prepared }, Object.create(f.prepared), new Proxy(f.prepared, {})]) {
    assert.throws(() => prepareSogResources(forged as PreparedSogMetadata, 'meta.json', f.catalog, f.graphOwner.options), /bounded parser/);
  }
  assert.deepEqual(f.graphOwner.admissions, []); f.dispose();
});
test('graph borrows metadata and catalog while releasing only its own reservation exactly once', () => {
  const f = fixture(), graph = f.graph();
  const metadataBytes = f.owner.ledger.usage.bytes, catalogBytes = f.catalogOwner.ledger.usage.bytes;
  assert.ok(f.graphOwner.ledger.usage.bytes > 0);
  graph.dispose(); graph.dispose();
  assert.equal(f.graphOwner.releases, 1); assert.equal(f.graphOwner.ledger.usage.bytes, 0);
  assert.equal(f.owner.ledger.usage.bytes, metadataBytes); assert.equal(f.catalogOwner.ledger.usage.bytes, catalogBytes);
  assert.throws(() => graph.resources, /disposed/); assert.throws(() => graph.assertCurrent(), /disposed/);
  f.dispose();
});
for (const owner of ['metadata', 'catalog', 'candidate'] as const) {
  test(`every graph accessor refuses after its borrowed ${owner} becomes unavailable`, () => {
    const f = fixture(), graph = f.graph();
    if (owner === 'metadata') f.prepared.dispose();
    else if (owner === 'catalog') f.catalog.dispose();
    else f.graphOwner.cancel();
    for (const key of ['primaryResourceId', 'assetRootPrefix', 'resourceCount', 'totalBytes', 'resources', 'bindings', 'preparationBytes'] as const) {
      assert.throws(() => graph[key]);
    }
    assert.throws(() => graph.assertCurrent());
    f.dispose(graph); assert.equal(f.graphOwner.ledger.usage.bytes, 0);
  });
}
test('graph path work is admitted before resolving a long component-rich reference', () => {
  const reference = './'.repeat(2000) + '../outside.webp';
  const f = fixture(document({ quats: { files: [reference] } }));
  const owner = ownership(64 * 1024 + 256 * (5 + 41));
  assert.throws(() => prepareSogResources(f.prepared, 'meta.json', f.catalog, owner.options), AdmissionError);
  assert.equal(owner.resizes.length, 1); assert.equal(owner.releases, 1); assert.equal(owner.ledger.usage.bytes, 0);
  f.dispose();
});
test('all long aliased binding strings are admitted independently of their unique resource count', () => {
  const folder = 'long'.repeat(2048), primaryPath = `collection/${folder}/meta.json`;
  const aliases = Array.from({ length: 8 }, (_, index) => index % 2 ? './texture.webp' : 'texture.webp');
  const parsed = metadata(document({
    means: { files: ['texture.webp', '../outside.webp', ...aliases.slice(2)], mins: [0, 0, 0], maxs: [1, 1, 1] },
    scales: { files: aliases, codebook: [0] }, quats: { files: aliases }, sh0: { files: aliases, codebook: [0] },
    shN: { files: aliases, bands: 1, count: 1, codebook: [0] },
  }));
  const catOwner = ownership(), graphOwner = ownership();
  const catalog = prepareSogCatalog([
    resource(primaryPath, parsed.bytes.byteLength, 'meta'), resource(`collection/${folder}/texture.webp`, 1, 'texture'),
    resource('collection/outside.webp', 2, 'outside'),
  ], catOwner.options);
  const graph = prepareSogResources(parsed.prepared, primaryPath, catalog, graphOwner.options);
  assert.equal(graph.assetRootPrefix, 'collection/'); assert.equal(graph.bindings.length, 40); assert.equal(graph.resourceCount, 3);
  // Independent retained-value census: every exposed occurrence remains covered
  // even if an engine copies substrings and the parser/catalog retire first.
  const strings = [graph.assetRootPrefix, graph.primaryResourceId,
    ...graph.resources.flatMap(entry => [entry.resourceId, entry.acquisitionPath, entry.fingerprintPath]),
    ...graph.bindings.flatMap(entry => [entry.reference, entry.resourceId, entry.acquisitionPath, entry.fingerprintPath])];
  const retainedBytes = 2 * strings.reduce((sum, value) => sum + value.length, 0);
  assert.ok(retainedBytes > 1_000_000);
  assert.ok(graph.preparationBytes > retainedBytes);
  const tooSmall = ownership(retainedBytes - 1);
  assert.throws(() => prepareSogResources(parsed.prepared, primaryPath, catalog, tooSmall.options), AdmissionError);
  assert.equal(tooSmall.resizes.length, 2); assert.equal(tooSmall.ledger.usage.bytes, 0);
  const covered = graph.preparationBytes, values = graph.resources, bindings = graph.bindings;
  parsed.prepared.dispose(); catalog.dispose();
  assert.equal(parsed.owner.ledger.usage.bytes, 0); assert.equal(catOwner.ledger.usage.bytes, 0);
  assert.equal(graphOwner.ledger.usage.bytes, covered);
  assert.equal(values[0]!.acquisitionPath.length > 8000, true);
  assert.equal(bindings[0]!.reference, 'texture.webp');
  assert.throws(() => graph.resources, /disposed/);
  graph.dispose(); assert.equal(graphOwner.ledger.usage.bytes, 0);
});
test('graph cancellation after admitted census releases work without disposing borrowed owners', () => {
  const f = fixture(), owner = ownership();
  const options = { ...owner.options, admit(bytes: number) { const lease = owner.options.admit(bytes); owner.cancel(); return lease; } };
  assert.throws(() => prepareSogResources(f.prepared, 'meta.json', f.catalog, options), /current/);
  assert.equal(owner.releases, 1); assert.equal(owner.ledger.usage.bytes, 0);
  f.prepared.assertCurrent(); f.catalog.assertCurrent(); f.dispose();
});
test('catalog cancellation and reentrant disposal are checked after current hooks', () => {
  const owner = ownership(); let catalog: PreparedSogCatalog | undefined, disposeOnCurrent = false;
  const options = { ...owner.options, current() { owner.options.current(); if (disposeOnCurrent) catalog!.dispose(); } };
  catalog = prepareSogCatalog([resource('a')], options);
  disposeOnCurrent = true;
  assert.throws(() => catalog!.lookup('a'), /disposed/); assert.equal(owner.releases, 1);
  assert.equal(owner.ledger.usage.bytes, 0);
});
for (const invalidator of ['metadata', 'catalog'] as const) {
  test(`a ${invalidator} current hook cannot return graph data after disposing the other borrowed owner`, () => {
    const metaOwner = ownership(), catOwner = ownership(), graphOwner = ownership();
    let invalidate: () => void = () => undefined;
    const run = (kind: typeof invalidator, owner: ReturnType<typeof ownership>) => ({ ...owner.options,
      current() { owner.options.current(); if (kind === invalidator) invalidate(); },
    });
    const bytes = new TextEncoder().encode(JSON.stringify(document()));
    const parsed = parseSogMetadata(bytes, run('metadata', metaOwner));
    const catalog = prepareSogCatalog([resource('meta.json', bytes.byteLength), ...BASIC.map(path => resource(path))], run('catalog', catOwner));
    const graph = prepareSogResources(parsed, 'meta.json', catalog, graphOwner.options);
    const retained = graphOwner.ledger.usage.bytes;
    invalidate = () => { if (invalidator === 'metadata') catalog.dispose(); else parsed.dispose(); };
    assert.throws(() => graph.resources, /disposed/);
    assert.equal(graphOwner.ledger.usage.bytes, retained);
    cleanup(parsed, catalog, graph); assert.equal(graphOwner.ledger.usage.bytes, 0);
  });
}
test('late metadata-current disposal prevents graph construction after the final allowance is admitted', () => {
  const metaOwner = ownership(), catOwner = ownership(), graphOwner = ownership();
  let catalog: PreparedSogCatalog | undefined;
  const bytes = new TextEncoder().encode(JSON.stringify(document()));
  const parsed = parseSogMetadata(bytes, { ...metaOwner.options, current() {
    metaOwner.options.current(); if (graphOwner.resizes.length === 2) catalog!.dispose();
  } });
  catalog = prepareSogCatalog([resource('meta.json', bytes.byteLength), ...BASIC.map(path => resource(path))], catOwner.options);
  assert.throws(() => prepareSogResources(parsed, 'meta.json', catalog!, graphOwner.options), /disposed/);
  assert.equal(graphOwner.resizes.length, 2); assert.equal(graphOwner.releases, 1);
  assert.equal(graphOwner.ledger.usage.bytes, 0); assert.equal(catOwner.ledger.usage.bytes, 0);
  parsed.dispose(); assert.equal(metaOwner.ledger.usage.bytes, 0);
});
test('metadata-current release of catalog credit without disposal is refused before returning graph data', () => {
  const metaOwner = ownership(), catOwner = ownership(), graphOwner = ownership();
  let invalidate = false, catalogLease: ResourceLease | undefined;
  const bytes = new TextEncoder().encode(JSON.stringify(document()));
  const parsed = parseSogMetadata(bytes, { ...metaOwner.options, current() {
    metaOwner.options.current(); if (invalidate) catalogLease!();
  } });
  const catalog = prepareSogCatalog([resource('meta.json', bytes.byteLength), ...BASIC.map(path => resource(path))], {
    ...catOwner.options, admit(bytes) { catalogLease = catOwner.options.admit(bytes); return catalogLease; },
  });
  const graph = prepareSogResources(parsed, 'meta.json', catalog, graphOwner.options);
  invalidate = true;
  assert.throws(() => graph.bindings, /stale/);
  assert.equal(catOwner.ledger.usage.bytes, 0);
  cleanup(parsed, catalog, graph); assert.equal(graphOwner.ledger.usage.bytes, 0);
});
test('a graph current hook disposing its own graph is refused after borrowed checks', () => {
  const f = fixture(); let graph: PreparedSogResources | undefined, invalidate = false;
  const options = { ...f.graphOwner.options, current() { if (invalidate) graph!.dispose(); } };
  graph = prepareSogResources(f.prepared, 'meta.json', f.catalog, options);
  invalidate = true;
  assert.throws(() => graph!.resources, /disposed/);
  assert.equal(f.graphOwner.ledger.usage.bytes, 0); assert.equal(f.graphOwner.releases, 1); f.dispose(graph);
});
test('async ownership hooks are observed and refused without treating a Promise as a lease', async () => {
  const owner = ownership();
  assert.throws(() => prepareSogCatalog([resource('a')], {
    ...owner.options, admit: (() => Promise.reject(new Error('Async admission.'))) as unknown as SogResourceOptions['admit'],
  }), /synchronously/);
  assert.equal(owner.releases, 0); assert.equal(owner.ledger.usage.bytes, 0);
  assert.throws(() => prepareSogCatalog([resource('a')], {
    ...owner.options, current: (() => Promise.reject(new Error('Async current.'))) as unknown as SogResourceOptions['current'],
  }), /synchronously/);
  await Promise.resolve(); await Promise.resolve();
});
for (const problem of ['wrong-bytes', 'missing-resize', 'throwing-bytes', 'throwing-resize', 'throwing-then', 'thenable'] as const) {
  test(`callable malformed admission ${problem} releases captured ownership exactly once`, async () => {
    const owner = ownership();
    const options = { ...owner.options, admit(bytes: number) {
      const actual = owner.options.admit(bytes), lease = (() => actual()) as ResourceLease;
      Object.defineProperty(lease, 'bytes', { get() {
        if (problem === 'throwing-bytes') throw new Error('Malformed bytes getter.');
        return problem === 'wrong-bytes' ? actual.bytes - 1 : actual.bytes;
      } });
      Object.defineProperty(lease, 'resize', { get() {
        if (problem === 'throwing-resize') throw new Error('Malformed resize getter.');
        return problem === 'missing-resize' ? undefined : actual.resize;
      } });
      if (problem === 'throwing-then') Object.defineProperty(lease, 'then', { get() { throw new Error('Malformed then getter.'); } });
      if (problem === 'thenable') Object.defineProperty(lease, 'then', { value(_resolve: unknown, reject: (error: Error) => void) {
        reject(new Error('Rejected callable thenable.'));
      } });
      return bindResourceLeaseCredit(lease, actual);
    } };
    assert.throws(() => prepareSogCatalog([resource('a')], options), /admission|Malformed|synchronously/);
    assert.equal(owner.releases, 1); assert.equal(owner.ledger.usage.bytes, 0);
    await Promise.resolve(); await Promise.resolve();
  });
}
test('unfulfilled resize refuses before path helpers and disposes the original reservation', () => {
  const owner = ownership();
  const options = { ...owner.options, admit(bytes: number) {
    const actual = owner.options.admit(bytes), lease = (() => actual()) as ResourceLease;
    Object.defineProperty(lease, 'bytes', { get: () => actual.bytes }); lease.resize = () => undefined;
    return bindResourceLeaseCredit(lease, actual);
  } };
  assert.throws(() => prepareSogCatalog([resource('same', 1, 'a'), resource('same', 1, 'b')], options), /did not reserve/);
  assert.equal(owner.releases, 1); assert.equal(owner.ledger.usage.bytes, 0);
});
test('stale admission after current hook refuses before descriptor allocation or access', () => {
  const owner = ownership(); let admitted: ResourceLease | undefined;
  const options = { ...owner.options,
    admit(bytes: number) { admitted = owner.options.admit(bytes); return admitted; },
    current() { if (admitted) admitted(); },
  };
  const entries = [resource('a')];
  Object.defineProperty(entries, 0, { get() { throw new Error('The stale census must not traverse input.'); } });
  assert.throws(() => prepareSogCatalog(entries, options), /stale/);
  assert.equal(owner.ledger.usage.bytes, 0);
});
test('reusing a live catalog lease cannot dispose the original owner', () => {
  const f = fixture(), owner = ownership(); let existing: ResourceLease | undefined;
  const options = { ...owner.options, admit(bytes: number) {
    existing ??= owner.options.admit(bytes); return existing;
  } };
  const catalog = prepareSogCatalog([resource('other', 1)], options);
  const retained = owner.ledger.usage.bytes;
  assert.throws(() => prepareSogResources(f.prepared, 'meta.json', f.catalog, options), /reused/);
  assert.equal(owner.ledger.usage.bytes, retained); assert.equal(owner.releases, 0); catalog.assertCurrent();
  catalog.dispose(); assert.equal(owner.releases, 1); assert.equal(owner.ledger.usage.bytes, 0); f.dispose();
});
test('async resize and cleanup failures preserve the preparation error and settle the valid preparation lease', async () => {
  const owner = ownership();
  const options = { ...owner.options, admit(bytes: number) {
    const actual = owner.options.admit(bytes);
    const lease = (() => { actual(); return Promise.reject(new Error('Async cleanup.')); }) as unknown as ResourceLease;
    Object.defineProperty(lease, 'bytes', { get: () => actual.bytes });
    lease.resize = (() => Promise.reject(new Error('Async resize.'))) as unknown as ResourceLease['resize'];
    return bindResourceLeaseCredit(lease, actual);
  } };
  assert.throws(() => prepareSogCatalog([resource('a')], options), error => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 2);
    assert.match(error.errors[0].message, /synchronously/); assert.match(error.errors[1].message, /synchronously/); return true;
  });
  assert.equal(owner.releases, 1); assert.equal(owner.ledger.usage.bytes, 0);
  await Promise.resolve(); await Promise.resolve();
});
