import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  assertCanonicalAcquiredPath,
  canonicalAcquiredPath,
  compareUtf8Paths,
  resolveAssetResourcePaths,
  resolveMetadataReference,
  validateAcquiredPaths,
} from '../src/io/paths.ts';

test('acquisition preserves case, composed/decomposed Unicode, and non-BMP names', () => {
  assert.equal(canonicalAcquiredPath(['Textures', 'é-😀.bin']), 'Textures/é-😀.bin');
  assert.equal(canonicalAcquiredPath(['textures', 'e\u0301.bin']), 'textures/e\u0301.bin');
  assert.notEqual(canonicalAcquiredPath(['é']), canonicalAcquiredPath(['e\u0301']));
  assert.notEqual(canonicalAcquiredPath(['A']), canonicalAcquiredPath(['a']));
  // Legal literal characters are not treated as URL/query encoding here.
  assert.equal(canonicalAcquiredPath(['space name', '%2e?#.bin']), 'space name/%2e?#.bin');
});

for (const [label, components] of [
  ['no components', []],
  ['empty component', ['x', '']],
  ['dot component', ['.']],
  ['parent component', ['x', '..']],
  ['slash filename', ['a/b']],
  ['backslash filename', ['a\\b']],
  ['null filename', ['a\0b']],
  ['unpaired high surrogate', ['\ud800']],
  ['unpaired low surrogate', ['\udfff']],
  ['high surrogate followed by ASCII', ['\ud800a']],
] as const) {
  test(`acquisition rejects ${label}`, () => assert.throws(() => canonicalAcquiredPath(components)));
}

for (const path of ['', '/a', 'a/', 'a//b', './a', 'a/../b', 'a\\b', 'a/\ud800']) {
  test(`canonical acquired path refuses ${JSON.stringify(path)}`, () => {
    assert.throws(() => assertCanonicalAcquiredPath(path));
  });
}

test('UTF-8 comparator orders scalars rather than UTF-16 code units', () => {
  const paths = ['\u{10000}', '\ue000', 'é', 'e\u0301', 'a', 'A', 'a/b', 'a-'];
  assert.deepEqual([...paths].sort(compareUtf8Paths), ['A', 'a', 'a-', 'a/b', 'e\u0301', 'é', '\ue000', '\u{10000}']);
  const encoder = new TextEncoder();
  for (const left of paths) for (const right of paths) {
    const independent = Math.sign(Buffer.compare(encoder.encode(left), encoder.encode(right)));
    assert.equal(Math.sign(compareUtf8Paths(left, right)), independent);
  }
});

test('acquired path collision validation preserves distinct case/Unicode names', () => {
  assert.deepEqual([...validateAcquiredPaths(['A', 'a', 'é', 'e\u0301'])], ['A', 'a', 'é', 'e\u0301']);
  assert.throws(() => validateAcquiredPaths(['a', 'a']), /Duplicate/);
  assert.throws(() => validateAcquiredPaths(['a', 'a/b']), /also a directory/);
  assert.throws(() => validateAcquiredPaths(['a/b', 'a']), /also a directory/);
});

test('metadata-only normalization resolves parent traversal within the selected root', () => {
  assert.equal(resolveMetadataReference('models/v1/meta.json', '..\\textures//./é.bin'), 'models/textures/é.bin');
  assert.equal(resolveMetadataReference('models/v1/meta.json', '../../root.bin'), 'root.bin');
  assert.equal(resolveMetadataReference('m.json', 'Textures\\A.bin'), 'Textures/A.bin');
  assert.equal(resolveMetadataReference('models/m.json', './%2e%2e.bin'), 'models/%2e%2e.bin');
  assert.equal(resolveMetadataReference('models/m.json', 'a?b#c'), 'models/a?b#c');
});

for (const reference of [
  '', '../out', '..\\out', '/out', '\\out', '//host/share', '\\\\host\\share',
  'C:/out', 'C:\\out', 'C:relative', 'https://example.test/a', 'HTTP://example.test/a',
  'file:///a', 'data:abc', 'blob:abc', 'custom+scheme:abc', '../../../out',
  '.', './', 'x/..', '\ud800', 'a\0b',
]) {
  test(`metadata resolver refuses ${JSON.stringify(reference)}`, () => {
    assert.throws(() => resolveMetadataReference('m.json', reference));
  });
}

