import { describe, expect, it, vi } from 'vitest';
import { captureSelectionViewCommand, isBeginColorCommand, validateSelectionView } from '../src/document/selectionView';
import { isTransformCommand } from '../src/document/transformProtocol';
import { isOpacityCommand } from '../src/document/opacityProtocol';
import { isSelectionFilterCommand } from '../src/document/filterProtocol';

const camera = () => [0, 0, 0, .35, .18, 3, 1, 45, 0, 0, 1];
describe('current-view command scope', () => {
  it('detaches and freezes canonical float camera values; absence and null are unrestricted', () => {
    expect(validateSelectionView(undefined)).toBeNull(); expect(validateSelectionView(null)).toBeNull();
    const input = camera(), result = validateSelectionView(input)!; input[0] = 100;
    expect(result[0]).toBe(0); expect(result[3]).toBe(Math.fround(.35)); expect(Object.isFrozen(result)).toBe(true);
    const scope = camera(), command = captureSelectionViewCommand({ command: 'single', index: 1, selectionView: scope });
    scope[0] = 2; expect(command.selectionView![0]).toBe(0);
  });
  it.each([0, 5, 6, 7, 8, 10])('refuses invalid native camera component %i', index => {
    for (const invalid of [NaN, Infinity, -Infinity, Number.MAX_VALUE]) {
      const input = camera(); input[index] = invalid; expect(() => validateSelectionView(input)).toThrow();
    }
    if ([5, 6, 10].includes(index)) { const input = camera(); input[index] = 0; expect(() => validateSelectionView(input)).toThrow(); }
    if (index === 7) for (const value of [9.99, 120.01, 120.000000001]) { const input = camera(); input[index] = value; expect(() => validateSelectionView(input)).toThrow(); }
    if (index === 8) for (const value of [.5, 1.0000000001]) { const input = camera(); input[index] = value; expect(() => validateSelectionView(input)).toThrow(); }
  });
  it('refuses sparse/accessor/foreign arrays without invoking camera getters', () => {
    const sparse = camera(); delete sparse[3];
    const getter = vi.fn(() => 3), accessor = camera(); Object.defineProperty(accessor, '5', { enumerable: true, get: getter });
    const extra = Object.assign(camera(), { unexpected: 1 });
    for (const value of [sparse, accessor, extra, new Float32Array(camera()), camera().slice(0, 10), [...camera(), 1], Object.setPrototypeOf(camera(), null)])
      expect(() => validateSelectionView(value)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it('keeps exact session command shapes and accepts scope only when captured', () => {
    expect(isTransformCommand({ command: 'beginTransform', kind: 'numeric', selectedOnly: true, selectionView: camera() })).toBe(true);
    expect(isOpacityCommand({ command: 'beginOpacity', selectedOnly: true, selectionView: null })).toBe(true);
    expect(isBeginColorCommand({ command: 'beginColor', selectedOnly: true, selectionView: camera() })).toBe(true);
    for (const command of [{ command: 'beginColor', selectedOnly: 1 }, { command: 'beginColor', selectedOnly: true, extra: 1 },
      { command: 'beginColor', selectedOnly: true, selectionView: [] }]) expect(isBeginColorCommand(command)).toBe(false);
    expect(isTransformCommand({ command: 'endTransform', id: 1, selectionView: camera() })).toBe(false);
    expect(isOpacityCommand({ command: 'applyOpacity', id: 1, epoch: 1, scale: 2, selectionView: camera() })).toBe(false);
    expect(isSelectionFilterCommand({ command: 'previewFilter', id: 1, epoch: 1, kind: 'opacity',
      parameters: { minimum: 0, maximum: 1 }, operation: 0, selectionView: camera() })).toBe(true);
    expect(isSelectionFilterCommand({ command: 'confirmFilter', id: 1, epoch: 1, selectionView: camera() })).toBe(false);
  });
  it.each(['restore', 'resetCleanup', 'undo', 'redo', 'export', 'alignCenter', 'colorTolerance', 'fillTolerance'])('%s cannot inject a new scope', command => {
    expect(() => captureSelectionViewCommand({ command, selectionView: camera() })).toThrow();
  });
});
