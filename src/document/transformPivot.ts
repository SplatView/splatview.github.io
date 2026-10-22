import { canonicalJson } from '../build/verification';
import { sameTransformBase, validateTransformBaseIdentity, type TransformBaseIdentity, type TransformVec3 } from './transformProtocol';
import type { NativeSummary } from './types';

export type TransformPivotMode = 'scene' | 'selection' | 'origin' | 'custom';
export type TransformFocusScope = 'scene' | 'selection';
export type TransformFocusCommand = Readonly<{ command: 'transformFocus'; scope: TransformFocusScope;
  revision: number; contentRevision: number; transformBase: TransformBaseIdentity | null }>;
export type TransformFocusState = Readonly<{ revision: number; contentRevision: number;
  transformBase: TransformBaseIdentity | null; ready: boolean; signature: string }>;

/** This event counter can rewind on rollback and restarts in a fresh worker.
 * Validate its representation, never impose cross-response monotonicity. */
export function validateSelectionCommitRevision(summary: unknown): number {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(summary)))
    throw new Error('Invalid native selection commit revision.');
  const counter = Object.getOwnPropertyDescriptor(summary, 'selectionCommitRevision');
  const loaded = Object.getOwnPropertyDescriptor(summary, 'loaded'), kind = Object.getOwnPropertyDescriptor(summary, 'kind');
  if (!counter?.enumerable || !('value' in counter) || typeof counter.value !== 'number' ||
      !Number.isSafeInteger(counter.value) || counter.value < 0 ||
      !loaded?.enumerable || !('value' in loaded) || typeof loaded.value !== 'boolean' ||
      !kind?.enumerable || !('value' in kind) || ![0, 1, 2].includes(kind.value) ||
      (!loaded.value || kind.value !== 0) && counter.value !== 0)
    throw new Error('Invalid native selection commit revision.');
  return counter.value;
}

export function nextPivotMode(mode: TransformPivotMode, hasSelected: boolean): Exclude<TransformPivotMode, 'custom'> {
  return mode === 'scene' ? hasSelected ? 'selection' : 'origin' : mode === 'selection' ? 'origin' : 'scene';
}
export function pivotPresentation(mode: TransformPivotMode, hasSelected: boolean): {
  icon: 'CenterPivot' | 'SelectionPivot' | 'OriginPivot' | 'PickCenter'; tooltip: string;
} {
  if (mode === 'selection') return { icon: 'SelectionPivot', tooltip: 'Pivot: selection center\nClick for origin (0,0,0)' };
  if (mode === 'origin') return { icon: 'OriginPivot', tooltip: 'Pivot: origin (0,0,0)\nClick for scene center' };
  if (mode === 'custom') return { icon: 'PickCenter', tooltip: 'Pivot: custom\nClick for scene center' };
  return { icon: 'CenterPivot', tooltip: hasSelected ? 'Pivot: scene center\nClick for selection center' :
    'Pivot: scene center\nClick for origin (0,0,0)' };
}
function fields(value: unknown, expected: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length || keys.some(key => typeof key !== 'string' || !expected.includes(key))) return null;
  const result: Record<string, unknown> = {};
  for (const name of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor?.enumerable || !('value' in descriptor)) return null;
    result[name] = descriptor.value;
  }
  return result;
}
export function validateTransformFocusCommand(value: unknown): TransformFocusCommand {
  const data = fields(value, ['command', 'scope', 'revision', 'contentRevision', 'transformBase']);
  if (!data || data.command !== 'transformFocus' || typeof data.scope !== 'string' || !['scene', 'selection'].includes(data.scope) ||
      !Number.isSafeInteger(data.revision) || Number(data.revision) < 0 ||
      !Number.isSafeInteger(data.contentRevision) || Number(data.contentRevision) < 0)
    throw new Error('Invalid transform focus command.');
  let transformBase: TransformBaseIdentity | null;
  try { transformBase = data.transformBase === null ? null : validateTransformBaseIdentity(data.transformBase); }
  catch { throw new Error('Invalid transform focus command.'); }
  return Object.freeze({ command: 'transformFocus', scope: data.scope as TransformFocusScope,
    revision: Number(data.revision), contentRevision: Number(data.contentRevision), transformBase });
}
/** Persistent state only. Job progress, sceneChanged, point, and admitted heap
 * growth are per-response observations and cannot authorize a document edit. */
