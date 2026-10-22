import { AdmissionError, checkedBytes } from './resources';
import type { NativeSummary } from './types';

export const GEOMETRY_LAYOUT_VERSION = 1;
export const GEOMETRY_CHUNK_BYTES = 1024 * 1024;
export type GeometryChannel = 'vertices' | 'indices';
export type GeometryDescriptor = {
  layoutVersion: 1; kind: 1 | 2; vertexCount: number; triangleCount: number;
  vertexStride: 16; indexStride: 4; vertexBytes: number; indexBytes: number;
  revision: number; contentRevision: number;
};
const fields = ['layoutVersion', 'kind', 'vertexCount', 'triangleCount', 'vertexStride', 'indexStride',
  'vertexBytes', 'indexBytes', 'revision', 'contentRevision'] as const;
function integer(value: unknown, minimum: number, maximum: number, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum)
    throw new AdmissionError(`Invalid geometry ${name}.`);
}
/** A detached, exact descriptor; caller mutation cannot change an admitted transfer. */
export function validateGeometryDescriptor(value: unknown): GeometryDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...fields].sort().join(','))
    throw new AdmissionError('Invalid geometry descriptor.');
  const descriptor = value as GeometryDescriptor;
  if (descriptor.layoutVersion !== GEOMETRY_LAYOUT_VERSION || descriptor.kind !== 1 && descriptor.kind !== 2 ||
      descriptor.vertexStride !== 16 || descriptor.indexStride !== 4) throw new AdmissionError('Unsupported geometry layout.');
  integer(descriptor.vertexCount, 1, 0xffffffff, 'vertex count');
  integer(descriptor.triangleCount, descriptor.kind === 2 ? 1 : 0, Math.floor(0xffffffff / 3), 'triangle count');
  if (descriptor.kind === 1 && descriptor.triangleCount !== 0) throw new AdmissionError('Point clouds cannot contain triangle indices.');
  integer(descriptor.revision, 0, Number.MAX_SAFE_INTEGER, 'revision');
  integer(descriptor.contentRevision, 0, Number.MAX_SAFE_INTEGER, 'content revision');
  if (descriptor.vertexBytes !== checkedBytes(descriptor.vertexCount, 16) ||
      descriptor.indexBytes !== checkedBytes(descriptor.triangleCount, 12)) throw new AdmissionError('Invalid geometry channel byte count.');
  return { layoutVersion: 1, kind: descriptor.kind, vertexCount: descriptor.vertexCount, triangleCount: descriptor.triangleCount,
    vertexStride: 16, indexStride: 4, vertexBytes: descriptor.vertexBytes, indexBytes: descriptor.indexBytes,
    revision: descriptor.revision, contentRevision: descriptor.contentRevision };
}
export function sameGeometryDescriptor(a: GeometryDescriptor, b: GeometryDescriptor): boolean {
  return fields.every(field => a[field] === b[field]);
}
/** Geometry never carries a fabricated Gaussian mask, history or editable draft. */
export function geometryDescriptor(summary: NativeSummary): GeometryDescriptor {
  const descriptor = validateGeometryDescriptor(summary.geometry);
  integer(summary.sourceCount, descriptor.vertexCount, Number.MAX_SAFE_INTEGER, 'source count');
  integer(summary.sourceFaces, descriptor.kind === 2 ? 1 : 0, Number.MAX_SAFE_INTEGER, 'source face count');
  if (summary.ok !== true || summary.loaded !== true || summary.kind !== descriptor.kind || summary.count !== descriptor.vertexCount ||
      summary.revision !== descriptor.revision || summary.contentRevision !== descriptor.contentRevision ||
      summary.selected !== 0 || summary.visible !== descriptor.vertexCount || summary.shDegree !== 0 ||
      summary.canUndo !== false || summary.canRedo !== false || summary.transaction !== false || summary.selectionDraft !== false ||
      summary.pending !== false || summary.sceneChanged !== false || typeof summary.sampledGeometry !== 'boolean' ||
      descriptor.kind === 1 && summary.sourceFaces !== 0 || summary.selectionMapId !== null || summary.pendingSelectionMapId !== null ||
      summary.selectionMapBytes !== 0 || !Array.isArray(summary.selectionMapRetainedIds) || summary.selectionMapRetainedIds.length !== 0)
    throw new AdmissionError('Invalid read-only geometry state.');
  return descriptor;
}
export function geometryChannelCount(descriptor: GeometryDescriptor, channel: GeometryChannel): number {
  return channel === 'vertices' ? descriptor.vertexCount : checkedBytes(descriptor.triangleCount, 3);
}
export function geometryChunkCount(descriptor: GeometryDescriptor, channel: GeometryChannel, first: number): number {
  const total = geometryChannelCount(descriptor, channel), stride = channel === 'vertices' ? descriptor.vertexStride : descriptor.indexStride;
  integer(first, 0, total, 'chunk offset');
  return Math.min(Math.floor(GEOMETRY_CHUNK_BYTES / stride), total - first);
}
export function validateGeometryChunk(descriptor: GeometryDescriptor, channel: unknown, first: unknown, count: unknown, bytes: unknown,
  nextVertex: number, nextIndex: number): asserts channel is GeometryChannel {
  if (channel !== 'vertices' && channel !== 'indices') throw new Error('Invalid geometry channel.');
  const next = channel === 'vertices' ? nextVertex : nextIndex;
  if (channel === 'indices' && nextVertex !== descriptor.vertexCount) throw new Error('Geometry indices arrived before the vertices.');
  const expected = geometryChunkCount(descriptor, channel, next), stride = channel === 'vertices' ? 16 : 4;
  if (!expected || first !== next || count !== expected || !(bytes instanceof ArrayBuffer) || bytes.byteLength !== checkedBytes(expected, stride))
    throw new Error('Invalid geometry chunk range.');
}
/** Native heap ranges must be checked before slice can silently truncate them. */
export function geometryHeapChunk(heap: Uint8Array<ArrayBuffer>, pointer: number, length: number, expected: number): ArrayBuffer {
  if (!Number.isSafeInteger(pointer) || pointer <= 0 || pointer % 4 || !Number.isSafeInteger(length) || length !== expected ||
      length <= 0 || length > GEOMETRY_CHUNK_BYTES || pointer > heap.byteLength || length > heap.byteLength - pointer)
    throw new Error('Invalid native geometry chunk.');
  return heap.slice(pointer, pointer + length).buffer;
}
