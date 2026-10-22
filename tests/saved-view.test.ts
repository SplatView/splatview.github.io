import { describe, expect, it } from 'vitest';
import { MAX_SAVED_THUMBNAIL_BYTES, MAX_SAVED_VIEW_RECORD_BYTES, savedViewCameraState,
  savedViewFromCamera, savedViewMatches, thumbnailPlan, validateSavedViewRecord,
  type SavedView, type SavedViewRecord } from '../src/io/savedView';

const H = '0123456789abcdef'.repeat(4);
const otherHash = 'fedcba9876543210'.repeat(4);
function draft() {
  return { kind: 'splatview-saved-view' as const, schemaVersion: 1 as const,
    recordId: 'record/opaque:1', appVersion: '0.1.0', createdAt: 1000, updatedAt: 2000,
    source: { scheme: 'splatview-source-v1' as const, assetDigest: H, resourceCount: 1,
      totalBytes: 512, sourceKindHint: 'PLY' }, sourceKind: 'gaussian' as SavedViewRecord['sourceKind'],
    view: { target: [1, -2, 3] as [number, number, number], yaw: .5, pitch: -.25, distance: 8,
      radius: 2, fov: 45, yUp: true, roll: .125, background: 'gray' as SavedView['background'] },
    thumbnail: { type: 'image/png' as const, width: 320, height: 320, byteLength: 4096, sha256: H },
    displayName: 'first.ply' };
}
const valid = () => validateSavedViewRecord(draft());
const abi = [1, -2, 3, .5, -.25, 8, 2, 45, 1, .125, 1.6];

describe('pure version1 saved-view records', () => {
  it('makes a deep independent frozen snapshot without changing the input', () => {
    const input = draft(), before = JSON.stringify(input), record = validateSavedViewRecord(input);
    expect(JSON.stringify(input)).toBe(before); expect(record).toEqual(input);
    for (const value of [record, record.source, record.view, record.view.target, record.thumbnail]) expect(Object.isFrozen(value)).toBe(true);
    input.view.target[0] = 900; input.source.assetDigest = otherHash; input.thumbnail.width = 1;
    expect(record.view.target).toEqual([1, -2, 3]); expect(record.source.assetDigest).toBe(H);
    expect(record.thumbnail.width).toBe(320);
    expect(() => { (record.view.target as unknown as number[])[0] = 99; }).toThrow();
  });
  it('migrates only an absent legacy background to black and never mutates the legacy object', () => {
    const input = draft(), { background: _, ...legacyView } = input.view;
    void _;
    const legacy = { ...input, view: legacyView };
    expect(validateSavedViewRecord(legacy).view.background).toBe('black');
    expect(Object.hasOwn(legacyView, 'background')).toBe(false);
    for (const background of [undefined, null, '', 'Grey', 0, false])
      expect(() => validateSavedViewRecord({ ...legacy, view: { ...legacyView, background } })).toThrow();
  });
  it.each(['black', 'gray', 'white'] as const)('preserves the %s source-matched background', background => {
    const input = draft(); input.view.background = background;
    expect(validateSavedViewRecord(input).view.background).toBe(background);
  });
  it.each([null, undefined, [], 'record', new Date(), new Map(), 1])('case %#: refuses non-record', input => {
    expect(() => validateSavedViewRecord(input)).toThrow();
  });
  const invalidRoots: [string, Record<string, unknown>][] = [
    ['kind', { kind: 'scene' }], ['schema0', { schemaVersion: 0 }], ['schema2', { schemaVersion: 2 }],
    ['schema string', { schemaVersion: '1' }], ['empty id', { recordId: '' }], ['empty version', { appVersion: '' }],
    ['negative time', { createdAt: -1 }], ['fractional time', { createdAt: .5 }], ['unsafe time', { createdAt: 2 ** 53 }],
    ['infinite time', { updatedAt: Infinity }], ['reversed time', { updatedAt: 999 }],
    ['unknown source kind', { sourceKind: 'splat' }], ['nonstring display', { displayName: 7 }],
    ['unknown field', { aspect: 2 }], ['oversize id', { recordId: 'a'.repeat(8193) }],
    ['invalid Unicode', { displayName: '\ud800' }],
  ];
  it.each(invalidRoots)('refuses %s atomically', (_, patch) => {
    const input = { ...draft(), ...patch }, before = JSON.stringify(input);
    expect(() => validateSavedViewRecord(input)).toThrow(); expect(JSON.stringify(input)).toBe(before);
  });
  it('requires every version1 root field', () => {
    for (const key of Object.keys(draft())) {
      const input: Record<string, unknown> = { ...draft() }; delete input[key];
      expect(() => validateSavedViewRecord(input), key).toThrow();
    }
  });
  it('does not invoke accessor fields or accept custom prototypes/symbol fields', () => {
    const accessor = draft(); let calls = 0;
    Object.defineProperty(accessor, 'recordId', { enumerable: true, get() { calls++; throw new Error('called getter'); } });
    expect(() => validateSavedViewRecord(accessor)).toThrow(/data field/); expect(calls).toBe(0);
    expect(() => validateSavedViewRecord(Object.assign(Object.create({ parent: true }), draft()))).toThrow();
    expect(() => validateSavedViewRecord({ ...draft(), [Symbol('hidden')]: 1 })).toThrow();
    const hidden = draft(); Object.defineProperty(hidden, 'displayName', { value: 'hidden', enumerable: false });
    expect(() => validateSavedViewRecord(hidden)).toThrow();
  });
  it('accepts inert null-prototype input and empty display hints', () => {
    const input = Object.assign(Object.create(null), draft(), { displayName: '' });
    expect(validateSavedViewRecord(input).displayName).toBe('');
  });
  it('enforces the exact8192-byte serialized UTF8 record boundary', () => {
    const input = draft(); input.displayName = '';
    const baseline = new TextEncoder().encode(JSON.stringify(input)).length;
    input.displayName = 'a'.repeat(MAX_SAVED_VIEW_RECORD_BYTES - baseline);
    expect(new TextEncoder().encode(JSON.stringify(validateSavedViewRecord(input))).length).toBe(8192);
    input.displayName += 'a'; expect(() => validateSavedViewRecord(input)).toThrow(/8192/);
  });
  it('counts multibyte, quote and control escaping rather than UTF16 code units', () => {
    for (const prefix of ['é', '😀', '"', '\\', '\u0000', '\n']) {
      const input = draft(); input.displayName = prefix;
      const baseline = new TextEncoder().encode(JSON.stringify(input)).length;
      input.displayName += 'a'.repeat(8192 - baseline);
      expect(new TextEncoder().encode(JSON.stringify(validateSavedViewRecord(input))).length).toBe(8192);
      input.displayName += 'a'; expect(() => validateSavedViewRecord(input)).toThrow(/8192/);
    }
  });
});

