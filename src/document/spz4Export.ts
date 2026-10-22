import { AdmissionError, assertResourceCredit, checkedBytes, resourceLeaseCredit, type ResourceCredit, type ResourceLease } from './resources';
import { synchronousSourceHook } from './source';
import { isAdmittedSceneExportFormat, type AdmittedSceneExportFormat } from './exportFormats';

export type Spz4ExportPlan = Readonly<{ count: number; shDegree: number; outputCapacity: number; nativeWorkBytes: number }>;
export type SceneExportPlan = Readonly<Spz4ExportPlan & { format: AdmittedSceneExportFormat; scope: number }>;
export type SceneExportOptions = {
  signal: AbortSignal;
  current(): void;
  admitNative(bytes: number): ResourceLease;
  admitOutput(bytes: number): ResourceLease;
  onAccepted(): void;
};
export type Spz4ExportOptions = SceneExportOptions;

/** Native checked bounds use a 32-bit address space. Large text output remains
 * a valid plan; the actual scene ledger must admit it before any writer runs. */
export function validateSceneExportPlan(value: unknown): SceneExportPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'count,format,nativeWorkBytes,outputCapacity,scope,shDegree')
    throw new AdmissionError('Invalid scene export memory plan.');
  const { format, scope, count, shDegree, outputCapacity, nativeWorkBytes } = value as SceneExportPlan;
  if (!isAdmittedSceneExportFormat(format) || !Number.isInteger(scope) || scope < 0 || scope > 2 ||
      !Number.isSafeInteger(count) || count < 1 || count > 1_000_000 ||
      !Number.isInteger(shDegree) || shDegree < 0 || shDegree > 3 ||
      !Number.isSafeInteger(outputCapacity) || outputCapacity < 1 || outputCapacity > 0x7fff_ffff ||
      !Number.isSafeInteger(nativeWorkBytes) || nativeWorkBytes < outputCapacity || nativeWorkBytes > 0xffff_ffff)
    throw new AdmissionError('Invalid scene export memory plan.');
  checkedBytes(outputCapacity, 2);
  return Object.freeze({ format, scope, count, shDegree, outputCapacity, nativeWorkBytes });
}

/** Costs come from the verified native codec; never accept another scene's plan. */
export function validateSpz4ExportPlan(value: unknown): Spz4ExportPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'count,nativeWorkBytes,outputCapacity,shDegree')
    throw new AdmissionError('Invalid SPZ export memory plan.');
  const { count, shDegree, outputCapacity, nativeWorkBytes } = value as Spz4ExportPlan;
  if (!Number.isSafeInteger(count) || count < 1 || count > 1_000_000 ||
      !Number.isInteger(shDegree) || shDegree < 0 || shDegree > 3 ||
      !Number.isSafeInteger(outputCapacity) || outputCapacity < 32 || outputCapacity > 128 * 1024 * 1024 ||
      !Number.isSafeInteger(nativeWorkBytes) || nativeWorkBytes < outputCapacity || nativeWorkBytes > 256 * 1024 * 1024)
    throw new AdmissionError('Invalid SPZ export memory plan.');
  checkedBytes(outputCapacity, 2);
  return Object.freeze({ count, shDegree, outputCapacity, nativeWorkBytes });
}

/** Own both the transferred buffer and Blob copy until the caller hands off. */
export class OwnedExportBytes {
  private buffer?: ArrayBuffer;
  private blobOnly = false;
  private disposed = false;
  private readonly credit: ResourceCredit;
  private retained: number;
  constructor(bytes: ArrayBuffer, private readonly lease: ResourceLease) {
    this.credit = resourceLeaseCredit(lease);
    this.buffer = bytes;
    this.retained = checkedBytes(bytes.byteLength, 2);
    synchronousSourceHook(lease.resize(this.retained)); assertResourceCredit(this.credit, this.retained);
  }
  get bytes(): ArrayBuffer {
    if (!this.buffer) throw new Error('The export buffer was released.');
    return this.buffer;
  }
  // Call only after the buffer's local reference leaves the Blob construction scope.
  retainBlob(): void {
    if (!this.buffer || this.blobOnly) return;
    const length = this.buffer.byteLength;
    assertResourceCredit(this.credit, this.retained);
    synchronousSourceHook(this.lease.resize(length)); assertResourceCredit(this.credit, length);
    this.retained = length; this.buffer = undefined; this.blobOnly = true;
  }
  dispose(): void {
    if (this.disposed) return;
    assertResourceCredit(this.credit, this.retained);
    this.buffer = undefined; synchronousSourceHook(this.lease()); this.disposed = true;
  }
}
