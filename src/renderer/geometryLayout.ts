import { AdmissionError, checkedBytes } from '../document/resources';

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
export function geometryInteger(value: unknown, minimum: number, maximum: number, name: string): asserts value is number {
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
  geometryInteger(descriptor.vertexCount, 1, 0xffffffff, 'vertex count');
  geometryInteger(descriptor.triangleCount, descriptor.kind === 2 ? 1 : 0, Math.floor(0xffffffff / 3), 'triangle count');
  if (descriptor.kind === 1 && descriptor.triangleCount !== 0) throw new AdmissionError('Point clouds cannot contain triangle indices.');
  geometryInteger(descriptor.revision, 0, Number.MAX_SAFE_INTEGER, 'revision');
  geometryInteger(descriptor.contentRevision, 0, Number.MAX_SAFE_INTEGER, 'content revision');
  if (descriptor.vertexBytes !== checkedBytes(descriptor.vertexCount, 16) ||
      descriptor.indexBytes !== checkedBytes(descriptor.triangleCount, 12)) throw new AdmissionError('Invalid geometry channel byte count.');
  return { layoutVersion: 1, kind: descriptor.kind, vertexCount: descriptor.vertexCount, triangleCount: descriptor.triangleCount,
    vertexStride: 16, indexStride: 4, vertexBytes: descriptor.vertexBytes, indexBytes: descriptor.indexBytes,
    revision: descriptor.revision, contentRevision: descriptor.contentRevision };
}
export function sameGeometryDescriptor(a: GeometryDescriptor, b: GeometryDescriptor): boolean {
  return fields.every(field => a[field] === b[field]);
}