describe('complete content matching without physical identity', () => {
  it('matches renames and independent identical copies without choosing among saved records', () => {
    const first = valid(), input = draft(); input.recordId = 'second'; input.displayName = 'renamed/copied.ply';
    input.createdAt = 1500; input.updatedAt = 2500; input.appVersion = 'future-display-version';
    const second = validateSavedViewRecord(input), current = { ...first.source };
    expect(savedViewMatches(first, current, 'gaussian')).toBe(true);
    expect(savedViewMatches(second, current, 'gaussian')).toBe(true);
    expect(first.recordId).not.toBe(second.recordId);
  });
  it.each([
    ['digest', { assetDigest: otherHash }], ['count', { resourceCount: 2 }], ['bytes', { totalBytes: 513 }],
    ['kind hint', { sourceKindHint: 'SOG v1' }], ['scheme', { scheme: 'future-scheme' }],
  ])('refuses changed source %s', (_, patch) => {
    const record = valid(); expect(savedViewMatches(record, { ...record.source, ...patch } as typeof record.source, 'gaussian')).toBe(false);
  });
  it.each(['points', 'mesh'] as const)('refuses mismatched decoded %s kind', kind => {
    const record = valid(); expect(savedViewMatches(record, record.source, kind)).toBe(false);
  });
  it('matches a complete resource group; changed metadata/extra/texture digests refuse', () => {
    const input = draft(); input.source.resourceCount = 6; input.source.totalBytes = 701; input.source.sourceKindHint = 'SOG v1';
    const record = validateSavedViewRecord(input);
    expect(savedViewMatches(record, { ...record.source }, 'gaussian')).toBe(true);
    for (const digit of ['a', 'b', 'c']) expect(savedViewMatches(record, { ...record.source, assetDigest: digit.repeat(64) }, 'gaussian')).toBe(false);
  });
  it('refuses a corrupt record at matching time without modifying either input', () => {
    const record = valid(), corrupt = { ...record, schemaVersion: 2 } as unknown as SavedViewRecord;
    const source = { ...record.source }, before = JSON.stringify(source);
    expect(savedViewMatches(corrupt, source, 'gaussian')).toBe(false); expect(JSON.stringify(source)).toBe(before);
  });
  it.each([
    { scheme: 'old' }, { assetDigest: H.toUpperCase() }, { assetDigest: '0'.repeat(63) },
    { resourceCount: 0 }, { resourceCount: 2 ** 32 }, { resourceCount: 1.1 }, { totalBytes: -1 },
    { totalBytes: 2 ** 53 }, { sourceKindHint: '' }, { sourceKindHint: 'a'.repeat(129) }, { unknown: 1 },
  ])('rejects malformed complete fingerprint %j', patch => {
    const input = draft(); expect(() => validateSavedViewRecord({ ...input, source: { ...input.source, ...patch } })).toThrow();
  });
  it('accepts exact safe-size/u32 fingerprint limits without a guessed source capacity cap', () => {
    const input = draft(); input.source.resourceCount = 0xffff_ffff; input.source.totalBytes = Number.MAX_SAFE_INTEGER;
    expect(validateSavedViewRecord(input).source).toEqual(input.source);
  });
});

