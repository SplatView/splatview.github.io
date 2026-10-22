import { SOURCE_FINGERPRINT_SCHEME, type SourceFingerprint } from '../io/fingerprint';
import { MAX_SOURCE_READ_BYTES } from '../io/readBroker';
import { checkedBytes, type ResourceLease } from './resources';
import type { NativeSummary } from './types';
import type { GroupSourceDescriptor } from './sourceGroup';

export type SingleSourceDescriptor = Readonly<{
  kind: 'single'; operationId: string; resourceId: string; byteLength: number;
  path: ''; role: 'primary';
}>;
export type SourceDescriptor = SingleSourceDescriptor | GroupSourceDescriptor;
export type SourceReadDescriptor = Readonly<{ operationId: string; resourceId: string; byteLength: number }>;
export type SourceRange = Readonly<{
  operationId: string; resourceId: string; rangeId: number; offset: number; length: number;
}>;
export type SourceLoadResult = Readonly<{ summary: NativeSummary; fingerprint: Readonly<SourceFingerprint> }>;
export type SourceLoadOptions = { admit(bytes: number): ResourceLease; current(): void; nativeLease?: ResourceLease };

export function synchronousSourceHook(value: unknown): void {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    const then = (value as { then?: unknown }).then;
    if (typeof then === 'function') {
      void new Promise<unknown>((resolve, reject) => { Reflect.apply(then, value, [resolve, reject]); }).catch(() => undefined);
      throw new TypeError('Source ownership hooks must complete synchronously.');
    }
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}
function uint32(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
}
function finiteArray(value: unknown, length: number): boolean {
  if (!Array.isArray(value) || value.length !== length) return false;
  for (let index = 0; index < length; index++) if (!Number.isFinite(value[index])) return false;
  return true;
}
export function validateSourceDescriptor(value: unknown): SingleSourceDescriptor {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'byteLength,kind,operationId,path,resourceId,role')
    throw new Error('Invalid source descriptor.');
  const { kind, operationId, resourceId, byteLength, path, role } = value;
  if (kind !== 'single' || !identifier(operationId) || !identifier(resourceId) || !uint32(byteLength) || path !== '' || role !== 'primary')
    throw new Error('Invalid source descriptor.');
  return Object.freeze({ kind, operationId, resourceId, byteLength, path, role });
}
/** Final input plus bounded hash/canonical/descriptor/output work, not decoder memory. */
export function sourceStageBytes(byteLength: number): number {
  if (!uint32(byteLength)) throw new Error('Invalid source input byte length.');
  return checkedBytes(byteLength + 64 * 1024, 1);
}
/** Worker-local limit; the host admits the receive credit separately before I/O. */
export function sourceWorkerBytes(byteLength: number): number {
  return sourceStageBytes(byteLength) + Math.min(byteLength, MAX_SOURCE_READ_BYTES);
}
export function validateSourceRange(value: unknown, descriptor: SourceReadDescriptor, rangeId: number, offset: number): SourceRange {
  if (!object(value)) throw new Error('Invalid source range.');
  const { operationId, resourceId, rangeId: actualId, offset: actualOffset, length } = value;
  const expected = Math.min(MAX_SOURCE_READ_BYTES, descriptor.byteLength - offset);
  if (operationId !== descriptor.operationId || resourceId !== descriptor.resourceId ||
      !uint32(actualId) || actualId !== rangeId || !uint32(actualOffset) || actualOffset !== offset ||
      !uint32(length) || length === 0 || length !== expected)
    throw new Error('Invalid source range identity or credit.');
  return Object.freeze({ operationId, resourceId, rangeId: actualId, offset: actualOffset, length });
}
export function validateSourceFingerprint(value: unknown, descriptor: SourceDescriptor, summary: NativeSummary): Readonly<SourceFingerprint> {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'assetDigest,resourceCount,scheme,sourceKindHint,totalBytes')
    throw new Error('Invalid complete source fingerprint.');
  const { scheme, assetDigest, resourceCount, totalBytes, sourceKindHint } = value;
  if (scheme !== SOURCE_FINGERPRINT_SCHEME || typeof assetDigest !== 'string' || !/^[0-9a-f]{64}$/.test(assetDigest) ||
      resourceCount !== (descriptor.kind === 'single' ? 1 : descriptor.resources.length) || totalBytes !== descriptor.byteLength || typeof sourceKindHint !== 'string' ||
      sourceKindHint.length === 0 || sourceKindHint.length > 128 || sourceKindHint !== summary?.format ||
      summary?.ok !== true || summary.loaded !== true || ![0, 1, 2].includes(summary.kind) ||
      !uint32(summary.count) || !uint32(summary.sourceCount) || summary.sourceCount < summary.count ||
      !uint32(summary.shDegree) || summary.shDegree > 3 || summary.pending !== false ||
      !uint32(summary.revision) || !uint32(summary.contentRevision) ||
      !Number.isSafeInteger(summary.memoryBytes) || summary.memoryBytes < 0 ||
      summary.transaction !== false || summary.selectionDraft !== false || summary.sceneChanged !== false ||
      summary.canUndo !== false || summary.canRedo !== false || summary.selected !== 0 || !uint32(summary.visible) || summary.visible > summary.count ||
      summary.selectionMapId !== null || summary.pendingSelectionMapId !== null || summary.selectionMapBytes !== 0 ||
      !Array.isArray(summary.selectionMapRetainedIds) || summary.selectionMapRetainedIds.length !== 0 ||
      !finiteArray(summary.center, 3) ||
      !Number.isFinite(summary.radius) || summary.radius < 0 || typeof summary.yUp !== 'boolean' ||
      !finiteArray(summary.camera, 11) || descriptor.kind === 'group' &&
      (summary.kind !== 0 || summary.shDegree !== 0 || summary.sourceCount < 1 || summary.sourceCount > 10_000_000 ||
       summary.count < 1 || summary.count > 1_000_000))
    throw new Error('The complete fingerprint does not match the decoded source.');
  return Object.freeze({ scheme, assetDigest, resourceCount, totalBytes, sourceKindHint });
}
