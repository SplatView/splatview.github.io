import { validateSelectionView } from './selectionView';

/** The raw preference survives scene-dependent effective radius resolution. */
export type SelectionRangePreference = Readonly<{ enabled: boolean; radius: number | null }>;
export type SelectionRangeFields = Readonly<{ rangeEnabled: boolean; rangeRadius: number | null }>;
export type SelectionRangeCenter = readonly [number, number, number];
export type ToleranceRange = Readonly<{ enabled: boolean; radius: number | null; center: SelectionRangeCenter | null }>;
export type ToleranceRangeOwner = Readonly<{ sessionId: number; tool: 'color' | 'fill'; range: ToleranceRange; recorded: boolean }>;
export const SELECTION_RANGE_COMMANDS = ['colorPick', 'colorTolerance', 'fillPick', 'fillTolerance'] as const;
export type SelectionRangeCommandName = typeof SELECTION_RANGE_COMMANDS[number];
export type CapturedSelectionRangeCommand = Readonly<{ command: SelectionRangeCommandName; sessionId: number;
  rangeEnabled: boolean; rangeRadius: number | null; [key: string]: unknown }>;

export function isSelectionRangeCommand(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const name = Object.getOwnPropertyDescriptor(value, 'command');
  if (name && (!name.enumerable || !('value' in name))) throw new Error('Invalid selection Range command.');
  return !!name && 'value' in name && (SELECTION_RANGE_COMMANDS as readonly unknown[]).includes(name.value);
}

function dataRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(message);
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new Error(message);
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !('value' in field)) throw new Error(message);
    Object.defineProperty(result, key, { value: field.value, enumerable: true });
  }
  return result;
}
function exact(value: unknown, keys: readonly string[], message: string): Record<string, unknown> {
  const data = dataRecord(value, message), names = Object.keys(data);
  if (names.length !== keys.length || names.some(name => !keys.includes(name))) throw new Error(message);
  return data;
}
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value > 0; }
function float32(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.fround(value) === value;
}
function radius(value: unknown, enabled: boolean, message: string): number | null {
  if (value === null && !enabled) return null;
  if (!positive(value) || !float32(value)) throw new Error(message);
  return value;
}
function center(value: unknown, message: string): SelectionRangeCenter | null {
  if (value === null) return null;
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== 3 ||
      Reflect.ownKeys(value).length !== 4) throw new Error(message);
  const result: number[] = [];
  for (let index = 0; index < 3; index++) {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    if (!field?.enumerable || !('value' in field) || !float32(field.value)) throw new Error(message);
    result.push(field.value);
  }
  return Object.freeze(result) as unknown as SelectionRangeCenter;
}

/** Preserve raw preference precision and automatic null across scene changes.
 * Resolution/clamping to scene statistics occurs before constructing RPC fields. */
export function validateSelectionRangePreference(value: unknown): SelectionRangePreference {
  const message = 'Invalid selection Range preference.', data = exact(value, ['enabled', 'radius'], message);
  if (typeof data.enabled !== 'boolean' || data.radius !== null && !positive(data.radius)) throw new Error(message);
  return Object.freeze({ enabled: data.enabled, radius: data.radius as number | null });
}
/** Resolved RPC fields and acknowledged metadata must contain exact float32
 * radii. Calculated scene bounds do not impose an additional protocol hard cap. */
export function validateSelectionRangeFields(value: unknown): SelectionRangeFields {
  const message = 'Invalid selection Range command fields.', data = exact(value, ['rangeEnabled', 'rangeRadius'], message);
  if (typeof data.rangeEnabled !== 'boolean') throw new Error(message);
  return Object.freeze({ rangeEnabled: data.rangeEnabled, rangeRadius: radius(data.rangeRadius, data.rangeEnabled, message) });
}
/** Validate/capture only the Range extension, not the originating command's
 * seed/camera/map/operation contract. Both validators must run before dispatch. */
