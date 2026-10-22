import { describe, expect, it } from 'vitest';
import { assertFilterAcknowledgement, assertFilterRequest, captureFilterState, captureSelectionFilterCommand, FilterOperation,
  filterDefaults, filterWireParameters, isSelectionFilterCommand, normalizeFilterParameters,
  sameFilterSummary, validateFilterSummary, validateFilterWireParameters } from '../src/document/filterProtocol';
import { estimateFilterWorkBytes } from '../src/document/filterMemory';

describe('desktop filter protocol and bounded admission', () => {
  it('retains independent shared defaults and only sends active predicate fields', () => {
    const defaults = filterDefaults(), another = filterDefaults(); defaults.center[0] = 9;
    expect(another.center).toEqual([0, 0, 0]);
    expect(filterWireParameters('sphere', another)).toEqual({ center: [0, 0, 0], radius: 1 });
    expect(filterWireParameters('box', another)).toEqual({ center: [0, 0, 0], size: [1, 1, 1], rotation: [0, 0, 0] });
    expect(filterWireParameters('ellipsoid', another)).toEqual(filterWireParameters('box', another));
    expect(filterWireParameters('opacity', another)).toEqual({ minimum: 0, maximum: 1 });
    expect(filterWireParameters('scale', another)).toEqual({ minimum: 0, maximum: 100 });
    expect(filterWireParameters('frustum', another)).toMatchObject({ fov: 60, aspect: 1, near: Math.fround(.1), far: 100 });
  });
  it('validates each active field without erasing persisted unrelated controls', () => {
    const parameters = { ...filterDefaults(), radius: -1, minOpacity: .9, maxOpacity: .1 };
    expect(normalizeFilterParameters('sphere', parameters)).toBeNull();
    expect(normalizeFilterParameters('opacity', parameters)).toBeNull();
    expect(normalizeFilterParameters('box', parameters)).toEqual(parameters);
    expect(filterWireParameters('box', parameters)).not.toHaveProperty('radius');
  });
  it.each([
    ['sphere', { center: [0, 0, 0], radius: 0 }, true],
    ['sphere', { center: [0, 0, 0], radius: -1 }, false],
    ['box', { center: [0, 0, 0], size: [0, 1, 1], rotation: [0, 0, 90] }, true],
    ['ellipsoid', { center: [0, 0, 0], size: [0, 1, 1], rotation: [0, 0, 90] }, false],
    ['opacity', { minimum: 0, maximum: 1 }, true],
    ['opacity', { minimum: .2, maximum: .1 }, false],
    ['scale', { minimum: 200, maximum: 300 }, true],
    ['scale', { minimum: 0, maximum: Infinity }, false],
    ['frustum', { center: [0, 0, 0], rotation: [0, 0, 0], fov: 60, aspect: 1, near: 0, far: .001 }, true],
    ['frustum', { center: [0, 0, 0], rotation: [0, 0, 0], fov: 180, aspect: 1, near: .1, far: 100 }, false],
    ['frustum', { center: [0, 0, 0], rotation: [0, 0, 0], fov: 60, aspect: 1, near: 2, far: 1 }, false],
  ] as const)('checks %s bounds for %j', (kind, parameters, accepted) => {
    expect(!!validateFilterWireParameters(kind, parameters)).toBe(accepted);
  });
  it('refuses malformed vectors, extra fields and accessor payloads without invoking getters', () => {
    for (const center of [[0, 0], [0, 0, 0, 0], [NaN, 0, 0], [1e13, 0, 0]])
      expect(validateFilterWireParameters('sphere', { center, radius: 1 })).toBeNull();
    expect(validateFilterWireParameters('sphere', { center: [0, 0, 0], radius: 1, invert: true })).toBeNull();
    let reads = 0;
    const accessor = { center: [0, 0, 0], get radius() { reads++; return 1; } };
    expect(validateFilterWireParameters('sphere', accessor)).toBeNull(); expect(reads).toBe(0);
  });
  it('requires exact source-independent owner identity and monotonic preview metadata', () => {
    const began = validateFilterSummary({ id: 7, kind: 'box', epoch: 0, previewEpoch: null, changed: false });
    const preview = validateFilterSummary({ id: 7, kind: 'box', epoch: 2, previewEpoch: 1, changed: true });
    expect(Object.isFrozen(began)).toBe(true); expect(sameFilterSummary(began, preview)).toBe(false);
    expect(sameFilterSummary(preview, { ...preview! })).toBe(true);
    expect(validateFilterSummary(null)).toBeNull();
    for (const value of [undefined, {}, { ...began, id: 0 }, { ...began, kind: 'cube' },
      { ...began, epoch: .1 }, { ...began, previewEpoch: 1 }, { ...preview, previewEpoch: 3 },
      { ...preview, epoch: Number.MAX_SAFE_INTEGER + 1 }, { ...preview, selectionDraft: true }])
      expect(() => validateFilterSummary(value)).toThrow('Invalid native selection filter metadata');
  });
  it('rejects invalid family commands before native execution', () => {
    expect(isSelectionFilterCommand({ command: 'beginFilter', kind: 'sphere' })).toBe(true);
    expect(isSelectionFilterCommand({ command: 'cancelFilter', id: 1 })).toBe(true);
    const preview = { command: 'previewFilter', id: 1, epoch: 2, kind: 'sphere', operation: 3, parameters: { center: [0, 0, 0], radius: 1 } };
    expect(isSelectionFilterCommand(preview)).toBe(true);
    for (const command of [{ ...preview, epoch: 0 }, { ...preview, operation: 4 }, { ...preview, id: -1 },
      { ...preview, kind: 'cone' }, { command: 'confirmFilter', id: 1, epoch: 0 }, { command: 'cancelFilter', id: 1, epoch: 2 }])
      expect(isSelectionFilterCommand(command)).toBe(false);
  });
  it('admits bounded preview work independently from scene/file size and rejects malformed counts', () => {
    expect(estimateFilterWorkBytes(1_000_000) - estimateFilterWorkBytes(0)).toBe(32_000_000);
    for (const count of [-1, .1, NaN, 1_000_001]) expect(() => estimateFilterWorkBytes(count)).toThrow();
  });
});

