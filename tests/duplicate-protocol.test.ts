import { describe, expect, it, vi } from 'vitest';
import { isDuplicateCommand, sameDuplicateRange, validateDuplicateRange, validateDuplicateSummary } from '../src/document/duplicateProtocol';
import { captureSelectionViewCommand, SELECTION_VIEW_COMMANDS } from '../src/document/selectionView';

describe('Duplicate scene marker and command contract', () => {
  it('copies a nonempty suffix and compares values across independent wire objects', () => {
    const input = { first: 3, count: 2 }, range = validateDuplicateRange(input, 5);
    expect(range).toEqual(input); expect(range).not.toBe(input); expect(Object.isFrozen(range)).toBe(true);
    input.first = 0;
    expect(sameDuplicateRange(range, { first: 3, count: 2 })).toBe(true);
    expect(sameDuplicateRange(range, { first: 2, count: 3 })).toBe(false);
    expect(sameDuplicateRange(range, null)).toBe(false); expect(sameDuplicateRange(null, null)).toBe(true);
    expect(validateDuplicateRange({ first: 999_999, count: 1 }, 1_000_000)).toEqual({ first: 999_999, count: 1 });
  });
  it.each([undefined, [], {}, { first: 0 }, { first: 0, count: 0 }, { first: 0, count: 4 },
    { first: 1, count: 5 }, { first: 4, count: 2 }, { first: -0, count: 5 }, { first: 3, count: -0 },
    { first: 3.5, count: 1.5 }, { first: -1, count: 6 }, { first: 3, count: 2, revision: 9 },
    { first: 3, count: 2, [Symbol('range')]: true }, { first: Infinity, count: 2 },
    { first: Number.MAX_SAFE_INTEGER, count: 2 }, Object.create({ first: 3, count: 2 })])('refuses invalid suffix %#', value => {
    expect(() => validateDuplicateRange(value, 5)).toThrow();
  });
  it('requires inert own data and refuses markers on unloaded or geometry scenes', () => {
    const getter = vi.fn(() => 3), range = Object.defineProperty({ count: 2 }, 'first', { enumerable: true, get: getter });
    expect(() => validateDuplicateRange(range, 5)).toThrow(); expect(getter).not.toHaveBeenCalled();
    expect(() => validateDuplicateRange({ first: 3, count: 2 }, 5, false)).toThrow();
    expect(() => validateDuplicateRange(null, 1_000_001)).toThrow();
    expect(() => validateDuplicateRange(null, -0)).toThrow();
    const summary = { loaded: true, kind: 0, count: 5, sourceCount: 9, duplicateRange: null };
    expect(validateDuplicateSummary(summary)).toBeNull();
    const { duplicateRange: _range, ...missing } = summary;
    expect(() => validateDuplicateSummary(missing as typeof summary)).toThrow(/Missing/);
    expect(() => validateDuplicateSummary({ ...summary, count: 10 })).toThrow(/topology/);
    expect(() => validateDuplicateSummary({ ...summary, kind: 1, duplicateRange: { first: 3, count: 2 } })).toThrow();
    expect(() => validateDuplicateSummary({ ...summary, loaded: false, count: 0 })).toThrow();
  });
  it('admits only Duplicate and a frozen captured camera, with no caller supplied records or marker', () => {
    expect(SELECTION_VIEW_COMMANDS).toContain('duplicate');
    expect(isDuplicateCommand({ command: 'duplicate' })).toBe(true);
    const camera = [0, 0, 0, 0, 0, 5, 1, 60, 1, 0, 1];
    const command = { command: 'duplicate', selectionView: camera };
    expect(isDuplicateCommand(command)).toBe(true);
    const captured = captureSelectionViewCommand(command); camera[0] = 10;
    expect(captured.selectionView[0]).toBe(0); expect(Object.isFrozen(captured.selectionView)).toBe(true);
    for (const value of [null, [], {}, { command: 'Duplicate' }, { command: 'duplicate', first: 3 },
      { command: 'duplicate', duplicateRange: null }, { command: 'duplicate', selectionView: [0] },
      Object.create({ command: 'duplicate' })]) expect(isDuplicateCommand(value)).toBe(false);
    const getter = vi.fn(() => camera), accessor = Object.defineProperty({ command: 'duplicate' }, 'selectionView', { enumerable: true, get: getter });
    expect(isDuplicateCommand(accessor)).toBe(false); expect(getter).not.toHaveBeenCalled();
  });
});
