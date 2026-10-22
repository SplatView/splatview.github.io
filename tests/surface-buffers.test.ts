import { describe, expect, it } from 'vitest';
import { planSurfaceBuffers } from '../src/renderer/webgpu/surfaceBuffers';

const smallMap = { width: 32, height: 16, sourceCount: 33, downsampled: false };

describe('surface buffer accounting', () => {
  it.each([
    { channels: {}, auxiliaryBytes: 16, projectionBytes: 0, colorBytes: 16, visibilityBytes: 0,
      retainedCpuBytes: 4096, physicalScratchBytes: 8304, aggregateBytes: 12536 },
    { channels: { colors: true }, auxiliaryBytes: 528, projectionBytes: 48, colorBytes: 8192, visibilityBytes: 0,
      retainedCpuBytes: 10240, physicalScratchBytes: 25232, aggregateBytes: 35608 },
    { channels: { visible: true }, auxiliaryBytes: 528, projectionBytes: 48, colorBytes: 16, visibilityBytes: 8,
      retainedCpuBytes: 4104, physicalScratchBytes: 8880, aggregateBytes: 13120 },
    { channels: { colors: true, visible: true }, auxiliaryBytes: 528, projectionBytes: 48, colorBytes: 8192, visibilityBytes: 8,
      retainedCpuBytes: 10248, physicalScratchBytes: 25248, aggregateBytes: 35632 },
  ])('separates physical, host and retained bytes for $channels', ({ channels, aggregateBytes, ...expected }) => {
    const plan = planSurfaceBuffers({ ...smallMap, ...channels });
    // Independent 32x16 fixture: 512 pixels, two 16x16 tiles and two visibility
    // words for 33 sources. Host scratch is 8 count + 32 span + 96 parameter bytes.
    expect(plan).toEqual({ pixels: 512, tilesX: 2, tilesY: 1, tileCount: 2,
      countBytes: 8, layoutBytes: 16, outputBytes: 4096, readbackBytes: 4096,
      hostScratchBytes: 136, ...expected });
    expect(plan.retainedCpuBytes + plan.hostScratchBytes + plan.physicalScratchBytes).toBe(aggregateBytes);
  });

  it('accounts for partial edge tiles and per-source bounded-map projection', () => {
    // These are the bounded dimensions of a 1025x769 viewport. Depth-only
    // downsampling adds a 33x48-byte projection but keeps the 16-byte color dummy.
    const plan = planSurfaceBuffers({ width: 591, height: 443, sourceCount: 33, downsampled: true });
    expect(plan).toEqual({ pixels: 261813, tilesX: 37, tilesY: 28, tileCount: 1036,
      countBytes: 4144, layoutBytes: 8288, outputBytes: 2094504, readbackBytes: 2094504,
      auxiliaryBytes: 16, projectionBytes: 1584, colorBytes: 16, visibilityBytes: 0,
      hostScratchBytes: 20816, physicalScratchBytes: 4207248, retainedCpuBytes: 2094504 });
    expect(plan.hostScratchBytes + plan.physicalScratchBytes + plan.retainedCpuBytes).toBe(6322568);
  });

  it.each([
    { region: { x: 5, y: 2, width: 3, height: 7 }, readbackBytes: 168, physicalScratchBytes: 4376 },
    { region: { x: 0, y: 2, width: 32, height: 3 }, readbackBytes: 768, physicalScratchBytes: 4976 },
    { region: { x: 0, y: 0, width: 0, height: 0 }, readbackBytes: 4, physicalScratchBytes: 4212 },
    { region: { x: 5, y: 2, width: 3, height: 0 }, readbackBytes: 4, physicalScratchBytes: 4212 },
  ])('restricts only readback for resolved depth coverage $region', ({ region, readbackBytes, physicalScratchBytes }) => {
    const plan = planSurfaceBuffers({ ...smallMap, region });
    expect(plan).toEqual({ pixels: 512, tilesX: 2, tilesY: 1, tileCount: 2,
      countBytes: 8, layoutBytes: 16, outputBytes: 4096, readbackBytes,
      auxiliaryBytes: 16, projectionBytes: 0, colorBytes: 16, visibilityBytes: 0,
      hostScratchBytes: 136, physicalScratchBytes, retainedCpuBytes: 4096 });
  });

  it('retains mandatory dummy bindings and all three parameter copies on the smallest map', () => {
    const plan = planSurfaceBuffers({ width: 1, height: 1, sourceCount: 1, downsampled: false });
    expect(plan).toEqual({ pixels: 1, tilesX: 1, tilesY: 1, tileCount: 1,
      countBytes: 4, layoutBytes: 8, outputBytes: 8, readbackBytes: 8,
      auxiliaryBytes: 16, projectionBytes: 0, colorBytes: 16, visibilityBytes: 0,
      hostScratchBytes: 116, physicalScratchBytes: 112, retainedCpuBytes: 8 });
  });

  it.each([0, -1, .5, NaN, Infinity])('refuses malformed map dimension %s', dimension => {
    expect(() => planSurfaceBuffers({ ...smallMap, width: dimension })).toThrow(/viewport dimensions/);
    expect(() => planSurfaceBuffers({ ...smallMap, height: dimension })).toThrow(/viewport dimensions/);
  });

  it.each([-1, .5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('refuses malformed source count %s', sourceCount => {
    expect(() => planSurfaceBuffers({ ...smallMap, sourceCount })).toThrow(/allocation is too large/);
  });

  it.each([
    { ...smallMap, width: Number.MAX_SAFE_INTEGER, height: 2 },
    { ...smallMap, sourceCount: Number.MAX_SAFE_INTEGER, colors: true },
    { ...smallMap, sourceCount: Number.MAX_SAFE_INTEGER, downsampled: true },
    // Each depth output is individually safe, but their physical sum is not.
    { ...smallMap, width: 1, height: 2 ** 49 },
    { ...smallMap, region: { x: 0, y: 0, width: Number.MAX_SAFE_INTEGER, height: 2 } },
  ])('refuses an unsafe product or aggregate before allocation: %j', input => {
    expect(() => planSurfaceBuffers(input)).toThrow(/allocation is too large/);
  });
});
