import { describe, expect, it } from 'vitest';
import { sourceStageBytes, sourceWorkerBytes, synchronousSourceHook, validateSourceDescriptor, validateSourceFingerprint,
  validateSourceRange, type SourceDescriptor } from '../src/document/source';
import type { NativeSummary } from '../src/document/types';

const MiB = 1_048_576;
function descriptor(byteLength = 4): SourceDescriptor {
  return { kind: 'single', operationId: 'candidate', resourceId: 'primary', byteLength, path: '', role: 'primary' };
}
function summary(): NativeSummary {
  return { ok: true, duplicateRange: null, loaded: true, count: 3, sourceCount: 3, shDegree: 0, format: 'PLY', kind: 0,
    selected: 0, visible: 3, canUndo: false, canRedo: false, revision: 0, contentRevision: 0,
    transaction: false, selectionDraft: false, sceneChanged: false, pending: false, progress: 1,
    center: [0, 0, 0], radius: 1, yUp: false, camera: [0, 0, 0, 0, 0, 0, 1, 45, 1, 0, 1], memoryBytes: 1024,
    selectionMapId: null, pendingSelectionMapId: null, selectionMapBytes: 0, selectionMapRetainedIds: [], floor: null, filter: null, transformSession: null, opacitySession: null };
}
function fingerprint() {
  return { scheme: 'splatview-source-v1', assetDigest: 'b'.repeat(64), resourceCount: 1, totalBytes: 4, sourceKindHint: 'PLY' };
}

describe('single-file source descriptor and admission contract', () => {
  it('permits synchronous hooks and observes/refuses promise and custom-thenable hooks', async () => {
    for (const value of [undefined, null, 1, {}, () => undefined]) expect(() => synchronousSourceHook(value)).not.toThrow();
    expect(() => synchronousSourceHook(Promise.resolve())).toThrow(/synchronously/);
    let observed = 0;
    expect(() => synchronousSourceHook({ then(_resolve: unknown, reject: (reason: unknown) => void) {
      observed++; reject(new Error('thenable rejection was observed'));
    } })).toThrow(/synchronously/);
    await Promise.resolve(); expect(observed).toBe(1);
    expect(() => synchronousSourceHook({ get then(): never { throw new Error('invalid hook getter'); } })).toThrow('invalid hook getter');
  });
  it('snapshots each descriptor scalar once into a frozen independent object', () => {
    const input = descriptor(), counts = new Map<string, number>();
    const getters = Object.fromEntries(Object.keys(input).map(key => [key, { enumerable: true, get() {
      counts.set(key, (counts.get(key) ?? 0) + 1); return input[key as keyof SourceDescriptor];
    } }]));
    const result = validateSourceDescriptor(Object.defineProperties({}, getters));
    expect(result).toEqual(descriptor()); expect(Object.isFrozen(result)).toBe(true);
    expect([...counts.values()]).toEqual([1, 1, 1, 1, 1, 1]);
    Object.assign(input, { operationId: 'changed', resourceId: 'changed', byteLength: 999 });
    expect(result).toEqual(descriptor());
    expect(() => { (result as { byteLength: number }).byteLength = 8; }).toThrow();
  });
  it.each([null, undefined, [], 'file', 4, {}, new Uint8Array(4)])('case %#: rejects non-descriptor shape %j', input => {
    expect(() => validateSourceDescriptor(input)).toThrow();
  });
  it.each([
    ['group kind', { kind: 'group' }], ['wrong role', { role: 'referenced' }], ['nonempty path', { path: 'a.ply' }],
    ['missing path', { path: undefined }], ['numeric operation', { operationId: 1 }], ['empty operation', { operationId: '' }],
    ['long operation', { operationId: 'o'.repeat(129) }], ['empty resource', { resourceId: '' }],
    ['long resource', { resourceId: 'r'.repeat(129) }], ['boxed resource', { resourceId: new String('primary') }],
    ['negative length', { byteLength: -1 }], ['fractional length', { byteLength: .5 }], ['NaN length', { byteLength: NaN }],
    ['infinite length', { byteLength: Infinity }], ['string length', { byteLength: '4' }], ['bigint length', { byteLength: 4n }],
    ['uint32 overflow', { byteLength: 0x1_0000_0000 }], ['extra field', { file: new Blob() }],
  ] as const)('rejects %s before allocation', (_label, change) => {
    expect(() => validateSourceDescriptor({ ...descriptor(), ...change })).toThrow();
  });
  it('requires all six fields to be own properties and propagates failed snapshots', () => {
    expect(() => validateSourceDescriptor(Object.create(descriptor()))).toThrow();
    const input = { ...descriptor(), get byteLength(): number { throw new Error('cannot inspect source'); } };
    expect(() => validateSourceDescriptor(input)).toThrow('cannot inspect source');
  });
  it('accepts exact opaque ID and uint32 boundaries without coercion', () => {
    for (const byteLength of [0, 0xffff_ffff]) {
      const result = validateSourceDescriptor({ ...descriptor(byteLength), operationId: 'o'.repeat(128), resourceId: 'r'.repeat(128) });
      expect(result.byteLength).toBe(byteLength); expect(result.operationId.length).toBe(128);
    }
  });
  it.each([[0, 65_536, 65_536], [4, 65_540, 65_544], [MiB, 1_114_112, 2_162_688],
    [MiB + 1, 1_114_113, 2_162_689], [0xffff_ffff, 4_295_032_831, 4_296_081_407]])(
    'accounts for native input %i plus fixed work and one receive credit', (bytes, stage, worker) => {
      expect(sourceStageBytes(bytes)).toBe(stage); expect(sourceWorkerBytes(bytes)).toBe(worker);
    });
  it.each([-1, .5, NaN, Infinity, 0x1_0000_0000, '4', null, undefined, 4n])('refuses invalid admission length %s', bytes => {
    expect(() => sourceStageBytes(bytes as number)).toThrow(); expect(() => sourceWorkerBytes(bytes as number)).toThrow();
  });
});

