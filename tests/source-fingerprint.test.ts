import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'vitest';
import {
  finishSourceFingerprint,
  MAX_CANONICAL_SEGMENT_BYTES,
  prepareCanonicalSource,
  SOURCE_FINGERPRINT_SCHEME,
  writeCanonicalSource,
} from '../src/io/fingerprint.ts';
import type { SourceFingerprintInput, SourceResourceDigest } from '../src/io/fingerprint.ts';

const ABC_DIGEST = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const EMPTY_DIGEST = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const OBJECT_DIGEST = '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';
const ZERO_DIGEST = '6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d';
// Independently constructed by independent-vectors.py (struct + hashlib).
const SINGLE_HEX = '53706c617456696577536f7572636500763100000000000101000000000000000000000003' + ABC_DIGEST;
const SINGLE_HASH = 'b8e58e5d08b008eba9c2de43d1dad740d9c7ba7349748bf0e8164175f2023afe';
const GROUP_HEX = '53706c617456696577536f7572636500763100010000000201000000066d2e6a736f6e' +
  '0000000000000002' + OBJECT_DIGEST + '000000000f74657874757265732fc3a92e62696e' +
  '0000000000000001' + ZERO_DIGEST;
const GROUP_HASH = '8fb663dfe1573bdd35fb57167c97baa2cc52ca67d8f816e13169e7f67da00da5';
const PRIMARY_ONLY_GROUP_HEX = '53706c617456696577536f75726365007631000100000001' +
  '01000000066d2e6a736f6e0000000000000003' + ABC_DIGEST;

function resource(path = '', role: 'primary' | 'referenced' = 'primary',
  byteLength = 3, digest = ABC_DIGEST): SourceResourceDigest {
  return { path, role, byteLength, sha256: Buffer.from(digest, 'hex') };
}
function single(): SourceFingerprintInput { return { kind: 'single', resources: [resource()] }; }
function group(): SourceFingerprintInput {
  return { kind: 'group', resources: [resource('textures/é.bin', 'referenced', 1, ZERO_DIGEST),
    resource('m.json', 'primary', 2, OBJECT_DIGEST)] };
}
function collect(input: SourceFingerprintInput, limit?: number): Buffer {
  const segments: Uint8Array[] = [];
  writeCanonicalSource(input, (segment) => { segments.push(segment); }, limit);
  return Buffer.concat(segments);
}
function digest(input: SourceFingerprintInput, limit?: number): string {
  const hash = createHash('sha256');
  writeCanonicalSource(input, (segment) => hash.update(segment), limit);
  return hash.digest('hex');
}

test('single source emits literal v1 bytes and independently published asset digest', () => {
  assert.equal(collect(single()).toString('hex'), SINGLE_HEX);
  assert.equal(digest(single()), SINGLE_HASH);
  assert.deepEqual(writeCanonicalSource(single(), () => undefined), {
    scheme: 'splatview-source-v1', resourceCount: 1, totalBytes: 3,
  });
});

test('group source sorts UTF-8 paths and emits literal v1 bytes and asset digest', () => {
  assert.equal(collect(group()).toString('hex'), GROUP_HEX);
  assert.equal(digest(group()), GROUP_HASH);
  const reordered: SourceFingerprintInput = { kind: 'group', resources: [...group().resources].reverse() };
  assert.equal(digest(reordered), GROUP_HASH);
});

