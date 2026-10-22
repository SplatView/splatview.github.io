import { describe, expect, it } from 'vitest';
import { containsSurfaceRegion, unionSurfaceRegions, volumeSurfaceRegion } from '../src/renderer/webgpu/surfaceCoverage';
import type { SurfaceRegion } from '../src/renderer/webgpu/surfaceQuery';

const full = { viewportWidth: 128, viewportHeight: 128, mapWidth: 128, mapHeight: 128 };
const region = (x: number, y: number, width: number, height: number): SurfaceRegion => ({ x, y, width, height });

describe('volume brush depth coverage', () => {
  it('includes a tap depth halo on both sides of tile borders', () => {
    expect(volumeSurfaceRegion({ ...full, points: [[64, 64]] })).toEqual(region(48, 48, 32, 32));
    expect(volumeSurfaceRegion({ ...full, points: [[15, 15]] })).toEqual(region(0, 0, 32, 32));
    expect(volumeSurfaceRegion({ ...full, points: [[18, 18]] })).toEqual(region(16, 16, 16, 16));
  });

  it('bounds the complete accumulated path rather than the latest endpoint', () => {
    const result = volumeSurfaceRegion({ viewportWidth: 256, viewportHeight: 128, mapWidth: 128, mapHeight: 64,
      points: [[80, 40], [160, 90], [96, 50]] });
    expect(result).toEqual(region(32, 16, 64, 32));
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('keeps offscreen segments crossing the view and rejects wholly disjoint paths', () => {
    const dimensions = { viewportWidth: 256, viewportHeight: 128, mapWidth: 128, mapHeight: 64 };
    expect(volumeSurfaceRegion({ ...dimensions, points: [[-10, 64], [266, 64]] })).toEqual(region(0, 16, 128, 32));
    for (const points of [[[-1, 40], [-1, 80]], [[256, 40], [270, 80]], [[40, -1]], [[40, 128]]])
      expect(volumeSurfaceRegion({ ...dimensions, points })).toEqual(region(0, 0, 0, 0));
  });

  it('clips aligned coverage at non-square, non-tile-aligned map edges', () => {
    const dimensions = { viewportWidth: 200, viewportHeight: 100, mapWidth: 100, mapHeight: 50 };
    expect(volumeSurfaceRegion({ ...dimensions, points: [[199, 99]] })).toEqual(region(96, 32, 4, 18));
    expect(volumeSurfaceRegion({ ...dimensions, points: [[0, 0]] })).toEqual(region(0, 0, 16, 16));
  });

  it('uses framebuffer coordinates independently of CSS size or DPR', () => {
    const a = volumeSurfaceRegion({ viewportWidth: 400, viewportHeight: 200, mapWidth: 200, mapHeight: 100, points: [[100, 50], [200, 100]] });
    const b = volumeSurfaceRegion({ viewportWidth: 800, viewportHeight: 400, mapWidth: 200, mapHeight: 100, points: [[200, 100], [400, 200]] });
    expect(a).toEqual(b);
  });

  it('covers nearest and bilinear neighbors throughout the interpolated path bounds', () => {
    const dimensions = { viewportWidth: 479, viewportHeight: 237, mapWidth: 173, mapHeight: 86 };
    const coverage = volumeSurfaceRegion({ ...dimensions, points: [[-17, 19], [400, 210], [123, 40]] })!;
    // Independent native-style sample positions, including the half-pixel
    // bilinear neighborhood, throughout the complete path bounding rectangle.
    let missingSamples = 0;
    for (let y = 19; y <= 210; y++) for (let x = 0; x <= 400; x++) {
      const sx = (x + .5) * dimensions.mapWidth / dimensions.viewportWidth - .5;
      const sy = (y + .5) * dimensions.mapHeight / dimensions.viewportHeight - .5;
      for (const px of [Math.floor(sx), Math.floor(sx) + 1]) for (const py of [Math.floor(sy), Math.floor(sy) + 1]) {
        if (px >= 0 && py >= 0 && px < dimensions.mapWidth && py < dimensions.mapHeight &&
          !containsSurfaceRegion(coverage, region(px, py, 1, 1))) missingSamples++;
      }
    }
    expect(missingSamples).toBe(0);
  });

  it('falls back to full coverage for ambiguous or unrepresentable input', () => {
    for (const points of [[], [[1]], [[1, 2, 3]], [[NaN, 1]], [[Infinity, 1]], [[1.5, 2]], [[2 ** 31, 0]]])
      expect(volumeSurfaceRegion({ ...full, points })).toBeUndefined();
    for (const dimensions of [{ viewportWidth: 65_536 }, { mapWidth: 65_536 }, { viewportHeight: 0 },
      { mapHeight: 1.5 }, { mapWidth: 129 }, { viewportWidth: NaN }])
      expect(volumeSurfaceRegion({ ...full, ...dimensions, points: [[64, 64]] })).toBeUndefined();
  });
});

describe('immutable surface-region compatibility', () => {
  it('allows full to satisfy partial but never partial to satisfy full', () => {
    const partial = region(16, 32, 32, 16);
    expect(containsSurfaceRegion(undefined, undefined)).toBe(true);
    expect(containsSurfaceRegion(undefined, partial)).toBe(true);
    expect(containsSurfaceRegion(partial, undefined)).toBe(false);
    expect(containsSurfaceRegion(partial, region(32, 32, 16, 16))).toBe(true);
    expect(containsSurfaceRegion(partial, region(32, 32, 17, 16))).toBe(false);
    expect(containsSurfaceRegion(partial, region(0, 0, 0, 0))).toBe(true);
  });

  it('unions disjoint or growing rectangles without mutating either input', () => {
    const a = region(16, 32, 32, 16), b = region(64, 16, 16, 16);
    const joined = unionSurfaceRegions(a, b);
    expect(joined).toEqual(region(16, 16, 64, 32)); expect(Object.isFrozen(joined)).toBe(true);
    expect(a).toEqual(region(16, 32, 32, 16)); expect(b).toEqual(region(64, 16, 16, 16));
    expect(unionSurfaceRegions(undefined, a)).toBeUndefined();
    expect(unionSurfaceRegions(a, undefined)).toBeUndefined();
    expect(unionSurfaceRegions(region(0, 0, 0, 0), a)).toEqual(a);
    expect(unionSurfaceRegions(a, region(0, 0, 0, 0))).toEqual(a);
  });
});
