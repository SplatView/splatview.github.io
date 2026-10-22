import { describe, expect, it } from 'vitest';
import { IDENTITY_ALIGNMENT_FRAME } from '../src/document/alignment';
import { sameAlignmentBranch, sameAlignmentFrame, validateAlignmentSummary } from '../src/document/alignmentProtocol';
import { acceptsResult, BUILD_ID, PROTOCOL_VERSION, type Revision } from '../src/document/types';

const summary = (branchId = 0) => ({ version: 2, frame: [...IDENTITY_ALIGNMENT_FRAME], branchId, canReset: false, retainedBranchIds: [branchId] });
describe('alignment summary wire metadata', () => {
  it('accepts immutable uniform-scale scene frames while refusing rounded native delta as scene metadata', () => {
    const frame = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, .1, -.2, .3, 1];
    const parsed = validateAlignmentSummary({ ...summary(7), frame, canReset: true })!;
    expect(parsed.frame).toEqual(frame.map(Math.fround)); expect(Object.isFrozen(parsed.frame)).toBe(true);
    frame[0] = 3; expect(parsed.frame[0]).toBe(2);
    const rawDelta = [...parsed.frame]; rawDelta[15] = Math.fround(1 - 2 ** -24);
    expect(() => validateAlignmentSummary({ ...summary(), frame: rawDelta })).toThrow('affine');
    expect(sameAlignmentBranch(parsed, { ...parsed, branchId: 8 })).toBe(false);
  });
  it('accepts only absent optional metadata without a frame owner', () => {
    expect(validateAlignmentSummary(undefined)).toBeNull(); expect(validateAlignmentSummary(null)).toBeNull();
    for (const value of [false, 0, '', [], new Date(), {}]) expect(() => validateAlignmentSummary(value)).toThrow();
  });
  it('admits proper rotated scene frames while refusing reflection, nonuniform scale and shear', () => {
    const frame = [0, 2, 0, 0, -2, 0, 0, 0, 0, 0, 2, 0, .1, -.2, .3, 1];
    expect(validateAlignmentSummary({ ...summary(), frame })!.frame).toEqual(frame.map(Math.fround));
    for (const invalid of [frame.map((value, index) => index === 0 ? .5 : value),
      [1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]])
      expect(() => validateAlignmentSummary({ ...summary(), frame: invalid })).toThrow();
  });

  it('clones, canonicalizes and freezes metadata without retaining caller arrays', () => {
    const input = summary(7); input.canReset = true; input.frame[12] = .1;
    const parsed = validateAlignmentSummary(input)!;
    input.frame[12] = 8; input.branchId = 10; input.canReset = false; input.retainedBranchIds[0] = 10;
    expect(parsed).toEqual({ version: 2, frame: [...IDENTITY_ALIGNMENT_FRAME].map((value, index) => index === 12 ? Math.fround(.1) : value),
      branchId: 7, canReset: true, retainedBranchIds: [7] });
    expect(Object.isFrozen(parsed)).toBe(true); expect(Object.isFrozen(parsed.frame)).toBe(true); expect(Object.isFrozen(parsed.retainedBranchIds)).toBe(true);
    expect(validateAlignmentSummary(Object.assign(Object.create(null), summary()))).toEqual(summary());
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1', null])('refuses invalid branch identity %s', branchId => {
    expect(() => validateAlignmentSummary({ ...summary(), branchId })).toThrow();
  });

  it.each([{ version: 1 }, { version: 3 }, { canReset: 0 }, { canReset: undefined }, { extra: true }, { frame: null },
    { branchId: undefined }, { retainedBranchIds: undefined }])
    ('refuses malformed fields %#', patch => { expect(() => validateAlignmentSummary({ ...summary(), ...patch })).toThrow(); });

  it('rejects exotic prototypes, missing/inherited fields, symbols and non-data properties without invoking getters', () => {
    let accesses = 0;
    const accessor = { ...summary() }; Object.defineProperty(accessor, 'frame', { enumerable: true, get() { accesses++; return summary().frame; } });
    const hidden = { ...summary() }; Object.defineProperty(hidden, 'branchId', { enumerable: false, value: 1 });
    const inherited = Object.create(summary());
    const symbol = { ...summary(), [Symbol('wire')]: 1 };
    class Metadata { version = 2; frame = [...IDENTITY_ALIGNMENT_FRAME]; branchId = 1; canReset = true; retainedBranchIds = [1]; }
    for (const value of [accessor, hidden, inherited, symbol, new Metadata()]) expect(() => validateAlignmentSummary(value)).toThrow();
    expect(accesses).toBe(0);
    const missing = { ...summary() } as Record<string, unknown>; delete missing.canReset;
    expect(() => validateAlignmentSummary(missing)).toThrow();
  });

  it('refuses sparse, extra, typed and accessor frame arrays without observing accessors', () => {
    let accesses = 0;
    const accessor = [...IDENTITY_ALIGNMENT_FRAME];
    Object.defineProperty(accessor, '12', { enumerable: true, get() { accesses++; return 0; } });
    const extra = Object.assign([...IDENTITY_ALIGNMENT_FRAME], { extra: 1 });
    const symbol = [...IDENTITY_ALIGNMENT_FRAME]; Object.defineProperty(symbol, Symbol('wire'), { value: 1 });
    const sparse = [...IDENTITY_ALIGNMENT_FRAME]; delete sparse[12];
    const string = [...IDENTITY_ALIGNMENT_FRAME] as unknown[]; string[12] = '0';
    for (const frame of [new Array(16), sparse, accessor, extra, symbol, new Float32Array(16), string,
      [...IDENTITY_ALIGNMENT_FRAME, 0], IDENTITY_ALIGNMENT_FRAME.slice(0, 15)])
      expect(() => validateAlignmentSummary({ ...summary(), frame })).toThrow();
    expect(accesses).toBe(0);
  });

  it('keeps divergent equal-matrix branches distinct, even when a branch is no longer resettable', () => {
    const first = validateAlignmentSummary({ ...summary(1), canReset: true })!;
    const divergent = validateAlignmentSummary({ ...summary(2), canReset: true })!;
    expect(sameAlignmentFrame(first.frame, divergent.frame)).toBe(true);
    expect(sameAlignmentFrame(new Array(16), new Array(16))).toBe(false);
    expect(sameAlignmentBranch(first, divergent)).toBe(false);
    expect(sameAlignmentBranch(first, { ...first, canReset: false })).toBe(true);
    const changed = [...first.frame]; changed[12] = 1;
    expect(sameAlignmentBranch(first, { ...first, frame: validateAlignmentSummary({ ...summary(), frame: changed })!.frame })).toBe(false);
    expect(validateAlignmentSummary(summary(Number.MAX_SAFE_INTEGER))!.branchId).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('accepts authoritative retained branches without requiring an unretained initial branch', () => {
    const parsed = validateAlignmentSummary({ ...summary(9), retainedBranchIds: [2, 5, 9] })!;
    expect(parsed.retainedBranchIds).toEqual([2, 5, 9]);
    const full = Array.from({ length: 64 }, (_, id) => id);
    expect(validateAlignmentSummary({ ...summary(63), retainedBranchIds: full })!.retainedBranchIds).toEqual(full);
  });

  it.each([[], [1], [0, 0], [1, 0], [0, -1], [0, .5], [0, Infinity], [0, NaN], [0, Number.MAX_SAFE_INTEGER + 1],
    [0, '1'], Array.from({ length: 65 }, (_, id) => id)].map(retainedBranchIds => ({ retainedBranchIds })))
    ('refuses malformed retained branch ownership %#', ({ retainedBranchIds }) => {
    expect(() => validateAlignmentSummary({ ...summary(), retainedBranchIds })).toThrow();
  });

  it('refuses exotic retained arrays without observing accessor entries', () => {
    let observed = 0;
    const accessor = [0]; Object.defineProperty(accessor, '0', { enumerable: true, get() { observed++; return 0; } });
    const sparse = new Array(1), extra = Object.assign([0], { extra: 1 }), symbol = [0];
    Object.defineProperty(symbol, Symbol('wire'), { value: 1 });
    for (const retainedBranchIds of [accessor, sparse, extra, symbol, new Uint32Array([0]), Object.create([0])])
      expect(() => validateAlignmentSummary({ ...summary(), retainedBranchIds })).toThrow();
    expect(observed).toBe(0);
  });

  it('does not replace response admission: equal alignment keys still refuse stale document/source/edit envelopes', () => {
    const base: Revision = { documentId: 'alignment', sourceGeneration: 2, contentRevision: 3, selectionRevision: 4, draftRevision: 0 };
    const envelope = { base, protocolVersion: PROTOCOL_VERSION, buildId: BUILD_ID, requestId: 1 };
    const key = validateAlignmentSummary(summary())!;
    expect(sameAlignmentBranch(key, validateAlignmentSummary(summary())!)).toBe(true);
    expect(acceptsResult(envelope, base)).toBe(true);
    for (const patch of [{ documentId: 'replacement' }, { sourceGeneration: 3 }, { contentRevision: 4 }, { selectionRevision: 5 }, { draftRevision: 1 }])
      expect(acceptsResult(envelope, { ...base, ...patch })).toBe(false);
  });
});
