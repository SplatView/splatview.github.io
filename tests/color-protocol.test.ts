import { describe, expect, it } from 'vitest';
import { colorValues, sameColorBase, validateColorSession } from '../src/document/colorProtocol';
import { NEUTRAL_COLOR } from '../src/document/types';

const session = () => ({ version: 1, active: true, sessionId: 1, baseId: 2, epochId: 3,
  selectedOnly: false, pending: false, values: [...NEUTRAL_COLOR], applied: [...NEUTRAL_COLOR] });
describe('color session wire values', () => {
  it.each([new Array(15), [...NEUTRAL_COLOR.slice(0, 14)], [...NEUTRAL_COLOR, 0],
    [...NEUTRAL_COLOR.slice(0, 14), NaN], [...NEUTRAL_COLOR.slice(0, 14), Infinity],
    [...NEUTRAL_COLOR.slice(0, 14), '0'], [6, ...NEUTRAL_COLOR.slice(1)]])('refuses malformed and sparse fields %#', value => {
    expect(() => colorValues(value)).toThrow('Invalid color values');
    expect(() => validateColorSession({ ...session(), values: value })).toThrow();
  });
  it('clones and freezes acknowledged fields so later input mutation cannot change an owner', () => {
    const input = session(), result = validateColorSession(input)!;
    input.values[0] = 4; input.applied[0] = 3;
    expect(result.values).toEqual(NEUTRAL_COLOR); expect(result.applied).toEqual(NEUTRAL_COLOR);
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.values)).toBe(true);
    expect(Object.isFrozen(result.applied)).toBe(true);
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, '1'])('rejects unsafe identities %s', id => {
    expect(() => validateColorSession({ ...session(), epochId: id })).toThrow();
  });
  it('accepts exact maximum identity and requires all three identities to match', () => {
    const value = validateColorSession({ ...session(), epochId: Number.MAX_SAFE_INTEGER })!;
    expect(sameColorBase(value, value)).toBe(true);
    expect(sameColorBase(value, { ...value, sessionId: 2 })).toBe(false);
    expect(sameColorBase(value, { ...value, baseId: 3 })).toBe(false);
    expect(sameColorBase(value, { ...value, epochId: 1 })).toBe(false);
  });
  it.each([{ extra: 1 }, { active: false }, { version: 2 }, { selectedOnly: 1 }, { pending: 0 }])('rejects malformed metadata %#', patch => {
    expect(() => validateColorSession({ ...session(), ...patch })).toThrow();
  });
  it('accepts inactive or absent metadata without creating a session', () => {
    expect(validateColorSession(null)).toBeNull(); expect(validateColorSession(undefined)).toBeNull();
  });
});
