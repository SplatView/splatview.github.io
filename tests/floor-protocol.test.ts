import { describe, expect, it } from 'vitest';
import { FLOOR_NORMAL_TOLERANCE, MAX_FLOOR_TESTED_POINTS, validateFloorSummary } from '../src/document/floorProtocol';
import { acceptsResult, BUILD_ID, PROTOCOL_VERSION, type Revision } from '../src/document/types';

const context = (loadedCount = 9, pending = false) => ({ loadedCount, pending });
const plane = () => ({ normal: [0, 1, 0], center: [1, -.2, 3], radius: 2, rms: .01, inliers: 6, tested: 9 });
const ready = () => ({ version: 1, id: 7, status: 'ready', stage: 'complete', selectedOnly: false, plane: plane() });
const pending = (stage = 'sampling') => ({ ...ready(), status: 'pending', stage, plane: null });
const none = () => ({ ...ready(), status: 'none', plane: null });

describe('Floor candidate wire metadata', () => {
  it('requires the always-emitted field and accepts only explicit null absence', () => {
    expect(validateFloorSummary(null, context())).toBeNull();
    for (const value of [undefined, false, 0, '', [], new Date(), {}])
      expect(() => validateFloorSummary(value, context())).toThrow('native floor');
  });

  it.each(['sampling', 'threshold', 'ransac', 'refine'])('accepts pending stage %s only with a pending native owner', stage => {
    expect(validateFloorSummary(pending(stage), context(9, true))).toEqual(pending(stage));
    expect(() => validateFloorSummary(pending(stage), context())).toThrow('pending');
  });

  it('allows completed candidates and no-result terminals beside a separate pending native query', () => {
    for (const summary of [ready(), none()]) {
      expect(validateFloorSummary(summary, context(9, true))!.status).toBe(summary.status);
      expect(validateFloorSummary(summary, context())!.status).toBe(summary.status);
    }
    expect(validateFloorSummary(none(), context(0))).toEqual(none());
  });

  it.each([
    { status: 'pending', stage: 'complete', plane: null },
    { status: 'pending', stage: 'sampling', plane: plane() },
    { status: 'ready', stage: 'ransac' }, { status: 'ready', plane: null },
    { status: 'none', stage: 'refine', plane: null }, { status: 'none', plane: plane() },
    { status: 'cancelled', plane: null }, { status: 'failed', plane: null },
    { status: null }, { stage: null }, { stage: 'unknown' },
  ])('refuses inconsistent candidate states %#', patch => {
    expect(() => validateFloorSummary({ ...ready(), ...patch }, context(9, true))).toThrow();
  });

  it.each([0, -1, .5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1', null, undefined])
    ('refuses invalid candidate identity %s', id => {
      expect(() => validateFloorSummary({ ...ready(), id }, context())).toThrow('identity');
    });

  it('accepts the largest safe identity without treating it as response ownership', () => {
    expect(validateFloorSummary({ ...ready(), id: Number.MAX_SAFE_INTEGER }, context())!.id).toBe(Number.MAX_SAFE_INTEGER);
    const base: Revision = { documentId: 'floor', sourceGeneration: 2, contentRevision: 3, selectionRevision: 4, draftRevision: 0 };
    const envelope = { base, protocolVersion: PROTOCOL_VERSION, buildId: BUILD_ID, requestId: 1 };
    expect(acceptsResult(envelope, base)).toBe(true);
    for (const patch of [{ documentId: 'other' }, { sourceGeneration: 3 }, { contentRevision: 4 }, { selectionRevision: 5 }, { draftRevision: 1 }])
      expect(acceptsResult(envelope, { ...base, ...patch })).toBe(false);
  });

  it.each([{ version: 0 }, { version: 2 }, { version: '1' }, { selectedOnly: 0 }, { selectedOnly: undefined }, { extra: true }])
    ('refuses malformed summary fields %#', patch => {
      expect(() => validateFloorSummary({ ...ready(), ...patch }, context())).toThrow();
    });

  it('detaches and freezes every nested float32 value without changing caller inputs', () => {
    const input = ready(), original = structuredClone(input), parsed = validateFloorSummary(input, context())!;
    expect(input).toEqual(original); expect(parsed.status).toBe('ready');
    if (parsed.status !== 'ready') throw new Error('Expected a ready fixture.');
    expect(parsed.plane.center).toEqual([1, Math.fround(-.2), 3]); expect(parsed.plane.rms).toBe(Math.fround(.01));
    for (const value of [parsed, parsed.plane, parsed.plane.normal, parsed.plane.center]) expect(Object.isFrozen(value)).toBe(true);
    input.id = 8; input.plane.center[0] = 20; input.plane.normal[1] = -1; input.plane.radius = 9;
    expect(parsed.id).toBe(7); expect(parsed.plane.center[0]).toBe(1); expect(parsed.plane.normal[1]).toBe(1); expect(parsed.plane.radius).toBe(2);
    const nullPrototype = Object.assign(Object.create(null), ready());
    nullPrototype.plane = Object.assign(Object.create(null), plane());
    expect(validateFloorSummary(nullPrototype, Object.assign(Object.create(null), context()))).toEqual(validateFloorSummary(ready(), context()));
  });

  it('admits the declared float32 normal-rounding band without normalizing a malformed candidate', () => {
    expect(FLOOR_NORMAL_TOLERANCE).toBe(1e-4);
    for (const normal of [[0, Math.fround(1.00009), 0], [0, Math.fround(.99991), 0], [0, -1, 0]])
      expect(validateFloorSummary({ ...ready(), plane: { ...plane(), normal } }, context())!.status).toBe('ready');
    for (const normal of [[0, 0, 0], [0, 2, 0], [0, 1.00011, 0], [0, .99989, 0], [1, 1, 0]])
      expect(() => validateFloorSummary({ ...ready(), plane: { ...plane(), normal } }, context())).toThrow('unit normal');
  });

  it('preserves signed zero in source-normal and center components', () => {
    const parsed = validateFloorSummary({ ...ready(), plane: { ...plane(), normal: [-0, -1, -0], center: [-0, 0, -0] } }, context());
    if (parsed?.status !== 'ready') throw new Error('Expected a ready fixture.');
    expect(Object.is(parsed.plane.normal[0], -0)).toBe(true); expect(Object.is(parsed.plane.normal[2], -0)).toBe(true);
    expect(Object.is(parsed.plane.center[0], -0)).toBe(true); expect(Object.is(parsed.plane.center[2], -0)).toBe(true);
  });

  it.each([NaN, Infinity, -Infinity, Number.MAX_VALUE, Number.MIN_VALUE, '1', null, undefined])
    ('refuses non-finite or nonrepresentable float fields %s', value => {
      for (const key of ['radius', 'rms'])
        expect(() => validateFloorSummary({ ...ready(), plane: { ...plane(), [key]: value } }, context())).toThrow();
      for (const key of ['normal', 'center']) {
        const vector = [...plane()[key as 'normal' | 'center']]; vector[0] = value as number;
        expect(() => validateFloorSummary({ ...ready(), plane: { ...plane(), [key]: vector } }, context())).toThrow();
      }
    });

  it('keeps finite float32 range and sign semantics without adding scene-radius quotas', () => {
    const smallest = Math.fround(2 ** -149), largest = Math.fround(3.4028234663852886e38);
    const parsed = validateFloorSummary({ ...ready(), plane: { ...plane(), center: [largest, -largest, smallest], radius: smallest, rms: -0 } }, context())!;
    expect(parsed.status).toBe('ready');
    for (const patch of [{ radius: 0 }, { radius: -0 }, { radius: -1 }, { rms: -1 }, { rms: -Number.MIN_VALUE }])
      expect(() => validateFloorSummary({ ...ready(), plane: { ...plane(), ...patch } }, context())).toThrow();
  });

  it.each([
    { inliers: 2 }, { inliers: 3.5 }, { inliers: NaN }, { inliers: '3' }, { inliers: Number.MAX_SAFE_INTEGER + 1 },
    { tested: 5 }, { tested: 9.5 }, { tested: Infinity }, { tested: '9' }, { tested: Number.MAX_SAFE_INTEGER + 1 },
  ])('refuses invalid support counts %#', patch => {
    expect(() => validateFloorSummary({ ...ready(), plane: { ...plane(), ...patch } }, context())).toThrow('support');
  });

  it('couples support to loaded preview membership and the native retained-sample ceiling', () => {
    expect(MAX_FLOOR_TESTED_POINTS).toBe(50_000);
    expect(() => validateFloorSummary(ready(), context(8))).toThrow('support');
    const full = { ...ready(), plane: { ...plane(), inliers: 50_000, tested: 50_000 } };
    expect(validateFloorSummary(full, context(1_000_000))!.status).toBe('ready');
    expect(() => validateFloorSummary({ ...full, plane: { ...full.plane, tested: 50_001 } }, context(1_000_000))).toThrow('support');
    expect(() => validateFloorSummary(full, context(49_999))).toThrow('support');
    expect(() => validateFloorSummary(ready(), context(0))).toThrow('support');
  });

  it.each([-1, .5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '9', null, undefined])
    ('refuses malformed loaded-count context %s even for null metadata', loadedCount => {
      expect(() => validateFloorSummary(null, { loadedCount: loadedCount as number, pending: false })).toThrow('context');
    });

  it('refuses nonboolean or non-data owner context without observing accessors', () => {
    let reads = 0;
    const accessor = { ...context() }; Object.defineProperty(accessor, 'pending', { enumerable: true, get() { reads++; return false; } });
    for (const owner of [accessor, { ...context(), pending: 0 }, { ...context(), extra: 1 }, Object.create(context())])
      expect(() => validateFloorSummary(null, owner)).toThrow('context');
    expect(reads).toBe(0);
  });

  it('refuses exotic metadata, nested planes and hidden/accessor fields without invoking getters', () => {
    let reads = 0;
    for (const nested of [false, true]) {
      const data = nested ? plane() : ready();
      const key = nested ? 'normal' : 'plane';
      const accessor = { ...data }; Object.defineProperty(accessor, key, { enumerable: true, get() { reads++; return data[key as keyof typeof data]; } });
      const hidden = { ...data }; Object.defineProperty(hidden, key, { enumerable: false, value: data[key as keyof typeof data] });
      const missing = { ...data } as Record<string, unknown>; delete missing[key];
      const symbol = { ...data, [Symbol('wire')]: 1 };
      class Exotic { constructor() { Object.assign(this, data); } }
      for (const value of [accessor, hidden, missing, symbol, Object.create(data), new Exotic(), { ...data, extra: true }])
        expect(() => validateFloorSummary(nested ? { ...ready(), plane: value } : value, context())).toThrow();
    }
    expect(reads).toBe(0);
  });

  it('refuses sparse, inherited, typed, extra and accessor vectors without observing entries', () => {
    let reads = 0;
    const accessor = [0, 1, 0]; Object.defineProperty(accessor, '1', { enumerable: true, get() { reads++; return 1; } });
    const hidden = [0, 1, 0]; Object.defineProperty(hidden, '1', { enumerable: false, value: 1 });
    const sparse = [0, 1, 0]; delete sparse[1];
    const symbol = [0, 1, 0]; Object.defineProperty(symbol, Symbol('wire'), { value: 0 });
    class Vector extends Array<number> {}
    for (const value of [accessor, hidden, sparse, new Array(3), symbol, Object.assign([0, 1, 0], { extra: 1 }),
      [0, 1], [0, 1, 0, 0], new Float32Array([0, 1, 0]), Object.create([0, 1, 0]), new Vector(0, 1, 0)])
      for (const key of ['normal', 'center'])
        expect(() => validateFloorSummary({ ...ready(), plane: { ...plane(), [key]: value } }, context())).toThrow();
    expect(reads).toBe(0);
  });
});
