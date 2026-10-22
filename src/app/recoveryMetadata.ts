import { validateSimilarityAlignmentFrame, type AlignmentCameraState } from '../document/alignment';
import { sameAlignmentFrame, validateAlignmentSummary, type AlignmentSummary } from '../document/alignmentProtocol';
import { MAX_ALIGNMENT_VIEW_CHECKPOINTS, type AlignmentViewCheckpoint, type AlignmentViewCheckpoints } from '../document/alignmentViews';
import { validateColorSession, type ColorSessionSummary } from '../document/colorProtocol';
import { validateOpacitySummary, type OpacitySessionSummary } from '../document/opacityProtocol';
import { validateDuplicateRange, type DuplicateRange } from '../document/duplicateProtocol';
import type { RecoveryJson } from '../document/recoveryCheckpoint';
import { transformUiParameters, transformWireParameters, validateTransformSummary,
  type TransformParameters, type TransformSessionSummary } from '../document/transformProtocol';
import { BACKGROUND_COLORS, type BackgroundColor } from '../input/background';

export type RecoveryNativeExpectation = Readonly<{ kind: 0 | 1 | 2; count: number; sourceCount: number; shDegree: number; format: string;
  duplicateRange: DuplicateRange }>;
export type RecoveryAppliedTools = Readonly<{
  color: ColorSessionSummary | null;
  transform: Readonly<{ session: TransformSessionSummary; parameters: TransformParameters }> | null;
  opacity: OpacitySessionSummary | null;
}>;
export type RecoveryMetadata = Readonly<{
  version: 2; native: RecoveryNativeExpectation; alignment: AlignmentSummary | null;
  activeCamera: Readonly<AlignmentCameraState>; defaultCamera: Readonly<AlignmentCameraState>; background: BackgroundColor;
  alignmentViews: readonly (readonly [number, AlignmentViewCheckpoint])[];
  savedContent: number; applied: RecoveryAppliedTools;
}> & { readonly [key: string]: RecoveryJson };
export type RecoveryMetadataInput = Readonly<{
  native: Readonly<Omit<RecoveryNativeExpectation, 'kind'> & { kind: number }>; alignment: AlignmentSummary | null;
  activeCamera: readonly number[]; defaultCamera: readonly number[]; background: BackgroundColor;
  alignmentViews: AlignmentViewCheckpoints; savedContent: number; applied: RecoveryAppliedTools;
}>;
const invalid = (detail: string) => new Error(`Invalid recovery browser metadata: ${detail}.`);
const zero = (value: number) => Object.is(value, -0) ? 0 : value;
const mapEntries = Map.prototype.entries;
const mapNext = Object.getPrototypeOf(mapEntries.call(new Map())).next as
  (this: MapIterator<[number, AlignmentViewCheckpoint]>) => IteratorResult<[number, AlignmentViewCheckpoint]>;

/** Bounded data-only copy before invoking existing protocol parsers. They see
 * independent inert arrays/objects, including the older color parser. Signed
 * zero is canonicalized because this is JSON metadata, not native scene bytes.
 */