test('prepared canonical lengths and repeated writes match independent v1 byte vectors', () => {
  const cases = [
    { input: single(), hex: SINGLE_HEX, hash: SINGLE_HASH, resources: 1, bytes: 3 },
    { input: group(), hex: GROUP_HEX, hash: GROUP_HASH, resources: 2, bytes: 3 },
  ];
  for (const { input, hex, hash, resources, bytes } of cases) {
    const prepared = prepareCanonicalSource(input);
    assert.equal(prepared.canonicalByteLength, Buffer.from(hex, 'hex').byteLength);
    assert.equal(prepared.resourceCount, resources);
    assert.equal(prepared.totalBytes, bytes);
    for (const limit of [1, 7, MAX_CANONICAL_SEGMENT_BYTES]) {
      const segments: Uint8Array[] = [];
      const incremental = createHash('sha256');
      const summary = prepared.write((segment) => { segments.push(segment); incremental.update(segment); }, limit);
      assert.ok(segments.every((segment) => segment.byteLength > 0 && segment.byteLength <= limit));
      assert.ok(segments.every((segment) => segment.buffer.byteLength <= limit));
      assert.equal(Buffer.concat(segments).toString('hex'), hex);
      assert.equal(incremental.digest('hex'), hash);
      assert.deepEqual(summary, { scheme: SOURCE_FINGERPRINT_SCHEME, resourceCount: resources, totalBytes: bytes });
      assert.equal(segments.reduce((sum, segment) => sum + segment.byteLength, 0), prepared.canonicalByteLength);
    }
  }
  const largest = prepareCanonicalSource({ kind: 'single',
    resources: [resource('', 'primary', Number.MAX_SAFE_INTEGER)] });
  assert.equal(largest.canonicalByteLength, Buffer.from(SINGLE_HEX, 'hex').byteLength);
  assert.equal(largest.totalBytes, Number.MAX_SAFE_INTEGER);
});

test('prepared descriptors freeze public scalars and isolate later input and emitted-buffer mutations', () => {
  const primary = { ...resource('m.json', 'primary', 2, OBJECT_DIGEST) };
  const referenced = { ...resource('textures/é.bin', 'referenced', 1, ZERO_DIGEST) };
  const mutable = { kind: 'group', resources: [referenced, primary] };
  const prepared = prepareCanonicalSource(mutable as SourceFingerprintInput);
  assert.ok(Object.isFrozen(prepared));
  assert.deepEqual(Object.keys(prepared).sort(),
    ['canonicalByteLength', 'resourceCount', 'scheme', 'totalBytes', 'write']);
  assert.equal(Reflect.set(prepared, 'canonicalByteLength', 0), false);
  assert.equal(Reflect.set(prepared, 'write', () => undefined), false);
  mutable.kind = 'single';
  primary.path = '../changed'; primary.role = 'referenced'; primary.byteLength = -1; primary.sha256.fill(0);
  referenced.path = ''; referenced.byteLength = 999; referenced.sha256.fill(0);
  mutable.resources.splice(0, 2, { ...resource() });
  const write = prepared.write; // The closure does not depend on a mutable receiver.
  const first: Uint8Array[] = [];
  write((segment) => { first.push(segment); }, 11);
  assert.equal(Buffer.concat(first).toString('hex'), GROUP_HEX);
  for (const segment of first) segment.fill(0);
  const second: Uint8Array[] = [];
  write((segment) => { second.push(segment); }, 11);
  assert.equal(Buffer.concat(second).toString('hex'), GROUP_HEX);
  assert.equal(new Set([...first, ...second].map((segment) => segment.buffer)).size, first.length + second.length);
  assert.equal(prepared.canonicalByteLength, Buffer.from(GROUP_HEX, 'hex').byteLength);
});

test('preparation reads descriptor fields once and repeated writes never read them again', () => {
  const reads = { kind: 0, resources: 0, length: 0, entry: 0, path: 0, role: 0, byteLength: 0, sha256: 0 };
  const once = (key: keyof typeof reads, value: unknown) => {
    assert.equal(++reads[key], 1, `Unexpected repeated ${key} read`);
    return value;
  };
  const supplied = Object.defineProperties({}, {
    path: { get: () => once('path', 'm.json') },
    role: { get: () => once('role', 'primary') },
    byteLength: { get: () => once('byteLength', 3) },
    sha256: { get: () => once('sha256', Buffer.from(ABC_DIGEST, 'hex')) },
  }) as SourceResourceDigest;
  const resources = new Proxy([supplied], { get: (target, key, receiver) => {
    if (key === 'length') return once('length', 1);
    if (key === '0') return once('entry', supplied);
    if (key === Symbol.iterator) throw new Error('The untrusted iterator must not be read');
    return Reflect.get(target, key, receiver);
  } });
  const input = Object.defineProperties({}, {
    kind: { get: () => once('kind', 'group') },
    resources: { get: () => once('resources', resources) },
  }) as SourceFingerprintInput;
  const prepared = prepareCanonicalSource(input);
  assert.deepEqual(reads, { kind: 1, resources: 1, length: 1, entry: 1, path: 1, role: 1, byteLength: 1, sha256: 1 });
  assert.equal(prepared.canonicalByteLength, Buffer.from(PRIMARY_ONLY_GROUP_HEX, 'hex').byteLength);
  for (const limit of [1, 17]) {
    const segments: Uint8Array[] = [];
    prepared.write((segment) => { segments.push(segment); }, limit);
    assert.equal(Buffer.concat(segments).toString('hex'), PRIMARY_ONLY_GROUP_HEX);
  }
});

