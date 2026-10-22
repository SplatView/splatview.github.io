import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { GradeControls } from '../src/ui/GradeControls';
import { gradeDisplayValue, gradeEntryText, gradeEscapeValue, gradePointerValue, gradeSliderTweak,
  gradeValueText, parseGradeText, type GradeField } from '../src/ui/gradeInput';
import { colorFields } from '../src/generated/desktop';

// Independent literal captured field metadata used by input arithmetic oracles.
const brightness: GradeField = { name: 'brightness', label: 'Brightness', low: 0, high: 5, displayScale: 1, format: '%.2f×' };
const contrast: GradeField = { name: 'contrast', label: 'Contrast', low: 0, high: 5, displayScale: 100, format: '%.0f%%' };
const temperature: GradeField = { name: 'temperature', label: 'Temperature', low: -1, high: 1, displayScale: 100, format: '%.0f' };
const hue: GradeField = { name: 'hue', label: 'Hue shift', low: -180, high: 180, displayScale: 1, format: '%.0f°' };
const fade: GradeField = { name: 'fade', label: 'Fade', low: 0, high: 1, displayScale: 100, format: '%.0f%%' };
const gamma: GradeField = { name: 'gamma', label: 'Gamma', low: .1, high: 5, displayScale: 1, format: '%.2f' };

describe('grading display and field-local text policy', () => {
  it('presents multiplier, percent, degrees and gamma decimals while preserving raw values on display', () => {
    const input = Object.freeze([Math.fround(1.234567), Math.fround(.375123)]), before = [...input];
    expect(gradeValueText(brightness, input[0])).toBe('1.23×'); expect(gradeValueText(contrast, input[1])).toBe('38%');
    expect(gradeValueText(hue, 12.25)).toBe('12°'); expect(gradeValueText(gamma, .125)).toBe('0.12');
    expect(input).toEqual(before); expect(gradeEntryText(brightness, input[0])).toBe('1.23');
    expect(gradeDisplayValue(contrast, input[1])).toBe(Math.fround(input[1] * 100));
  });
  it.each([[.125, '0.12'], [.375, '0.38'], [-.125, '-0.12'], [-.375, '-0.38']] as const)
   ('uses CRT nearest-even two-decimal tie formatting for %s', (value, expected) => {
      expect(gradeEntryText(brightness, value)).toBe(expected);
    });
  it.each([[2.5, '2°'], [3.5, '4°'], [-2.5, '-2°'], [-3.5, '-4°']] as const)
   ('uses signed nearest-even integer tie formatting for %s', (value, expected) => {
      expect(gradeValueText(hue, value)).toBe(expected);
    });
  it('retains the sign of formatted negative zero', () => {
    expect(gradeEntryText(brightness, -.001)).toBe('-0.00'); expect(gradeValueText(hue, -.25)).toBe('-0°');
  });
  it.each([[contrast, ' 125% ', 1.25], [brightness, '1.234567×', 1.234567], [hue, '-42.25°', -42.25],
    [gamma, '.125', .125], [temperature, '+100', 1], [temperature, '-2e1', -.2]] as const)
   ('parses complete finite display text %s/%s without format-rounding typed precision', (field, text, expected) => {
      expect(parseGradeText(field, text)).toBe(Math.fround(expected));
    });
  it.each(['', ' ', '-', '.', '1e', 'NaN', 'Infinity', '1e999', '1.25junk', '1+2', '0x10', '10%%', '1% trailing'])
   ('rejects invalid text %j rather than applying an older value', text => { expect(parseGradeText(contrast, text)).toBeNull(); });
  it('clamps after display-unit parsing and does not treat +100 as relative arithmetic', () => {
    expect(parseGradeText(contrast, '+100')).toBe(1); expect(parseGradeText(contrast, '700%')).toBe(5);
    expect(parseGradeText(temperature, '-700')).toBe(-1); expect(parseGradeText(gamma, '0')).toBe(Math.fround(.1));
    expect(parseGradeText(hue, '250°')).toBe(180);
  });
  it('keeps untouched and equal-format hidden-decimal edits on Escape, restoring only a different formatted display', () => {
    const raw = Math.fround(1.234), initial = gradeEntryText(brightness, raw);
    expect(initial).toBe('1.23'); expect(gradeEscapeValue(brightness, raw, initial)).toBeNull();
    expect(gradeEscapeValue(brightness, Math.fround(1.231), initial)).toBeNull();
    expect(gradeEscapeValue(brightness, Math.fround(1.4), initial)).toBe(Math.fround(1.23));
    expect(gradeEscapeValue(brightness, 1, gradeEntryText(brightness, .125))).toBe(Math.fround(.12));
  });
  it('format-rounds real pointer edits but preserves additional direct text precision', () => {
    expect(gradePointerValue(contrast, 125.25)).toBe(Math.fround(1.25));
    expect(parseGradeText(contrast, '125.25%')).toBe(Math.fround(1.2525));
    expect(gradePointerValue(brightness, .125)).toBe(Math.fround(.12));
  });
});

