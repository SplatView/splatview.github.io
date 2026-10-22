import { colorFields } from '../generated/desktop';
import { AdmissionError, checkedBytes, estimateSceneBytes, MiB } from './resources';
import { validateColorSession, type ColorSessionSummary } from './colorProtocol';

export type { AutoColorMethod } from './colorProtocol';
export type ColorSessionState = ColorSessionSummary;
export type ColorDisplayBinding = {
  documentId: string; sourceGeneration: number; sessionId: number; baseId: number; epochId: number;
};
export function isAutoColorMethod(value: unknown): value is import('./colorProtocol').AutoColorMethod {
  return typeof value === 'string' && ['enhance', 'exposure', 'contrast', 'white_balance'].includes(value);
}
export function colorValues(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== colorFields.length) return null;
  const copy = Array.from(value);
  return copy.every((number, index) => typeof number === 'number' && Number.isFinite(number) &&
    number >= colorFields[index].low && number <= colorFields[index].high) ? copy.map(Math.fround) : null;
}
export function sameColorValues(left: readonly number[], right: readonly number[]) {
  return left.length === colorFields.length && right.length === left.length &&
    Array.from(left).every((value, index) => typeof value === 'number' && Number.isFinite(value) &&
      typeof right[index] === 'number' && Number.isFinite(right[index]) && Math.fround(value) === Math.fround(right[index]));
}
export function colorSessionState(value: ColorSessionState | null | undefined): ColorSessionState | null {
  return validateColorSession(value);
}
export function estimateColorWorkBytes(count: number, degree: number, automatic: boolean) {
  if (!Number.isSafeInteger(count) || count < 0 || count > 1_000_000) throw new AdmissionError('Unsupported color scene size.');
  // The scene estimate includes native candidate and staging policy. Auto adds
  // bounded analyzer arrays, the measured WASM owner, and 4 MiB of policy
  // headroom. Actual grants/census and retained WASM growth remain separate;
  // this allowance does not close all runtime memory ownership.
  return estimateSceneBytes(count, degree) + (automatic ? checkedBytes(Math.min(count, 65536), 8) + 3072 + 1912 + 4 * MiB : 0);
}