function inertJson(input: unknown): RecoveryJson {
  const visiting = new Set<object>();
  let nodes = 0, characters = 0;
  const visit = (value: unknown, depth: number, normalizeZero = true): RecoveryJson => {
    if (++nodes > 4096 || depth > 12) throw invalid('structural bound');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw invalid('finite number');
      if (!normalizeZero && Object.is(value, -0)) throw invalid('duplicate range integer');
      return zero(value);
    }
    if (typeof value === 'string') {
      characters += value.length;
      if (value.length > 128 || characters > 16384) throw invalid('text bound');
      return value;
    }
    if (!value || typeof value !== 'object' || visiting.has(value)) throw invalid('JSON data');
    const array = Array.isArray(value);
    if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) throw invalid('data prototype');
    visiting.add(value);
    try {
      if (array) {
        const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
        if (!Number.isInteger(length) || length < 0 || length > 4096 - nodes || Reflect.ownKeys(value).length !== length + 1)
          throw invalid('dense array');
        const output: RecoveryJson[] = [];
        for (let index = 0; index < length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor?.enumerable || !('value' in descriptor)) throw invalid('array data field');
          output.push(visit(descriptor.value, depth + 1, normalizeZero));
        }
        return Object.freeze(output);
      }
      const keys = Reflect.ownKeys(value);
      if (keys.length > 64 || keys.length > 4096 - nodes) throw invalid('object bound');
      const entries: [string, RecoveryJson][] = [];
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (typeof key !== 'string' || key.length > 64 || !descriptor?.enumerable || !('value' in descriptor))
          throw invalid('object data field');
        entries.push([key, visit(descriptor.value, depth + 1, normalizeZero && key !== 'duplicateRange')]);
      }
      return Object.freeze(Object.fromEntries(entries));
    } finally { visiting.delete(value); }
  };
  return visit(input, 0);
}
function fields(value: unknown, expected: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    throw invalid('record');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length || keys.some(key => typeof key !== 'string' || !expected.includes(key))) throw invalid('fields');
  return value as Record<string, unknown>;
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw invalid('integer');
  return value;
}
function camera(value: unknown): Readonly<AlignmentCameraState> {
  // Same eleven-float boundary as CameraController.checkedCameraState. Native
  // camera transforms remain responsible for derived view/projection matrices.
  if (!Array.isArray(value) || value.length !== 11) throw invalid('camera length');
  const result = value.map(number => {
    if (typeof number !== 'number' || !Number.isFinite(Math.fround(number))) throw invalid('camera float32');
    return zero(Math.fround(number));
  });
  if (result[5] <= 0 || result[6] <= 0 || result[10] <= 0 || result[8] !== 0 && result[8] !== 1) throw invalid('camera range');
  return Object.freeze(result) as unknown as Readonly<AlignmentCameraState>;
}
function nativeExpectation(value: unknown): RecoveryNativeExpectation {
  const data = fields(value, ['kind', 'count', 'sourceCount', 'shDegree', 'format', 'duplicateRange']);
  // An admitted source remains nonempty, while Delete All/Crop may leave its
  // committed edited graph empty without discarding its history or cameras.
  const kind = integer(data.kind, 0, 2), count = integer(data.count, 0, 1_000_000),
    sourceCount = integer(data.sourceCount, Math.max(1, count), 0xffff_ffff);
  const shDegree = integer(data.shDegree, 0, 3);
  if (kind !== 0 && shDegree !== 0 || typeof data.format !== 'string' || data.format.length === 0 || data.format.length > 128)
    throw invalid('native scene expectation');
  const duplicateRange = validateDuplicateRange(data.duplicateRange, count, kind === 0);
  return Object.freeze({ kind: kind as 0 | 1 | 2, count, sourceCount, shDegree, format: data.format, duplicateRange });
}
function alignmentViews(value: unknown, alignment: AlignmentSummary | null): readonly (readonly [number, AlignmentViewCheckpoint])[] {
  if (!Array.isArray(value) || value.length > MAX_ALIGNMENT_VIEW_CHECKPOINTS || value.length > 0 && !alignment)
    throw invalid('alignment checkpoint bound or owner');
  const seen = new Set<number>();
  return Object.freeze(value.map(pair => {
    if (!Array.isArray(pair) || pair.length !== 2) throw invalid('alignment checkpoint entry');
    const branch = integer(pair[0]);
    if (seen.has(branch)) throw invalid('duplicate alignment branch');
    seen.add(branch);
    const data = fields(pair[1], ['branchId', 'frame', 'activeRoll', 'defaultRoll', 'corrected']);
    if (integer(data.branchId) !== branch || branch !== 0 && !alignment!.retainedBranchIds.includes(branch))
      throw invalid('alignment branch owner');
    const frame = validateSimilarityAlignmentFrame(data.frame);
    if (typeof data.activeRoll !== 'number' || !Number.isFinite(Math.fround(data.activeRoll)) ||
        typeof data.defaultRoll !== 'number' || !Number.isFinite(Math.fround(data.defaultRoll)) || typeof data.corrected !== 'boolean')
      throw invalid('alignment roll checkpoint');
    if (branch === alignment!.branchId && !sameAlignmentFrame(frame, alignment!.frame)) throw invalid('current alignment checkpoint frame');
    return Object.freeze([branch, Object.freeze({ branchId: branch, frame, activeRoll: zero(Math.fround(data.activeRoll)),
      defaultRoll: zero(Math.fround(data.defaultRoll)), corrected: data.corrected })] as const);
  }));
}
function appliedTools(value: unknown): RecoveryAppliedTools {
  const data = fields(value, ['color', 'transform', 'opacity']);
  if (data.color === undefined || data.opacity === undefined) throw invalid('applied tool fields');
  const color = validateColorSession(data.color), opacity = validateOpacitySummary(data.opacity);
  if (color && (color.pending || color.values.some((number, index) => Math.fround(number) !== Math.fround(color.applied[index]))))
    throw invalid('unfinished color preview');
  let transform: RecoveryAppliedTools['transform'] = null;
  if (data.transform !== null) {
    const entry = fields(data.transform, ['session', 'parameters']), session = validateTransformSummary(entry.session);
    const parameters = transformUiParameters(entry.parameters);
    if (!session || !parameters || !transformWireParameters(parameters)) throw invalid('applied transform');
    // The durable graph finalizes transient gizmo sessions. A fresh worker
    // cannot offer Cancel without the original shared geometry baseline.
    if (session.kind === 'numeric') transform = Object.freeze({ session, parameters });
  }
  if (transform && opacity) throw invalid('mutually exclusive transform and opacity owners');
  return Object.freeze({ color, transform, opacity });
}

