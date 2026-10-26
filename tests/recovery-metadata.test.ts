import { describe, expect, it } from 'vitest';
import { decodeRecoveryMetadata, encodeRecoveryMetadata, type RecoveryAppliedTools } from '../src/app/recoveryMetadata';
import { IDENTITY_ALIGNMENT_FRAME, type AlignmentFrame } from '../src/document/alignment';
import type { AlignmentSummary } from '../src/document/alignmentProtocol';
import { MAX_ALIGNMENT_VIEW_CHECKPOINTS, type AlignmentViewCheckpoint } from '../src/document/alignmentViews';
import type { ColorSessionSummary } from '../src/document/colorProtocol';
import type { DuplicateRange } from '../src/document/duplicateProtocol';
import { transformDefaults, type TransformMatrix, type TransformSessionSummary } from '../src/document/transformProtocol';
import { NEUTRAL_COLOR } from '../src/renderer/defaults';

function frame(x = 0): AlignmentFrame {
  const values = [...IDENTITY_ALIGNMENT_FRAME]; values[12] = x;
  return values as unknown as AlignmentFrame;
}
function alignment(branchId = 1, retainedBranchIds = [0, 1]): AlignmentSummary {
  return { version: 2, branchId, frame: frame(3), canReset: true, retainedBranchIds };
}
function checkpoint(branchId: number, value = branchId === 1 ? frame(3) : frame()): AlignmentViewCheckpoint {
  return { branchId, frame: value, activeRoll: .375, defaultRoll: -.25, corrected: true };
}
function input() {
  return { native: { kind: 0, count: 6, sourceCount: 12, shDegree: 3, format: 'PLY', duplicateRange: null as DuplicateRange }, alignment: alignment() as AlignmentSummary | null,
    activeCamera: [1, 2, 3, .25, -.125, 9, 2, 55, 1, .375, 1.5],
    defaultCamera: [4, 5, 6, .75, -.5, 7, 3, 65, 0, -.25, 1.5], background: 'gray' as const,
    alignmentViews: new Map([[0, checkpoint(0)], [1, checkpoint(1)]]), savedContent: 4,
    applied: { color: null, transform: null, opacity: null } as RecoveryAppliedTools };
}
function color(): ColorSessionSummary {
  const applied = [...NEUTRAL_COLOR]; applied[0] = 1.25;
  return { version: 1, active: true, sessionId: 2, baseId: 3, epochId: 4, selectedOnly: true,
    values: [...applied], applied, pending: false };
}
function transform(): TransformSessionSummary {
  return { id: 5, baseId: 6, epoch: 7, appliedEpoch: 7, kind: 'numeric', selectedOnly: true, gizmo: null,
    appliedMatrix: [...IDENTITY_ALIGNMENT_FRAME] as TransformMatrix, pivot: [1, 2, 3] };
}
function frozenTree(value: unknown): boolean {
  if (!value || typeof value !== 'object') return true;
  return Object.isFrozen(value) && Object.values(value).every(frozenTree);
}

