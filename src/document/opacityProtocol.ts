import { commandWithoutSelectionView } from './selectionView';
export type OpacityBaseIdentity = Readonly<{ id: number; baseId: number; epoch: number }>;
export type OpacitySessionSummary = OpacityBaseIdentity & Readonly<{
  appliedEpoch: number | null; selectedOnly: boolean; appliedScale: number;
}>;
export const OPACITY_COMMANDS = ['beginOpacity', 'applyOpacity', 'resetOpacity', 'endOpacity'] as const;
function fields(value: unknown, expected: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length || keys.some(key => typeof key !== 'string' || !expected.includes(key))) return null;
  const result: Record<string, unknown> = {};
  for (const key of expected) {
    const item = Object.getOwnPropertyDescriptor(value, key);
    if (!item?.enumerable || !('value' in item)) return null;
    result[key] = item.value;
  }
  return result;
}
/** UI can retain a finite value while its active native range is invalid. */
export function opacityUiScale(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
export function opacityScale(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 5 ? Math.fround(value) : null;
}
export function validateOpacityBaseIdentity(value: unknown): OpacityBaseIdentity {
  const data = fields(value, ['id', 'baseId', 'epoch']);
  if (!data || !Number.isSafeInteger(data.id) || Number(data.id) < 1 || !Number.isSafeInteger(data.baseId) || Number(data.baseId) < 1 ||
    !Number.isSafeInteger(data.epoch) || Number(data.epoch) < 0) throw new Error('Invalid opacity-base stream identity.');
  return Object.freeze({ id: Number(data.id), baseId: Number(data.baseId), epoch: Number(data.epoch) });
}
export function validateOpacitySummary(value: unknown): OpacitySessionSummary | null {
  if (value === null) return null;
  const data = fields(value, ['id', 'baseId', 'epoch', 'appliedEpoch', 'selectedOnly', 'appliedScale']);
  if (!data) throw new Error('Invalid native opacity session.');
  const identity = validateOpacityBaseIdentity({ id: data.id, baseId: data.baseId, epoch: data.epoch }), scale = opacityScale(data.appliedScale);
  if (scale === null || typeof data.selectedOnly !== 'boolean' || data.appliedEpoch !== null &&
    (!Number.isSafeInteger(data.appliedEpoch) || Number(data.appliedEpoch) < 1 || Number(data.appliedEpoch) > identity.epoch) ||
    identity.epoch === 0 && data.appliedEpoch !== null || data.appliedEpoch === null && scale !== 1)
    throw new Error('Invalid native opacity session.');
  return Object.freeze({ ...identity, appliedEpoch: data.appliedEpoch as number | null, selectedOnly: data.selectedOnly, appliedScale: scale });
}
export function sameOpacityBase(a: OpacityBaseIdentity, b: OpacityBaseIdentity) { return a.id === b.id && a.baseId === b.baseId && a.epoch === b.epoch; }
export function sameOpacitySummary(a: OpacitySessionSummary | null, b: OpacitySessionSummary | null) {
  return a === null ? b === null : b !== null && sameOpacityBase(a, b) && a.appliedEpoch === b.appliedEpoch &&
    a.selectedOnly === b.selectedOnly && a.appliedScale === b.appliedScale;
}
export function isOpacityCommand(value: unknown): boolean {
  value = commandWithoutSelectionView(value, ['beginOpacity']);
  const command = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'command')?.value : undefined;
  const keys = command === 'beginOpacity' ? ['command', 'selectedOnly'] : command === 'applyOpacity' ? ['command', 'id', 'epoch', 'scale'] :
    command === 'resetOpacity' ? ['command', 'id', 'epoch'] : command === 'endOpacity' ? ['command', 'id'] : null;
  const data = keys && fields(value, keys);
  if (!data) return false;
  if (command === 'beginOpacity') return typeof data.selectedOnly === 'boolean';
  if (!Number.isSafeInteger(data.id) || Number(data.id) < 1) return false;
  return command === 'endOpacity' || Number.isSafeInteger(data.epoch) && Number(data.epoch) > 0 && (command === 'resetOpacity' || opacityScale(data.scale) !== null);
}