test('prepared writes have independent state when a consumer starts another write', () => {
  const prepared = prepareCanonicalSource(group());
  const outer: Uint8Array[] = [];
  const inner: Uint8Array[] = [];
  prepared.write((segment) => {
    outer.push(segment);
    if (outer.length === 1) prepared.write((nested) => { inner.push(nested); }, 13);
  }, 7);
  assert.equal(Buffer.concat(outer).toString('hex'), GROUP_HEX);
  assert.equal(Buffer.concat(inner).toString('hex'), GROUP_HEX);
  assert.equal(new Set([...outer, ...inner].map((segment) => segment.buffer)).size, outer.length + inner.length);
});

test('all segment limits preserve exact canonical bytes, including split scalar bytes', () => {
  for (const limit of [1, 2, 3, 7, 16, 31, 32, 64, 69, 70, 128, MAX_CANONICAL_SEGMENT_BYTES]) {
    const segments: Uint8Array[] = [];
    writeCanonicalSource(group(), (segment) => { segments.push(segment); }, limit);
    assert.ok(segments.every((segment) => segment.length > 0 && segment.length <= limit));
    assert.ok(segments.every((segment) => segment.buffer.byteLength <= limit));
    assert.equal(Buffer.concat(segments).toString('hex'), GROUP_HEX);
    assert.equal(digest(single(), limit), SINGLE_HASH);
  }
});

test('empty resources and exact safe uint64 file lengths retain their actual lengths', () => {
  const empty: SourceFingerprintInput = { kind: 'single', resources: [resource('', 'primary', 0, EMPTY_DIGEST)] };
  const emptyExpected = '53706c617456696577536f7572636500763100000000000101000000000000000000000000' + EMPTY_DIGEST;
  assert.equal(prepareCanonicalSource(empty).canonicalByteLength, Buffer.from(emptyExpected, 'hex').byteLength);
  assert.equal(collect(empty).toString('hex'), emptyExpected);
  const largest: SourceFingerprintInput = { kind: 'single', resources: [resource('', 'primary', Number.MAX_SAFE_INTEGER)] };
  assert.equal(collect(largest).subarray(29, 37).toString('hex'), '001fffffffffffff');
});

test('encoder snapshots kind, paths, roles, lengths and mutable digests before first emission', () => {
  const mutable = { kind: 'single', resources: [{ path: '', role: 'primary', byteLength: 3,
    sha256: Buffer.from(ABC_DIGEST, 'hex') }] };
  const segments: Uint8Array[] = [];
  writeCanonicalSource(mutable as SourceFingerprintInput, (segment) => {
    segments.push(segment);
    mutable.kind = 'group'; mutable.resources[0]!.path = 'changed';
    mutable.resources[0]!.role = 'referenced'; mutable.resources[0]!.byteLength = 0;
    mutable.resources[0]!.sha256.fill(0);
  }, 1);
  assert.equal(Buffer.concat(segments).toString('hex'), SINGLE_HEX);
});

