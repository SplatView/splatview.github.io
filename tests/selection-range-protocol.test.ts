import { describe, expect, it } from 'vitest';
import { assertToleranceRangeAcknowledgement, assertToleranceRangeRequest, captureSelectionRangeCommand, sameToleranceRange,
  selectionRangeCommandFields, toleranceRangeOwner, ToleranceRangeOperation,
  validateSelectionRangeFields, validateSelectionRangePreference, validateToleranceRange, validateToleranceRangeSummary } from '../src/document/selectionRange';

const range = { enabled: true, radius: Math.fround(.1), center: [1, 2, 3] };
function summary(patch: Record<string, unknown> = {}) {
  return { loaded: true, kind: 0, toleranceSessionId: 4, toleranceTool: 'color', toleranceRange: range, toleranceRecorded: true, ...patch };
}
const absent = { loaded: false, kind: 0, toleranceSessionId: null, toleranceTool: null, toleranceRange: null, toleranceRecorded: null };
const fields = { rangeEnabled: true, rangeRadius: Math.fround(.1) };
const pick = { command: 'colorPick', sessionId: 4, ...fields };
const camera = [0, 0, 0, 0, 0, 3, 1, 45, 0, 0, 1];

describe('raw Range preference versus resolved command fields', () => {
  it('preserves automatic null and raw double precision independently of the enabled preference', () => {
    for (const enabled of [false, true]) for (const radius of [null, .1, Number.MIN_VALUE, Number.MAX_VALUE]) {
      const source = { enabled, radius }, parsed = validateSelectionRangePreference(source);
      expect(parsed).toEqual(source); expect(parsed).not.toBe(source); expect(Object.isFrozen(parsed)).toBe(true);
    }
  });
  it.each([{ enabled: 1, radius: null }, { enabled: false }, { enabled: false, radius: 0 }, { enabled: true, radius: -1 },
    { enabled: false, radius: NaN }, { enabled: true, radius: Infinity }, { enabled: false, radius: '1' },
    { enabled: true, radius: 1, center: [0, 0, 0] }])('rejects malformed raw preference %#', value => {
    expect(() => validateSelectionRangePreference(value)).toThrow('Invalid selection Range preference.');
  });
  it('requires resolved enabled values while permitting disabled automatic or retained values', () => {
    expect(validateSelectionRangeFields(fields)).toEqual(fields);
    expect(validateSelectionRangeFields({ rangeEnabled: false, rangeRadius: null })).toEqual({ rangeEnabled: false, rangeRadius: null });
    expect(validateSelectionRangeFields({ ...fields, rangeEnabled: false })).toEqual({ ...fields, rangeEnabled: false });
    // Protocol domain has no additional calculated-statistics hard cap.
    expect(validateSelectionRangeFields({ ...fields, rangeRadius: Math.fround(1e30) }).rangeRadius).toBe(Math.fround(1e30));
    expect(validateSelectionRangeFields({ ...fields, rangeRadius: Math.fround(2 ** -149) }).rangeRadius).toBe(2 ** -149);
  });
  it.each([{ ...fields, rangeRadius: null }, { ...fields, rangeRadius: .1 }, { ...fields, rangeRadius: 0 },
    { ...fields, rangeRadius: -1 }, { ...fields, rangeRadius: Infinity }, { ...fields, rangeRadius: Number.MAX_VALUE },
    { ...fields, rangeEnabled: 1 }, { ...fields, center: [1, 2, 3] }, { rangeEnabled: false }, { rangeRadius: null }])(
    'refuses unresolved, overflowed or malformed RPC fields %#', value => {
      expect(() => validateSelectionRangeFields(value)).toThrow('Invalid selection Range command fields.');
    });
  it('defaults only a completely omitted legacy extension and captures every four-command family', () => {
    for (const command of ['colorPick', 'colorTolerance', 'fillPick', 'fillTolerance']) {
      expect(selectionRangeCommandFields({ command, sessionId: 1 })).toEqual({ rangeEnabled: false, rangeRadius: null });
      const source = { command, ...fields }, parsed = selectionRangeCommandFields(source); source.rangeRadius = 9;
      expect(parsed).toEqual(fields); expect(Object.isFrozen(parsed)).toBe(true);
    }
  });
  it.each([{ command: 'single', ...fields }, { ...pick, rangeRadius: undefined }, { command: 'colorPick', rangeEnabled: false },
    { command: 'fillPick', rangeRadius: null }, { ...pick, center: [1, 2, 3] }, { ...pick, rangeCenter: [1, 2, 3] },
    { ...pick, toleranceRange: range }, { ...pick, operationOwner: null }])('refuses partial extensions and caller centers %#', value => {
    expect(() => selectionRangeCommandFields(value)).toThrow();
  });
  it('rejects exotic prototypes, symbols, hidden fields and accessors without reading them', () => {
    let reads = 0;
    const accessor = { ...pick }; Object.defineProperty(accessor, 'rangeRadius', { enumerable: true, get() { reads++; return 1; } });
    const hidden = { ...pick }; Object.defineProperty(hidden, 'extra', { value: true });
    for (const value of [accessor, hidden, { ...pick, [Symbol('hidden')]: 1 }, Object.assign(Object.create({}), pick), []])
      expect(() => selectionRangeCommandFields(value)).toThrow();
    expect(reads).toBe(0);
  });
});