export function selectionRangeCommandFields(value: unknown): SelectionRangeFields {
  const message = 'Invalid selection Range command.', data = dataRecord(value, message);
  if (!(SELECTION_RANGE_COMMANDS as readonly unknown[]).includes(data.command) ||
      ['center', 'rangeCenter', 'toleranceRange', 'operationOwner'].some(name => Object.hasOwn(data, name))) throw new Error(message);
  const enabled = Object.hasOwn(data, 'rangeEnabled'), resolved = Object.hasOwn(data, 'rangeRadius');
  if (!enabled && !resolved) return Object.freeze({ rangeEnabled: false, rangeRadius: null });
  if (enabled !== resolved) throw new Error(message);
  return validateSelectionRangeFields({ rangeEnabled: data.rangeEnabled, rangeRadius: data.rangeRadius });
}
/** Capture the entire request before entering either asynchronous queue. An
 * amendment cannot smuggle in a replacement camera, click, map or center. */
export function captureSelectionRangeCommand(value: unknown, requireFillSample = false): CapturedSelectionRangeCommand {
  const message = 'Invalid selection Range command.', data = dataRecord(value, message);
  const fields = selectionRangeCommandFields(value), name = data.command as SelectionRangeCommandName;
  const pick = name === 'colorPick' || name === 'fillPick', color = name === 'colorPick' || name === 'colorTolerance';
  const allowed = ['command', 'sessionId', 'tolerance', 'rangeEnabled', 'rangeRadius',
    ...(color ? ['connected', 'mapId'] : []), ...(pick ? ['camera', 'operation', 'width', 'height', 'seed', 'selectionView',
      ...(color ? ['index'] : ['mapId', 'visibleOnly', 'overlap', 'sampleRadiusPixels'])] : [])];
  if (Object.keys(data).some(key => !allowed.includes(key)) || !Number.isSafeInteger(data.sessionId) || Number(data.sessionId) < 1 ||
      typeof data.tolerance !== 'number' || !Number.isFinite(data.tolerance) || !Number.isFinite(Math.fround(data.tolerance))) throw new Error(message);
  for (const key of ['connected', 'visibleOnly', 'overlap']) if (Object.hasOwn(data, key) && typeof data[key] !== 'boolean') throw new Error(message);
  if (Object.hasOwn(data, 'mapId') && (!Number.isSafeInteger(data.mapId) || Number(data.mapId) < 1)) throw new Error(message);
  const result: Record<string, unknown> = { ...data, ...fields };
  if (pick) {
    if (!Object.hasOwn(data, 'camera') || data.camera === null || data.camera === undefined) throw new Error(message);
    result.camera = validateSelectionView(data.camera);
    if (Object.hasOwn(data, 'selectionView')) result.selectionView = validateSelectionView(data.selectionView);
    if (Object.hasOwn(data, 'operation') && (!Number.isInteger(data.operation) || Number(data.operation) < 0 || Number(data.operation) > 3)) throw new Error(message);
    if (color && (!Number.isSafeInteger(data.index) || Number(data.index) < 0 || Number(data.index) > 0xffff_ffff)) throw new Error(message);
    const capture = ['width', 'height', 'seed'].filter(key => Object.hasOwn(data, key));
    if (capture.length && capture.length !== 3 || !color && capture.length !== 3 || !color && !Object.hasOwn(data, 'mapId')) throw new Error(message);
    if (capture.length) {
      for (const key of ['width', 'height']) if (!Number.isInteger(data[key]) || Number(data[key]) < 1 || Number(data[key]) > 0x7fff_ffff) throw new Error(message);
      if (!Array.isArray(data.seed) || Object.getPrototypeOf(data.seed) !== Array.prototype || data.seed.length !== 2 ||
          Reflect.ownKeys(data.seed).length !== 3) throw new Error(message);
      const seed: number[] = [];
      for (let index = 0; index < 2; index++) {
        const field = Object.getOwnPropertyDescriptor(data.seed, String(index));
        if (!field?.enumerable || !('value' in field) || !Number.isInteger(field.value) || field.value < -0x8000_0000 || field.value > 0x7fff_ffff) throw new Error(message);
        seed.push(field.value);
      }
      result.seed = Object.freeze(seed);
    }
    if (!color) {
      if ((requireFillSample || fields.rangeEnabled || Object.hasOwn(data, 'sampleRadiusPixels')) &&
          (!positive(data.sampleRadiusPixels) || !positive(Math.fround(data.sampleRadiusPixels)))) throw new Error(message);
    }
  }
  return Object.freeze(result) as CapturedSelectionRangeCommand;
}
export function validateToleranceRange(value: unknown): ToleranceRange | null {
  if (value === null) return null;
  const message = 'Invalid native tolerance Range.', data = exact(value, ['enabled', 'radius', 'center'], message);
  if (typeof data.enabled !== 'boolean') throw new Error(message);
  return Object.freeze({ enabled: data.enabled, radius: radius(data.radius, data.enabled, message), center: center(data.center, message) });
}
export function sameToleranceRange(a: ToleranceRange | null, b: ToleranceRange | null): boolean {
  return a === null ? b === null : b !== null && a.enabled === b.enabled && a.radius === b.radius &&
    (a.center === null ? b.center === null : b.center !== null && a.center.every((number, index) => number === b.center![index]));
}
/** Native summary owns this nullable field even before the first loaded scene.
 * A centerless Fill is structurally representable; command acknowledgement
 * below proves its permitted legacy-entry or later empty-amendment origin. */