test('emitted segments are independently owned and are never reused or overwritten', () => {
  const segments: Uint8Array[] = [];
  writeCanonicalSource(group(), (segment) => { segments.push(segment); }, 11);
  assert.equal(new Set(segments.map((segment) => segment.buffer)).size, segments.length);
  assert.equal(Buffer.concat(segments).toString('hex'), GROUP_HEX);
  segments[0]!.fill(0);
  assert.equal(Buffer.from(segments[1]!).toString('hex'), Buffer.from(GROUP_HEX, 'hex').subarray(11, 22).toString('hex'));
});

test('a path longer than a segment is encoded without a path-sized emitted backing buffer', () => {
  const path = '😀'.repeat(600_000); // 2.4 MiB of canonical UTF-8.
  const input: SourceFingerprintInput = { kind: 'group', resources: [resource(path)] };
  const prepared = prepareCanonicalSource(input);
  assert.equal(prepared.canonicalByteLength, 24 + 45 + 2_400_000);
  let count = 0;
  let bytes = 0;
  const actual = createHash('sha256');
  prepared.write((segment) => {
    count++; bytes += segment.byteLength;
    assert.ok(segment.byteLength <= MAX_CANONICAL_SEGMENT_BYTES);
    assert.ok(segment.buffer.byteLength <= MAX_CANONICAL_SEGMENT_BYTES);
    actual.update(segment);
  });
  const independent = createHash('sha256');
  independent.update(Buffer.from('53706c617456696577536f757263650076310001000000010100249f00', 'hex'));
  independent.update(new TextEncoder().encode(path));
  independent.update(Buffer.from('0000000000000003' + ABC_DIGEST, 'hex'));
  assert.equal(bytes, 24 + 45 + 2_400_000);
  assert.equal(count, 3);
  assert.equal(actual.digest('hex'), independent.digest('hex'));
});

test('non-BMP sorting follows literal UTF-8 path order and preserves distinct spellings', () => {
  const input: SourceFingerprintInput = { kind: 'group', resources: [
    resource('\u{10000}', 'referenced', 0, EMPTY_DIGEST), resource('\ue000', 'primary', 0, EMPTY_DIGEST),
  ] };
  const expected = '53706c617456696577536f75726365007631000100000002' +
    '0100000003ee80800000000000000000' + EMPTY_DIGEST +
    '0000000004f09080800000000000000000' + EMPTY_DIGEST;
  assert.equal(collect(input).toString('hex'), expected);
  assert.notEqual(digest({ kind: 'group', resources: [resource('é')] }),
    digest({ kind: 'group', resources: [resource('e\u0301')] }));
  assert.notEqual(digest({ kind: 'group', resources: [resource('A')] }),
    digest({ kind: 'group', resources: [resource('a')] }));
});

test('identical renamed single-file copies share the content key while hints remain separate', () => {
  const first = { displayName: 'original.ply', modified: 1, input: single() };
  const renamed = { displayName: 'copy-renamed.ply', modified: 999, input: single() };
  assert.equal(digest(first.input), digest(renamed.input));
  const summary = writeCanonicalSource(first.input, () => undefined);
  const record = finishSourceFingerprint(summary, Buffer.from(SINGLE_HASH, 'hex'), 'gaussian-ply');
  assert.deepEqual(record, { scheme: SOURCE_FINGERPRINT_SCHEME, assetDigest: SINGLE_HASH,
    resourceCount: 1, totalBytes: 3, sourceKindHint: 'gaussian-ply' });
  assert.equal('displayName' in record, false);
  assert.equal('modified' in record, false);
});

test('changed referenced digest, path, role and byte length change the content key', () => {
  const original = group();
  const baseline = digest(original);
  for (const changed of [
    [resource('textures/é.bin', 'referenced', 1, ABC_DIGEST), original.resources[1]!],
    [resource('textures/renamed.bin', 'referenced', 1, ZERO_DIGEST), original.resources[1]!],
    [resource('textures/é.bin', 'primary', 1, ZERO_DIGEST), resource('m.json', 'referenced', 2, OBJECT_DIGEST)],
    [resource('textures/é.bin', 'referenced', 2, ZERO_DIGEST), original.resources[1]!],
  ]) assert.notEqual(digest({ kind: 'group', resources: changed }), baseline);
});