describe('authoritative filter difference and persistent metadata proof', () => {
  const baseline = { id: 7, kind: 'sphere' as const, epoch: 0, previewEpoch: null, changed: false };
  const scene = (filter: unknown = baseline, patch: Record<string, unknown> = {}) => ({ loaded: true, kind: 0,
    selectionDraft: false, pending: false, selected: 2, filter, ...patch });
  const preview = { command: 'previewFilter' as const, id: 7, epoch: 1, kind: 'sphere' as const,
    operation: 0, parameters: { center: [0, 0, 0] as [number, number, number], radius: 1 } };
  it('requires an own boolean, rejects null-preview differences and never evaluates a getter', () => {
    for (const changed of [undefined, null, 0, 1, 'true', NaN]) expect(() => validateFilterSummary({ ...baseline, changed })).toThrow();
    expect(() => validateFilterSummary({ ...baseline, changed: true })).toThrow();
    let reads = 0; const accessor = { ...baseline };
    Object.defineProperty(accessor, 'changed', { enumerable: true, get() { reads++; return false; } });
    expect(() => validateFilterSummary(accessor)).toThrow(); expect(reads).toBe(0);
    const missing = { loaded: true, kind: 0, selectionDraft: false, pending: false };
    expect(() => captureFilterState(missing)).toThrow();
    expect(() => captureFilterState(scene(baseline, { kind: 1 }))).toThrow();
    expect(() => captureFilterState(scene(baseline, { loaded: false }))).toThrow();
    expect(() => captureFilterState(scene(baseline, { selectionDraft: true }))).toThrow();
  });
  it('distinguishes no-op and equal-count changed previews through the native scalar alone', () => {
    const before = captureFilterState(scene());
    for (const changed of [false, true]) {
      const after = scene({ ...baseline, epoch: 1, previewEpoch: 1, changed });
      expect(() => assertFilterAcknowledgement(preview, before, after)).not.toThrow();
      expect(captureFilterState(after).filter!.changed).toBe(changed); expect(after.selected).toBe(2);
    }
    expect(sameFilterSummary({ ...baseline, epoch: 1, previewEpoch: 1, changed: false },
      { ...baseline, epoch: 1, previewEpoch: 1, changed: true })).toBe(false);
  });
  it('captures vectors and view before queues and refuses caller-supplied result metadata', () => {
    const source = { ...preview, parameters: { center: [1, 2, 3], radius: 2 }, selectionView: [0, 0, 0, 0, 0, 3, 1, 45, 0, 0, 1] };
    const captured = captureSelectionFilterCommand(source);
    source.parameters.center[0] = 99; source.selectionView[0] = 88;
    expect(captured).toMatchObject({ parameters: { center: [1, 2, 3] }, selectionView: [0, 0, 0, 0, 0, 3, 1, 45, 0, 0, 1] });
    expect(Object.isFrozen(captured)).toBe(true);
    if (captured.command !== 'previewFilter') throw new Error('Wrong command');
    expect(Object.isFrozen(captured.parameters)).toBe(true); expect(Object.isFrozen(captured.parameters.center)).toBe(true);
    expect(Object.isFrozen(captured.selectionView)).toBe(true);
    expect(() => captureSelectionFilterCommand({ ...preview, changed: true })).toThrow();
  });
  it('checks the before owner and permits only the prior visible metadata when a preview is interrupted', () => {
    const before = captureFilterState(scene({ ...baseline, epoch: 1, previewEpoch: 1, changed: true })), command = { ...preview, epoch: 2 };
    const retained = scene({ ...baseline, epoch: 2, previewEpoch: 1, changed: true });
    expect(() => assertFilterAcknowledgement(command, before, retained, true)).not.toThrow();
    expect(() => assertFilterAcknowledgement(command, before, retained)).toThrow('acknowledgement');
    expect(() => assertFilterAcknowledgement(command, before, scene({ ...baseline, epoch: 2, previewEpoch: 1, changed: false }), true)).toThrow();
    expect(() => assertFilterRequest({ ...preview, epoch: 1 }, before)).toThrow('another captured owner');
    expect(() => assertFilterRequest({ command: 'confirmFilter', id: 7, epoch: 1 }, captureFilterState(retained))).toThrow();
    expect(() => assertFilterRequest({ command: 'beginFilter', kind: 'sphere' }, before)).toThrow();
  });
  it('confirms an older acknowledged visible epoch only with explicit true and no active job', () => {
    const before = captureFilterState(scene({ ...baseline, epoch: 2, previewEpoch: 1, changed: true }));
    const command = { command: 'confirmFilter' as const, id: 7, epoch: 1, visiblePreview: true as const };
    expect(captureSelectionFilterCommand(command)).toEqual(command);
    expect(() => assertFilterRequest(command, before)).not.toThrow();
    expect(() => assertFilterAcknowledgement(command, before, scene(null))).not.toThrow();
    expect(() => assertFilterRequest({ command: 'confirmFilter', id: 7, epoch: 1 }, before)).toThrow();
    expect(() => assertFilterRequest({ ...command, epoch: 2 }, before)).toThrow();
    expect(() => assertFilterRequest(command, { ...before, pending: true })).toThrow();
    for (const visiblePreview of [false, undefined, null, 1, 'true'])
      expect(isSelectionFilterCommand({ ...command, visiblePreview })).toBe(false);
  });
  it('binds full changed metadata to commit/status and the exact baseline to rollback independently of receipt2', () => {
    const before = scene(), after = scene({ ...baseline, epoch: 1, previewEpoch: 1, changed: true }), proof = new FilterOperation(before);
    proof.assert('active', before); proof.accept(after); proof.assert('active', after); proof.assert('committed', after); proof.assert('rolled-back', before);
    expect(() => proof.assert('committed', scene({ ...baseline, epoch: 1, previewEpoch: 1, changed: false }))).toThrow('outside its captured request');
    expect(() => proof.assert('rolled-back', after)).toThrow('outside its captured request');
    expect(() => proof.assert('expired-conflict', before)).toThrow('outcome is unknown');
  });
});