describe('native ABI1 view snapshot/apply', () => {
  it('roundtrips independently expected eleven-field ordering and recomputes only viewport aspect', () => {
    const view = savedViewFromCamera(abi, 'white');
    expect(view).toEqual({ target: [1, -2, 3], yaw: .5, pitch: -.25, distance: 8, radius: 2,
      fov: 45, yUp: true, roll: .125, background: 'white' });
    const landscape = savedViewCameraState(view, 16 / 9), portrait = savedViewCameraState(view, 9 / 16);
    expect(landscape).toEqual([1, -2, 3, .5, -.25, 8, 2, 45, 1, .125, Math.fround(16 / 9)]);
    expect(portrait).toEqual([1, -2, 3, .5, -.25, 8, 2, 45, 1, .125, .5625]);
    landscape[0] = 99; expect(savedViewCameraState(view, 1)[0]).toBe(1);
    expect(Object.hasOwn(view, 'aspect')).toBe(false); expect(abi[10]).toBe(1.6);
  });
  it('normalizes native Float32 precision while preserving roll/up and signed zero', () => {
    const state = [0, -0, .1, .35, .18, 3, 1, 45, 0, -.2, 1.6];
    const view = savedViewFromCamera(state, 'black');
    expect(view.target).toEqual([0, -0, Math.fround(.1)]); expect(view.roll).toBe(Math.fround(-.2));
    expect(view.yUp).toBe(false); expect(savedViewCameraState(view, 1.6)).toEqual(state.map(Math.fround));
    state[0] = 10; expect(view.target[0]).toBe(0);
  });
  it('accepts native metadata endpoints, not a guessed tight angle/distance range', () => {
    for (const sign of [-1, 1]) {
      const state = [...abi]; state[0] = sign * 1e12; state[3] = sign * 1e12;
      state[4] = sign * Math.fround(1.5707964); state[9] = sign * 1e12;
      state[5] = Math.fround(2 ** -149); state[6] = 1e12; state[7] = sign < 0 ? 10 : 120;
      const view = savedViewFromCamera(state, 'gray');
      expect(view.yaw).toBe(sign * Math.fround(1e12)); expect(view.distance).toBeGreaterThan(0);
      expect(view.fov).toBe(sign < 0 ? 10 : 120);
    }
  });
  it.each([
    [0, NaN], [1, Infinity], [2, 1e13], [3, -1e13], [4, 1.58], [4, -1.58],
    [5, 0], [5, -1], [5, 1e-100], [6, 0], [6, 1e13], [7, 9], [7, 121], [8, 2], [8, true],
    [9, Infinity], [10, 0], [10, -1], [10, NaN],
  ])('refuses ABI field%d=%s', (index, value) => {
    const input: unknown[] = [...abi]; input[index as number] = value;
    expect(() => savedViewFromCamera(input as number[], 'gray')).toThrow();
  });
  it.each([[], abi.slice(0, 10), [...abi, 1]].map(state => ({ state })))('refuses malformed ABI length $state.length', ({ state }) => {
    expect(() => savedViewFromCamera(state, 'gray')).toThrow();
  });
  it('refuses sparse/accessor target entries and extra persisted aspect', () => {
    const input = draft(); delete (input.view.target as unknown[])[1];
    expect(() => validateSavedViewRecord(input)).toThrow();
    const getter = [1, 2, 3]; let calls = 0;
    Object.defineProperty(getter, '0', { get() { calls++; return 1; }, enumerable: true });
    expect(() => validateSavedViewRecord({ ...draft(), view: { ...draft().view, target: getter } })).toThrow();
    expect(calls).toBe(0);
    expect(() => validateSavedViewRecord({ ...draft(), view: { ...draft().view, aspect: 2 } })).toThrow();
  });
  it.each([0, -1, NaN, Infinity, 1e100, 1e-100])('refuses unusable current aspect%s before returning a state', aspect => {
    expect(() => savedViewCameraState(valid().view, aspect)).toThrow();
  });
});