export function toleranceRangeOwner(value: unknown): ToleranceRangeOwner | null {
  const message = 'Invalid native tolerance Range owner.', data = dataRecord(value, message);
  if (!['toleranceRange', 'toleranceRecorded', 'toleranceSessionId', 'toleranceTool', 'loaded', 'kind'].every(name => Object.hasOwn(data, name)) ||
      typeof data.loaded !== 'boolean' || ![0, 1, 2].includes(data.kind as number)) throw new Error(message);
  const range = validateToleranceRange(data.toleranceRange);
  if (data.toleranceSessionId === null || data.toleranceTool === null || range === null) {
    if (data.toleranceSessionId !== null || data.toleranceTool !== null || range !== null || data.toleranceRecorded !== null) throw new Error(message);
    return null;
  }
  if (!Number.isSafeInteger(data.toleranceSessionId) || Number(data.toleranceSessionId) < 1 ||
      !['color', 'fill'].includes(data.toleranceTool as string) || !data.loaded || data.kind !== 0 ||
      data.toleranceTool === 'color' && range.center === null || typeof data.toleranceRecorded !== 'boolean') throw new Error(message);
  return Object.freeze({ sessionId: Number(data.toleranceSessionId), tool: data.toleranceTool as 'color' | 'fill', range, recorded: data.toleranceRecorded });
}
export function validateToleranceRangeSummary(value: unknown): ToleranceRange | null { return toleranceRangeOwner(value)?.range ?? null; }
export function captureToleranceRangeState(value: unknown): Readonly<{ loaded: boolean; kind: number; toleranceSessionId: number | null;
  toleranceTool: 'color' | 'fill' | null; toleranceRange: ToleranceRange | null; toleranceRecorded: boolean | null }> {
  const owner = toleranceRangeOwner(value), data = dataRecord(value, 'Invalid native tolerance Range owner.');
  return Object.freeze({ loaded: data.loaded as boolean, kind: data.kind as number, toleranceSessionId: owner?.sessionId ?? null,
    toleranceTool: owner?.tool ?? null, toleranceRange: owner?.range ?? null, toleranceRecorded: owner?.recorded ?? null });
}
export function sameToleranceRangeOwner(a: ToleranceRangeOwner | null, b: ToleranceRangeOwner | null): boolean {
  return a === null ? b === null : b !== null && a.sessionId === b.sessionId && a.tool === b.tool && a.recorded === b.recorded && sameToleranceRange(a.range, b.range);
}
export function assertToleranceRangeOwnerUnchanged(expected: ToleranceRangeOwner | null, summary: unknown): void {
  if (!sameToleranceRangeOwner(expected, toleranceRangeOwner(summary))) throw new Error('The tolerance Range owner changed outside its captured request.');
}
/** Other scene mutations may retire a completed stroke. They cannot change its
 * config, center or originating-checkpoint Undo bit while retaining its ID. */
