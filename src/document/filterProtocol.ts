import { commandWithoutSelectionView, validateSelectionView, type SelectionView } from './selectionView';
// Capture02 processing_ui.cpp:85-119,388-596; processing.cpp:372-507.
// UI values persist independently; only the active predicate crosses the wire.
export const SELECTION_FILTER_KINDS = ['sphere', 'box', 'ellipsoid', 'frustum', 'opacity', 'scale'] as const;
export type SelectionFilterKind = typeof SELECTION_FILTER_KINDS[number];
export type FilterVec3 = [number, number, number];
export type SelectionFilterParameters = {
  center: FilterVec3; size: FilterVec3; rotation: FilterVec3;
  radius: number; fov: number; aspect: number; near: number; far: number;
  minOpacity: number; maxOpacity: number; minScale: number; maxScale: number;
};
export type SelectionFilterSummary = Readonly<{
  id: number; kind: SelectionFilterKind; epoch: number; previewEpoch: number | null;
  /** Required at selectionFilter2 runtime boundaries. Optional only for older
   * isolated controller doubles, never a default inferred from selected count. */
  changed?: boolean;
}>;
export type FilterWireParameters = Record<string, number | FilterVec3>;
export type SelectionFilterCommand =
  | { command: 'beginFilter'; kind: SelectionFilterKind }
  | { command: 'previewFilter'; id: number; epoch: number; kind: SelectionFilterKind; parameters: FilterWireParameters; operation: number; selectionView?: SelectionView | null }
  | { command: 'confirmFilter'; id: number; epoch: number; visiblePreview?: true }
  | { command: 'cancelFilter'; id: number };