const malformed: [string, unknown][] = [
  ['unknown asset kind', { kind: 'other', resources: [resource()] }],
  ['missing input', null],
  ['missing resources', { kind: 'single' }],
  ['zero resources', { kind: 'group', resources: [] }],
  ['single with multiple resources', { kind: 'single', resources: [resource(), resource('a', 'referenced')] }],
  ['named single', { kind: 'single', resources: [resource('a')] }],
  ['empty group path', { kind: 'group', resources: [resource()] }],
  ['group dot path', { kind: 'group', resources: [resource('a/../b')] }],
  ['group backslash path', { kind: 'group', resources: [resource('a\\b')] }],
  ['group invalid Unicode', { kind: 'group', resources: [resource('\ud800')] }],
  ['duplicate paths', { kind: 'group', resources: [resource('a'), resource('a', 'referenced')] }],
  ['file and directory collision', { kind: 'group', resources: [resource('a'), resource('a/b', 'referenced')] }],
  ['no primary', { kind: 'single', resources: [resource('', 'referenced')] }],
  ['multiple primary', { kind: 'group', resources: [resource('a'), resource('b')] }],
  ['invalid role', { kind: 'single', resources: [{ ...resource(), role: 'owner' }] }],
  ['sparse resources', { kind: 'group', resources: new Array(1) }],
  ['short digest', { kind: 'single', resources: [{ ...resource(), sha256: new Uint8Array(31) }] }],
  ['long digest', { kind: 'single', resources: [{ ...resource(), sha256: new Uint8Array(33) }] }],
  ['non-byte digest', { kind: 'single', resources: [{ ...resource(), sha256: new Int8Array(32) }] }],
  ['hex instead of byte digest', { kind: 'single', resources: [{ ...resource(), sha256: ABC_DIGEST }] }],
  ['unsafe total', { kind: 'group', resources: [resource('a', 'primary', Number.MAX_SAFE_INTEGER), resource('b', 'referenced', 1)] }],
  ['uint32 count overflow', { kind: 'group', resources: new Proxy([], { get: (target, key, receiver) =>
    key === 'length' ? 0x1_0000_0000 : Reflect.get(target, key, receiver) }) }],
];
for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, 2 ** 64, NaN, Infinity, '3', 3n, null]) {
  malformed.push([`invalid length ${typeof value} ${String(value)}`, { kind: 'single', resources: [{ ...resource(), byteLength: value }] }]);
}
for (const [label, input] of malformed) {
  test(`canonical encoding rejects ${label} before any emission`, () => {
    let emissions = 0;
    assert.throws(() => writeCanonicalSource(input as SourceFingerprintInput, () => { emissions++; }, 1));
    assert.equal(emissions, 0);
    assert.throws(() => prepareCanonicalSource(input as SourceFingerprintInput));
  });
}

test('invalid segment limits and consumer are refused before any emission', () => {
  for (const limit of [0, -1, 0.5, NaN, Infinity, MAX_CANONICAL_SEGMENT_BYTES + 1]) {
    assert.throws(() => writeCanonicalSource(single(), () => assert.fail('unexpected emission'), limit));
  }
  assert.throws(() => writeCanonicalSource(single(), null as never));
});

test('legacy consumer and limit refusal happens before reading the descriptor', () => {
  let reads = 0;
  const input = Object.defineProperty({}, 'kind', { get: () => {
    reads++; throw new Error('Descriptor must not be read');
  } }) as SourceFingerprintInput;
  assert.throws(() => writeCanonicalSource(input, null as never, 0), /consumer is required/);
  assert.throws(() => writeCanonicalSource(input, () => undefined, 0), /segment limit/);
  assert.equal(reads, 0);
});

