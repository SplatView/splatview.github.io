import type { ResourceLease } from '../document/resources';

export const MAX_SOURCE_READ_BYTES = 1024 * 1024;

export type SourceReadDescriptor = Readonly<{
  operationId: string;
  resourceId: string;
  byteLength: number;
}>;
export type SourceReadRequest = Readonly<{
  operationId: string;
  resourceId: string;
  offset: number;
  length: number;
}>;
export type SourceReadOptions = {
  admit(bytes: number): ResourceLease;
  current(): void;
};
export type SourceReadChunk = Readonly<{
  /** Borrow only while this chunk owns the broker's sole read credit. */
  bytes: ArrayBuffer;
  /** Acknowledge successful synchronous consumption/transfer; advances once. */
  consume(): void;
  /** Abandon this chunk and cancel the resource without advancing. */
  release(): void;
}>;

type ReadOwner = {
  offset: number;
  length: number;
  phase: 'reading' | 'delivered' | 'consumed' | 'released';
  lease?: ResourceLease;
  bytes?: ArrayBuffer;
  settled: Promise<void>;
  settle(): void;
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}
function safeBytes(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function failure(reason: unknown, message: string): Error {
  return reason instanceof Error ? reason : new Error(message, { cause: reason });
}
function bufferLength(value: unknown): number {
  // The intrinsic getter rejects views, SharedArrayBuffer and objects that
  // merely imitate an ArrayBuffer's prototype/toStringTag. Detached buffers
  // report zero bytes and cannot satisfy this broker's nonempty read lengths.
  const bytes = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!.call(value) as number;
  const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
  if (resizable?.call(value)) throw new Error('A source read returned a resizable buffer.');
  return bytes;
}

/**
 * A main-thread, single-resource Blob read owner. No hashing or worker routing.
 *
 * read() retains a 2*length read/receive reservation until consume() returns,
 * including while the returned chunk awaits its caller. Call consume() only
 * after synchronous consumption or postMessage/transfer returns successfully.
 * If a receiver retains those bytes afterward, its own admission must cover
 * that lifetime; this broker does not acknowledge native worker consumption.
 *
 * Cancellation cannot abort Blob.arrayBuffer(). retire() joins that actual
 * operation, retains its reservation until it settles, and then forgets Blob.
 */
export class SourceReadBroker {
  private file?: Blob;
  private slice?: Blob['slice'];
  private readonly resource: SourceReadDescriptor;
  private readonly admit: (bytes: number) => ResourceLease;
  private readonly current: () => void;
  private active?: ReadOwner;
  private offset = 0;
  private cancelled?: Error;
  private retirement?: Promise<void>;

  constructor(file: Blob, descriptor: SourceReadDescriptor, options: SourceReadOptions) {
    if (!object(descriptor) || !object(options)) throw new Error('Invalid source read configuration.');
    // Read each potentially getter-backed input once before publishing state.
    const operationId: unknown = descriptor.operationId, resourceId: unknown = descriptor.resourceId;
    const byteLength: unknown = descriptor.byteLength, admit: unknown = options.admit, current: unknown = options.current;
    if (!identifier(operationId) || !identifier(resourceId) || !safeBytes(byteLength) ||
      typeof admit !== 'function' || typeof current !== 'function') throw new Error('Invalid source read configuration.');
    let size: unknown, slice: unknown;
    try {
      size = Object.getOwnPropertyDescriptor(Blob.prototype, 'size')!.get!.call(file);
      slice = file.slice;
    } catch { throw new Error('A source read requires a Blob.'); }
    if (!safeBytes(size) || size !== byteLength || typeof slice !== 'function')
      throw new Error('The source descriptor does not match its Blob.');
    this.resource = Object.freeze({ operationId, resourceId, byteLength });
    this.file = file; this.slice = slice as Blob['slice'];
    this.admit = bytes => (admit as SourceReadOptions['admit'])(bytes);
    this.current = () => { (current as SourceReadOptions['current'])(); };
  }

  get descriptor(): SourceReadDescriptor { return this.resource; }
  get pending(): boolean { return this.active !== undefined; }
  get consumedBytes(): number { return this.offset; }
  /** Complete bytes do not independently establish candidate eligibility. */
  get complete(): boolean { return !this.cancelled && !this.active && this.offset === this.resource.byteLength; }

  private assertCurrent(): void {
    if (this.cancelled) throw this.cancelled;
    if (!this.file || this.retirement) throw new Error('The source read owner is retired.');
    try { this.current(); }
    catch (reason) { this.cancel(reason); throw this.cancelled!; }
    // A current() callback may synchronously cancel/retire this owner.
    if (this.cancelled) throw this.cancelled;
    if (!this.file || this.retirement) throw new Error('The source read owner is retired.');
  }

  private finish(owner: ReadOwner, phase: 'consumed' | 'released'): void {
    if (owner.phase === 'consumed' || owner.phase === 'released') return;
    owner.phase = phase; owner.bytes = undefined;
    const lease = owner.lease; owner.lease = undefined;
    try { if (typeof lease === 'function') lease(); }
    finally {
      if (this.active === owner) this.active = undefined;
      owner.settle();
    }
  }

  async read(request: SourceReadRequest): Promise<SourceReadChunk> {
    this.assertCurrent();
    if (!object(request)) throw new Error('Invalid source read range.');
    const operationId: unknown = request.operationId, resourceId: unknown = request.resourceId;
    const offset: unknown = request.offset, length: unknown = request.length;
    if (operationId !== this.resource.operationId || resourceId !== this.resource.resourceId)
      throw new Error('The source read identity does not match.');
    if (!safeBytes(offset) || !safeBytes(length) || length === 0 || length > MAX_SOURCE_READ_BYTES ||
      offset !== this.offset || offset > this.resource.byteLength || length > this.resource.byteLength - offset)
      throw new Error('Invalid source read range.');
    if (this.active) throw new Error('A source read credit is already outstanding.');

    let settle!: () => void;
    const owner: ReadOwner = { offset, length, phase: 'reading',
      settled: new Promise<void>(resolve => { settle = resolve; }), settle: () => settle() };
    this.active = owner;
    try {
      const bytes = length * 2;
      owner.lease = this.admit(bytes);
      if (typeof owner.lease !== 'function' || owner.lease.bytes !== bytes)
        throw new Error('Invalid source read reservation.');
      this.assertCurrent();
      const part = this.slice!.call(this.file!, offset, offset + length);
      const read = part.arrayBuffer;
      this.assertCurrent();
      // Keep this owner in 'reading' through the actual unabortable promise.
      const reading: unknown = read.call(part);
      if (!object(reading) || typeof reading.then !== 'function') throw new Error('A source read did not return a promise.');
      const result: unknown = await (reading as unknown as PromiseLike<unknown>);
      this.assertCurrent();
      if (bufferLength(result) !== length) throw new Error('A source read returned the wrong byte length.');
      owner.bytes = result as ArrayBuffer; owner.phase = 'delivered';
      const broker = this;
      return Object.freeze({
        get bytes(): ArrayBuffer {
          broker.assertCurrent();
          if (broker.active !== owner || owner.phase !== 'delivered') throw new Error('The source read chunk is no longer owned.');
          return owner.bytes!;
        },
        consume(): void {
          broker.assertCurrent();
          if (broker.active !== owner || owner.phase !== 'delivered') throw new Error('The source read chunk is no longer owned.');
          broker.offset = owner.offset + owner.length;
          broker.finish(owner, 'consumed');
        },
        release(): void {
          // A stale release cannot cancel a successor range after consumption.
          if (broker.active !== owner || owner.phase !== 'delivered') return;
          broker.cancel(new DOMException('The source read chunk was abandoned.', 'AbortError'));
        },
      });
    } catch (reason) {
      const error = failure(reason, 'The source read failed.');
      this.cancel(error);
      this.finish(owner, 'released');
      throw error;
    }
  }

  cancel(reason?: unknown): void {
    this.cancelled ??= reason === undefined ? new DOMException('The source read was cancelled.', 'AbortError') :
      failure(reason, 'The source read was cancelled.');
    if (this.active?.phase === 'delivered') this.finish(this.active, 'released');
  }

  retire(): Promise<void> {
    if (this.retirement) return this.retirement;
    // Install the promise before cancel(), including reentrant lease release.
    let resolve!: () => void, reject!: (reason: unknown) => void;
    this.retirement = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    const settled = this.active?.settled ?? Promise.resolve();
    let cancellationFailure: unknown;
    try { this.cancel(); } catch (reason) { cancellationFailure = reason; }
    void settled.then(() => {
      this.file = undefined; this.slice = undefined;
      if (cancellationFailure !== undefined) reject(cancellationFailure); else resolve();
    });
    return this.retirement;
  }
}