export function captureTransformFocusState(summary: NativeSummary): TransformFocusState {
  const transformBase = summary.transformSession ? validateTransformBaseIdentity({ id: summary.transformSession.id,
    baseId: summary.transformSession.baseId, epoch: summary.transformSession.epoch }) : null;
  const persistent: Record<string, unknown> = {};
  for (const name of ['loaded', 'kind', 'count', 'sourceCount', 'duplicateRange', 'shDegree', 'format', 'selected', 'visible',
    'canUndo', 'canRedo', 'revision', 'contentRevision', 'selectionCommitRevision', 'undoSelectionRevision', 'transaction', 'selectionDraft', 'center', 'radius', 'yUp', 'camera',
    'toleranceSessionId', 'toleranceTool', 'toleranceConnected', 'toleranceRange', 'toleranceRecorded', 'toleranceMapId', 'selectionMapId', 'pendingSelectionMapId',
    'selectionMapBytes', 'selectionMapRetainedIds', 'geometry', 'sourceFaces', 'sampledGeometry', 'colorSession', 'alignment',
    'floor', 'filter', 'transformSession', 'opacitySession', 'morphologyRange'] as const) persistent[name] = summary[name] ?? null;
  return Object.freeze({ revision: summary.revision, contentRevision: summary.contentRevision, transformBase,
    ready: summary.ok === true && summary.loaded === true && summary.kind === 0 && summary.pending === false &&
      summary.transaction === false && summary.selectionDraft === false && summary.pendingSelectionMapId === null &&
      !summary.filter && !summary.colorSession?.pending,
    signature: canonicalJson(persistent) });
}
export function assertTransformFocusBinding(command: TransformFocusCommand, state: TransformFocusState): void {
  if (!state.ready || command.revision !== state.revision || command.contentRevision !== state.contentRevision ||
      (command.transformBase === null ? state.transformBase !== null :
        state.transformBase === null || !sameTransformBase(command.transformBase, state.transformBase)))
    throw new Error('The transform focus snapshot is stale or busy.');
}
export function assertTransformFocusUnchanged(before: TransformFocusState, summary: NativeSummary): void {
  const after = captureTransformFocusState(summary);
  if (summary.pending !== false || !after.ready || before.signature !== after.signature)
    throw new Error('The transform focus response changed the document.');
}
/** The terminal must explicitly distinguish an empty selection from a missing
 * result. Never borrow a center field, inherited property, accessor or old point. */
export function transformFocusPoint(summary: unknown, scope: TransformFocusScope = 'selection'): TransformVec3 | null {
  if (!summary || typeof summary !== 'object') throw new Error('Invalid native transform focus point.');
  const descriptor = Object.getOwnPropertyDescriptor(summary, 'point');
  if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error('Invalid native transform focus point.');
  if (descriptor.value === null) {
    if (scope === 'scene') throw new Error('Invalid native transform focus point.');
    return null;
  }
  const value: unknown = descriptor.value;
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== 3 ||
      Reflect.ownKeys(value).length !== 4) throw new Error('Invalid native transform focus point.');
  const result: number[] = [];
  for (let index = 0; index < 3; index++) {
    const item = Object.getOwnPropertyDescriptor(value, String(index));
    if (!item?.enumerable || !('value' in item) || typeof item.value !== 'number' || !Number.isFinite(item.value) ||
        Math.fround(item.value) !== item.value) throw new Error('Invalid native transform focus point.');
    result.push(item.value);
  }
  return Object.freeze(result) as unknown as TransformVec3;
}