export function isSelectionFilterKind(value: unknown): value is SelectionFilterKind {
  return SELECTION_FILTER_KINDS.includes(value as SelectionFilterKind);
}
export function filterDefaults(_kind?: SelectionFilterKind): SelectionFilterParameters {
  return { center: [0, 0, 0], size: [1, 1, 1], rotation: [0, 0, 0], radius: 1,
    fov: 60, aspect: 1, near: .1, far: 100, minOpacity: 0, maxOpacity: 1, minScale: 0, maxScale: 100 };
}
function fields(value: unknown, names: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== names.length || keys.some(key => typeof key !== 'string' || !names.includes(key))) return null;
  const result: Record<string, unknown> = Object.create(null);
  for (const name of names) {
    const property = Object.getOwnPropertyDescriptor(value, name);
    if (!property?.enumerable || !('value' in property)) return null;
    result[name] = property.value;
  }
  return result;
}
function scalar(value: unknown, low = -1e12, high = 1e12): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high) return null;
  const result = Math.fround(value);
  return Number.isFinite(result) && result >= low && result <= high ? result : null;
}
function vector(value: unknown, low = -1e12): FilterVec3 | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== 3 ||
      Reflect.ownKeys(value).length !== 4) return null;
  const result: number[] = [];
  for (let index = 0; index < 3; index++) {
    const property = Object.getOwnPropertyDescriptor(value, String(index));
    if (!property?.enumerable || !('value' in property)) return null;
    const number = scalar(property.value, low);
    if (number === null) return null;
    result.push(number);
  }
  return result as FilterVec3;
}
export function validateFilterWireParameters(kind: SelectionFilterKind, value: unknown): FilterWireParameters | null {
  if (!isSelectionFilterKind(kind)) return null;
  const names = kind === 'sphere' ? ['center', 'radius'] : kind === 'box' || kind === 'ellipsoid' ? ['center', 'size', 'rotation'] :
    kind === 'frustum' ? ['center', 'rotation', 'fov', 'aspect', 'near', 'far'] : ['minimum', 'maximum'];
  const data = fields(value, names);
  if (!data) return null;
  if (kind === 'opacity' || kind === 'scale') {
    const minimum = scalar(data.minimum, 0, kind === 'opacity' ? 1 : 1e12),
      maximum = scalar(data.maximum, 0, kind === 'opacity' ? 1 : 1e12);
    return minimum === null || maximum === null || minimum > maximum ? null : { minimum, maximum };
  }
  const center = vector(data.center);
  if (!center) return null;
  if (kind === 'sphere') {
    const radius = scalar(data.radius, 0); return radius === null ? null : { center, radius };
  }
  const rotation = vector(data.rotation);
  if (!rotation) return null;
  if (kind === 'box' || kind === 'ellipsoid') {
    const size = vector(data.size, 0);
    return !size || kind === 'ellipsoid' && size.some(value => value <= 0) ? null : { center, size, rotation };
  }
  const fov = scalar(data.fov, .001 * 180 / Math.PI, (Math.PI - .001) * 180 / Math.PI),
    aspect = scalar(data.aspect, .001, 1000), near = scalar(data.near, 0), far = scalar(data.far, .0001);
  return fov === null || aspect === null || near === null || far === null || far <= near ? null : { center, rotation, fov, aspect, near, far };
}
export function filterWireParameters(kind: SelectionFilterKind, values: SelectionFilterParameters): FilterWireParameters | null {
  if (!values || typeof values !== 'object') return null;
  const data = kind === 'sphere' ? { center: values.center, radius: values.radius } : kind === 'box' || kind === 'ellipsoid' ?
    { center: values.center, size: values.size, rotation: values.rotation } : kind === 'frustum' ?
    { center: values.center, rotation: values.rotation, fov: values.fov, aspect: values.aspect, near: values.near, far: values.far } :
    kind === 'opacity' ? { minimum: values.minOpacity, maximum: values.maxOpacity } : { minimum: values.minScale, maximum: values.maxScale };
  return validateFilterWireParameters(kind, data);
}
export function normalizeFilterParameters(kind: SelectionFilterKind, values: SelectionFilterParameters): SelectionFilterParameters | null {
  if (!filterWireParameters(kind, values) || !Array.isArray(values.center) || !Array.isArray(values.size) || !Array.isArray(values.rotation)) return null;
  return { ...values, center: [...values.center], size: [...values.size], rotation: [...values.rotation] };
}
export function validateFilterSummary(value: unknown, _context?: Readonly<{ loadedCount?: number; pending?: boolean }>): SelectionFilterSummary | null {
  if (value === null) return null;
  const data = fields(value, ['id', 'kind', 'epoch', 'previewEpoch', 'changed']);
  if (!data || !Number.isSafeInteger(data.id) || (data.id as number) <= 0 || !isSelectionFilterKind(data.kind) ||
      !Number.isSafeInteger(data.epoch) || (data.epoch as number) < 0 ||
      data.previewEpoch !== null && (!Number.isSafeInteger(data.previewEpoch) || (data.previewEpoch as number) <= 0 ||
        (data.previewEpoch as number) > (data.epoch as number)) || data.epoch === 0 && data.previewEpoch !== null ||
      typeof data.changed !== 'boolean' || data.previewEpoch === null && data.changed)
    throw new Error('Invalid native selection filter metadata.');
  return Object.freeze({ id: data.id as number, kind: data.kind, epoch: data.epoch as number,
    previewEpoch: data.previewEpoch as number | null, changed: data.changed });
}
export function sameFilterSummary(a: SelectionFilterSummary | null | undefined, b: SelectionFilterSummary | null | undefined): boolean {
  return a == null || b == null ? a == null && b == null : a.id === b.id && a.kind === b.kind && a.epoch === b.epoch && a.previewEpoch === b.previewEpoch && a.changed === b.changed;
}
export function isSelectionFilterCommand(value: unknown): value is SelectionFilterCommand {
  value = commandWithoutSelectionView(value, ['previewFilter']);
  if (!value || typeof value !== 'object') return false;
  const name = Object.getOwnPropertyDescriptor(value, 'command');
  if (!name?.enumerable || !('value' in name)) return false;
  const command = name.value;
  const names = command === 'beginFilter' ? ['command', 'kind'] : command === 'cancelFilter' ? ['command', 'id'] :
    command === 'confirmFilter' ? ['command', 'id', 'epoch', ...(Object.hasOwn(value, 'visiblePreview') ? ['visiblePreview'] : [])] :
    command === 'previewFilter' ? ['command', 'id', 'epoch', 'kind', 'parameters', 'operation'] : null;
  if (!names) return false;
  const data = fields(value, names);
  if (!data) return false;
  if (command === 'beginFilter') return isSelectionFilterKind(data.kind);
  if (!Number.isSafeInteger(data.id) || (data.id as number) <= 0) return false;
  if (command === 'cancelFilter') return true;
  if (!Number.isSafeInteger(data.epoch) || (data.epoch as number) <= 0) return false;
  return command === 'confirmFilter' ? !Object.hasOwn(data, 'visiblePreview') || data.visiblePreview === true : isSelectionFilterKind(data.kind) && Number.isInteger(data.operation) &&
    (data.operation as number) >= 0 && (data.operation as number) <= 3 && !!validateFilterWireParameters(data.kind, data.parameters);
}

export function isFilterCommandName(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const name = Object.getOwnPropertyDescriptor(value, 'command');
  if (name && (!name.enumerable || !('value' in name))) throw new Error('Invalid selection filter command.');
  return !!name && 'value' in name && ['beginFilter', 'previewFilter', 'confirmFilter', 'cancelFilter'].includes(name.value);
}
/** Detach the predicate, vectors and camera before either serial queue starts. */
export function captureSelectionFilterCommand(value: unknown): Readonly<SelectionFilterCommand> {
  if (!isSelectionFilterCommand(value)) throw new Error('Invalid selection filter command.');
  if (value.command !== 'previewFilter') return Object.freeze({ ...value });
  const parameters = validateFilterWireParameters(value.kind, value.parameters)!;
  for (const [key, number] of Object.entries(parameters)) if (Array.isArray(number)) parameters[key] = Object.freeze(number) as unknown as FilterVec3;
  Object.freeze(parameters);
  const scope = Object.getOwnPropertyDescriptor(value, 'selectionView');
  return Object.freeze({ ...value, parameters, ...(scope ? { selectionView: validateSelectionView(scope.value) } : {}) });
}
export type FilterState = Readonly<{ loaded: boolean; kind: number; selectionDraft: boolean; pending: boolean;
  filter: SelectionFilterSummary | null }>;
