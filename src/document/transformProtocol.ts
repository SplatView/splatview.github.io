import { commandWithoutSelectionView, validateSelectionView, type SelectionView } from './selectionView';
export type TransformMode = 'euler' | 'quaternion' | 'axis-angle' | 'matrix';
export type TransformKind = 'numeric' | 'gizmo';
export type TransformVec3 = [number, number, number];
export type TransformQuaternion = [number, number, number, number];
export type TransformMatrix = [number, number, number, number, number, number, number, number,
  number, number, number, number, number, number, number, number];
export type TransformFlips = [boolean, boolean, boolean];
export type TransformParameters = {
  mode: TransformMode; translation: TransformVec3; scale: TransformVec3; pivot: TransformVec3;
  euler: TransformVec3; quaternion: TransformQuaternion; axis: TransformVec3; angle: number;
  matrix: TransformMatrix; flips: TransformFlips;
};
type PoseDefinition = { translation: TransformVec3; scale: TransformVec3; pivot: TransformVec3; flips: TransformFlips };
export type TransformDefinition =
  | PoseDefinition & { mode: 'euler'; euler: TransformVec3 }
  | PoseDefinition & { mode: 'quaternion'; quaternion: TransformQuaternion }
  | PoseDefinition & { mode: 'axis-angle'; axis: TransformVec3; angle: number }
  | { mode: 'matrix'; matrix: TransformMatrix; pivot: TransformVec3; flips: TransformFlips };
export type TransformBaseIdentity = Readonly<{ id: number; baseId: number; epoch: number }>;
export type GizmoTransformSummary = Readonly<{ cancelBaseId: number | null; cancelContentRevision: number | null; canUndo: boolean; canRedo: boolean }>;
export type TransformSessionSummary = TransformBaseIdentity & Readonly<{
  appliedEpoch: number | null; kind: TransformKind; selectedOnly: boolean;
  appliedMatrix: TransformMatrix; pivot: TransformVec3; gizmo: GizmoTransformSummary | null;
}>;
export const TRANSFORM_COMMANDS = ['beginTransform', 'applyTransform', 'resetTransform', 'endTransform',
  'rebaseTransform', 'undoTransform', 'redoTransform', 'cancelTransform'] as const;