describe('native horizontal keyboard tweak policy', () => {
  it('uses normal, Ctrl slow and Shift fast increments in the native displayed units', () => {
    expect(gradeSliderTweak(brightness, 1, 1).value).toBe(Math.fround(1.05));
    expect(gradeSliderTweak(contrast, 1, 1).value).toBe(Math.fround(1.05));
    expect(gradeSliderTweak(contrast, 1, 1, 0, true).value).toBe(Math.fround(1.01));
    expect(gradeSliderTweak(contrast, 1, 1, 0, false, true).value).toBe(1.5);
    expect(gradeSliderTweak(temperature, 0, 1).value).toBe(Math.fround(.02));
    expect(gradeSliderTweak(temperature, 0, 1, 0, true).value).toBe(Math.fround(.01));
    expect(gradeSliderTweak(fade, .5, 1).value).toBe(Math.fround(.51));
    expect(gradeSliderTweak(fade, .5, 1, 0, false, true).value).toBe(Math.fround(.6));
    expect(gradeSliderTweak(gamma, 1, 1).value).toBe(Math.fround(1.05));
  });
  it('retains normalized Ctrl residual through a format-rounded stall, then advances on the next press', () => {
    const first = gradeSliderTweak(brightness, 1, 1, 0, true);
    expect(first.value).toBe(1); expect(first.accumulator).toBeGreaterThan(0);
    const second = gradeSliderTweak(brightness, first.value, 1, first.accumulator, true);
    expect(second.value).toBe(Math.fround(1.01)); expect(second.accumulator).toBeGreaterThanOrEqual(0);
  });
  it('clears accumulated movement when pushed past a bound and reverses immediately', () => {
    const stop = gradeSliderTweak(contrast, 5, 1, .3);
    expect(stop).toEqual({ value: 5, accumulator: 0 });
    expect(gradeSliderTweak(contrast, stop.value, -1, stop.accumulator).value).toBe(Math.fround(4.95));
    expect(gradeSliderTweak(temperature, -1, -1, -.2)).toEqual({ value: -1, accumulator: 0 });
  });
});

describe('grading controls presentation boundary', () => {
  const render = (shownIndices = colorFields.map((_, index) => index), enabled = true) => renderToStaticMarkup(createElement(GradeControls,
    { grade: colorFields.map(field => field.neutral), fields: colorFields, shownIndices, enabled, onValues() {} }));
  it('renders all15 native labels/units with unchanged source-order and raw-step range input', () => {
    const markup = render(); let previous = -1;
    for (const field of colorFields) { const at = markup.indexOf(`aria-label="${field.label}"`); expect(at).toBeGreaterThan(previous); previous = at; }
    expect((markup.match(/type="range"/g) ?? [])).toHaveLength(15); expect(markup).toContain('aria-label="Fade"');
    expect(markup).not.toContain('Fade / boost'); expect(markup).toContain('aria-valuetext="0°"'); expect(markup).toContain('step="any"');
  });
  it('shows exactly the Basic subset and delegates availability without writing a preview on render', () => {
    const onValues = vi.fn();
    const markup = renderToStaticMarkup(createElement(GradeControls, { grade: colorFields.map(field => field.neutral), fields: colorFields,
      shownIndices: [0, 1, 3, 5], enabled: false, onValues }));
    for (const label of ['Brightness', 'Contrast', 'Saturation', 'Temperature']) expect(markup).toContain(`aria-label="${label}"`);
    expect((markup.match(/disabled=""/g) ?? [])).toHaveLength(4); expect(markup).not.toContain('aria-label="Gamma"'); expect(onValues).not.toHaveBeenCalled();
  });
});
