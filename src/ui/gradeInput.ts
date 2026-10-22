// Navigation and formatted-entry rules adapt Dear ImGui v1.91.9b
// SliderBehaviorT/TempInputScalar, copyright (c) 2014-2025 Omar Cornut, MIT.
// Full notice: public/licenses/ImGui-MIT.txt; source/changes:
// docs/third-party/GRADING_INPUT_REFERENCES.md.
// Fixed-size presentation/input policy from Capture02 color.hpp:12-27,
// ui_widgets.hpp:338-351 and ImGui SliderBehaviorT/TempInputScalar. This is
// display-unit navigation only; native Color owns every grading operation.
export type GradeField = Readonly<{
  name: string; label: string; low: number; high: number; displayScale: number; format: string; neutral?: number;
}>;
const f32 = Math.fround;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
export function gradePrecision(field: GradeField): number {
  const match = /%\.(\d+)f/.exec(field.format);
  if (!match || Number(match[1]) > 6) throw new Error('Unsupported grading display format.');
  return Number(match[1]);
}
export function gradeSuffix(field: GradeField): string {
  return field.format.includes('%%') ? '%' : field.format.endsWith('×') ? '×' : field.format.endsWith('°') ? '°' : '';
}
export function gradeDisplayValue(field: GradeField, value: number): number { return f32(f32(value) * f32(field.displayScale)); }
export function gradeDisplayBounds(field: GradeField): readonly [number, number] {
  return [gradeDisplayValue(field, field.low), gradeDisplayValue(field, field.high)];
}
// snprintf's default nearest/even formatting differs from JS toFixed at exact
// binary ties. All captured fields use zero or two decimal places; products
// below are exact in binary64 for their binary32 display values.
function formattedNumber(value: number, precision: number): string {
  const factor = 10 ** precision, scaled = Math.abs(value) * factor, lower = Math.floor(scaled), remainder = scaled - lower;
  const rounded = remainder > .5 || remainder === .5 && lower % 2 !== 0 ? lower + 1 : lower;
  const whole = Math.floor(rounded / factor), fraction = String(rounded % factor).padStart(precision, '0');
  return `${value < 0 || Object.is(value, -0) ? '-' : ''}${whole}${precision ? `.${fraction}` : ''}`;
}
export function gradeEntryText(field: GradeField, value: number): string { return formattedNumber(gradeDisplayValue(field, value), gradePrecision(field)); }
export function gradeValueText(field: GradeField, value: number): string { return gradeEntryText(field, value) + gradeSuffix(field); }
/** TempInputScalar compares the current formatted display buffer with its
 * initial formatted text. Hidden-decimal edits with equal formatting survive
 * Escape; untouched entry never quantizes the original stored value. */
export function gradeEscapeValue(field: GradeField, currentValue: number, initialText: string): number | null {
  return gradeEntryText(field, currentValue) === initialText ? null : parseGradeText(field, initialText);
}

/** Accept complete finite decimal text and recognized display decorations.
 * Native scanf accepts numeric prefixes; the browser rejects unrecognized
 * trailing text so an invalid draft cannot Apply an older valid candidate. */
export function parseGradeText(field: GradeField, text: string): number | null {
  const number = text.trim().replace(/\s*[%×°]$/, '').trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(number)) return null;
  const parsed = Number(number); if (!Number.isFinite(parsed)) return null;
  const [low, high] = gradeDisplayBounds(field);
  return f32(clamp(f32(parsed), low, high) / f32(field.displayScale));
}
/** Pointer edits round to the native field format; direct text does not. */
export function gradePointerValue(field: GradeField, displayed: number): number {
  const [low, high] = gradeDisplayBounds(field), bounded = clamp(f32(displayed), low, high);
  return f32(f32(Number(formattedNumber(bounded, gradePrecision(field)))) / f32(field.displayScale));
}
/** Horizontal slider Left/Right policy. Keep its normalized accumulator until
 * the slider loses activation; Ctrl is slow and Shift fast on both platforms. */
export function gradeSliderTweak(field: GradeField, value: number, direction: -1 | 1, accumulator = 0,
  slow = false, fast = false): Readonly<{ value: number; accumulator: number }> {
  const [low, high] = gradeDisplayBounds(field), range = f32(high - low);
  if (!(range > 0)) return { value, accumulator: 0 };
  let input = direction as number;
  if (gradePrecision(field) > 0) { input = f32(input / 100); if (slow) input = f32(input / 10); }
  else input = range <= 100 || slow ? f32(input / range) : f32(input / 100);
  if (fast) input = f32(input * 10);
  const delta = f32(f32(accumulator) + input), displayed = clamp(gradeDisplayValue(field, value), low, high);
  const oldRatio = f32(f32(displayed - low) / range);
  if (oldRatio >= 1 && delta > 0 || oldRatio <= 0 && delta < 0) return { value, accumulator: 0 };
  const ratio = clamp(f32(oldRatio + delta), 0, 1), candidate = f32(low + f32(range * ratio));
  const rounded = f32(Number(formattedNumber(candidate, gradePrecision(field))));
  const newRatio = f32(f32(rounded - low) / range), movement = f32(newRatio - oldRatio);
  return { value: Object.is(rounded, displayed) ? value : f32(rounded / f32(field.displayScale)),
    accumulator: f32(delta - (delta > 0 ? Math.min(movement, delta) : Math.max(movement, delta))) };
}