const names = ['mode', 'translation', 'scale', 'pivot', 'euler', 'quaternion', 'axis', 'angle', 'matrix', 'flips'] as const;
export function transformDefaults(): TransformParameters {
  return { mode: 'euler', translation: [0, 0, 0], scale: [1, 1, 1], pivot: [0, 0, 0], euler: [0, 0, 0],
    quaternion: [1, 0, 0, 0], axis: [0, 0, 1], angle: 0,
    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], flips: [false, false, false] };
}
function fields(value: unknown, expected: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length || keys.some(key => typeof key !== 'string' || !expected.includes(key))) return null;
  const result: Record<string, unknown> = {};
  for (const name of expected) {
    const item = Object.getOwnPropertyDescriptor(value, name);
    if (!item?.enumerable || !('value' in item)) return null;
    result[name] = item.value;
  }
  return result;
}
function vector(value: unknown, length: number, bound = Number.MAX_VALUE, rounded = false): number[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== length ||
    Reflect.ownKeys(value).length !== length + 1) return null;
  const result: number[] = [];
  for (let index = 0; index < length; index++) {
    const item = Object.getOwnPropertyDescriptor(value, String(index));
    if (!item?.enumerable || !('value' in item) || typeof item.value !== 'number' || !Number.isFinite(item.value) || Math.abs(item.value) > bound) return null;
    const number = rounded ? Math.fround(item.value) : item.value;
    if (!Number.isFinite(number) || Math.abs(number) > bound) return null;
    result.push(number);
  }
  return result;
}
function flips(value: unknown): TransformFlips | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== 3 || Reflect.ownKeys(value).length !== 4) return null;
  const result: boolean[] = [];
  for (let index = 0; index < 3; index++) {
    const item = Object.getOwnPropertyDescriptor(value, String(index));
    if (!item?.enumerable || !('value' in item) || typeof item.value !== 'boolean') return null;
    result.push(item.value);
  }
  return result as TransformFlips;
}
export function isTransformMode(value: unknown): value is TransformMode {
  return typeof value === 'string' && ['euler', 'quaternion', 'axis-angle', 'matrix'].includes(value);
}
/** Retain finite, temporarily invalid numeric input without running transform math. */
export function transformUiParameters(value: unknown): TransformParameters | null {
  const data = fields(value, names);
  if (!data || !isTransformMode(data.mode) || typeof data.angle !== 'number' || !Number.isFinite(data.angle)) return null;
  const result: Record<string, unknown> = { mode: data.mode, angle: data.angle };
  for (const key of ['translation', 'scale', 'pivot', 'euler', 'quaternion', 'axis', 'matrix'] as const) {
    const array = vector(data[key], key === 'matrix' ? 16 : key === 'quaternion' ? 4 : 3);
    if (!array) return null;
    result[key] = array;
  }
  const flip = flips(data.flips); return flip ? { ...result, flips: flip } as TransformParameters : null;
}
export function patchTransformParameters(previous: TransformParameters, patch: unknown): TransformParameters | null {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || ![Object.prototype, null].includes(Object.getPrototypeOf(patch))) return null;
  const result = { ...previous };
  for (const key of Reflect.ownKeys(patch)) {
    if (typeof key !== 'string' || !names.includes(key as typeof names[number])) return null;
    const item = Object.getOwnPropertyDescriptor(patch, key);
    if (!item?.enumerable || !('value' in item)) return null;
    Object.defineProperty(result, key, { value: item.value, enumerable: true, writable: true, configurable: true });
  }
  return transformUiParameters(result);
}
export function sameTransformParameters(a: TransformParameters, b: TransformParameters) {
  return names.every(key => Array.isArray(a[key]) ? Array.isArray(b[key]) &&
    (a[key] as (number | boolean)[]).every((value, index) => value === (b[key] as (number | boolean)[])[index]) : a[key] === b[key]);
}
export function validateTransformDefinition(value: unknown): TransformDefinition | null {
  const mode = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'mode')?.value : undefined;
  if (!isTransformMode(mode)) return null;
  const expected = mode === 'matrix' ? ['mode', 'matrix', 'pivot', 'flips'] :
    ['mode', 'translation', 'scale', 'pivot', 'flips', ...(mode === 'euler' ? ['euler'] : mode === 'quaternion' ? ['quaternion'] : ['axis', 'angle'])];
  const data = fields(value, expected);
  if (!data) return null;
  const pivot = vector(data.pivot, 3, 1e12, true), flip = flips(data.flips);
  if (!pivot || !flip) return null;
  if (mode === 'matrix') {
    const matrix = vector(data.matrix, 16, 1e12, true);
    return !matrix || matrix[12] !== 0 || matrix[13] !== 0 || matrix[14] !== 0 || matrix[15] !== 1 ? null :
      { mode, matrix: matrix as TransformMatrix, pivot: pivot as TransformVec3, flips: flip };
  }
  const translation = vector(data.translation, 3, 1e12, true), scale = vector(data.scale, 3, 1e6, true);
  if (!translation || !scale || scale.some(value => value <= 0)) return null;
  const common = { translation: translation as TransformVec3, scale: scale as TransformVec3, pivot: pivot as TransformVec3, flips: flip };
  if (mode === 'euler') { const euler = vector(data.euler, 3, 1e12, true); return euler ? { ...common, mode, euler: euler as TransformVec3 } : null; }
  if (mode === 'quaternion') {
    const quaternion = vector(data.quaternion, 4, 1e12, true);
    return quaternion && quaternion.some(value => value !== 0) ? { ...common, mode, quaternion: quaternion as TransformQuaternion } : null;
  }
  const axis = vector(data.axis, 3, 1e12, true), angle = typeof data.angle === 'number' ? Math.fround(data.angle) : Number.NaN;
  return axis && Number.isFinite(angle) && Math.abs(angle) <= 1e12 ? { ...common, mode, axis: axis as TransformVec3, angle } : null;
}
export function transformWireParameters(parameters: TransformParameters): TransformDefinition | null {
  const common = { mode: parameters.mode, pivot: parameters.pivot, flips: parameters.flips };
  return validateTransformDefinition(parameters.mode === 'matrix' ? { ...common, matrix: parameters.matrix } :
    { ...common, translation: parameters.translation, scale: parameters.scale,
      ...(parameters.mode === 'euler' ? { euler: parameters.euler } : parameters.mode === 'quaternion' ?
        { quaternion: parameters.quaternion } : { axis: parameters.axis, angle: parameters.angle }) });
}
export function validateTransformMatrix(value: unknown): TransformMatrix | null {
  const matrix = vector(value, 16, Number.MAX_VALUE, true);
  return !matrix || matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1 ? null : matrix as TransformMatrix;
}
export function validateTransformBaseIdentity(value: unknown): TransformBaseIdentity {
  const data = fields(value, ['id', 'baseId', 'epoch']);
  if (!data || !Number.isSafeInteger(data.id) || Number(data.id) < 1 || !Number.isSafeInteger(data.baseId) || Number(data.baseId) < 1 ||
    !Number.isSafeInteger(data.epoch) || Number(data.epoch) < 0) throw new Error('Invalid transform-base stream identity.');
  return Object.freeze({ id: Number(data.id), baseId: Number(data.baseId), epoch: Number(data.epoch) });
}
export function validateTransformSummary(value: unknown): TransformSessionSummary | null {
  if (value === null) return null;
  const data = fields(value, ['id', 'baseId', 'epoch', 'appliedEpoch', 'kind', 'selectedOnly', 'appliedMatrix', 'pivot', 'gizmo']);
  if (!data) throw new Error('Invalid native transform session.');
  const identity = validateTransformBaseIdentity({ id: data.id, baseId: data.baseId, epoch: data.epoch });
  const matrix = validateTransformMatrix(data.appliedMatrix), pivot = vector(data.pivot, 3, Number.MAX_VALUE, true);
  if (!matrix || !pivot || !['numeric', 'gizmo'].includes(data.kind as string) || typeof data.selectedOnly !== 'boolean' ||
    data.appliedEpoch !== null && (!Number.isSafeInteger(data.appliedEpoch) || Number(data.appliedEpoch) < 1 || Number(data.appliedEpoch) > identity.epoch) ||
    identity.epoch === 0 && data.appliedEpoch !== null) throw new Error('Invalid native transform session.');
  let gizmo: GizmoTransformSummary | null = null;
  if (data.kind === 'numeric') { if (data.gizmo !== null) throw new Error('Invalid native transform session.'); }
  else {
    const session = fields(data.gizmo, ['cancelBaseId', 'cancelContentRevision', 'canUndo', 'canRedo']);
    if (!session || typeof session.canUndo !== 'boolean' || typeof session.canRedo !== 'boolean' ||
        (session.cancelBaseId === null) !== (session.cancelContentRevision === null) ||
        session.cancelBaseId !== null && (!Number.isSafeInteger(session.cancelBaseId) || Number(session.cancelBaseId) < 1 ||
          !Number.isSafeInteger(session.cancelContentRevision) || Object.is(session.cancelContentRevision, -0) || Number(session.cancelContentRevision) < 0) ||
        session.cancelBaseId === null && (session.canUndo || session.canRedo)) throw new Error('Invalid native transform session.');
    gizmo = Object.freeze({ cancelBaseId: session.cancelBaseId as number | null, cancelContentRevision: session.cancelContentRevision as number | null,
      canUndo: session.canUndo, canRedo: session.canRedo });
  }
  return Object.freeze({ ...identity, kind: data.kind as TransformKind, selectedOnly: data.selectedOnly, gizmo,
    appliedEpoch: data.appliedEpoch as number | null, appliedMatrix: Object.freeze(matrix) as unknown as TransformMatrix,
    pivot: Object.freeze(pivot) as unknown as TransformVec3 });
}
export function sameTransformBase(a: TransformBaseIdentity, b: TransformBaseIdentity) { return a.id === b.id && a.baseId === b.baseId && a.epoch === b.epoch; }
export function sameTransformSummary(a: TransformSessionSummary | null, b: TransformSessionSummary | null) {
  return a === null ? b === null : b !== null && sameTransformBase(a, b) && a.appliedEpoch === b.appliedEpoch && a.kind === b.kind &&
    a.selectedOnly === b.selectedOnly && a.appliedMatrix.every((value, index) => value === b.appliedMatrix[index]) && a.pivot.every((value, index) => value === b.pivot[index]) &&
    sameGizmoSummary(a.gizmo, b.gizmo);
}
export function isTransformCommand(value: unknown): boolean {
  value = commandWithoutSelectionView(value, ['beginTransform', 'rebaseTransform']);
  const command = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'command')?.value : undefined;
  const expected = command === 'beginTransform' ? ['command', 'kind', 'selectedOnly'] : command === 'applyTransform' ?
    ['command', 'id', 'epoch', 'parameters'] : command === 'rebaseTransform' ? ['command', 'id', 'epoch', 'selectedOnly'] :
    ['resetTransform', 'undoTransform', 'redoTransform', 'cancelTransform'].includes(command) ? ['command', 'id', 'epoch'] : command === 'endTransform' ? ['command', 'id'] : null;
  const data = expected && fields(value, expected);
  if (!data) return false;
  if (command === 'beginTransform') return ['numeric', 'gizmo'].includes(data.kind as string) && typeof data.selectedOnly === 'boolean';
  if (!Number.isSafeInteger(data.id) || Number(data.id) < 1) return false;
  if (command === 'endTransform') return true;
  return Number.isSafeInteger(data.epoch) && Number(data.epoch) > 0 && (command === 'applyTransform' ? !!validateTransformDefinition(data.parameters) :
    command !== 'rebaseTransform' || typeof data.selectedOnly === 'boolean');
}
function sameGizmoSummary(a: GizmoTransformSummary | null, b: GizmoTransformSummary | null): boolean {
  return a === null ? b === null : b !== null && a.cancelBaseId === b.cancelBaseId && a.cancelContentRevision === b.cancelContentRevision &&
    a.canUndo === b.canUndo && a.canRedo === b.canRedo;
}
export type CapturedTransformCommand = Readonly<
  { command: 'beginTransform'; kind: TransformKind; selectedOnly: boolean; selectionView?: SelectionView | null } |
  { command: 'rebaseTransform'; id: number; epoch: number; selectedOnly: boolean; selectionView?: SelectionView | null } |
  { command: 'applyTransform'; id: number; epoch: number; parameters: TransformDefinition } |
  { command: 'resetTransform' | 'undoTransform' | 'redoTransform' | 'cancelTransform'; id: number; epoch: number } |
  { command: 'endTransform'; id: number }>;
