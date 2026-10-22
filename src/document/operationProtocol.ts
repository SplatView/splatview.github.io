import type { NativeSummary } from './types';
import { sameDuplicateRange, validateDuplicateRange, type DuplicateRange } from './duplicateProtocol';

export type OperationScope = Readonly<{ version: 1; documentId: string; sourceGeneration: number; clientGeneration: string }>;
export type OperationOwner = OperationScope & Readonly<{ operationId: number }>;
export type OperationAction = 'begin' | 'commit' | 'rollback' | 'status' | 'retire';
export type OperationOutcome = 'active' | 'committed' | 'rolled-back' | 'not-started' | 'expired-conflict';
export type OperationSnapshot = Readonly<{
  count: number; sourceCount: number; duplicateRange: DuplicateRange;
  revision: number; contentRevision: number; selected: number; visible: number;
  canUndo: boolean; canRedo: boolean; transaction: boolean; selectionDraft: boolean; pending: boolean;
  toleranceSessionId: number | null; toleranceMapId: number | null;
  selectionMapId: number | null; pendingSelectionMapId: number | null; selectionMapRetainedIds: readonly number[];
}>;
export type OperationReceipt = Readonly<{
  version: 2; owner: OperationOwner; outcome: OperationOutcome;
  before: OperationSnapshot | null; terminal: OperationSnapshot | null;
}>;
export type OperationResolution = Readonly<{ receipt: OperationReceipt; summary: NativeSummary }>;
export type OperationRecovery = Readonly<{
  owner: OperationOwner; phase: OperationAction | 'request'; state: 'checking' | 'required' | 'idle'; error?: Error;
}>;

