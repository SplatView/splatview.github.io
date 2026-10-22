import type { ResourceLease } from '../document/resources';
import { prepareCanonicalSource, type SourceFingerprintSummary } from '../io/fingerprint';
import { assertSourceHeapRange, NativeSourceHash, SOURCE_HASH_MAX_CHUNK, type SourceHashModule } from './sourceHash';

/** Structural owned-read contract; routing and Blob ownership belong to callers. */
export interface SourceInputChunk {
  readonly bytes: ArrayBuffer;
  consume(): void;
  release(): void;
}
export interface SourceInputOptions {
  read(offset: number, length: number): PromiseLike<SourceInputChunk>;
  admit(bytes: number): ResourceLease;
  /** Throws when this candidate may no longer consume or publish work. */
  current(): void;
}
export interface StagedSourceInput {
  /** Borrow only until dispose(), including throughout synchronous decoding. */
  readonly pointer: number;
  readonly byteLength: number;
  readonly canonicalByteLength: number;
  readonly summary: Readonly<SourceFingerprintSummary>;
  /** Independently owned final canonical digest; not a published source key. */
  readonly assetDigest: Uint8Array<ArrayBuffer>;
  /** Retaining the digest after disposal requires the caller's own admission. */
  dispose(): void;
}

const arrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const arrayBufferResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
// Native digest output plus the resource digest and its private canonical copy.
const HASH_WORK_BYTES = 3 * 32;

function exactBuffer(value: unknown, expected: number): ArrayBuffer {
  if (arrayBufferLength.call(value) !== expected || arrayBufferResizable?.call(value))
    throw new Error('A source input read returned an invalid byte buffer.');
  // Constructing a view also rejects a detached empty ArrayBuffer.
  new Uint8Array(value as ArrayBuffer);
  return value as ArrayBuffer;
}
function synchronous(value: unknown): void {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    const then = (value as { then?: unknown }).then;
    if (typeof then === 'function') {
      void new Promise<unknown>((resolve, reject) => { Reflect.apply(then, value, [resolve, reject]); })
        .catch(() => undefined);
      throw new TypeError('Source input hooks must complete synchronously.');
    }
  }
}
function allocation(module: SourceHashModule, bytes: number, own: (pointer: number) => void): number {
  if (bytes === 0) return 0;
  const pointer = module._malloc(bytes);
  if (!Number.isInteger(pointer) || pointer <= 0 || pointer > 0xffff_ffff)
    throw new Error('There is not enough native memory to stage this source.');
  // A malformed return is not an owned allocation and must never reach free().
  assertSourceHeapRange(module, pointer, bytes);
  own(pointer);
  return pointer;
}
function throwFailures(errors: unknown[]): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Source input cleanup failed.');
}

/**
 * Stage one candidate's input once. Each owned read is copied into the final
 * decoder allocation, then that exact native range is hashed before consume().
 * No scene is opened or changed here. The caller completes the fingerprint with
 * the actual decoded kind and retains this owner through the decoder borrow.
 *
 * read() owns admission for its read/receive buffers. Our admissions cover the
 * final native input + retained 32-byte asset digest, native hash output, private
 * resource digests, and canonical scratch/emission overlap. Fixed native hash
 * state belongs to the module baseline. An outstanding read is always joined:
 * current() cancellation never releases these allocations before it settles.
 */
