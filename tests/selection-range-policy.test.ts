import { describe, expect, it } from 'vitest';
import { resolveSelectionRange, resolvedSelectionRangeFields } from '../src/app/selectionRange';
import type { MorphologyRange } from '../src/input/selectionMorphology';

const range: MorphologyRange = { version: 1, minimum: .125, maximum: 128, default: 4 };
describe('viewer Range radius resolution', () => {
  it('recomputes the geometric mean using half the morphology maximum', () => {
    expect(resolveSelectionRange({ enabled: true, radius: null }, range)).toEqual({ minimum: .125, maximum: 64, value: Math.fround(Math.sqrt(8)) });
  });
  it('retains raw precision and restores a remembered value when a later source permits it', () => {
    const preference = Object.freeze({ enabled: true, radius: 100.123456789 });
    expect(resolveSelectionRange(preference, range)?.value).toBe(64);
    expect(resolveSelectionRange(preference, { ...range, maximum: 1024 })?.value).toBe(Math.fround(100.123456789));
    expect(preference.radius).toBe(100.123456789);
  });
  it.each([Number.MIN_VALUE, .00001, .1, 1e20, Number.MAX_VALUE])('clamps the remembered positive input %s before float32 quantization', radius => {
    const value = resolveSelectionRange({ enabled: false, radius }, range)!;
    expect(value.value).toBe(Math.fround(Math.max(.125, Math.min(64, radius))));
    expect(Object.isFrozen(value)).toBe(true);
  });
  it('keeps a collapsed scene range positive and exactly representable', () => {
    const collapsed = { version: 1 as const, minimum: Math.fround(1e-6), maximum: Math.fround(1e-6), default: Math.fround(1e-6) };
    expect(resolveSelectionRange({ enabled: true, radius: null }, collapsed)).toEqual({ minimum: collapsed.minimum, maximum: collapsed.minimum, value: collapsed.minimum });
  });
  it('requires statistics for an enabled command while preserving the disabled legacy path', () => {
    expect(resolvedSelectionRangeFields({ enabled: true, radius: 2 }, null)).toBeUndefined();
    expect(resolvedSelectionRangeFields({ enabled: false, radius: 2 }, null)).toEqual({ rangeEnabled: false, rangeRadius: null });
    expect(resolvedSelectionRangeFields({ enabled: false, radius: .1 }, range)).toEqual({ rangeEnabled: false, rangeRadius: .125 });
  });
});
