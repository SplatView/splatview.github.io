import { AdmissionError, MiB } from './resources';

/** Descriptor/range domain, not a promise that an input fits browser memory. */
export const MAX_SOURCE_TRANSPORT_BYTES = 0xffff_ffff;
/** Compatibility name for the technical transport bound. */
export const MAX_INPUT_BYTES = MAX_SOURCE_TRANSPORT_BYTES;
export const NATIVE_LOAD_BUDGET_BYTES = 512 * MiB;

export function assertSceneInputBytes(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new AdmissionError('Invalid scene file size.');
  if (value > MAX_SOURCE_TRANSPORT_BYTES)
    throw new AdmissionError('The scene source exceeds the 32-bit input transport limit.');
}

/** Native decode charges its complete input concurrently with decoder work.
 * This necessary preflight leaves room for that work; later admission remains authoritative. */
export function assertSourceFitsDecodeBudget(sourceBytes: unknown, budgetBytes: unknown): void {
  if (typeof sourceBytes !== 'number' || !Number.isSafeInteger(sourceBytes) || sourceBytes < 0)
    throw new AdmissionError('Invalid scene source memory size.');
  if (typeof budgetBytes !== 'number' || !Number.isSafeInteger(budgetBytes) || budgetBytes < 1 || budgetBytes > MAX_SOURCE_TRANSPORT_BYTES)
    throw new AdmissionError('Invalid scene decode memory budget.');
  if (sourceBytes >= budgetBytes)
    throw new AdmissionError('The scene source does not fit within the available decode memory budget.');
}

const blobSize = Object.getOwnPropertyDescriptor(Blob.prototype, 'size')!.get!;

/** Inspect the real Blob bytes, without invoking a caller's own size property. */
export function sceneFileBytes(file: Blob): number {
  let byteLength: unknown;
  try { byteLength = blobSize.call(file); }
  catch { throw new AdmissionError('Choose a valid scene file.'); }
  assertSceneInputBytes(byteLength);
  return byteLength;
}