export async function stageSingleSourceInput(
  module: SourceHashModule,
  byteLength: number,
  options: SourceInputOptions,
): Promise<StagedSourceInput> {
  if (!Number.isInteger(byteLength) || byteLength < 0 || byteLength > 0xffff_ffff)
    throw new RangeError('Source input bytes must fit the native uint32 decoder range.');
  if (!options || typeof options !== 'object') throw new TypeError('Source input options are required.');
  const { read, admit, current } = options;
  if (typeof read !== 'function' || typeof admit !== 'function' || typeof current !== 'function')
    throw new TypeError('Source input read, admission and current hooks are required.');
  const check = () => { synchronous(Reflect.apply(current, options, [])); };
  let pointer = 0, scratch = 0, hash: NativeSourceHash | undefined;
  let inputLease: ResourceLease | undefined;
  const workLeases: ResourceLease[] = [];
  let disposed = false;
  function reserve(bytes: number, retained: boolean): void {
    const lease = Reflect.apply(admit, options, [bytes]) as ResourceLease;
    if (typeof lease === 'function') {
      if (retained) inputLease = lease; else workLeases.push(lease);
    }
    // Observe a rejected async admission without treating its promise as a lease.
    synchronous(lease);
    if (typeof lease !== 'function') throw new Error('Invalid source input reservation.');
    if (lease.bytes !== bytes) throw new Error('Invalid source input reservation.');
    check();
  }
  function releaseWork(): unknown[] {
    const errors: unknown[] = [];
    const owner = hash; hash = undefined;
    try { owner?.dispose(); } catch (error) { errors.push(error); }
    const ownedScratch = scratch; scratch = 0;
    try { if (ownedScratch) module._free(ownedScratch); } catch (error) { errors.push(error); }
    for (const lease of workLeases.splice(0).reverse()) {
      try { synchronous(lease()); } catch (error) { errors.push(error); }
    }
    return errors;
  }
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    const errors = releaseWork(), ownedPointer = pointer, lease = inputLease;
    pointer = 0; inputLease = undefined;
    try { if (ownedPointer) module._free(ownedPointer); } catch (error) { errors.push(error); }
    try { if (lease) synchronous(lease()); } catch (error) { errors.push(error); }
    throwFailures(errors);
  }
  function canonicalHash(resourceDigest: Uint8Array): {
    assetDigest: Uint8Array<ArrayBuffer>;
    canonicalByteLength: number;
    summary: Readonly<SourceFingerprintSummary>;
  } {
    check();
    const prepared = prepareCanonicalSource({ kind: 'single', resources: [{
      path: '', role: 'primary', byteLength, sha256: resourceDigest,
    }] });
    const capacity = Math.min(SOURCE_HASH_MAX_CHUNK, prepared.canonicalByteLength);
    // Native scratch plus two independently owned emitter buffers at flush.
    reserve(3 * capacity, false);
    allocation(module, capacity, value => { scratch = value; });
    check();
    hash!.reset();
    hash!.begin(prepared.canonicalByteLength);
    let offset = 0;
    prepared.write(segment => {
      check();
      assertSourceHeapRange(module, scratch, segment.byteLength);
      module.HEAPU8.set(segment, scratch);
      hash!.update(offset, scratch, segment.byteLength);
      offset += segment.byteLength;
      check();
    }, capacity);
    if (offset !== prepared.canonicalByteLength) throw new Error('Incomplete canonical source input.');
    const assetDigest = hash!.finish();
    check();
    // Only scalars and the final owned digest escape this private descriptor.
    return { assetDigest, canonicalByteLength: prepared.canonicalByteLength,
      summary: Object.freeze({ scheme: prepared.scheme, resourceCount: prepared.resourceCount,
        totalBytes: prepared.totalBytes }) };
  }
  try {
    check();
    reserve(byteLength + 32, true);
    allocation(module, byteLength, value => { pointer = value; });
    check();
    reserve(HASH_WORK_BYTES, false);
    hash = new NativeSourceHash(module);
    check();
    hash.begin(byteLength);
    for (let offset = 0; offset < byteLength;) {
      check();
      const length = Math.min(SOURCE_HASH_MAX_CHUNK, byteLength - offset);
      // No cancellation race/early return: this actual owned read must settle.
      const chunk = await Reflect.apply(read, options, [offset, length]) as SourceInputChunk;
      let release: (() => void) | undefined, consumed = false;
      let failure: unknown, failed = false;
      try {
        if (!chunk || typeof chunk !== 'object') throw new Error('Invalid source input chunk.');
        release = chunk.release;
        if (typeof release !== 'function') throw new Error('Invalid source input release hook.');
        const consume = chunk.consume;
        if (typeof consume !== 'function') throw new Error('Invalid source input consume hook.');
        check();
        const bytes = exactBuffer(chunk.bytes, length);
        check();
        // Every allocation/hook/native call may replace the module heap view.
        assertSourceHeapRange(module, pointer + offset, length);
        module.HEAPU8.set(new Uint8Array(bytes), pointer + offset);
        hash.update(offset, pointer + offset, length);
        check();
        synchronous(Reflect.apply(consume, chunk, []));
        consumed = true;
        offset += length;
        check();
      } catch (error) { failure = error; failed = true; }
      if (!consumed && release) {
        try { synchronous(Reflect.apply(release, chunk, [])); }
        catch (error) {
          if (!failed) failure = error;
          else failure = new AggregateError([failure, error], 'Source input read and release failed.');
          failed = true;
        }
      }
      if (failed) throw failure;
    }
    check();
    const { assetDigest, canonicalByteLength, summary } = canonicalHash(hash.finish());
    throwFailures(releaseWork());
    check();
    return Object.freeze({
      get pointer(): number {
        if (disposed) throw new Error('The staged source input was disposed.');
        check();
        assertSourceHeapRange(module, pointer, byteLength);
        return pointer;
      },
      byteLength, canonicalByteLength, summary, assetDigest, dispose,
    });
  } catch (error) {
    try { dispose(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Source input staging and cleanup failed.'); }
    throw error;
  }
}