describe('complete immutable Color/Fill request capture', () => {
  const fill = () => ({ command: 'fillPick', sessionId: 4, tolerance: .25, mapId: 8, camera: [...camera],
    width: 80, height: 40, seed: [12, 13], operation: 1, sampleRadiusPixels: 2.5, ...fields });
  it('detaches every nested click/camera field before a queue or deferred callback can observe edits', () => {
    const source = { ...fill(), selectionView: [...camera] }, captured = captureSelectionRangeCommand(source, true);
    source.camera[0] = 90; source.seed[0] = 30; source.selectionView[0] = 100; source.rangeRadius = 20;
    expect(captured).toMatchObject({ camera, seed: [12, 13], selectionView: camera, rangeRadius: Math.fround(.1), sampleRadiusPixels: 2.5 });
    for (const value of [captured, captured.camera, captured.seed, captured.selectionView]) expect(Object.isFrozen(value)).toBe(true);
    expect(captureSelectionRangeCommand(captured, true)).toEqual(captured);
  });
  it('reserves physical sampling for new clients while permitting documented disabled legacy Fill omission', () => {
    const legacy: Record<string, unknown> = fill(); delete legacy.rangeEnabled; delete legacy.rangeRadius; delete legacy.sampleRadiusPixels;
    expect(captureSelectionRangeCommand(legacy)).toMatchObject({ rangeEnabled: false, rangeRadius: null });
    expect(() => captureSelectionRangeCommand(legacy, true)).toThrow();
    expect(() => captureSelectionRangeCommand({ ...legacy, ...fields })).toThrow();
    for (const sampleRadiusPixels of [0, -1, Infinity, Number.MIN_VALUE, Number.MAX_VALUE, '2'])
      expect(() => captureSelectionRangeCommand({ ...fill(), sampleRadiusPixels }, true)).toThrow();
  });
  it('refuses partial view captures, nested accessors and replacement amendment coordinates without invoking them', () => {
    let reads = 0;
    const seed = [1, 2]; Object.defineProperty(seed, '0', { enumerable: true, get() { reads++; return 1; } });
    const source = fill(); Object.defineProperty(source, 'tolerance', { enumerable: true, get() { reads++; return 1; } });
    for (const value of [source, { ...fill(), seed }, { ...fill(), width: undefined }, { ...fill(), camera: [] },
      { command: 'colorTolerance', sessionId: 4, tolerance: .1, camera, ...fields },
      { command: 'fillTolerance', sessionId: 4, tolerance: .1, mapId: 8, ...fields },
      { command: 'colorPick', sessionId: 4, tolerance: .1, index: 0, camera, width: 80, ...fields }])
      expect(() => captureSelectionRangeCommand(value)).toThrow();
    expect(reads).toBe(0);
  });
});