export function assertToleranceOwnerRetainedOrRetired(expected: ToleranceRangeOwner | null, summary: unknown): void {
  if (toleranceRangeOwner(summary) !== null) assertToleranceRangeOwnerUnchanged(expected, summary);
}

/** Receipt2 deliberately remains unchanged. Keep this independent transient
 * proof next to each operation so rollback/status cannot authorize a new Range. */
export class ToleranceRangeOperation {
  private baseline: ToleranceRangeOwner | null;
  private current: ToleranceRangeOwner | null;
  constructor(before: unknown) { this.baseline = this.current = toleranceRangeOwner(before); }
  accept(summary: unknown): void { this.current = toleranceRangeOwner(summary); }
  assertRetained(summary: unknown): void {
    if (toleranceRangeOwner(summary) !== null) assertToleranceRangeOwnerUnchanged(this.current, summary);
  }
  assert(outcome: string, summary: unknown): void {
    if (!['active', 'committed', 'rolled-back', 'not-started'].includes(outcome)) throw new Error('The tolerance Range operation outcome is unknown.');
    assertToleranceRangeOwnerUnchanged(['rolled-back', 'not-started'].includes(outcome) ? this.baseline : this.current, summary);
  }
}

export function assertToleranceRangeRequest(command: unknown, before: unknown): void {
  const message = 'The tolerance Range request belongs to another captured owner.', data = dataRecord(command, message);
  selectionRangeCommandFields(command);
  if (!Number.isSafeInteger(data.sessionId) || Number(data.sessionId) < 1) throw new Error(message);
  const previous = toleranceRangeOwner(before), pick = data.command === 'colorPick' || data.command === 'fillPick';
  const tool = data.command === 'colorPick' || data.command === 'colorTolerance' ? 'color' : 'fill';
  if (pick ? previous !== null && Number(data.sessionId) <= previous.sessionId :
      previous === null || previous.sessionId !== data.sessionId || previous.tool !== tool) throw new Error(message);
}

/** Authenticate Range metadata even when an accepted amendment leaves native
 * revision and selectionCommitRevision unchanged. Receipt2 alone does not bind
 * these fields. Existing topology/mask/receipt validation remains mandatory. */
export function assertToleranceRangeAcknowledgement(command: unknown, before: unknown, after: unknown): 'completed' | 'unchanged' {
  const message = 'The tolerance Range acknowledgement changed its captured request.';
  const data = dataRecord(command, message), fields = selectionRangeCommandFields(command);
  try { assertToleranceRangeRequest(command, before); } catch { throw new Error(message); }
  const previous = toleranceRangeOwner(before), current = toleranceRangeOwner(after);
  const name = data.command as SelectionRangeCommandName, pick = name === 'colorPick' || name === 'fillPick';
  const tool = name === 'colorPick' || name === 'colorTolerance' ? 'color' : 'fill';
  if (pick && previous && Number(data.sessionId) <= previous.sessionId) throw new Error(message);
  if (pick && (!current || current.sessionId !== data.sessionId)) {
    if (previous === null ? current !== null : current === null || previous.sessionId !== current.sessionId ||
        previous.tool !== current.tool || previous.recorded !== current.recorded || !sameToleranceRange(previous.range, current.range)) throw new Error(message);
    return 'unchanged'; // Missed/empty initial pick retained the preceding owner.
  }
  if (!current || current.sessionId !== data.sessionId || current.tool !== tool ||
      current.range.enabled !== fields.rangeEnabled || current.range.radius !== fields.rangeRadius) throw new Error(message);
  if (!pick) {
    if (!previous || previous.sessionId !== current.sessionId || previous.tool !== tool ||
        (previous.range.center === null ? current.range.center !== null : current.range.center === null ||
          previous.range.center.some((number, index) => number !== current.range.center![index]))) throw new Error(message);
  } else if (tool === 'fill' && fields.rangeEnabled && current.range.center === null) {
    throw new Error(message); // Initial enabled Fill may not install a centerless owner.
  }
  return 'completed';
}