test('metadata references deduplicate canonical aliases but reject acquired ambiguity', () => {
  const selected = ['textures/A.bin', 'm.json', 'unrelated.bin', 'textures/é.bin'];
  assert.deepEqual(resolveAssetResourcePaths('m.json', [
    'textures/A.bin', './textures\\A.bin', 'textures//é.bin', './m.json',
  ], selected), ['m.json', 'textures/A.bin', 'textures/é.bin']);
  assert.deepEqual(resolveAssetResourcePaths('m.json', [], ['m.json', 'neighbor.bin']), ['m.json']);
  assert.throws(() => resolveAssetResourcePaths('m.json', ['textures/A.bin'], [...selected, 'textures/A.bin']), /Duplicate/);
  assert.throws(() => resolveAssetResourcePaths('m.json', ['missing.bin'], selected), /not acquired/);
  assert.throws(() => resolveAssetResourcePaths('absent.json', [], selected), /primary metadata/);
  assert.throws(() => resolveAssetResourcePaths('m.json', ['textures/a.bin'], selected), /not acquired/);
  assert.throws(() => resolveAssetResourcePaths('m.json', ['textures/e\u0301.bin'], selected), /not acquired/);
});

test('selection order and outer folder labels do not alter asset-relative paths', () => {
  const rootA = { label: 'Original folder', components: [['m.json'], ['nested', 'a.bin']] };
  const rootB = { label: 'Renamed copy', components: [['nested', 'a.bin'], ['m.json']] };
  const first = rootA.components.map(canonicalAcquiredPath);
  const second = rootB.components.map(canonicalAcquiredPath);
  assert.deepEqual(resolveAssetResourcePaths('m.json', ['nested/a.bin'], first),
    resolveAssetResourcePaths('m.json', ['nested/a.bin'], second));
});

test('acquisition validates numeric components even when a custom iterator hides traversal', () => {
  const components = ['safe', '..', 'escaped'];
  let iterations = 0;
  Object.defineProperty(components, Symbol.iterator, { value: function* () { iterations++; yield 'safe'; } });
  assert.throws(() => canonicalAcquiredPath(components), /relative path component/);
  assert.equal(iterations, 0);
});

test('acquisition joins the validated numeric snapshot rather than mutable input methods or getters', () => {
  const components = ['safe'];
  let reads = 0;
  Object.defineProperty(components, '0', { get: () => ++reads === 1 ? 'safe' : '..' });
  Object.defineProperty(components, 'join', { value: () => 'unsafe/../escaped' });
  Object.defineProperty(components, Symbol.iterator, { value: function* () { yield '..'; } });
  assert.equal(canonicalAcquiredPath(components), 'safe');
  assert.equal(reads, 1);
});

test('acquisition snapshots array length once and ignores custom iterator entries', () => {
  let lengthReads = 0;
  const components = new Proxy(['safe', '..'], { get: (target, key, receiver) => {
    if (key === 'length') return ++lengthReads === 1 ? 1 : 2;
    if (key === Symbol.iterator) throw new Error('The untrusted iterator must not be read');
    return Reflect.get(target, key, receiver);
  } });
  assert.equal(canonicalAcquiredPath(components), 'safe');
  assert.equal(lengthReads, 1);
});

test('acquired collision validation cannot be bypassed by hiding numeric duplicate entries', () => {
  const paths = ['same', 'same'];
  Object.defineProperty(paths, Symbol.iterator, { value: function* () { yield 'same'; } });
  assert.throws(() => validateAcquiredPaths(paths), /Duplicate/);
});

test('reference resolution snapshots numeric references instead of an iterator hiding missing resources', () => {
  const references = ['missing.bin'];
  Object.defineProperty(references, Symbol.iterator, { value: function* () { yield 'm.json'; } });
  assert.throws(() => resolveAssetResourcePaths('m.json', references, ['m.json']), /not acquired/);
});
