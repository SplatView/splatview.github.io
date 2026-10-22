import { validateSimilarityAlignmentFrame, type AlignmentFrame } from './alignment';

export type AlignmentSummary = Readonly<{
  version: 2; frame: AlignmentFrame; branchId: number; canReset: boolean; retainedBranchIds: readonly number[];
}>;
const fields = ['version', 'frame', 'branchId', 'canReset', 'retainedBranchIds'] as const;

/** Parse inert wire metadata; publication ownership stays with its response envelope. */
export function validateAlignmentSummary(value: unknown): AlignmentSummary | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Invalid native alignment metadata.');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !fields.includes(key as typeof fields[number])))
    throw new Error('Invalid native alignment metadata.');
  const data: Record<string, unknown> = Object.create(null);
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error('Invalid native alignment data field.');
    data[key] = descriptor.value;
  }
  if (data.version !== 2 || typeof data.branchId !== 'number' || !Number.isSafeInteger(data.branchId) ||
      data.branchId < 0 || typeof data.canReset !== 'boolean') throw new Error('Invalid native alignment identity.');
  const retained = data.retainedBranchIds;
  if (!Array.isArray(retained) || Object.getPrototypeOf(retained) !== Array.prototype || retained.length < 1 || retained.length > 64 ||
      Reflect.ownKeys(retained).length !== retained.length + 1) throw new Error('Invalid retained alignment branches.');
  const retainedBranchIds = Array.from({ length: retained.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(retained, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor) || typeof descriptor.value !== 'number' ||
        !Number.isSafeInteger(descriptor.value) || descriptor.value < 0) throw new Error('Invalid retained alignment branch.');
    return descriptor.value as number;
  });
  if (!retainedBranchIds.includes(data.branchId) || retainedBranchIds.some((id, index) => index > 0 && id <= retainedBranchIds[index - 1]))
    throw new Error('Invalid retained alignment branch order or owner.');
  return Object.freeze({ version: 2, frame: validateSimilarityAlignmentFrame(data.frame), branchId: data.branchId, canReset: data.canReset,
    retainedBranchIds: Object.freeze(retainedBranchIds) });
}

/** Matrix equality alone is insufficient for divergent history branches. */
export function sameAlignmentFrame(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== 16 || b.length !== 16) return false;
  for (let index = 0; index < 16; index++) if (!Number.isFinite(a[index]) || a[index] !== b[index]) return false;
  return true;
}

/** A branch key also includes its immutable frame; response revisions remain mandatory. */
export function sameAlignmentBranch(a: AlignmentSummary, b: AlignmentSummary): boolean {
  return a.branchId === b.branchId && sameAlignmentFrame(a.frame, b.frame);
}
