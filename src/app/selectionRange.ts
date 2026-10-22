import type { SelectionRangePreference, SelectionRangeFields } from '../document/selectionRange';
import type { MorphologyRange } from '../input/selectionMorphology';

export type SelectionRangeBounds = Readonly<{ minimum: number; maximum: number; value: number }>;

/** Desktop uses the same sampled statistics as morphology, with half its
 * maximum reach and a freshly computed geometric mean. Remembered user input
 * remains unrounded; only the effective operand is clamped/quantized. */
export function resolveSelectionRange(preference: SelectionRangePreference, range: MorphologyRange | null): SelectionRangeBounds | undefined {
  if (!range) return undefined;
  const minimum = range.minimum, maximum = Math.max(minimum, Math.fround(range.maximum / 2));
  const initial = Math.sqrt(minimum * maximum);
  const value = Math.fround(Math.max(minimum, Math.min(maximum, preference.radius ?? initial)));
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Object.freeze({ minimum, maximum, value });
}

export function resolvedSelectionRangeFields(preference: SelectionRangePreference, range: MorphologyRange | null): SelectionRangeFields | undefined {
  const bounds = resolveSelectionRange(preference, range);
  if (preference.enabled && !bounds) return undefined;
  return Object.freeze({ rangeEnabled: preference.enabled, rangeRadius: bounds?.value ?? null });
}