/** Freeze the press target and transform definition before entering either queue. */
export function captureTransformCommand(value: unknown): CapturedTransformCommand {
  if (!isTransformCommand(value)) throw new Error('Invalid transform session command.');
  const data = value as Record<string, unknown>, result: Record<string, unknown> = {};
  for (const name of Object.keys(data)) result[name] = Object.getOwnPropertyDescriptor(data, name)!.value;
  if (Object.hasOwn(data, 'selectionView')) result.selectionView = validateSelectionView(result.selectionView);
  if (result.command === 'applyTransform') {
    const parameters = validateTransformDefinition(result.parameters)!;
    for (const value of Object.values(parameters)) if (Array.isArray(value)) Object.freeze(value);
    result.parameters = Object.freeze(parameters);
  }
  return Object.freeze(result) as CapturedTransformCommand;
}
export type TransformState = Readonly<{ loaded: boolean; kind: number; revision: number; contentRevision: number;
  pending: boolean; transformSession: TransformSessionSummary | null }>;
export function captureTransformState(value: unknown): TransformState {
  const message = 'Invalid native transform session.';
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(message);
  const own = (name: string) => {
    const data = Object.getOwnPropertyDescriptor(value, name);
    if (!data?.enumerable || !('value' in data)) throw new Error(message);
    return data.value as unknown;
  };
  const loaded = own('loaded'), kind = own('kind'), compact = loaded === false && kind === 0;
  const revision = compact && !Object.hasOwn(value, 'revision') ? 0 : own('revision');
  const contentRevision = compact && !Object.hasOwn(value, 'contentRevision') ? 0 : own('contentRevision');
  const pending = compact && !Object.hasOwn(value, 'pending') ? false : own('pending');
  const transformSession = validateTransformSummary(own('transformSession'));
  if (typeof loaded !== 'boolean' || ![0, 1, 2].includes(kind as number) || typeof pending !== 'boolean' ||
      !Number.isSafeInteger(revision) || Number(revision) < 0 || !Number.isSafeInteger(contentRevision) || Number(contentRevision) < 0 ||
      transformSession && (!loaded || kind !== 0)) throw new Error(message);
  return Object.freeze({ loaded, kind: kind as number, revision: Number(revision), contentRevision: Number(contentRevision), pending, transformSession });
}
export function assertTransformRequest(command: CapturedTransformCommand, before: TransformState): void {
  const session = before.transformSession, message = 'The transform request belongs to another captured owner.';
  if (!before.loaded || before.kind !== 0 || before.pending) throw new Error(message);
  if (command.command === 'beginTransform') { if (session) throw new Error(message); return; }
  if (!session || session.id !== command.id) throw new Error(message);
  if (command.command === 'endTransform') return;
  if (command.epoch <= session.epoch || command.command === 'resetTransform' && session.kind !== 'numeric' ||
      ['rebaseTransform', 'undoTransform', 'redoTransform', 'cancelTransform'].includes(command.command) && session.kind !== 'gizmo' ||
      command.command === 'undoTransform' && !session.gizmo?.canUndo || command.command === 'redoTransform' && !session.gizmo?.canRedo) throw new Error(message);
}
const identityMatrix = (matrix: TransformMatrix) => matrix.every((value, index) => value === (index % 5 === 0 ? 1 : 0));
export function assertTransformAcknowledgement(command: CapturedTransformCommand, before: TransformState, value: unknown, interrupted = false): void {
  assertTransformRequest(command, before);
  const after = captureTransformState(value), previous = before.transformSession, current = after.transformSession;
  const message = 'The transform acknowledgement changed its captured request.';
  if (interrupted && sameTransformSummary(previous, current)) return;
  if (after.pending) throw new Error(message);
  if (command.command === 'beginTransform') {
    if (!current || current.kind !== command.kind || current.selectedOnly !== command.selectedOnly || current.epoch !== 0 ||
        current.appliedEpoch !== null || !identityMatrix(current.appliedMatrix) || current.gizmo && current.gizmo.cancelBaseId !== null ||
        after.revision !== before.revision || after.contentRevision !== before.contentRevision) throw new Error(message);
    return;
  }
  if (command.command === 'endTransform' || command.command === 'cancelTransform') {
    if (current !== null || command.command === 'endTransform' && (after.revision !== before.revision || after.contentRevision !== before.contentRevision) ||
        command.command === 'cancelTransform' && after.contentRevision !== (previous!.gizmo!.cancelContentRevision ?? before.contentRevision)) throw new Error(message);
    return;
  }
  if (!current || current.id !== previous!.id || current.kind !== previous!.kind || current.epoch !== command.epoch) throw new Error(message);
  if (command.command === 'applyTransform' || command.command === 'resetTransform') {
    if (current.selectedOnly !== previous!.selectedOnly) throw new Error(message);
    if (interrupted && current.baseId === previous!.baseId && current.appliedEpoch === previous!.appliedEpoch &&
        current.appliedMatrix.every((number, index) => number === previous!.appliedMatrix[index]) &&
        current.pivot.every((number, index) => number === previous!.pivot[index]) && sameGizmoSummary(current.gizmo, previous!.gizmo)) return;
    if (previous!.kind === 'gizmo' ? current.baseId === previous!.baseId || current.appliedEpoch !== null || !identityMatrix(current.appliedMatrix) :
        current.baseId !== previous!.baseId || current.appliedEpoch !== command.epoch || command.command === 'resetTransform' && !identityMatrix(current.appliedMatrix)) throw new Error(message);
    if (previous!.gizmo) {
      if (!current.gizmo) throw new Error(message);
      if (previous!.gizmo.cancelBaseId !== null) {
        if (current.gizmo.cancelBaseId !== previous!.gizmo.cancelBaseId || current.gizmo.cancelContentRevision !== previous!.gizmo.cancelContentRevision) throw new Error(message);
      } else if (after.contentRevision === before.contentRevision ? current.gizmo.cancelBaseId !== null :
          current.gizmo.cancelBaseId !== previous!.baseId || current.gizmo.cancelContentRevision !== before.contentRevision) throw new Error(message);
    }
  } else {
    if (current.baseId === previous!.baseId || current.appliedEpoch !== null || !identityMatrix(current.appliedMatrix) ||
        current.selectedOnly !== (command.command === 'rebaseTransform' ? command.selectedOnly : previous!.selectedOnly) ||
        current.gizmo?.cancelBaseId !== previous!.gizmo?.cancelBaseId || current.gizmo?.cancelContentRevision !== previous!.gizmo?.cancelContentRevision ||
        command.command === 'rebaseTransform' && (!sameGizmoSummary(current.gizmo, previous!.gizmo) || after.revision !== before.revision || after.contentRevision !== before.contentRevision)) throw new Error(message);
  }
}
export type TransformRequestProof = Readonly<{ before: TransformState; command?: CapturedTransformCommand }>;
export function captureTransformRequest(value: unknown, before: TransformState): TransformRequestProof {
  const name = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'command') : undefined;
  const command = name && 'value' in name && (TRANSFORM_COMMANDS as readonly unknown[]).includes(name.value) ? captureTransformCommand(value) : undefined;
  if (command) assertTransformRequest(command, before);
  return Object.freeze({ before, ...(command ? { command } : {}) });
}
export function assertTransformUnchanged(expected: TransformSessionSummary | null, value: unknown): void {
  if (!sameTransformSummary(expected, captureTransformState(value).transformSession)) throw new Error('The transform session changed outside its captured request.');
}
export function assertTransformResponse(proof: TransformRequestProof, value: unknown, interrupted = false): void {
  if (proof.command) assertTransformAcknowledgement(proof.command, proof.before, value, interrupted);
  else assertTransformUnchanged(proof.before.transformSession, value);
}
/** Receipt2 remains stable; the complete transient owner is proved separately. */
export class TransformOperation {
  private baseline: TransformSessionSummary | null;
  private current: TransformSessionSummary | null;
  constructor(before: unknown) { this.baseline = this.current = captureTransformState(before).transformSession; }
  accept(value: unknown): void { this.current = captureTransformState(value).transformSession; }
  assert(outcome: string, value: unknown): void {
    if (!['active', 'committed', 'rolled-back', 'not-started'].includes(outcome)) throw new Error('The transform operation outcome is unknown.');
    assertTransformUnchanged(['rolled-back', 'not-started'].includes(outcome) ? this.baseline : this.current, value);
  }
}