describe('required authoritative completed tolerance Range metadata', () => {
  it('requires the explicit nullable field and coherent safe owner tuple', () => {
    expect(validateToleranceRangeSummary(absent)).toBeNull();
    expect(toleranceRangeOwner(summary())).toMatchObject({ sessionId: 4, tool: 'color', range });
    for (const state of [{ loaded: false, kind: 0 }, { loaded: true, kind: 1 }, { loaded: true, kind: 2 }]) {
      expect(validateToleranceRangeSummary({ ...absent, ...state })).toBeNull();
      expect(() => validateToleranceRangeSummary(summary(state))).toThrow('Invalid native tolerance Range owner.');
    }
    for (const patch of [{ toleranceRange: undefined }, { toleranceSessionId: null }, { toleranceSessionId: 0 },
      { toleranceSessionId: .5 }, { toleranceSessionId: Number.MAX_SAFE_INTEGER + 1 }, { toleranceTool: null }, { toleranceTool: 'brush' },
      { toleranceRange: null }]) expect(() => validateToleranceRangeSummary(summary(patch))).toThrow();
    expect(() => validateToleranceRangeSummary({ ...absent, toleranceRange: range })).toThrow();
    const missing = summary(); delete (missing as Partial<typeof missing>).toleranceRange;
    expect(() => validateToleranceRangeSummary(missing)).toThrow();
  });
  it('deeply freezes detached native center coordinates without rounding or inheriting fields', () => {
    const source = { ...range, center: [Math.fround(.1), -2, 3] }, parsed = validateToleranceRange(source)!;
    source.center[0] = 99; expect(parsed.center).toEqual([Math.fround(.1), -2, 3]);
    expect(Object.isFrozen(parsed)).toBe(true); expect(Object.isFrozen(parsed.center)).toBe(true);
    expect(validateToleranceRange(Object.assign(Object.create(null), range))).toEqual(range);
    expect(sameToleranceRange(parsed, validateToleranceRange({ ...parsed, center: [...parsed.center!] }))).toBe(true);
    expect(sameToleranceRange(parsed, validateToleranceRange({ ...parsed, radius: 2 }))).toBe(false);
  });
  it.each([undefined, { ...range, center: undefined }, { ...range, radius: .1 }, { ...range, radius: null },
    { ...range, center: [1, 2] }, { ...range, center: [.1, 2, 3] }, { ...range, center: [1, NaN, 3] },
    { ...range, center: [1, Infinity, 3] }, { ...range, center: new Array(3) },
    { ...range, center: Object.assign([1, 2, 3], { extra: 1 }) }, { ...range, extra: true }])(
    'refuses invalid exact metadata shape or coordinates %#', value => {
      expect(() => validateToleranceRange(value)).toThrow('Invalid native tolerance Range.');
    });
  it('requires own data metadata and never evaluates object or coordinate accessors', () => {
    let reads = 0;
    const accessor = summary(); Object.defineProperty(accessor, 'toleranceRange', { enumerable: true, get() { reads++; return range; } });
    const hidden = summary(); Object.defineProperty(hidden, 'toleranceRange', { value: range, enumerable: false });
    const coordinate = [1, 2, 3]; Object.defineProperty(coordinate, '0', { enumerable: true, get() { reads++; return 1; } });
    const inherited = Object.assign(Object.create({ toleranceRange: range }), { loaded: true, kind: 0, toleranceSessionId: 4, toleranceTool: 'color' });
    for (const value of [accessor, hidden, inherited, summary({ toleranceRange: { ...range, center: coordinate } }),
      summary({ toleranceRange: { ...range, [Symbol('extra')]: true } })]) expect(() => validateToleranceRangeSummary(value)).toThrow();
    expect(reads).toBe(0);
  });
  it('requires a Color center even with Range disabled, while representing documented centerless Fill', () => {
    const centerless = { enabled: false, radius: null, center: null };
    expect(() => validateToleranceRangeSummary(summary({ toleranceRange: centerless }))).toThrow('Invalid native tolerance Range owner.');
    expect(validateToleranceRangeSummary(summary({ toleranceTool: 'fill', toleranceRange: centerless }))).toEqual(centerless);
    expect(validateToleranceRangeSummary(summary({ toleranceTool: 'fill', toleranceRange: { ...range, center: null } }))).toEqual({ ...range, center: null });
  });
  it('requires the exact own originating-checkpoint Undo boolean, with null only for no owner', () => {
    expect(toleranceRangeOwner(summary({ toleranceRecorded: false }))!.recorded).toBe(false);
    for (const toleranceRecorded of [undefined, null, 0, 1, 'true', NaN])
      expect(() => toleranceRangeOwner(summary({ toleranceRecorded }))).toThrow();
    for (const toleranceRecorded of [undefined, false, true]) expect(() => toleranceRangeOwner({ ...absent, toleranceRecorded })).toThrow();
    let reads = 0; const accessor = summary();
    Object.defineProperty(accessor, 'toleranceRecorded', { enumerable: true, get() { reads++; return true; } });
    expect(() => toleranceRangeOwner(accessor)).toThrow(); expect(reads).toBe(0);
  });
});

