import type { SteadySettings } from './steadySettings';

export function supportsSteadyProjection(p: ArrayLike<number>) {
  return p.length === 16 && Array.from(p).every(Number.isFinite) && p[0] !== 0 && p[5] !== 0 &&
    p[1] === 0 && p[4] === 0 && p[2] === 0 && p[6] === 0 && p[3] === 0 && p[7] === 0 && p[11] === -1 && p[15] === 0;
}

export function multiplyMatrices(a: ArrayLike<number>, b: ArrayLike<number>) {
  const result = new Float32Array(16);
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++)
    for (let k = 0; k < 4; k++) result[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
  return result;
}
export function invertMatrix(m: ArrayLike<number>) {
  const rows = Array.from({ length: 4 }, (_, r) => Array.from({ length: 8 }, (_, c) => c < 4 ? m[c * 4 + r] : Number(c - 4 === r)));
  for (let c = 0; c < 4; c++) {
    let pivot = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(rows[r][c]) > Math.abs(rows[pivot][c])) pivot = r;
    if (Math.abs(rows[pivot][c]) < 1e-20) throw new RangeError('The render camera matrix is singular.');
    [rows[c], rows[pivot]] = [rows[pivot], rows[c]];
    const divisor = rows[c][c];
    for (let j = 0; j < 8; j++) rows[c][j] /= divisor;
    for (let r = 0; r < 4; r++) if (r !== c) {
      const factor = rows[r][c];
      for (let j = 0; j < 8; j++) rows[r][j] -= factor * rows[c][j];
    }
  }
  return Float32Array.from({ length: 16 }, (_, i) => rows[i % 4][4 + Math.floor(i / 4)]);
}

type DisplayFrame = { scene: object; revision: number; uniform: Uint32Array; shade: number };
/** Display identity is independent of temporary query/capture preparation. */
export class SteadyFrameState {
  private previous?: DisplayFrame;
  frame = 0;
  restFrames = 0;
  valid = false;
  reset() { this.previous = undefined; this.frame = 0; this.restFrames = 0; this.valid = false; }
  observe(next: DisplayFrame, settings: SteadySettings) {
    const previous = this.previous;
    const changed = !previous || previous.scene !== next.scene || previous.revision !== next.revision || previous.shade !== next.shade ||
      next.uniform.some((word, i) => !(i < 16 || i >= 32 && i < 35) && word !== previous.uniform[i]);
    if (changed) { this.valid = false; this.restFrames = 0; }
    const still = this.valid && !!previous && next.uniform.subarray(0, 16).every((word, i) => word === previous.uniform[i]);
    const converge = settings.animate && settings.convergence && settings.historyWeight > 0;
    const reconstruct = !still || !converge || this.restFrames < settings.convergenceFrames;
    if (reconstruct) this.restFrames = still && converge ? this.restFrames + 1 : 0;
    const result = { reconstruct, valid: this.valid, still, restFrames: this.restFrames,
      sampleFrame: settings.animate ? this.frame : 0,
      needsMore: converge && this.restFrames < settings.convergenceFrames };
    this.previous = { ...next, uniform: next.uniform.slice() };
    if (reconstruct) { this.valid = true; this.frame++; }
    return result;
  }
}