describe('committed browser recovery metadata', () => {
  it('roundtrips exact camera/default, background, save baseline and alignment branch roll lineage as JSON', () => {
    const original = input(), encoded = encodeRecoveryMetadata(original);
    expect(encoded.version).toBe(2); expect(encoded.native).toEqual(original.native);
    expect(encoded.activeCamera).toEqual(original.activeCamera); expect(encoded.defaultCamera).toEqual(original.defaultCamera);
    expect(encoded.background).toBe('gray'); expect(encoded.savedContent).toBe(4);
    expect(new Map(encoded.alignmentViews)).toEqual(original.alignmentViews);
    expect(decodeRecoveryMetadata(JSON.parse(JSON.stringify(encoded)))).toEqual(encoded);
    expect(frozenTree(encoded)).toBe(true);
  });
  it('finalizes gizmo recovery metadata instead of offering Cancel without its native original baseline', () => {
    const original = input(), parameters = transformDefaults();
    original.applied = { ...original.applied, transform: { session: { ...transform(), kind: 'gizmo', appliedEpoch: null,
      gizmo: { cancelBaseId: 4, cancelContentRevision: 2, canUndo: true, canRedo: false } }, parameters } };
    expect(encodeRecoveryMetadata(original).applied.transform).toBeNull();
  });
  it('retains acknowledged tool identities and applied parameters without retaining desired previews', () => {
    const original = input(), parameters = transformDefaults(); parameters.translation = [2, 3, 4];
    original.applied = { color: color(), transform: { session: transform(), parameters }, opacity: null };
    const encoded = encodeRecoveryMetadata(original), decoded = decodeRecoveryMetadata(encoded);
    expect(decoded.applied).toEqual(original.applied);
    expect(decoded.applied.transform!.session).not.toBe(original.applied.transform!.session);
    expect(decoded.applied.transform!.parameters.translation).not.toBe(parameters.translation);
    expect(frozenTree(decoded.applied)).toBe(true);
    parameters.translation[0] = 99;
    (original.applied.color!.applied as number[])[0] = 2;
    expect(decoded.applied.transform!.parameters.translation).toEqual([2, 3, 4]);
    expect(decoded.applied.color!.applied[0]).toBe(1.25);
  });
  it('preserves an applied opacity Reset owner without an unfinished UI scale', () => {
    const original = input(); original.applied = { color: null, transform: null,
      opacity: { id: 3, baseId: 4, epoch: 5, appliedEpoch: 5, selectedOnly: false, appliedScale: .5 } };
    expect(encodeRecoveryMetadata(original).applied.opacity).toEqual(original.applied.opacity);
  });
  it('accepts a correctly transposed wire matrix as the applied transform UI representation', () => {
    const original = input(), session = transform(), parameters = transformDefaults();
    session.appliedMatrix[12] = 5;
    parameters.mode = 'matrix'; parameters.matrix[3] = 5;
    original.applied = { color: null, transform: { session, parameters }, opacity: null };
    const metadata = encodeRecoveryMetadata(original);
    expect(metadata.applied.transform!.session.appliedMatrix[12]).toBe(5);
    expect(metadata.applied.transform!.parameters.matrix[3]).toBe(5);
    parameters.matrix[3] = 0; parameters.matrix[12] = 5;
    expect(() => encodeRecoveryMetadata(original)).toThrow(/applied transform/);
  });
  it('copies all browser aliases before returning and canonicalizes signed zero through JSON', () => {
    const original = input(); original.activeCamera[0] = -0;
    const metadata = encodeRecoveryMetadata(original);
    original.activeCamera[1] = 99; original.defaultCamera[2] = 98; original.native.count = 5;
    original.alignmentViews.clear();
    expect(metadata.activeCamera[1]).toBe(2); expect(metadata.defaultCamera[2]).toBe(6);
    expect(metadata.native.count).toBe(6); expect(metadata.alignmentViews.length).toBe(2);
    expect(Object.is(metadata.activeCamera[0], -0)).toBe(false);
    expect(JSON.parse(JSON.stringify(metadata))).toEqual(metadata);
  });
  it('uses intrinsic Map iteration and never invokes caller iterator or entries hooks', () => {
    const original = input(); let hooks = 0;
    Object.defineProperty(original.alignmentViews, Symbol.iterator, { get() { hooks++; throw new Error('untrusted iterator'); } });
    Object.defineProperty(original.alignmentViews, 'entries', { get() { hooks++; throw new Error('untrusted entries'); } });
    expect(encodeRecoveryMetadata(original).alignmentViews.length).toBe(2); expect(hooks).toBe(0);
    const fake = { entries() { hooks++; throw new Error('untrusted map'); } };
    expect(() => encodeRecoveryMetadata({ ...original, alignmentViews: fake as unknown as Map<number, AlignmentViewCheckpoint> }))
      .toThrow(/Map or bound/);
    expect(hooks).toBe(0);
  });
  it('permits the complete 34-entry desktop branch-roll allowance and refuses another entry', () => {
    const original = input(); original.alignment = alignment(1, Array.from({ length: 35 }, (_, index) => index));
    original.alignmentViews = new Map(Array.from({ length: MAX_ALIGNMENT_VIEW_CHECKPOINTS }, (_, index) => [index, checkpoint(index)]));
    const maximum = encodeRecoveryMetadata(original);
    expect(maximum.alignmentViews.length).toBe(34);
    original.alignmentViews.set(34, checkpoint(34));
    expect(() => encodeRecoveryMetadata(original)).toThrow(/bound/);
    expect(() => decodeRecoveryMetadata({ ...maximum, alignmentViews: [...maximum.alignmentViews, [34, checkpoint(34)]] })).toThrow(/bound/);
  });
  it.each([1, 2])('supports read-only geometry kind %i with its exact native expectation and cameras', kind => {
    const original = input(); original.native = { ...original.native, kind, shDegree: 0 }; original.alignment = null;
    original.alignmentViews.clear();
    expect(encodeRecoveryMetadata(original).native.kind).toBe(kind);
    expect(encodeRecoveryMetadata(original).alignment).toBeNull();
  });
  it('retains the original source and browser history metadata when committed edits remove every splat', () => {
    const original = input(); original.native.count = 0;
    const encoded = encodeRecoveryMetadata(original), restored = decodeRecoveryMetadata(JSON.parse(JSON.stringify(encoded)));
    expect(restored.native).toEqual({ kind: 0, count: 0, sourceCount: 12, shDegree: 3, format: 'PLY', duplicateRange: null });
    expect(restored.alignment).toEqual(original.alignment);
    expect(new Map(restored.alignmentViews)).toEqual(original.alignmentViews);
    expect(restored.activeCamera).toEqual(original.activeCamera); expect(restored.defaultCamera).toEqual(original.defaultCamera);
    expect(restored.savedContent).toBe(4);
    expect(() => decodeRecoveryMetadata({ ...encoded, native: { ...encoded.native, sourceCount: 0 } })).toThrow(/integer/);
  });
  it('owns the grown suffix independently and keeps it when browser cameras and save state roundtrip', () => {
    const original = input(), marker = { first: 6, count: 2 };
    original.native = { ...original.native, count: 8, sourceCount: 14, duplicateRange: marker };
    const encoded = encodeRecoveryMetadata(original);marker.first = 0;
    expect(encoded.native).toMatchObject({ count: 8, sourceCount: 14, duplicateRange: { first: 6, count: 2 } });
    expect(Object.isFrozen(encoded.native.duplicateRange)).toBe(true);
    const decoded = decodeRecoveryMetadata(JSON.parse(JSON.stringify(encoded)));
    expect(decoded).toEqual(encoded);expect(decoded.activeCamera).toEqual(original.activeCamera);
    expect(decoded.savedContent).toBe(4);
  });
  it.each([undefined, { first: 4, count: 0 }, { first: 4, count: 1 }, { first: 7, count: 1 },
    { first: -0, count: 6 }, { first: 4, count: 2, contentRevision: 4 }])('rejects malformed required suffix %j', duplicateRange => {
    const encoded = encodeRecoveryMetadata(input());
    expect(() => decodeRecoveryMetadata({ ...encoded, native: { ...encoded.native, duplicateRange } })).toThrow();
  });
  it('requires explicit null on geometry and never reads a marker accessor', () => {
    const encoded = encodeRecoveryMetadata(input());let reads = 0;
    const duplicateRange = { get first() { reads++;return 4; }, count: 2 };
    expect(() => decodeRecoveryMetadata({ ...encoded, native: { ...encoded.native, duplicateRange } })).toThrow(/object data/);
    const geometry = { ...encoded, alignment: null, alignmentViews: [], native: { ...encoded.native, kind: 1, shDegree: 0,
      duplicateRange: { first: 4, count: 2 } } };
    expect(() => decodeRecoveryMetadata(geometry)).toThrow();
    const { duplicateRange: _missing, ...missing } = encoded.native;
    expect(() => decodeRecoveryMetadata({ ...encoded, native: missing })).toThrow(/fields/);
    expect(reads).toBe(0);
  });
  it.each([
    ['scene kind', { kind: 3 }], ['negative edited count', { count: -1 }], ['loaded limit', { count: 1_000_001, sourceCount: 1_000_001 }],
    ['source subset', { sourceCount: 5 }], ['SH degree', { shDegree: 4 }], ['geometry SH', { kind: 1, shDegree: 3 }],
    ['missing format', { format: '' }], ['long format', { format: 'X'.repeat(129) }], ['source count bound', { sourceCount: 0x1_0000_0000 }],
  ])('rejects an invalid %s expectation', (_label, changed) => {
    const encoded = encodeRecoveryMetadata(input());
    expect(() => decodeRecoveryMetadata({ ...encoded, native: { ...encoded.native, ...changed } })).toThrow();
  });
  it.each([
    ['version', { version: 1 }], ['background', { background: 'transparent' }],
    ['saved content', { savedContent: -1 }], ['fractional save counter', { savedContent: 1.5 }],
    ['overflowed save counter', { savedContent: Number.MAX_SAFE_INTEGER + 1 }], ['unowned extension', { ignored: true }],
  ])('refuses an invalid %s field', (_label, changed) => {
    expect(() => decodeRecoveryMetadata({ ...encodeRecoveryMetadata(input()), ...changed })).toThrow();
  });
  it.each([
    ['distance', 5, 0], ['radius', 6, 0], ['aspect', 10, -1], ['up convention', 8, 2],
    ['float32 overflow', 0, 1e100], ['underflowed distance', 5, Number.MIN_VALUE],
  ])('refuses invalid camera %s', (_label, index, value) => {
    const encoded = encodeRecoveryMetadata(input()), camera = [...encoded.activeCamera]; camera[index] = value;
    expect(() => decodeRecoveryMetadata({ ...encoded, activeCamera: camera })).toThrow(/camera/);
    expect(() => decodeRecoveryMetadata({ ...encoded, defaultCamera: camera })).toThrow(/camera/);
  });
  it('rounds camera values at the existing eleven-float ABI boundary and requires dense exact arrays', () => {
    const original = input(); original.activeCamera[3] = .1;
    expect(encodeRecoveryMetadata(original).activeCamera[3]).toBe(Math.fround(.1));
    const encoded = encodeRecoveryMetadata(input()), sparse = [...encoded.activeCamera]; delete sparse[1];
    expect(() => decodeRecoveryMetadata({ ...encoded, activeCamera: sparse })).toThrow(/dense array|array data/);
    expect(() => decodeRecoveryMetadata({ ...encoded, activeCamera: [...encoded.activeCamera, 0] })).toThrow(/camera length/);
    expect(() => decodeRecoveryMetadata({ ...encoded, activeCamera: new Float32Array(encoded.activeCamera) })).toThrow(/prototype/);
  });
  it.each([
    ['duplicate', (encoded: ReturnType<typeof encodeRecoveryMetadata>) => [...encoded.alignmentViews, encoded.alignmentViews[0]]],
    ['entry/key mismatch', (encoded: ReturnType<typeof encodeRecoveryMetadata>) => [[0, checkpoint(1)], encoded.alignmentViews[1]]],
    ['unretained branch', (encoded: ReturnType<typeof encodeRecoveryMetadata>) => [...encoded.alignmentViews, [9, checkpoint(9)]]],
    ['current frame mismatch', (encoded: ReturnType<typeof encodeRecoveryMetadata>) => [encoded.alignmentViews[0], [1, checkpoint(1, frame(4))]]],
    ['missing pair data', (encoded: ReturnType<typeof encodeRecoveryMetadata>) => [[0], encoded.alignmentViews[1]]],
  ])('rejects an alignment checkpoint with %s', (_label, changed) => {
    const encoded = encodeRecoveryMetadata(input());
    expect(() => decodeRecoveryMetadata({ ...encoded, alignmentViews: changed(encoded) })).toThrow(/alignment/);
  });
  it('validates native alignment branch/frame authority through existing similarity admission', () => {
    const encoded = encodeRecoveryMetadata(input()), sheared = [...frame()]; sheared[1] = .5;
    expect(() => decodeRecoveryMetadata({ ...encoded, alignment: { ...encoded.alignment!, frame: sheared } })).toThrow(/uniform|shear/);
    expect(() => decodeRecoveryMetadata({ ...encoded, alignment: { ...encoded.alignment!, retainedBranchIds: [0] } })).toThrow(/alignment/);
    expect(() => decodeRecoveryMetadata({ ...encoded, alignment: null })).toThrow(/alignment/);
    const invalid = checkpoint(0); (invalid as { corrected: unknown }).corrected = 1;
    expect(() => decodeRecoveryMetadata({ ...encoded, alignmentViews: [[0, invalid]] })).toThrow(/roll checkpoint/);
  });
  it('refuses unfinished color previews and out-of-range applied grades', () => {
    const encoded = encodeRecoveryMetadata(input()), applied = color();
    expect(() => decodeRecoveryMetadata({ ...encoded, applied: { ...encoded.applied, color: { ...applied, pending: true } } }))
      .toThrow(/unfinished color/);
    expect(() => decodeRecoveryMetadata({ ...encoded, applied: { ...encoded.applied,
      color: { ...applied, values: NEUTRAL_COLOR } } })).toThrow(/unfinished color/);
    expect(() => decodeRecoveryMetadata({ ...encoded, applied: { ...encoded.applied,
      color: { ...applied, applied: [99, ...applied.applied.slice(1)] } } })).toThrow(/color values/);
  });
  it('refuses invalid applied transform input and simultaneous exclusive native owners', () => {
    const encoded = encodeRecoveryMetadata(input()), parameters = transformDefaults(); parameters.scale[0] = 0;
    expect(() => decodeRecoveryMetadata({ ...encoded, applied: { ...encoded.applied,
      transform: { session: transform(), parameters } } })).toThrow(/applied transform/);
    expect(() => decodeRecoveryMetadata({ ...encoded, applied: { ...encoded.applied,
      transform: { session: transform(), parameters: transformDefaults() },
      opacity: { id: 3, baseId: 4, epoch: 5, appliedEpoch: 5, selectedOnly: false, appliedScale: .5 } } })).toThrow(/exclusive/);
  });
  it('refuses geometry snapshots that claim editing or alignment owners', () => {
    const encoded = encodeRecoveryMetadata(input()), native = { ...encoded.native, kind: 1, shDegree: 0 };
    expect(() => decodeRecoveryMetadata({ ...encoded, native })).toThrow(/geometry tool owners/);
    expect(() => decodeRecoveryMetadata({ ...encoded, native, alignment: null, alignmentViews: [],
      applied: { ...encoded.applied, color: color() } })).toThrow(/geometry tool owners/);
  });
  it('does not invoke nested or top-level accessors, iterators or serialization methods', () => {
    let hooks = 0;
    const encoded = encodeRecoveryMetadata(input()), camera = [...encoded.activeCamera];
    Object.defineProperty(camera, '0', { enumerable: true, get() { hooks++; throw new Error('untrusted camera'); } });
    expect(() => decodeRecoveryMetadata({ ...encoded, activeCamera: camera })).toThrow(/array data/);
    const unsafe = { ...encoded };
    Object.defineProperty(unsafe, 'savedContent', { enumerable: true, get() { hooks++; throw new Error('untrusted save baseline'); } });
    expect(() => decodeRecoveryMetadata(unsafe)).toThrow(/object data/);
    const capture = input();
    Object.defineProperty(capture, 'native', { enumerable: true, get() { hooks++; throw new Error('untrusted native'); } });
    expect(() => encodeRecoveryMetadata(capture)).toThrow(/capture data/);
    const poison = { ...encoded, toJSON() { hooks++; throw new Error('untrusted JSON'); } };
    expect(() => decodeRecoveryMetadata(poison)).toThrow(/JSON data/);
    expect(hooks).toBe(0);
  });
  it('bounds malformed JSON structure and rejects cycles, symbols, hidden data and custom prototypes', () => {
    const encoded = encodeRecoveryMetadata(input()), cycle: unknown[] = []; cycle.push(cycle);
    expect(() => decodeRecoveryMetadata({ ...encoded, activeCamera: cycle })).toThrow(/JSON data/);
    expect(() => decodeRecoveryMetadata({ ...encoded, activeCamera: new Array(1000000) })).toThrow(/dense array/);
    const symbol = { ...encoded, [Symbol('hidden')]: true };
    expect(() => decodeRecoveryMetadata(symbol)).toThrow(/object data/);
    const hidden = { ...encoded }; Object.defineProperty(hidden, 'secret', { value: 1 });
    expect(() => decodeRecoveryMetadata(hidden)).toThrow(/object data/);
    expect(() => decodeRecoveryMetadata(Object.assign(Object.create({ inherited: true }), encoded))).toThrow(/prototype/);
    expect(() => decodeRecoveryMetadata({ ...encoded, savedContent: Infinity })).toThrow(/finite number/);
  });
});