describe('explicit Range acknowledgement independent of receipt2 revision snapshots', () => {
  it('rejects a stale or cross-tool amendment before dispatch', () => {
    expect(() => assertToleranceRangeRequest({ command: 'colorTolerance', sessionId: 4, ...fields }, absent)).toThrow('another captured owner');
    expect(() => assertToleranceRangeRequest({ command: 'fillTolerance', sessionId: 4, ...fields }, summary())).toThrow('another captured owner');
    expect(() => assertToleranceRangeRequest(pick, summary())).toThrow('another captured owner');
  });
  it('acknowledges exact requested radius/config even when the ordinary revision has not changed', () => {
    const before = summary({ revision: 7, selectionCommitRevision: 2 }), after = summary({ revision: 7, selectionCommitRevision: 2,
      toleranceRange: { ...range, enabled: false, radius: 2 } });
    expect(assertToleranceRangeAcknowledgement({ command: 'colorTolerance', sessionId: 4, rangeEnabled: false, rangeRadius: 2 }, before, after)).toBe('completed');
    expect(() => assertToleranceRangeAcknowledgement({ command: 'colorTolerance', sessionId: 4, ...fields }, before, after)).toThrow('acknowledgement');
  });
  it('accepts a frozen Color click center and refuses subsequent center/session/tool replacement', () => {
    expect(assertToleranceRangeAcknowledgement(pick, absent, summary())).toBe('completed');
    for (const patch of [{ toleranceRange: { ...range, center: [9, 2, 3] } }, { toleranceSessionId: 5 }, { toleranceTool: 'fill' }])
      expect(() => assertToleranceRangeAcknowledgement({ command: 'colorTolerance', sessionId: 4, ...fields }, summary(), summary(patch))).toThrow('acknowledgement');
  });
  it('preserves the exact preceding owner on a missed pick without manufacturing a new center', () => {
    expect(assertToleranceRangeAcknowledgement({ ...pick, sessionId: 5 }, summary(), summary())).toBe('unchanged');
    expect(assertToleranceRangeAcknowledgement(pick, absent, absent)).toBe('unchanged');
    expect(() => assertToleranceRangeAcknowledgement({ ...pick, sessionId: 5 }, summary(), summary({ toleranceRange: { ...range, radius: 2 } }))).toThrow('acknowledgement');
    expect(() => assertToleranceRangeAcknowledgement(pick, summary(), summary())).toThrow('acknowledgement');
  });
  it('permits only disabled centerless Fill entry and a later absolute empty amendment with the same null center', () => {
    const before = summary({ toleranceTool: 'fill', toleranceRange: { enabled: false, radius: null, center: null } });
    expect(assertToleranceRangeAcknowledgement({ command: 'fillPick', sessionId: 4 }, absent, before)).toBe('completed');
    const enabled = summary({ toleranceTool: 'fill', toleranceRange: { ...range, center: null } });
    expect(() => assertToleranceRangeAcknowledgement({ command: 'fillPick', sessionId: 4, ...fields }, absent, enabled)).toThrow('acknowledgement');
    expect(assertToleranceRangeAcknowledgement({ command: 'fillTolerance', sessionId: 4, ...fields }, before, enabled)).toBe('completed');
    expect(() => assertToleranceRangeAcknowledgement({ command: 'fillTolerance', sessionId: 4, ...fields }, before,
      summary({ toleranceTool: 'fill' }))).toThrow('acknowledgement');
  });
  it('binds active/committed metadata to the accepted owner and rolled-back/not-started metadata to the exact baseline', () => {
    const before = summary(), successor = summary({ toleranceRange: { ...range, radius: 2 } });
    const proof = new ToleranceRangeOperation(before); proof.assert('active', before); proof.accept(successor);
    proof.assert('active', successor); proof.assert('committed', successor); proof.assert('rolled-back', before); proof.assert('not-started', before);
    for (const outcome of ['rolled-back', 'not-started']) expect(() => proof.assert(outcome, successor)).toThrow('outside its captured request');
    for (const outcome of ['active', 'committed']) expect(() => proof.assert(outcome, before)).toThrow('outside its captured request');
    expect(() => proof.assert('committed', summary({ toleranceRange: { ...successor.toleranceRange, center: [3, 2, 1] } }))).toThrow();
    expect(() => proof.assert('expired-conflict', before)).toThrow('outcome is unknown');
  });
  it('accepts authoritative true/false checkpoint rewinds only through a bound amendment and preserves them on missed picks', () => {
    const before = summary(), restored = summary({ toleranceRecorded: false });
    expect(assertToleranceRangeAcknowledgement({ command: 'colorTolerance', sessionId: 4, ...fields }, before, restored)).toBe('completed');
    const proof = new ToleranceRangeOperation(before);
    expect(() => proof.assert('committed', restored)).toThrow('outside its captured request');
    proof.accept(restored); proof.assert('committed', restored); proof.assert('rolled-back', before);
    expect(() => assertToleranceRangeAcknowledgement({ ...pick, sessionId: 5 }, before, restored)).toThrow('acknowledgement');
  });
});