/** Decode only the committed browser bundle captured alongside the admitted
 * native graph. No desired preview, pending task, GPU handle or output success
 * is inferred here. Native alignment/tool equality is checked by publication.
 */
export function decodeRecoveryMetadata(value: unknown): RecoveryMetadata {
  const data = fields(inertJson(value), ['version', 'native', 'alignment', 'activeCamera', 'defaultCamera',
    'background', 'alignmentViews', 'savedContent', 'applied']);
  if (data.version !== 2 || !BACKGROUND_COLORS.includes(data.background as BackgroundColor) || data.alignment === undefined)
    throw invalid('version, background or alignment');
  const alignment = validateAlignmentSummary(data.alignment), native = nativeExpectation(data.native);
  const applied = appliedTools(data.applied);
  if (native.kind !== 0 && (alignment || applied.color || applied.transform || applied.opacity)) throw invalid('geometry tool owners');
  // The final copy also deeply freezes parser-produced transform arrays and
  // normalizes any signed zero introduced by float32 matrix validation.
  return inertJson({ version: 2, native, alignment, activeCamera: camera(data.activeCamera), defaultCamera: camera(data.defaultCamera),
    background: data.background, alignmentViews: alignmentViews(data.alignmentViews, alignment),
    savedContent: integer(data.savedContent), applied }) as RecoveryMetadata;
}

/** Capture an actual Map via its intrinsic iterator, not caller-provided
 * entries()/Symbol.iterator hooks. The returned JSON owns independent data.
 */
export function encodeRecoveryMetadata(input: RecoveryMetadataInput): RecoveryMetadata {
  const data = fields(input, ['native', 'alignment', 'activeCamera', 'defaultCamera', 'background', 'alignmentViews', 'savedContent', 'applied']);
  // Snapshot top-level data descriptors before reading values or iterating.
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(data)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) throw invalid('capture data field');
    copy[key] = descriptor.value;
  }
  const entries: [number, AlignmentViewCheckpoint][] = [];
  try {
    const iterator = mapEntries.call(copy.alignmentViews) as MapIterator<[number, AlignmentViewCheckpoint]>;
    for (;;) {
      const item = mapNext.call(iterator);
      if (item.done) break;
      if (entries.length >= MAX_ALIGNMENT_VIEW_CHECKPOINTS) throw invalid('alignment checkpoint bound');
      entries.push(item.value);
    }
  } catch { throw invalid('alignment checkpoint Map or bound'); }
  return decodeRecoveryMetadata({ version: 2, ...copy, alignmentViews: entries });
}
