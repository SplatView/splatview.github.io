import { describe, expect, it, vi } from 'vitest';
import { isTransformCommand, patchTransformParameters, transformDefaults, transformUiParameters, transformWireParameters,
  validateTransformBaseIdentity, validateTransformDefinition, validateTransformMatrix, validateTransformSummary } from '../src/document/transformProtocol';

describe('native Pro transform DTOs', () => {
  it('detaches all retained representations and switches modes without converting arrays', () => {
    const original = transformDefaults(); original.euler = [10, 20, 30]; original.quaternion = [2, 3, 4, 5];
    const copy = transformUiParameters(original)!; original.euler[0] = 99;
    expect(copy.euler).toEqual([10, 20, 30]);
    const switched = patchTransformParameters(copy, { mode: 'quaternion' })!;
    expect(switched.euler).toEqual([10, 20, 30]); expect(switched.quaternion).toEqual([2, 3, 4, 5]);
    expect(transformWireParameters(switched)).toEqual({ mode: 'quaternion', translation: [0, 0, 0], scale: [1, 1, 1],
      pivot: [0, 0, 0], flips: [false, false, false], quaternion: [2, 3, 4, 5] });
  });
  it.each(['euler', 'quaternion', 'axis-angle', 'matrix'] as const)('sends only exact active %s fields', mode => {
    const parameters = transformDefaults(); parameters.mode = mode;
    const wire = transformWireParameters(parameters)!;
    const keys = mode === 'matrix' ? ['flips', 'matrix', 'mode', 'pivot'] :
      ['flips', 'mode', 'pivot', 'scale', 'translation', ...(mode === 'axis-angle' ? ['angle', 'axis'] : [mode])];
    expect(Object.keys(wire).sort()).toEqual(keys.sort()); expect(validateTransformDefinition(wire)).toEqual(wire);
    expect(validateTransformDefinition({ ...wire, irrelevant: 1 })).toBeNull();
  });
  it('retains finite invalid desired values while active validation refuses them', () => {
    const parameters = patchTransformParameters(transformDefaults(), { scale: [-1, 0, 2], quaternion: [0, 0, 0, 0] })!;
    expect(parameters.scale).toEqual([-1, 0, 2]); expect(transformWireParameters(parameters)).toBeNull();
    expect(transformWireParameters({ ...parameters, mode: 'matrix' })).not.toBeNull();
    expect(transformWireParameters({ ...parameters, mode: 'quaternion', scale: [1, 1, 1] })).toBeNull();
  });
  it('admits reflected/sheared/singular affine matrix entry without changing its row-major layout', () => {
    const parameters = transformDefaults(); parameters.mode = 'matrix';
    parameters.matrix = [-1, .5, 0, 7, 0, 0, 0, 8, 0, 0, 2, 9, 0, 0, 0, 1]; parameters.pivot = [4, 5, 6]; parameters.flips = [true, false, true];
    expect(transformWireParameters(parameters)).toEqual({ mode: 'matrix', matrix: parameters.matrix, pivot: [4, 5, 6], flips: [true, false, true] });
    expect(transformWireParameters({ ...parameters, matrix: [...parameters.matrix.slice(0, 12), 1, 0, 0, 1] as typeof parameters.matrix })).toBeNull();
  });
  it('distinguishes raw input bounds from larger valid composed GPU output', () => {
    const matrix = transformDefaults().matrix; matrix[12] = Math.fround(1e18);
    expect(validateTransformMatrix(matrix)).toEqual(matrix);
    const parameters = transformDefaults(); parameters.mode = 'matrix'; parameters.matrix[3] = Math.fround(1e18);
    expect(transformWireParameters(parameters)).toBeNull();
  });
  it('rejects malformed/accessor/nonfinite control patches without invoking accessors', () => {
    const getter = vi.fn(() => [1, 2, 3]), patch = Object.defineProperty({}, 'translation', { enumerable: true, get: getter });
    expect(patchTransformParameters(transformDefaults(), patch)).toBeNull(); expect(getter).not.toHaveBeenCalled();
    for (const value of [{ angle: Number.NaN }, { pivot: [1, 2] }, { flips: [1, 0, 1] }, { unexpected: 1 }])
      expect(patchTransformParameters(transformDefaults(), value)).toBeNull();
  });
  it('requires exact positive owner/base identities and monotonic accepted-epoch metadata', () => {
    const metadata = { id: 1, baseId: 2, epoch: 0, appliedEpoch: null, kind: 'numeric', selectedOnly: true,
      appliedMatrix: transformDefaults().matrix, pivot: [3, 4, 5], gizmo: null };
    expect(validateTransformSummary(metadata)).toEqual(metadata); expect(Object.isFrozen(validateTransformSummary(metadata))).toBe(true);
    for (const patch of [{ id: 0 }, { baseId: 0 }, { epoch: -1 }, { appliedEpoch: 1 }, { kind: 'unknown' }, { selectedOnly: 1 }])
      expect(() => validateTransformSummary({ ...metadata, ...patch })).toThrow();
    expect(() => validateTransformSummary(undefined)).toThrow(); expect(validateTransformSummary(null)).toBeNull();
    expect(validateTransformBaseIdentity({ id: 1, baseId: 2, epoch: 0 })).toEqual({ id: 1, baseId: 2, epoch: 0 });
    expect(() => validateTransformBaseIdentity({ id: 1, baseId: 2, epoch: 0, extra: 1 })).toThrow();
  });
  it('admits only exact transform commands and active definitions', () => {
    expect(isTransformCommand({ command: 'beginTransform', kind: 'gizmo', selectedOnly: false })).toBe(true);
    expect(isTransformCommand({ command: 'applyTransform', id: 1, epoch: 1, parameters: transformWireParameters(transformDefaults()) })).toBe(true);
    expect(isTransformCommand({ command: 'resetTransform', id: 1, epoch: 2 })).toBe(true);
    expect(isTransformCommand({ command: 'endTransform', id: 1 })).toBe(true);
    for (const command of [{ command: 'beginTransform', kind: 'numeric' }, { command: 'applyTransform', id: 1, epoch: 0, parameters: {} },
      { command: 'endTransform', id: 1, epoch: 2 }, { command: 'resetTransform', id: Number.NaN, epoch: 2 }]) expect(isTransformCommand(command)).toBe(false);
  });
});
