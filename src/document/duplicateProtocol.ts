import { validateSelectionView } from './selectionView';

export const DUPLICATE_SCENE_LIMIT = 1_000_000;
export type DuplicateRange = Readonly<{ first: number; count: number }> | null;

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= minimum && value <= maximum;
}

/** The marker describes a nonempty suffix of one immutable Gaussian scene.
 * Its containing summary/receipt supplies the authoritative scene revision. */
export function validateDuplicateRange(value: unknown, loadedCount: number, gaussian = true): DuplicateRange {
  if (!integer(loadedCount, 0, gaussian ? DUPLICATE_SCENE_LIMIT : 0xffff_ffff)) throw new Error('Invalid Duplicate scene count.');
  if (value === null) return null;
  if (!gaussian || !value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Invalid Duplicate range.');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes('first') || !keys.includes('count')) throw new Error('Invalid Duplicate range.');
  const first = Object.getOwnPropertyDescriptor(value, 'first'), count = Object.getOwnPropertyDescriptor(value, 'count');
  if (!first?.enumerable || !('value' in first) || !count?.enumerable || !('value' in count) ||
      !integer(first.value, 0, loadedCount) || !integer(count.value, 1, DUPLICATE_SCENE_LIMIT) ||
      count.value !== loadedCount - first.value) throw new Error('Invalid Duplicate range.');
  return Object.freeze({ first: first.value, count: count.value });
}

export function sameDuplicateRange(a: DuplicateRange, b: DuplicateRange): boolean {
  return a === null || b === null ? a === b : a.first === b.first && a.count === b.count;
}

/** Every summary owns this field, including unloaded and view-only scenes. */
export function validateDuplicateSummary(value: { loaded: boolean; kind: number; count: number; sourceCount: number; duplicateRange: unknown }): DuplicateRange {
  if (typeof value.loaded !== 'boolean' || !integer(value.kind, 0, 2) ||
      !integer(value.count, 0, 0xffff_ffff) || !integer(value.sourceCount, 0, 0xffff_ffff) ||
      value.sourceCount < value.count || !value.loaded && (value.count !== 0 || value.sourceCount !== 0))
    throw new Error('Invalid native scene topology.');
  const range = Object.getOwnPropertyDescriptor(value, 'duplicateRange');
  if (!range?.enumerable || !('value' in range)) throw new Error('Missing native Duplicate range.');
  return validateDuplicateRange(range.value, value.count, value.loaded && value.kind === 0);
}

/** Duplicate accepts only its captured view; native code owns records/center IDs. */
export function isDuplicateCommand(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length < 1 || keys.length > 2 || keys.some(key => key !== 'command' && key !== 'selectionView')) return false;
  const command = Object.getOwnPropertyDescriptor(value, 'command');
  if (!command?.enumerable || !('value' in command) || command.value !== 'duplicate') return false;
  const scope = Object.getOwnPropertyDescriptor(value, 'selectionView');
  if (scope) {
    if (!scope.enumerable || !('value' in scope)) return false;
    try { validateSelectionView(scope.value); } catch { return false; }
  }
  return true;
}
