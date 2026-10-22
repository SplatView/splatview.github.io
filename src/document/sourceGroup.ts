import { SOURCE_FINGERPRINT_SCHEME, type SourceFingerprint } from '../io/fingerprint';
import { assertCanonicalAcquiredPath, compareUtf8Paths, validateAcquiredPaths } from '../io/paths';
import { MAX_SOURCE_READ_BYTES } from '../io/readBroker';
import { assertSceneInputBytes, assertSourceFitsDecodeBudget, NATIVE_LOAD_BUDGET_BYTES } from './sceneInputLimits';
import { checkedBytes, estimateSceneBytes, MiB } from './resources';
import type { NativeSummary } from './types';

export const MAX_GROUP_RESOURCES = 40;
export const MAX_GROUP_METADATA_BYTES = 16 * MiB;
export const GROUP_NATIVE_BUDGET_BYTES = NATIVE_LOAD_BUDGET_BYTES;
export const GROUP_NATIVE_WORK_BYTES = 64 * MiB;
export const MAX_GROUP_PATH_UNITS = 4_194_304;
export type GroupResourceDescriptor = Readonly<{
  resourceId: string; byteLength: number; path: string; role: 'primary' | 'referenced';
}>;
export type GroupSourceDescriptor = Readonly<{
  kind: 'group'; operationId: string; resourceId: string; byteLength: number;
  // Original acquisition paths let the worker resolve all literal parent
  // references. The authenticated graph derives rebased fingerprint paths.
  path: string; role: 'primary'; resources: readonly GroupResourceDescriptor[];
  decoder: Readonly<{ resourceId: string; byteLength: number }>;
}>;

function fields(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new Error('Invalid grouped source object.');
  const keys = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.length !== names.length || names.some(name => !Object.hasOwn(descriptors, name)))
    throw new Error('Invalid grouped source fields.');
  const result: Record<string, unknown> = Object.create(null);
  for (const name of names) {
    const descriptor = descriptors[name]!;
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable)
      throw new Error('Grouped source fields must be data values.');
    result[name] = descriptor.value;
  }
  return result;
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}
function uint32(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
}
function shDegree(value: unknown): value is 0 | 1 | 2 | 3 {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 3;
}
function metadataBytes(value: unknown): value is number {
  return uint32(value) && value > 0 && value <= MAX_GROUP_METADATA_BYTES;
}
function denseResources(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error('Invalid grouped resource table.');
  const descriptors = Object.getOwnPropertyDescriptors(value), length: unknown = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (typeof length !== 'number' || !Number.isInteger(length) || length < 2 || length > MAX_GROUP_RESOURCES + 1 ||
      Reflect.ownKeys(value).length !== length + 1)
    throw new Error('Invalid grouped resource table length.');
  const result: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable)
      throw new Error('Grouped resource table must be dense data.');
    result.push(descriptor.value);
  }
  return result;
}

function assertUnambiguousPathComponents(paths: readonly string[]): void {
  // At most 41 paths enter this comparison. Scan shared components directly,
  // without materializing a directory trie for an untrusted deep wire path.
  for (let index = 1; index < paths.length; index++) {
    const path = paths[index]!;
    for (let previous = 0; previous < index; previous++) {
      const other = paths[previous]!;
      let start = 0, otherStart = 0;
      while (true) {
        const end = path.indexOf('/', start), otherEnd = other.indexOf('/', otherStart);
        const component = path.slice(start, end < 0 ? path.length : end);
        const otherComponent = other.slice(otherStart, otherEnd < 0 ? other.length : otherEnd);
        if (component.toLowerCase() !== otherComponent.toLowerCase()) break;
        if (component !== otherComponent) throw new Error('Ambiguous case-alias grouped resource paths.');
        if (end < 0 || otherEnd < 0) break;
        start = end + 1; otherStart = otherEnd + 1;
      }
    }
  }
}

