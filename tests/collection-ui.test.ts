import { describe, expect, it } from 'vitest';
import { collectionArrowVisibility, collectionPageDirection } from '../src/input/collectionNavigation';

const key = { key: 'PageDown', repeat: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, defaultPrevented: false };
const context = { available: true, text: false, activeUi: false, popup: false, captured: false };
describe('desktop collection edge geometry and Page keys', () => {
  it('keeps the opposite edge when a real shell control intersects only one arrow', () => {
    expect(collectionArrowVisibility(1000, 600, 1, [{ left: 0, right: 70, top: 250, bottom: 350 }])).toEqual([false, true]);
    expect(collectionArrowVisibility(1000, 600, 1, [{ left: 0, right: 1000, top: 0, bottom: 48 }])).toEqual([true, true]);
    expect(collectionArrowVisibility(90, 600, 1, [])).toEqual([false, false]);
    expect(collectionArrowVisibility(1000, 87, 1, [])).toEqual([false, false]);
    expect(collectionArrowVisibility(1000, 109, 1.25, [])).toEqual([false, false]);
  });
  it('allows ordinary Page navigation without making Tools-open a keyboard exclusion', () => {
    expect(collectionPageDirection(key, context)).toBe(1);
    expect(collectionPageDirection({ ...key, key: 'PageUp' }, context)).toBe(-1);
    expect(collectionPageDirection({ ...key, key: 'ArrowDown' }, context)).toBeUndefined();
  });
  it.each(['repeat', 'ctrlKey', 'metaKey', 'altKey', 'isComposing', 'defaultPrevented'] as const)('consumes blocked %s Page keys without navigation', field => {
    expect(collectionPageDirection({ ...key, [field]: true }, context)).toBe(0);
  });
  it.each(['text', 'activeUi', 'popup', 'captured'] as const)('consumes a Page key owned by %s', field => {
    expect(collectionPageDirection(key, { ...context, [field]: true })).toBe(0);
  });
  it('consumes busy/loading/save or unavailable navigation', () => {
    expect(collectionPageDirection(key, { ...context, available: false })).toBe(0);
  });
});