test('invalid or failed prepared writes leave the snapshot reusable', () => {
  const prepared = prepareCanonicalSource(group());
  let emissions = 0;
  for (const limit of [0, -1, 0.5, NaN, Infinity, MAX_CANONICAL_SEGMENT_BYTES + 1]) {
    assert.throws(() => prepared.write(() => { emissions++; }, limit), /segment limit/);
  }
  assert.throws(() => prepared.write(null as never), /consumer is required/);
  assert.equal(emissions, 0);
  const failure = new Error('stopped');
  assert.throws(() => prepared.write(() => { emissions++; throw failure; }, 1), (error) => error === failure);
  assert.equal(emissions, 1);
  assert.throws(() => prepared.write(() => { emissions++; return Promise.resolve(); }, 1), /synchronously/);
  assert.equal(emissions, 2);
  const segments: Uint8Array[] = [];
  prepared.write((segment) => { segments.push(segment); }, 7);
  assert.equal(Buffer.concat(segments).toString('hex'), GROUP_HEX);
});

test('consumer failures stop emission and asynchronous consumers are refused', () => {
  const failure = new Error('stopped');
  let emissions = 0;
  assert.throws(() => writeCanonicalSource(group(), () => { emissions++; throw failure; }, 1),
    (error) => error === failure);
  assert.equal(emissions, 1);
  emissions = 0;
  assert.throws(() => writeCanonicalSource(group(), () => { emissions++; return Promise.resolve(); }, 1), /synchronously/);
  assert.equal(emissions, 1);
});

test('finish rejects unsupported/corrupt summaries and malformed digest or hint', () => {
  const summary = { scheme: SOURCE_FINGERPRINT_SCHEME, resourceCount: 1, totalBytes: 3 };
  for (const changed of [
    { ...summary, scheme: 'filename-only' }, { ...summary, resourceCount: 0 },
    { ...summary, resourceCount: 0x1_0000_0000 }, { ...summary, totalBytes: -1 },
    { ...summary, totalBytes: Number.MAX_SAFE_INTEGER + 1 },
  ]) assert.throws(() => finishSourceFingerprint(changed as typeof summary, Buffer.from(SINGLE_HASH, 'hex'), 'ply'));
  assert.throws(() => finishSourceFingerprint(summary, new Uint8Array(31), 'ply'));
  assert.throws(() => finishSourceFingerprint(summary, Buffer.from(SINGLE_HASH, 'hex'), ''));
});

test('canonical resource count and encoded table use numeric array entries rather than a custom iterator', () => {
  const resources = [resource('m.json')];
  let iterations = 0;
  Object.defineProperty(resources, Symbol.iterator, { value: function* () {
    iterations++; yield resource('m.json'); yield resource('extra.bin', 'referenced');
  } });
  const input: SourceFingerprintInput = { kind: 'group', resources };
  assert.equal(collect(input).toString('hex'), PRIMARY_ONLY_GROUP_HEX);
  assert.equal(iterations, 0);
});

test('canonical input kind, resource array, length, and numeric entries are read once', () => {
  const reads = { kind: 0, resources: 0, length: 0, first: 0 };
  const resources = new Proxy([resource('m.json'), resource('other.bin', 'referenced')], {
    get: (target, key, receiver) => {
      if (key === 'length') return ++reads.length === 1 ? 1 : 2;
      if (key === '0') reads.first++;
      if (key === Symbol.iterator) throw new Error('The untrusted iterator must not be read');
      return Reflect.get(target, key, receiver);
    },
  });
  const input = Object.defineProperties({}, {
    kind: { get: () => ++reads.kind === 1 ? 'group' : 'single' },
    resources: { get: () => ++reads.resources === 1 ? resources : [] },
  }) as SourceFingerprintInput;
  assert.equal(collect(input).toString('hex'), PRIMARY_ONLY_GROUP_HEX);
  assert.deepEqual(reads, { kind: 1, resources: 1, length: 1, first: 1 });
});