describe('source range credit contract', () => {
  it('copies one full chunk and the exact tail into independent frozen ranges', () => {
    const source = descriptor(MiB + 3), input = { operationId: 'candidate', resourceId: 'primary', rangeId: 0, offset: 0, length: MiB };
    const first = validateSourceRange(input, source, 0, 0); input.length = 1;
    expect(first).toEqual({ operationId: 'candidate', resourceId: 'primary', rangeId: 0, offset: 0, length: MiB });
    expect(Object.isFrozen(first)).toBe(true);
    const tail = validateSourceRange({ ...input, rangeId: 1, offset: MiB, length: 3 }, source, 1, MiB);
    expect(tail.length).toBe(3); expect(Object.isFrozen(tail)).toBe(true);
  });
  it.each([
    ['wrong operation', { operationId: 'other' }], ['wrong resource', { resourceId: 'other' }],
    ['string ID', { rangeId: '0' }], ['negative ID', { rangeId: -1 }], ['fractional ID', { rangeId: .5 }],
    ['out of order ID', { rangeId: 1 }], ['ID overflow', { rangeId: 0x1_0000_0000 }],
    ['gap', { offset: 1 }], ['negative offset', { offset: -1 }], ['fractional offset', { offset: .5 }],
    ['string offset', { offset: '0' }], ['zero credit', { length: 0 }], ['short credit', { length: 3 }],
    ['long credit', { length: 5 }], ['string credit', { length: '4' }], ['unsafe credit', { length: Number.MAX_SAFE_INTEGER + 1 }],
  ] as const)('refuses %s without advancing the expected range', (_label, change) => {
    const range = { operationId: 'candidate', resourceId: 'primary', rangeId: 0, offset: 0, length: 4 };
    expect(() => validateSourceRange({ ...range, ...change }, descriptor(), 0, 0)).toThrow();
    expect(validateSourceRange(range, descriptor(), 0, 0)).toEqual(range);
  });
  it('refuses a range after complete input, beyond its end, or for an empty input', () => {
    for (const [source, offset] of [[descriptor(), 4], [descriptor(), 5], [descriptor(0), 0]] as const)
      expect(() => validateSourceRange({ operationId: 'candidate', resourceId: 'primary', rangeId: 1, offset, length: 1 }, source, 1, offset)).toThrow();
  });
  it('requires the full one-MiB credit when more input remains and rejects shared runtime shapes', () => {
    expect(() => validateSourceRange({ operationId: 'candidate', resourceId: 'primary', rangeId: 0, offset: 0, length: MiB - 1 }, descriptor(MiB + 1), 0, 0)).toThrow();
    for (const input of [null, undefined, [], 4]) expect(() => validateSourceRange(input, descriptor(), 0, 0)).toThrow();
  });
});