describe('native centered-square thumbnail plan', () => {
  it.each([
    [1920, 1080, 1024, { x: 420, y: 0, side: 1080, width: 1024, height: 1024 }],
    [1080, 1920, 1024, { x: 0, y: 420, side: 1080, width: 1024, height: 1024 }],
    [1001, 600, 1024, { x: 200, y: 0, side: 600, width: 600, height: 600 }],
    [600, 1001, 1024, { x: 0, y: 200, side: 600, width: 600, height: 600 }],
    [7, 4, 1024, { x: 1, y: 0, side: 4, width: 4, height: 4 }],
    [1, 1, 1024, { x: 0, y: 0, side: 1, width: 1, height: 1 }],
    [2000, 2000, 256, { x: 0, y: 0, side: 2000, width: 256, height: 256 }],
    [320, 320, 0, { x: 0, y: 0, side: 320, width: 1, height: 1 }],
    [2048, 1024, 0xffff_ffff, { x: 512, y: 0, side: 1024, width: 1024, height: 1024 }],
  ] as const)('plans%d×%d max%d', (width, height, maximum, expected) => {
    const plan = thumbnailPlan(width, height, maximum); expect(plan).toEqual(expected); expect(Object.isFrozen(plan)).toBe(true);
  });
  it('uses the1024 default and accepts the exact native RGBA admission boundary', () => {
    expect(thumbnailPlan(16384, 4096)).toEqual({ x: 6144, y: 0, side: 4096, width: 1024, height: 1024 });
    expect(thumbnailPlan(16384, 1).width).toBe(1);
  });
  it.each([[0, 1], [1, 0], [-1, 1], [1.5, 2], [16385, 1], [1, 16385], [8192, 8193], [NaN, 1], [1, Infinity]])('refuses dimensions%s/%s', (width, height) => {
    expect(() => thumbnailPlan(width, height)).toThrow();
  });
  it.each([-1, .5, NaN, Infinity, 2 ** 32])('refuses invalid uint32 maximum%s', maximum => {
    expect(() => thumbnailPlan(1, 1, maximum)).toThrow();
  });
  it.each([
    { type: 'image/jpeg' }, { width: 0 }, { width: 1025, height: 1025 }, { height: 319 },
    { byteLength: 0 }, { byteLength: MAX_SAVED_THUMBNAIL_BYTES + 1 }, { sha256: 'A'.repeat(64) },
    { sha256: H + '0' }, { extra: true },
  ])('refuses malformed thumbnail metadata%j', patch => {
    const input = draft(); expect(() => validateSavedViewRecord({ ...input, thumbnail: { ...input.thumbnail, ...patch } })).toThrow();
  });
  it('validates a thumbnail identity without claiming its PNG bytes were decoded/hashed', () => {
    const input = draft(); input.thumbnail.width = input.thumbnail.height = 1;
    input.thumbnail.byteLength = MAX_SAVED_THUMBNAIL_BYTES;
    expect(validateSavedViewRecord(input).thumbnail).toEqual(input.thumbnail);
  });
});
