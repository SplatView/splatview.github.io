import { describe, expect, it } from 'vitest';
import { AdmissionError, checkedBytes, estimateCaptureBytes, ResourceLedger } from '../src/document/resources';

describe('clean capture peak admission', () => {
  it.each([[64, 3], [1280, 800], [2048, 1536]])('charges aligned %ix%i Gaussian and geometry captures at 16/20 bytes per pixel', (width, height) => {
    const pixels = width * height;
    // Independent owners: rgba8 color attachment, pixel copy, canvas backing,
    // mapped rgba8 readback; ordinary geometry additionally owns depth32float.
    const color = 4 * pixels, pixelCopy = 4 * pixels, canvas = 4 * pixels, mapped = 4 * pixels, depth = 4 * pixels;
    expect(estimateCaptureBytes(width, height)).toBe(color + pixelCopy + canvas + mapped);
    expect(estimateCaptureBytes(width, height, true)).toBe(color + pixelCopy + canvas + mapped + depth);
    expect(estimateCaptureBytes(width, height)).toBe(16 * pixels); expect(estimateCaptureBytes(width, height, true)).toBe(20 * pixels);
  });
  it.each([[1, 3, 256], [63, 7, 256], [65, 11, 512], [321, 241, 1536]])('charges actual padded mapped rows for %ix%i', (width, height, mappedRow) => {
    const pixels = width * height, retainedImageOwners = 12 * pixels;
    expect(estimateCaptureBytes(width, height)).toBe(retainedImageOwners + mappedRow * height);
    expect(estimateCaptureBytes(width, height, true)).toBe(retainedImageOwners + mappedRow * height + 4 * pixels);
    expect(estimateCaptureBytes(width, height)).toBeGreaterThan(16 * pixels);
  });
  it('accounts row padding independently of aspect ratio and cannot reuse a transposed estimate', () => {
    // Both images have 195 pixels, but three 512-byte rows differ from sixty-
    // five 256-byte rows. An estimate using only pixel count is insufficient.
    expect(estimateCaptureBytes(65, 3)).toBe(195 * 12 + 3 * 512);
    expect(estimateCaptureBytes(3, 65)).toBe(195 * 12 + 65 * 256);
    expect(estimateCaptureBytes(3, 65)).toBeGreaterThan(estimateCaptureBytes(65, 3));
  });
  it('admits capture alongside retained scene and viewport depth, refusing the entire image before allocation', () => {
    const imageBytes = estimateCaptureBytes(65, 11, true), sceneBytes = 1000, viewportDepth = 4096;
    const ledger = new ResourceLedger(sceneBytes + viewportDepth + imageBytes - 1);
    const scene = ledger.reserve('decoded', sceneBytes), depth = ledger.reserve('render', viewportDepth), before = ledger.usage;
    expect(() => ledger.reserve('image', imageBytes)).toThrow(AdmissionError); expect(ledger.usage).toEqual(before);
    depth(); const image = ledger.reserve('image', imageBytes); expect(ledger.usage.bytes).toBe(sceneBytes + imageBytes);
    image(); scene(); expect(ledger.usage.bytes).toBe(0);
  });
  for (const [width, height] of [[-1, 3], [3, -1], [1.5, 2], [2, 1.5], [NaN, 1], [1, Infinity],
    [Number.MAX_SAFE_INTEGER, 2], [2 ** 51, 1], [1, 2 ** 51], [2 ** 30, 2 ** 30]])
    it(`refuses unsafe framebuffer arithmetic ${width}x${height}`, () => {
      expect(() => estimateCaptureBytes(width, height)).toThrow(AdmissionError);
      expect(() => estimateCaptureBytes(width, height, true)).toThrow(AdmissionError);
    });
  it('refuses aggregate peak overflow even when each retained image component is a safe integer', () => {
    const width = 64, height = Math.floor(Number.MAX_SAFE_INTEGER / 1024) + 1, pixels = width * height;
    expect(Number.isSafeInteger(checkedBytes(pixels, 12))).toBe(true);
    expect(Number.isSafeInteger(checkedBytes(height, 256))).toBe(true);
    expect(() => estimateCaptureBytes(width, height)).toThrow(AdmissionError);
  });
});