/** Detach the exact wire table; private preparation owners never cross this boundary. */
export function validateGroupSourceDescriptor(value: unknown): GroupSourceDescriptor {
  const input = fields(value, ['kind', 'operationId', 'resourceId', 'byteLength', 'path', 'role', 'resources', 'decoder']);
  if (input.kind !== 'group' || typeof input.path !== 'string' || input.path.length > MAX_GROUP_PATH_UNITS || input.role !== 'primary' ||
      !identifier(input.operationId) || !identifier(input.resourceId) || !uint32(input.byteLength))
    throw new Error('Invalid grouped source identity.');
  assertCanonicalAcquiredPath(input.path);
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(input.path) || input.path.split('/').at(-1)!.toLowerCase() !== 'meta.json')
    throw new Error('Invalid grouped metadata path.');
  const ids = new Set<string>(), foldedPaths = new Set<string>(), resources: GroupResourceDescriptor[] = [];
  let totalBytes = 0, pathUnits = 0;
  for (const [index, raw] of denseResources(input.resources).entries()) {
    const item = fields(raw, ['resourceId', 'byteLength', 'path', 'role']);
    if (!identifier(item.resourceId) || ids.has(item.resourceId) || !uint32(item.byteLength) ||
        typeof item.path !== 'string' || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(item.path) ||
        item.role !== (index === 0 ? 'primary' : 'referenced'))
      throw new Error('Invalid grouped resource identity.');
    if (item.path.length > MAX_GROUP_PATH_UNITS - pathUnits)
      throw new Error('Grouped resource paths exceed the preparation limit.');
    assertCanonicalAcquiredPath(item.path);
    const folded = item.path.toLowerCase();
    if (foldedPaths.has(folded)) throw new Error('Ambiguous case-alias grouped resource paths.');
    foldedPaths.add(folded);
    if (index === 0 && (item.path !== input.path || item.resourceId !== input.resourceId || !metadataBytes(item.byteLength)))
      throw new Error('Invalid grouped metadata resource.');
    if (index > 1 && compareUtf8Paths(resources[index - 1]!.path, item.path) >= 0)
      throw new Error('Grouped resources are not in canonical order.');
    ids.add(item.resourceId); totalBytes += item.byteLength; pathUnits += item.path.length;
    resources.push(Object.freeze({ resourceId: item.resourceId, byteLength: item.byteLength,
      path: item.path, role: index === 0 ? 'primary' : 'referenced' }));
  }
  const paths = resources.map(item => item.path);
  validateAcquiredPaths(paths);
  assertUnambiguousPathComponents(paths);
  if (pathUnits > MAX_GROUP_PATH_UNITS || totalBytes !== input.byteLength)
    throw new Error('Invalid grouped source size.');
  assertSceneInputBytes(totalBytes);
  const decoder = fields(input.decoder, ['resourceId', 'byteLength']);
  if (!identifier(decoder.resourceId) || ids.has(decoder.resourceId) || !metadataBytes(decoder.byteLength))
    throw new Error('Invalid grouped decoder metadata.');
  return Object.freeze({ kind: 'group', operationId: input.operationId, resourceId: input.resourceId,
    byteLength: totalBytes, path: input.path, role: 'primary', resources: Object.freeze(resources),
    decoder: Object.freeze({ resourceId: decoder.resourceId, byteLength: decoder.byteLength }) });
}

export function groupBlockBytes(source: GroupSourceDescriptor): number {
  return checkedBytes(source.byteLength + source.decoder.byteLength, 1);
}
export const groupTransferBytes = groupBlockBytes;
export function groupDescriptorBytes(source: GroupSourceDescriptor): number {
  return 20 + 4 * (source.resources.length - 1);
}
export function groupNativeStageBytes(source: GroupSourceDescriptor): number {
  return groupBlockBytes(source) + groupDescriptorBytes(source);
}
/** Covers bounded parser/rewriter preparation as well as hash/descriptor work.
 * Only groupNativeStageBytes is actual native payload coverage. */
