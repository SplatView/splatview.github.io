import { describe, expect, it } from 'vitest';
import shader from '../src/renderer/webgpu/surface.wgsl?raw';
import { encodeSurfaceParameters, resolveSurfaceRegion, surfaceChannelFlags, surfaceDimensions,
  SURFACE_FLAGS, SURFACE_MAX_PACKED_COORDINATE, SURFACE_PARAMETERS_BYTES, SURFACE_TILE_SIZE } from '../src/renderer/webgpu/surfaceQuery';

const input = { fullWidth: 1025, fullHeight: 769, width: 591, height: 443,
  sourceCount: 0x01020304, channelFlags: 7, dispatchWidth: 65535, scale: .25 };

describe('surface query contract', () => {
  it('encodes the unchanged 48-byte uniform with an f32 scale and no region', () => {
    const words = encodeSurfaceParameters(input);
    expect(words.byteLength).toBe(48);
    // Independent expected ABI, including ceil-divided partial edge tiles.
    expect([...words]).toEqual([1025, 769, 591, 443, 37, 28, 0, 0x01020304, 7, 65535, 0x3e800000, 0]);
    expect(new Float32Array(words.buffer)[10]).toBe(.25);
  });

  it('packs unsigned u16 coordinates and exclusive coverage maxima without wrapping', () => {
    const words = encodeSurfaceParameters({ ...input, width: 65535, height: 65535,
      region: { x: 32768, y: 32767, width: 32767, height: 32768 } });
    expect(words[6]).toBe(0x7fff8000);
    expect(words[11]).toBe(0xffffffff);
    expect(words[8]).toBe(15);
    expect(words[10]).toBe(0x3e800000);
  });

  it('distinguishes explicit empty coverage from the full-map sentinel', () => {
    const words = encodeSurfaceParameters({ ...input, channelFlags: 0, region: { x: 0, y: 0, width: 0, height: 0 } });
    expect(words[6]).toBe(0); expect(words[11]).toBe(0); expect(words[8]).toBe(8);
  });

  it('keeps the host layout, shader field order, flags and workgroup dimensions aligned', () => {
    const fields = /struct SurfaceParams\s*\{([^}]+)\}/.exec(shader)![1].replace(/\s/g, '');
    expect(fields).toBe('full:vec2<u32>,size:vec2<u32>,tiles:vec2<u32>,coverageMinPacked:u32,count:u32,' +
      'channels:u32,dispatchWidth:u32,scale:f32,coverageMaxPacked:u32,');
    expect(SURFACE_PARAMETERS_BYTES).toBe(48);
    for (const [name, value] of Object.entries({ COLORS: SURFACE_FLAGS.colors, VISIBLE: SURFACE_FLAGS.visible,
      DOWNSAMPLED: SURFACE_FLAGS.downsampled, REGION: SURFACE_FLAGS.region, TILE_SIZE: SURFACE_TILE_SIZE })) {
      expect(shader).toMatch(new RegExp(`const\\s+SURFACE_${name}\\s*=\\s*${value}u\\s*;`));
    }
    const compositeSize = /@workgroup_size\((\d+),(\d+)\)\s*fn composite/.exec(shader);
    expect(compositeSize?.slice(1).map(Number)).toEqual([SURFACE_TILE_SIZE, SURFACE_TILE_SIZE]);
  });

  it.each([
    [{}, false, 0], [{ colors: true }, false, 1], [{ visible: true }, false, 2],
    [{ colors: true, visible: true }, true, 7], [{}, true, 4],
    [{ region: { x: 0, y: 0, width: 16, height: 16 } }, false, 0],
  ] as const)('keeps auxiliary channel flags separate from region coverage: %j', (channels, downsampled, expected) => {
    expect(surfaceChannelFlags(channels, downsampled)).toBe(expected);
  });

  it('keeps small viewports and floors bounded non-square dimensions', () => {
    expect(surfaceDimensions(320, 200)).toEqual({ width: 320, height: 200, scale: 1 });
    expect(surfaceDimensions(512, 512)).toEqual({ width: 512, height: 512, scale: 1 });
    expect(surfaceDimensions(1025, 769)).toMatchObject({ width: 591, height: 443 });
    expect(surfaceDimensions(1, 262145)).toMatchObject({ width: 1, height: 262144 });
  });

  it.each([0, -1, .5, NaN, Infinity])('refuses invalid viewport dimension %s', dimension => {
    expect(() => surfaceDimensions(dimension, 100)).toThrow(/viewport dimensions/);
    expect(() => surfaceDimensions(100, dimension)).toThrow(/viewport dimensions/);
  });

  it('rejects an unsafe viewport product', () => {
    expect(() => surfaceDimensions(Number.MAX_SAFE_INTEGER, 2)).toThrow();
  });

  it('snapshots a partial rectangle without changing the caller object', () => {
    const region = { x: 17, y: 31, width: 3, height: 19 };
    const result = resolveSurfaceRegion({ region }, 320, 200)!;
    expect(result).toEqual(region); expect(result).not.toBe(region); expect(Object.isFrozen(result)).toBe(true);
    region.x = 0; expect(result.x).toBe(17);
  });

  it('keeps empty coverage and falls back for full or unencodable coverage', () => {
    const empty = { x: 0, y: 0, width: 0, height: 0 };
    expect(resolveSurfaceRegion({ region: empty }, 320, 200)).toEqual(empty);
    expect(resolveSurfaceRegion({}, 320, 200)).toBeUndefined();
    expect(resolveSurfaceRegion({ region: { x: 0, y: 0, width: 320, height: 200 } }, 320, 200)).toBeUndefined();
    expect(resolveSurfaceRegion({ region: empty }, SURFACE_MAX_PACKED_COORDINATE + 1, 1)).toBeUndefined();
    expect(resolveSurfaceRegion({ region: empty }, 1, SURFACE_MAX_PACKED_COORDINATE + 1)).toBeUndefined();
  });

  it.each(['colors', 'visible'] as const)('%s always requires the full map, even with an invalid partial request', channel => {
    expect(resolveSurfaceRegion({ [channel]: true, region: { x: -1, y: 0, width: 1, height: 1 } }, 320, 200)).toBeUndefined();
  });

  it.each([
    { x: -1, y: 0, width: 1, height: 1 }, { x: 0, y: .5, width: 1, height: 1 },
    { x: 319, y: 0, width: 2, height: 1 }, { x: 0, y: 199, width: 1, height: 2 },
    { x: 0, y: 0, width: NaN, height: 1 }, { x: 0, y: 0, width: 1, height: Infinity },
  ])('refuses malformed or out-of-bounds coverage %j', region => {
    expect(() => resolveSurfaceRegion({ region }, 320, 200)).toThrow(/query coverage/);
  });
});
