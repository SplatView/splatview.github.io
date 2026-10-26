import { describe, expect, it } from 'vitest';
import { captureDepthOrderKey, depthOrderMatches } from '../src/renderer/orderKey';

const frame = () => {
  const f = new Float32Array(80); f[2] = -.25; f[6] = .125; f[10] = -.75; f[14] = 2;
  return new Uint32Array(f.buffer);
};
describe('resident exact source-depth order identity', () => {
  it('uses actual depth-row FP32 bits and source generation, independently of revision/FOV/grade/opacity', () => {
    const words = frame(), key = captureDepthOrderKey(words, 3);
    expect(depthOrderMatches(key, words.slice(), 3)).toBe(true);
    for (let i = 0; i < 80; i++) {
      const next = words.slice(); next[i] ^= 1;
      expect(depthOrderMatches(key, next, 3), `word ${i}`).toBe(![2, 6, 10, 14, 76].includes(i));
    }
    expect(depthOrderMatches(key, words, 4)).toBe(false);
    expect(depthOrderMatches(undefined, words, 3)).toBe(false);
  });
  it('captures geometry and scoped target identity, including captured-view overwrite', () => {
    const words = frame(), targets = new Uint8Array([1, 0]); words[76] = 1; words[77] = 1;
    const key = captureDepthOrderKey(words, 1, targets);
    expect(depthOrderMatches(key, words, 1, targets)).toBe(true);
    expect(depthOrderMatches(key, words, 1, targets.slice())).toBe(false);
    for (let i = 60; i < 78; i++) { const next = words.slice(); next[i] ^= 1; expect(depthOrderMatches(key, next, 1, targets)).toBe(false); }
    const captured = words.slice(); captured[14] ^= 1;
    const installed = captureDepthOrderKey(captured, 1, targets);
    expect(depthOrderMatches(installed, words, 1, targets)).toBe(false);
    words[77] = 0; const whole = captureDepthOrderKey(words, 1, targets);
    expect(depthOrderMatches(whole, words, 1, targets.slice())).toBe(true);
  });
  it('never assumes translation or signed zero preserves the FP32 permutation', () => {
    const words = frame(), key = captureDepthOrderKey(words, 1), next = words.slice();
    next[14] = 0x80000000;
    expect(depthOrderMatches(key, next, 1)).toBe(false);
    const zero = captureDepthOrderKey(next, 1); next[14] = 0;
    expect(depthOrderMatches(zero, next, 1)).toBe(false);
  });
});
