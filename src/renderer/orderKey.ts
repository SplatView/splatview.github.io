/** Exact canonical FP32 dependencies of the stable source-depth permutation.
 * Keys belong to one scene's installed order, including offscreen overwrites.
 * No projection, color, opacity or camera-revision dependency is implied.
 */
export type DepthOrderKey = Readonly<{
  sourceRevision: number;
  bits: Uint32Array;
  transformTargets: unknown;
}>;
const depth = [2, 6, 10, 14] as const;
export function depthOrderMatches(key: DepthOrderKey | undefined, words: Uint32Array,
  sourceRevision: number, transformTargets?: unknown) {
  if (!key || key.sourceRevision !== sourceRevision) return false;
  for (let i = 0; i < 4; i++) if (key.bits[i] !== words[depth[i]]) return false;
  if (key.bits[4] !== words[76]) return false;
  if (!words[76]) return true;
  if (key.bits[5] !== words[77]) return false;
  for (let i = 0; i < 16; i++) if (key.bits[6 + i] !== words[60 + i]) return false;
  return !words[77] || key.transformTargets === transformTargets;
}
export function captureDepthOrderKey(words: Uint32Array, sourceRevision: number, transformTargets?: unknown): DepthOrderKey {
  const bits = new Uint32Array(22);
  for (let i = 0; i < 4; i++) bits[i] = words[depth[i]];
  bits[4] = words[76];
  if (words[76]) { bits[5] = words[77]; bits.set(words.subarray(60, 76), 6); }
  return { sourceRevision, bits, transformTargets: words[76] && words[77] ? transformTargets : undefined };
}