test('changing per-resource getters are captured once before validation and encoding', () => {
  const reads = { path: 0, role: 0, byteLength: 0, sha256: 0 };
  const changing = Object.defineProperties({}, {
    path: { get: () => ++reads.path === 1 ? 'm.json' : '../escaped' },
    role: { get: () => ++reads.role === 1 ? 'primary' : 'referenced' },
    byteLength: { get: () => ++reads.byteLength === 1 ? 3 : -1 },
    sha256: { get: () => ++reads.sha256 === 1 ? Buffer.from(ABC_DIGEST, 'hex') : new Uint8Array(31) },
  }) as SourceResourceDigest;
  assert.equal(collect({ kind: 'group', resources: [changing] }).toString('hex'), PRIMARY_ONLY_GROUP_HEX);
  assert.deepEqual(reads, { path: 1, role: 1, byteLength: 1, sha256: 1 });
});

test('an invalid first resource getter value cannot be replaced by a valid later read', () => {
  let reads = 0;
  const changing = Object.defineProperties({ ...resource('m.json') }, {
    path: { get: () => ++reads === 1 ? '../escaped' : 'm.json' },
  });
  let emissions = 0;
  assert.throws(() => writeCanonicalSource({ kind: 'group', resources: [changing] }, () => { emissions++; }));
  assert.equal(reads, 1);
  assert.equal(emissions, 0);
});

test('resource and final asset digests copy actual typed-array bytes without custom iteration', () => {
  const custom = Buffer.from(ABC_DIGEST, 'hex');
  Object.defineProperty(custom, Symbol.iterator, { value: function* () { yield 0; } });
  assert.equal(collect({ kind: 'single', resources: [{ ...resource(), sha256: custom }] }).toString('hex'), SINGLE_HEX);
  assert.equal(finishSourceFingerprint({ scheme: SOURCE_FINGERPRINT_SCHEME, resourceCount: 1, totalBytes: 3 },
    custom, 'ply').assetDigest, ABC_DIGEST);
  const short = new Uint8Array(31);
  Object.defineProperty(short, 'length', { get: () => 32 });
  assert.throws(() => writeCanonicalSource({ kind: 'single', resources: [{ ...resource(), sha256: short }] },
    () => assert.fail('Unexpected emission')), /exactly 32 bytes/);
  assert.throws(() => finishSourceFingerprint({ scheme: SOURCE_FINGERPRINT_SCHEME, resourceCount: 1, totalBytes: 3 },
    short, 'ply'), /exactly 32 bytes/);
});

test('fingerprint completion snapshots summary getters before validation and publication', () => {
  const reads = { scheme: 0, resourceCount: 0, totalBytes: 0 };
  const summary = Object.defineProperties({}, {
    scheme: { get: () => ++reads.scheme === 1 ? SOURCE_FINGERPRINT_SCHEME : 'corrupt' },
    resourceCount: { get: () => ++reads.resourceCount === 1 ? 1 : 0 },
    totalBytes: { get: () => ++reads.totalBytes === 1 ? 3 : -1 },
  }) as Parameters<typeof finishSourceFingerprint>[0];
  const result = finishSourceFingerprint(summary, Buffer.from(SINGLE_HASH, 'hex'), 'ply');
  assert.equal(result.resourceCount, 1);
  assert.equal(result.totalBytes, 3);
  assert.deepEqual(reads, { scheme: 1, resourceCount: 1, totalBytes: 1 });
});

test('a rejected asynchronous consumer is refused and observed without an unhandled rejection', async () => {
  const unhandled: unknown[] = [];
  const observe = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', observe);
  try {
    let emissions = 0;
    assert.throws(() => writeCanonicalSource(group(), () => {
      emissions++;
      return Promise.reject(new Error('consumer rejection'));
    }, 1), /synchronously/);
    assert.equal(emissions, 1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', observe);
  }
});

test('an asynchronous thenable is observed using its captured then once', async () => {
  let thenReads = 0;
  let observations = 0;
  const thenable = Object.defineProperty({}, 'then', { get: () => {
    if (++thenReads > 1) throw new Error('The then getter was read again');
    return (_resolve: (value: unknown) => void, reject: (reason: unknown) => void) => {
      observations++; reject(new Error('thenable rejected'));
    };
  } });
  assert.throws(() => writeCanonicalSource(group(), () => thenable, 1), /synchronously/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(thenReads, 1);
  assert.equal(observations, 1);
});