function own(value: object, name: string): unknown {
  const field = Object.getOwnPropertyDescriptor(value, name);
  if (!field?.enumerable || !('value' in field)) throw new Error('Invalid native selection filter metadata.');
  return field.value;
}
/** Require an own nullable filter field on actual native summary boundaries. */
export function captureFilterState(value: unknown): FilterState {
  const message = 'Invalid native selection filter metadata.';
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(message);
  const loaded = own(value, 'loaded'), kind = own(value, 'kind'), filter = validateFilterSummary(own(value, 'filter'));
  if (typeof loaded !== 'boolean' || ![0, 1, 2].includes(kind as number)) throw new Error(message);
  const compact = loaded === false && kind === 0;
  const draft = compact && !Object.hasOwn(value, 'selectionDraft') ? false : own(value, 'selectionDraft');
  const pending = compact && !Object.hasOwn(value, 'pending') ? false : own(value, 'pending');
  if (typeof draft !== 'boolean' || typeof pending !== 'boolean' || filter && (!loaded || kind !== 0 || draft)) throw new Error(message);
  return Object.freeze({ loaded, kind: kind as number, selectionDraft: draft, pending, filter });
}
export function filterSummaryState(value: unknown): SelectionFilterSummary | null { return captureFilterState(value).filter; }
export function assertFilterUnchanged(expected: SelectionFilterSummary | null, summary: unknown): void {
  if (!sameFilterSummary(expected, filterSummaryState(summary))) throw new Error('The selection filter changed outside its captured request.');
}
export function assertFilterRequest(command: Readonly<SelectionFilterCommand>, before: FilterState): void {
  const filter = before.filter, message = 'The selection filter request belongs to another captured owner.';
  if (!before.loaded || before.kind !== 0 || before.selectionDraft) throw new Error(message);
  if (command.command === 'beginFilter') { if (filter || before.pending) throw new Error(message); return; }
  if (!filter || filter.id !== command.id) throw new Error(message);
  if (command.command === 'previewFilter' && (command.kind !== filter.kind || command.epoch <= filter.epoch || before.pending) ||
      command.command === 'confirmFilter' && (before.pending || command.epoch !== filter.previewEpoch ||
        command.visiblePreview !== true && command.epoch !== filter.epoch)) throw new Error(message);
}
/** changed is an authoritative native mask comparison, never inferred from
 * selected count, desired controls, epoch advancement or history availability. */
export function assertFilterAcknowledgement(command: Readonly<SelectionFilterCommand>, before: FilterState, summary: unknown,
  interrupted = false): void {
  assertFilterRequest(command, before);
  const after = captureFilterState(summary), previous = before.filter, current = after.filter;
  const message = 'The selection filter acknowledgement changed its captured request.';
  if (interrupted && sameFilterSummary(previous, current)) return;
  if (command.command === 'beginFilter') {
    if (!current || current.kind !== command.kind || current.epoch !== 0 || current.previewEpoch !== null || current.changed !== false || after.pending) throw new Error(message);
  } else if (command.command === 'previewFilter') {
    if (!current || current.id !== command.id || current.kind !== command.kind || current.epoch !== command.epoch) throw new Error(message);
    if (interrupted && current.previewEpoch === previous!.previewEpoch && current.changed === previous!.changed) return;
    if (after.pending || current.previewEpoch !== command.epoch) throw new Error(message);
  } else if (current !== null || after.pending) throw new Error(message);
}
export type FilterRequestProof = Readonly<{ before: FilterState; command?: Readonly<SelectionFilterCommand>; clear: boolean }>;
export function captureFilterRequest(value: unknown, before: FilterState): FilterRequestProof {
  const command = isFilterCommandName(value) ? captureSelectionFilterCommand(value) : undefined;
  if (command) assertFilterRequest(command, before);
  const name = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'command') : undefined;
  return Object.freeze({ before, ...(command ? { command } : {}), clear: !!name && 'value' in name && name.value === 'resetCleanup' });
}
export function assertFilterResponse(proof: FilterRequestProof, summary: unknown, interrupted = false): void {
  if (proof.command) assertFilterAcknowledgement(proof.command, proof.before, summary, interrupted);
  else if (!proof.clear || filterSummaryState(summary) !== null) assertFilterUnchanged(proof.before.filter, summary);
}
/** Independent of receipt2: bind the entire filter owner, including changed. */
export class FilterOperation {
  private baseline: SelectionFilterSummary | null;
  private current: SelectionFilterSummary | null;
  constructor(before: unknown) { this.baseline = this.current = filterSummaryState(before); }
  accept(summary: unknown): void { this.current = filterSummaryState(summary); }
  assert(outcome: string, summary: unknown): void {
    if (!['active', 'committed', 'rolled-back', 'not-started'].includes(outcome)) throw new Error('The selection filter operation outcome is unknown.');
    assertFilterUnchanged(['rolled-back', 'not-started'].includes(outcome) ? this.baseline : this.current, summary);
  }
}
