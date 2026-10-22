/** Canonical desktop camera: target xyz, yaw, pitch, distance, radius,
 * vertical FOV in degrees, yUp, roll and aspect. Native code derives clipping. */
export type SelectionView = readonly [number, number, number, number, number, number, number, number, number, number, number];
export type MaskChannel = 'document' | 'colorBase' | 'transformBase' | 'opacityBase';
export const SELECTION_VIEW_COMMANDS = ['clipSelection', 'selectAll', 'selectNone', 'invert', 'delete', 'crop',
  'single', 'rectangle', 'polygon', 'brush', 'volume', 'colorPick', 'fillPick', 'morphology', 'duplicate',
  'previewFilter', 'beginColor', 'grade', 'autoColor', 'transform', 'beginTransform', 'rebaseTransform', 'beginOpacity'] as const;

export function validateSelectionView(value: unknown): SelectionView | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== 11 ||
      Reflect.ownKeys(value).length !== 12) throw new Error('Invalid current-view camera.');
  const numbers: number[] = [];
  for (let index = 0; index < 11; index++) {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    if (!field?.enumerable || !('value' in field) || typeof field.value !== 'number' || !Number.isFinite(field.value))
      throw new Error('Invalid current-view camera.');
    if (index === 8 && field.value !== 0 && field.value !== 1 || index === 7 && (field.value < 10 || field.value > 120))
      throw new Error('Invalid current-view camera.');
    const number = Math.fround(field.value);
    if (!Number.isFinite(number)) throw new Error('Invalid current-view camera.');
    numbers.push(number);
  }
  if (numbers[5] <= 0 || numbers[6] <= 0 || numbers[7] < 10 || numbers[7] > 120 ||
      numbers[8] !== 0 && numbers[8] !== 1 || numbers[10] <= 0)
    throw new Error('Invalid current-view camera.');
  return Object.freeze(numbers) as unknown as SelectionView;
}

/** Let existing command families retain exact field validation. */
export function commandWithoutSelectionView(value: unknown, allowed: readonly string[]): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const scope = Object.getOwnPropertyDescriptor(value, 'selectionView');
  if (!scope) return value;
  const command = Object.getOwnPropertyDescriptor(value, 'command');
  if (!scope.enumerable || !('value' in scope) || !command || !('value' in command) || !allowed.includes(command.value)) return null;
  try { validateSelectionView(scope.value); } catch { return null; }
  const result = Object.create(Object.getPrototypeOf(value));
  for (const key of Reflect.ownKeys(value)) if (key !== 'selectionView')
    Object.defineProperty(result, key, Object.getOwnPropertyDescriptor(value, key)!);
  return result;
}

/** Detach camera values before an asynchronous worker queue can observe edits. */
export function captureSelectionViewCommand<T extends { command: string }>(value: T): T {
  const scope = Object.getOwnPropertyDescriptor(value, 'selectionView');
  if (!scope) return value;
  if (!scope.enumerable || !('value' in scope) || !(SELECTION_VIEW_COMMANDS as readonly string[]).includes(value.command))
    throw new Error('This command does not accept a current-view camera.');
  return { ...value, selectionView: validateSelectionView(scope.value) };
}

export function isBeginColorCommand(value: unknown): boolean {
  const command = commandWithoutSelectionView(value, ['beginColor']);
  if (!command || typeof command !== 'object' || Array.isArray(command) || ![Object.prototype, null].includes(Object.getPrototypeOf(command)) ||
      Reflect.ownKeys(command).length !== 2) return false;
  const name = Object.getOwnPropertyDescriptor(command, 'command'), selected = Object.getOwnPropertyDescriptor(command, 'selectedOnly');
  return !!name?.enumerable && 'value' in name && name.value === 'beginColor' &&
    !!selected?.enumerable && 'value' in selected && typeof selected.value === 'boolean';
}