const scopeFields = ['version', 'documentId', 'sourceGeneration', 'clientGeneration'] as const;
const snapshotFields = ['count', 'sourceCount', 'duplicateRange', 'revision', 'contentRevision', 'selected', 'visible', 'canUndo', 'canRedo', 'transaction',
  'selectionDraft', 'pending', 'toleranceSessionId', 'toleranceMapId', 'selectionMapId', 'pendingSelectionMapId',
  'selectionMapRetainedIds'] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function fields(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Invalid operation receipt.');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== names.length || keys.some(key => typeof key !== 'string' || !names.includes(key)))
    throw new Error('Invalid operation receipt.');
  const result: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error('Invalid operation receipt.');
    result[name] = descriptor.value;
  }
  return result;
}
function integer(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum) throw new Error('Invalid operation receipt.');
  return value;
}
function nullableId(value: unknown): number | null { return value === null ? null : integer(value, 1); }
function scope(data: Record<string, unknown>): OperationScope {
  if (data.version !== 1 || typeof data.documentId !== 'string' || !uuid.test(data.documentId) ||
      typeof data.clientGeneration !== 'string' || !uuid.test(data.clientGeneration)) throw new Error('Invalid operation owner.');
  return Object.freeze({ version: 1, documentId: data.documentId, sourceGeneration: integer(data.sourceGeneration, 1),
    clientGeneration: data.clientGeneration });
}
export function validateOperationScope(value: unknown): OperationScope { return scope(fields(value, scopeFields)); }
export function validateOperationOwner(value: unknown): OperationOwner {
  const data = fields(value, [...scopeFields, 'operationId']);
  return Object.freeze({ ...scope(data), operationId: integer(data.operationId, 1) });
}
export function sameOperationOwner(a: OperationOwner, b: OperationOwner): boolean {
  return a.version === b.version && a.documentId === b.documentId && a.sourceGeneration === b.sourceGeneration &&
    a.clientGeneration === b.clientGeneration && a.operationId === b.operationId;
}
export function validateOperationSnapshot(value: unknown): OperationSnapshot {
  const data = fields(value, snapshotFields);
  const count = integer(data.count), sourceCount = integer(data.sourceCount);
  if (count > 0xffff_ffff || sourceCount > 0xffff_ffff || sourceCount < count) throw new Error('Invalid operation scene counts.');
  const duplicateRange = validateDuplicateRange(data.duplicateRange, count, data.duplicateRange !== null);
  for (const key of ['canUndo', 'canRedo', 'transaction', 'selectionDraft', 'pending'] as const)
    if (typeof data[key] !== 'boolean') throw new Error('Invalid operation snapshot.');
  const ids = data.selectionMapRetainedIds;
  if (!Array.isArray(ids) || ids.length > 5) throw new Error('Invalid operation map owners.');
  if (Reflect.ownKeys(ids).length !== ids.length + 1 || Object.getPrototypeOf(ids) !== Array.prototype)
    throw new Error('Invalid operation map owners.');
  const retained: number[] = [];
  for (let index = 0; index < ids.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(ids, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error('Invalid operation map owners.');
    retained.push(integer(descriptor.value, 1));
  }
  if (new Set(retained).size !== retained.length) throw new Error('Invalid operation map owners.');
  const selected = integer(data.selected), visible = integer(data.visible);
  if (selected > visible || visible > count) throw new Error('Invalid operation selection counts.');
  return Object.freeze({ count, sourceCount, duplicateRange, revision: integer(data.revision), contentRevision: integer(data.contentRevision),
    selected, visible, canUndo: data.canUndo as boolean, canRedo: data.canRedo as boolean,
    transaction: data.transaction as boolean, selectionDraft: data.selectionDraft as boolean, pending: data.pending as boolean,
    toleranceSessionId: nullableId(data.toleranceSessionId), toleranceMapId: nullableId(data.toleranceMapId),
    selectionMapId: nullableId(data.selectionMapId), pendingSelectionMapId: nullableId(data.pendingSelectionMapId),
    selectionMapRetainedIds: Object.freeze(retained) });
}
export function operationSnapshot(summary: NativeSummary): OperationSnapshot {
  return validateOperationSnapshot({ count: summary.count, sourceCount: summary.sourceCount,
    duplicateRange: validateDuplicateRange(summary.duplicateRange, summary.count, summary.loaded && summary.kind === 0),
    revision: summary.revision, contentRevision: summary.contentRevision,
    selected: summary.selected, visible: summary.visible, canUndo: summary.canUndo, canRedo: summary.canRedo,
    transaction: summary.transaction, selectionDraft: summary.selectionDraft, pending: summary.pending,
    toleranceSessionId: summary.toleranceSessionId ?? null, toleranceMapId: summary.toleranceMapId ?? null,
    selectionMapId: summary.selectionMapId, pendingSelectionMapId: summary.pendingSelectionMapId,
    selectionMapRetainedIds: summary.selectionMapRetainedIds });
}
export function sameOperationSnapshot(a: OperationSnapshot, b: OperationSnapshot): boolean {
  return snapshotFields.every(key => key === 'duplicateRange' ? sameDuplicateRange(a[key], b[key]) : key === 'selectionMapRetainedIds' ?
    a[key].length === b[key].length && a[key].every((id, index) => id === b[key][index]) : a[key] === b[key]);
}
export function validateOperationReceipt(value: unknown, expected?: OperationOwner): OperationReceipt {
  const data = fields(value, ['version', 'owner', 'outcome', 'before', 'terminal']);
  const owner = validateOperationOwner(data.owner);
  if (data.version !== 2 || expected && !sameOperationOwner(owner, expected) || typeof data.outcome !== 'string' ||
      !['active', 'committed', 'rolled-back', 'not-started', 'expired-conflict'].includes(data.outcome))
    throw new Error('The operation receipt belongs to another edit.');
  const before = data.before === null ? null : validateOperationSnapshot(data.before);
  const terminal = data.terminal === null ? null : validateOperationSnapshot(data.terminal);
  const outcome = data.outcome as OperationOutcome;
  if (outcome === 'expired-conflict' ? before !== null || terminal !== null :
      !before || before.transaction || (outcome === 'active' ? terminal !== null : !terminal || terminal.transaction))
    throw new Error('Invalid operation outcome proof.');
  return Object.freeze({ version: 2, owner, outcome, before, terminal });
}
export function assertOperationSummary(receipt: OperationReceipt, summary: NativeSummary): void {
  if (!summary || summary.ok !== true) throw new Error('The operation has no successful native summary.');
  const snapshot = operationSnapshot(summary);
  if (receipt.outcome === 'expired-conflict' || (receipt.outcome === 'active' ? !snapshot.transaction :
      !receipt.terminal || !sameOperationSnapshot(receipt.terminal, snapshot)))
    throw new Error('The native summary does not match its operation receipt.');
}
/** This error proves restoration; it is never constructed from revision equality alone. */
export class OperationRestoredError extends Error {
  constructor(readonly receipt: OperationReceipt, readonly summary: NativeSummary) {
    super('The interrupted edit was restored.'); this.name = 'OperationRestoredError';
    if (!['rolled-back', 'not-started'].includes(receipt.outcome)) throw new Error('The operation was not restored.');
    assertOperationSummary(receipt, summary);
  }
}
/** Internal transport settlement; the logical operation remains owned until reconciliation. */
export class OperationUncertainError extends Error {
  constructor(readonly owner: OperationOwner, readonly phase: OperationAction | 'request', message: string) {
    super(message); this.name = 'OperationUncertainError';
  }
}
export function isOperationRestoredError(value: unknown): value is OperationRestoredError { return value instanceof OperationRestoredError; }
