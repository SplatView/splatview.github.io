import { describe, expect, it } from 'vitest';
import { selectionRangeSphereSegments } from '../src/ui/SelectionRangeOverlay';

describe('bounded retained Range sphere display geometry', () => {
  it('draws three closed 64-segment great circles around the accepted center', () => {
    const center = [3, -4, 7] as const, radius = 2.25, segments = selectionRangeSphereSegments(center, radius);
    expect(segments).toHaveLength(192);
    for (let plane = 0; plane < 3; plane++) for (let index = 0; index < 64; index++) {
      const [a, b] = segments[plane * 64 + index], next = segments[plane * 64 + (index + 1) % 64][0];
      for (const point of [a, b]) {
        expect(Math.hypot(...point.map((value, axis) => value - center[axis]))).toBeCloseTo(radius, 12);
        expect(point[plane]).toBe(center[plane]);
      }
      for (let axis = 0; axis < 3; axis++) expect(b[axis]).toBeCloseTo(next[axis], 12);
    }
    expect(center).toEqual([3, -4, 7]);
  });
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects an invalid radius %s without emitting SVG geometry', radius => {
    expect(selectionRangeSphereSegments([1, 2, 3], radius)).toEqual([]);
  });
  it('rejects a nonfinite accepted center without rendering misleading lines', () => {
    expect(selectionRangeSphereSegments([Number.NaN, 0, 0], 2)).toEqual([]);
    expect(selectionRangeSphereSegments([0, Number.POSITIVE_INFINITY, 0], 2)).toEqual([]);
  });
});