export function groupStageBytes(source: GroupSourceDescriptor): number {
  const metadata = source.resources[0]!.byteLength;
  const pathUnits = source.resources.reduce((sum, item) => sum + item.path.length, 0);
  const preparation = 6 * metadata + 256 * Math.min(metadata, 65_536) +
    2 * Math.min(metadata, 4_194_304) + 32 * pathUnits + 8 * MiB;
  return checkedBytes(groupNativeStageBytes(source) + preparation, 1);
}
export function groupWorkerBytes(source: GroupSourceDescriptor): number {
  return checkedBytes(groupStageBytes(source) + Math.min(MAX_SOURCE_READ_BYTES, groupTransferBytes(source)), 1);
}
/** Native candidate budget includes its input grant and temporary decoded planes.
 * Provision that bounded peak once, with GPU workspace; staging owns its input. */
export function groupDecodeAdmissionBytes(source: GroupSourceDescriptor, loadedCount: number, degree: 0 | 1 | 2 | 3 = 0): number {
  if (!Number.isInteger(loadedCount) || loadedCount < 1 || loadedCount > 1_000_000)
    throw new Error('Invalid grouped preview count.');
  if (!shDegree(degree)) throw new Error('Invalid grouped SH admission degree.');
  assertSourceFitsDecodeBudget(groupNativeStageBytes(source), GROUP_NATIVE_BUDGET_BYTES);
  return checkedBytes(GROUP_NATIVE_BUDGET_BYTES - groupNativeStageBytes(source) +
    estimateSceneBytes(loadedCount, degree) - 144 * loadedCount, 1);
}

export function validateGroupSourceFingerprint(value: unknown, source: GroupSourceDescriptor,
  summary: NativeSummary, expectedDegree?: 0 | 1 | 2 | 3 | null): Readonly<SourceFingerprint> {
  if (expectedDegree !== undefined && expectedDegree !== null && !shDegree(expectedDegree))
    throw new Error('Invalid grouped expected SH degree.');
  const input = fields(value, ['scheme', 'assetDigest', 'resourceCount', 'totalBytes', 'sourceKindHint']);
  const finiteArray = (array: unknown, length: number): boolean => Array.isArray(array) && array.length === length &&
    Array.from({ length }, (_, index) => Number.isFinite(array[index])).every(Boolean);
  if (input.scheme !== SOURCE_FINGERPRINT_SCHEME || typeof input.assetDigest !== 'string' || !/^[0-9a-f]{64}$/.test(input.assetDigest) ||
      input.resourceCount !== source.resources.length || input.totalBytes !== source.byteLength ||
      typeof input.sourceKindHint !== 'string' || !input.sourceKindHint.length || input.sourceKindHint.length > 128 ||
      input.sourceKindHint !== summary.format || summary.ok !== true || summary.loaded !== true || summary.kind !== 0 ||
      !uint32(summary.count) || summary.count < 1 || summary.count > 1_000_000 ||
      !uint32(summary.sourceCount) || summary.sourceCount < summary.count || summary.sourceCount > 10_000_000 ||
      !shDegree(summary.shDegree) || expectedDegree === null && summary.shDegree === 0 ||
      expectedDegree !== undefined && expectedDegree !== null && summary.shDegree !== expectedDegree ||
      summary.pending !== false || !uint32(summary.revision) || !uint32(summary.contentRevision) ||
      !Number.isSafeInteger(summary.memoryBytes) || summary.memoryBytes < 0 ||
      summary.transaction !== false || summary.selectionDraft !== false || summary.sceneChanged !== false ||
      summary.canUndo !== false || summary.canRedo !== false || summary.selected !== 0 || !uint32(summary.visible) || summary.visible > summary.count ||
      summary.selectionMapId !== null || summary.pendingSelectionMapId !== null || summary.selectionMapBytes !== 0 ||
      !Array.isArray(summary.selectionMapRetainedIds) || summary.selectionMapRetainedIds.length !== 0 ||
      !finiteArray(summary.center, 3) || !Number.isFinite(summary.radius) || summary.radius < 0 ||
      typeof summary.yUp !== 'boolean' || !finiteArray(summary.camera, 11))
    throw new Error('The complete fingerprint does not match the decoded grouped source.');
  return Object.freeze({ scheme: 'splatview-source-v1', assetDigest: input.assetDigest,
    resourceCount: source.resources.length, totalBytes: source.byteLength, sourceKindHint: input.sourceKindHint });
}
