/** Internal worker API. Message senders never supply native pointers. */
export interface SourceHashExports {
  _sv_source_hash_create(): number;
  _sv_source_hash_delete(handle: number): number;
  _sv_source_hash_begin(handle: number, expectedBytes: number): number;
  _sv_source_hash_update(handle: number, offset: number, pointer: number, length: number): number;
  _sv_source_hash_finish(handle: number): number;
  _sv_source_hash_digest(handle: number, output: number, length: number): number;
  _sv_source_hash_reset(handle: number): number;
  _sv_source_hash_state(handle: number): number;
  _sv_source_hash_expected_bytes(handle: number): number;
  _sv_source_hash_consumed_bytes(handle: number): number;
}
export interface SourceHashModule extends SourceHashExports {
  HEAPU8: Uint8Array<ArrayBuffer>;
  _malloc(bytes: number): number;
  _free(pointer: number): void;
}
export const SOURCE_HASH_MAX_CHUNK = 1024 * 1024;
const exports = ['create', 'delete', 'begin', 'update', 'finish', 'digest', 'reset',
  'state', 'expected_bytes', 'consumed_bytes'] as const;

export function assertSourceHashExports(module: SourceHashExports): void {
  if (exports.some(name => typeof module[`_sv_source_hash_${name}`] !== 'function'))
    throw new Error('The application core does not support source identity. Reload SplatView.');
}
function uint32(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff)
    throw new RangeError(`${label} must be an unsigned 32-bit integer.`);
  return value;
}
function byteCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${label} must be a nonnegative safe byte count.`);
  return value;
}
function status(value: number, operation: string): void {
  if (value !== 0) throw new Error(`Source hashing ${operation} failed (${value}).`);
}
export function assertSourceHeapRange(module: Pick<SourceHashModule, 'HEAPU8'>, pointer: number, length: number): void {
  uint32(pointer, 'Source pointer'); uint32(length, 'Source length');
  const size = module.HEAPU8.byteLength;
  if ((length > 0 && pointer === 0) || pointer > size || length > size - pointer)
    throw new RangeError('The source range is outside native memory.');
}

/** One fixed native owner with one privately owned 32-byte digest output. */
export class NativeSourceHash {
  private handle: number;
  private output = 0;
  constructor(private readonly module: SourceHashModule) {
    assertSourceHashExports(module);
    const raw = module._sv_source_hash_create();
    // Raw wasm i32 returns are signed; validate before zero extension.
    if (!Number.isInteger(raw) || raw < -0x8000_0000 || raw > 0xffff_ffff)
      throw new Error('The native source hash returned an invalid handle.');
    this.handle = raw >>> 0;
    if (!this.handle) throw new Error('The native source hash is already active or exhausted.');
    try {
      const pointer = module._malloc(32);
      assertSourceHeapRange(module, pointer, 32); this.output = pointer;
    } catch (error) {
      try { this.dispose(); }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Source hash initialization and cleanup failed.');
      }
      throw error;
    }
  }
  private current(): number {
    if (!this.handle) throw new Error('The source hash was closed.');
    return this.handle;
  }
  begin(expectedBytes: number): void {
    const handle = this.current(); byteCount(expectedBytes, 'Expected source bytes');
    status(this.module._sv_source_hash_begin(handle, expectedBytes), 'begin');
  }
  update(offset: number, pointer: number, length: number): void {
    const handle = this.current(); byteCount(offset, 'Source offset');
    uint32(length, 'Source length');
    if (length > SOURCE_HASH_MAX_CHUNK) throw new RangeError('A source hash range exceeds 1 MiB.');
    assertSourceHeapRange(this.module, pointer, length);
    status(this.module._sv_source_hash_update(handle, offset, pointer, length), 'update');
  }
  finish(): Uint8Array<ArrayBuffer> {
    const handle = this.current();
    assertSourceHeapRange(this.module, this.output, 32);
    status(this.module._sv_source_hash_finish(handle), 'finish');
    status(this.module._sv_source_hash_digest(handle, this.output, 32), 'digest');
    // Refresh the heap view after native calls; never expose native storage.
    assertSourceHeapRange(this.module, this.output, 32);
    return this.module.HEAPU8.slice(this.output, this.output + 32);
  }
  reset(): void { status(this.module._sv_source_hash_reset(this.current()), 'reset'); }
  get consumedBytes(): number {
    return byteCount(this.module._sv_source_hash_consumed_bytes(this.current()), 'Consumed source bytes');
  }
  dispose(): void {
    const handle = this.handle; this.handle = 0;
    const output = this.output; this.output = 0;
    // Delete cannot borrow the output allocation; release both even on refusal.
    let deletionFailed = false, deletionFailure: unknown;
    try { if (handle) status(this.module._sv_source_hash_delete(handle), 'delete'); }
    catch (error) { deletionFailed = true; deletionFailure = error; }
    try { if (output) this.module._free(output); }
    catch (error) {
      if (deletionFailed) throw new AggregateError([deletionFailure, error], 'Source hash cleanup failed.');
      throw error;
    }
    if (deletionFailed) throw deletionFailure;
  }
}
