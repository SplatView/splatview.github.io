import type { SceneCommand } from '../document/types';
import { commandWithoutSelectionView, type SelectionView } from '../document/selectionView';

// capture02 selection_morphology.hpp and Viewer::setSelectionSigma.
export const SELECTION_SIGMA_DEFAULT = 1;
export const SELECTION_SIGMA_MINIMUM = .5;
export const SELECTION_SIGMA_MAXIMUM = 10;
export const SELECTION_SIGMA_STEP = .5;
export type SelectionMorphologyMethod = 'sigma' | 'volume';
export type MorphologyRange = Readonly<{ version: 1; minimum: number; maximum: number; default: number }>;
export type SelectionMorphologyCommand = { command: 'morphology'; mode: 'grow' | 'shrink'; selectionView?: SelectionView | null } &
  ({ method?: undefined; sigma?: number } | { method: 'sigma'; sigma: number } | { method: 'volume'; distance: number });
export function selectionSigma(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  return Math.round(Math.max(SELECTION_SIGMA_MINIMUM, Math.min(SELECTION_SIGMA_MAXIMUM, value)) /
    SELECTION_SIGMA_STEP) * SELECTION_SIGMA_STEP;
}
export function isSelectionMorphologyCommand(command: SceneCommand, uiSteps = true): command is SelectionMorphologyCommand {
  const value = commandWithoutSelectionView(command, ['morphology']);
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const keys = Reflect.ownKeys(value), fields: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== 'string') return false;
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !('value' in field)) return false;
    fields[key] = field.value;
  }
  if (fields.command !== 'morphology' || fields.mode !== 'grow' && fields.mode !== 'shrink') return false;
  if (fields.method === 'volume') return keys.length === 4 && Object.hasOwn(fields, 'distance') &&
    typeof fields.distance === 'number' && Number.isFinite(fields.distance) && Math.fround(fields.distance) > 0 && Number.isFinite(Math.fround(fields.distance));
  if (fields.method !== undefined && fields.method !== 'sigma' || Object.hasOwn(fields, 'method') && fields.method === undefined) return false;
  const explicit = fields.method === 'sigma';
  if (keys.some(key => !['command', 'mode', 'method', 'sigma'].includes(String(key))) || explicit && keys.length !== 4) return false;
  return fields.sigma === undefined ? !explicit && !Object.hasOwn(fields, 'sigma') : typeof fields.sigma === 'number' &&
    (uiSteps ? fields.sigma === selectionSigma(fields.sigma) : Number.isFinite(Math.fround(fields.sigma)) &&
      Math.fround(fields.sigma) >= SELECTION_SIGMA_MINIMUM && Math.fround(fields.sigma) <= SELECTION_SIGMA_MAXIMUM);
}

export function validateMorphologyRange(value: unknown): MorphologyRange | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== 4) throw new Error('Invalid native morphology range.');
  const values: Record<string, number> = {};
  for (const key of ['version', 'minimum', 'maximum', 'default']) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !('value' in field) || typeof field.value !== 'number' || !Number.isFinite(field.value))
      throw new Error('Invalid native morphology range.');
    values[key] = key === 'version' ? field.value : Math.fround(field.value);
  }
  if (values.version !== 1 || values.minimum <= 0 || !Number.isFinite(values.maximum) || values.maximum < values.minimum ||
      values.default < values.minimum || values.default > values.maximum) throw new Error('Invalid native morphology range.');
  return Object.freeze({ version: 1, minimum: values.minimum, maximum: values.maximum, default: values.default });
}

export function selectionDistance(value: number, range: MorphologyRange): number | null {
  if (!Number.isFinite(value)) return null;
  return Math.fround(Math.max(range.minimum, Math.min(range.maximum, value)));
}

export function isMorphologyRangeCommand(command: SceneCommand): boolean {
  if (!command || typeof command !== 'object' || Array.isArray(command) || ![Object.prototype, null].includes(Object.getPrototypeOf(command)) ||
      Reflect.ownKeys(command).length !== 1) return false;
  const field = Object.getOwnPropertyDescriptor(command, 'command');
  return !!field?.enumerable && 'value' in field && field.value === 'morphologyRange';
}