describe('complete fingerprint publication contract', () => {
  it.each([0, 1, 2])('accepts only a completed native kind %i and returns a frozen private scalar snapshot', kind => {
    const input = fingerprint(), result = validateSourceFingerprint(input, descriptor(), { ...summary(), kind });
    input.assetDigest = 'a'.repeat(64); input.sourceKindHint = 'SPLAT'; input.totalBytes = 999;
    expect(result).toEqual(fingerprint()); expect(Object.isFrozen(result)).toBe(true);
  });
  it.each([
    ['scheme', { scheme: 'splatview-source-v2' }], ['missing digest', { assetDigest: undefined }],
    ['uppercase digest', { assetDigest: 'B'.repeat(64) }], ['short digest', { assetDigest: 'b'.repeat(63) }],
    ['long digest', { assetDigest: 'b'.repeat(65) }], ['nonhex digest', { assetDigest: 'z'.repeat(64) }],
    ['digest bytes', { assetDigest: new Uint8Array(32) }], ['empty group', { resourceCount: 0 }],
    ['group count', { resourceCount: 2 }], ['string count', { resourceCount: '1' }],
    ['wrong total', { totalBytes: 3 }], ['string total', { totalBytes: '4' }], ['wrong decoded format', { sourceKindHint: 'SPLAT' }],
    ['empty format', { sourceKindHint: '' }], ['extra field', { filename: 'file.ply' }],
  ] as const)('refuses fingerprint %s', (_label, change) => {
    expect(() => validateSourceFingerprint({ ...fingerprint(), ...change }, descriptor(), summary())).toThrow();
  });
  it.each([
    { ok: false }, { loaded: false }, { pending: true }, { kind: 3 }, { kind: '0' }, { count: -1 }, { count: 3.5 },
    { count: 0x1_0000_0000 }, { sourceCount: 2 }, { sourceCount: NaN }, { shDegree: -1 }, { shDegree: 4 },
    { shDegree: .5 }, { format: 'SPLAT' }, { revision: -1 }, { contentRevision: .5 }, { memoryBytes: Infinity },
    { memoryBytes: Number.MAX_SAFE_INTEGER + 1 }, { transaction: true }, { selectionDraft: true }, { sceneChanged: true },
    { canUndo: true }, { canRedo: true }, { selected: 1 }, { visible: 4 }, { visible: -1 },
    { selectionMapId: 1 }, { pendingSelectionMapId: 1 }, { selectionMapBytes: 4 }, { selectionMapRetainedIds: [1] },
    { center: [0, 0] }, { center: [0, NaN, 0] }, { center: new Array(3) }, { radius: -1 }, { radius: Infinity }, { yUp: 1 },
    { camera: [] }, { camera: new Array(11) }, { camera: [0, 0, 0, 0, 0, 0, 1, 45, 1, 0, NaN] },
  ])('refuses incomplete or inconsistent native summary %j', change => {
    expect(() => validateSourceFingerprint(fingerprint(), descriptor(), { ...summary(), ...change } as unknown as NativeSummary)).toThrow();
  });
  it('refuses unknown shapes, inherited-only records and throwing accessors', () => {
    for (const input of [null, undefined, [], 'fingerprint', {}, Object.create(fingerprint())])
      expect(() => validateSourceFingerprint(input, descriptor(), summary())).toThrow();
    expect(() => validateSourceFingerprint({ ...fingerprint(), get totalBytes(): number { throw new Error('bad fingerprint'); } }, descriptor(), summary())).toThrow('bad fingerprint');
  });
  it('keeps actual native format spelling and includes zero-byte total only when the decoded summary is valid', () => {
    const input = { ...fingerprint(), totalBytes: 0, sourceKindHint: 'Custom native format' };
    expect(validateSourceFingerprint(input, descriptor(0), { ...summary(), format: 'Custom native format' })).toEqual(input);
    expect(() => validateSourceFingerprint(input, descriptor(0), { ...summary(), format: 'Custom native format', loaded: false })).toThrow();
  });
});
