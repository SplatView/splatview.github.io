import { describe, expect, it, vi } from 'vitest';
import { isOpacityCommand, opacityScale, opacityUiScale, validateOpacityBaseIdentity, validateOpacitySummary } from '../src/document/opacityProtocol';
import { estimateOpacityWorkBytes, OPACITY_VIEW_BOOKKEEPING_BYTES } from '../src/document/opacityMemory';
import { estimateSceneBytes } from '../src/document/resources';
const session = () => ({ id: 1, baseId: 2, epoch: 0, appliedEpoch: null, selectedOnly: false, appliedScale: 1 });
describe('native opacity session protocol', () => {
  it('retains finite invalid UI values while native wire values require float32 scale0-5', () => {
    expect(opacityUiScale(6)).toBe(6); expect(opacityUiScale(-1)).toBe(-1); expect(opacityUiScale(Number.NaN)).toBeNull();
    for (const value of [0, .3, 1, 3, 5]) expect(opacityScale(value)).toBe(Math.fround(value));
    for (const value of [-1, 5.001, Infinity, '1', null]) expect(opacityScale(value)).toBeNull();
  });
  it('requires a nullable exact six-field owner and valid accepted epochs', () => {
    expect(validateOpacitySummary(null)).toBeNull(); expect(validateOpacitySummary(session())).toEqual(session());
    expect(validateOpacitySummary({ ...session(), epoch: 3, appliedEpoch: 2, appliedScale: .3 })).toMatchObject({ appliedScale: Math.fround(.3) });
    for (const value of [undefined, {}, { ...session(), kind: 'numeric' }, { ...session(), id: 0 }, { ...session(), baseId: 0 },
      { ...session(), epoch: -1 }, { ...session(), appliedEpoch: 0 }, { ...session(), appliedEpoch: 1 }, { ...session(), appliedScale: 2 },
      { ...session(), epoch: 2, appliedEpoch: 3 }, { ...session(), selectedOnly: 1 }]) expect(() => validateOpacitySummary(value)).toThrow();
  });
  it('admits consumed failed epochs with the previous accepted scalar and freezes detached metadata', () => {
    const original = { ...session(), epoch: 3, appliedEpoch: 2, appliedScale: .5 }, result = validateOpacitySummary(original)!;
    original.appliedScale = 3; expect(result.appliedScale).toBe(.5); expect(Object.isFrozen(result)).toBe(true);
    expect(validateOpacitySummary({ ...session(), epoch: 3 })).toEqual({ ...session(), epoch: 3 });
  });
  it('refuses malformed/accessor command and summary objects without invoking getters', () => {
    const getter = vi.fn(() => 2), value = Object.defineProperty({ ...session() }, 'appliedScale', { enumerable: true, get: getter });
    expect(() => validateOpacitySummary(value)).toThrow(); expect(getter).not.toHaveBeenCalled();
    const command = Object.defineProperty({}, 'command', { enumerable: true, get: getter }); expect(isOpacityCommand(command)).toBe(false);
    expect(getter).not.toHaveBeenCalled(); expect(isOpacityCommand({ command: 'applyOpacity', id: 1, epoch: 1, scale: 2, selectedOnly: true })).toBe(false);
  });
  it('accepts only the four exact session commands and fenced base identities', () => {
    for (const command of [{ command: 'beginOpacity', selectedOnly: true }, { command: 'applyOpacity', id: 1, epoch: 1, scale: 2 },
      { command: 'resetOpacity', id: 1, epoch: 2 }, { command: 'endOpacity', id: 1 }]) expect(isOpacityCommand(command)).toBe(true);
    for (const command of [{ command: 'applyOpacity', id: 1, epoch: 0, scale: 2 }, { command: 'applyOpacity', id: 1, epoch: 1, scale: 6 },
      { command: 'endOpacity', id: 0 }, { command: 'beginOpacity', selectedOnly: 1 }]) expect(isOpacityCommand(command)).toBe(false);
    expect(validateOpacityBaseIdentity({ id: 1, baseId: 2, epoch: 0 })).toEqual({ id: 1, baseId: 2, epoch: 0 });
    for (const identity of [undefined, null, { id: 1, baseId: 2 }, { id: 1, baseId: 2, epoch: 0, extra: 1 }]) expect(() => validateOpacityBaseIdentity(identity)).toThrow();
  });
  it('admits one candidate/job allowance separately from existing history/base ownership', () => {
    expect(estimateOpacityWorkBytes(3, 3)).toBe(estimateSceneBytes(3, 3) + OPACITY_VIEW_BOOKKEEPING_BYTES);
    for (const count of [-1, .5, 1_000_001, Infinity]) expect(() => estimateOpacityWorkBytes(count, 0)).toThrow();
  });
});
