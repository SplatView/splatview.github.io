import { describe, expect, it } from 'vitest';
import { HISTOGRAM_HEIGHT, histogramPaths } from '../src/renderer/histogram';

describe('desktop rendered histogram plotting', () => {
  const points = (path: string) => path.split(' ').map(value => value.slice(1).split(',').map(Number));
  it('uses the shared logarithmic peak, preserving cross-channel magnitude', () => {
    const bins = new Uint32Array(768); bins[0] = 99; bins[256 + 127] = 9; bins[512 + 255] = 1;
    const paths = histogramPaths(bins, 300).map(points);
    expect(paths.map(channel => channel.length)).toEqual([256, 256, 256]);
    expect(paths[0][0]).toEqual([4, 4]);
    expect(paths[1][127][1]).toBe(27);
    expect(paths[2][255][0]).toBe(296);
    expect(paths[2][255][1]).toBeCloseTo(HISTOGRAM_HEIGHT - 4 - 46 * Math.log(2) / Math.log(100), 3);
    expect(paths[0][255][1]).toBe(50);
  });
  it('places empty data on the baseline without inventing observations', () => {
    const paths = histogramPaths(undefined, 274).map(points);
    expect(paths[0][0]).toEqual([4, 50]); expect(paths[0][255]).toEqual([270, 50]);
    expect(paths[1]).toEqual(paths[0]); expect(paths[2]).toEqual(paths[0]);
  });
  it('refuses invalid shape or dimensions rather than drawing corrupted data', () => {
    for (const bins of [new Uint32Array(0), new Uint32Array(767), new Uint32Array(769)])
      expect(() => histogramPaths(bins, 274)).toThrow();
    for (const width of [0, 7, NaN, Infinity]) expect(() => histogramPaths(undefined, width)).toThrow();
  });
});
