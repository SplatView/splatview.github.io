import assert from 'node:assert/strict';
import { createHash, type Hash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ResourceLedger, type ResourceLease } from '../src/document/resources';
import { finishSourceFingerprint } from '../src/io/fingerprint';
import { stageSingleSourceInput, type SourceInputChunk, type SourceInputOptions } from '../src/workers/sourceInput';
import { SOURCE_HASH_MAX_CHUNK, type SourceHashModule } from '../src/workers/sourceHash';
import type { ModuleFactory, WasmModule } from '../src/workers/wasm';
import type { NativeSummary } from '../src/document/types';
import { gaussianPly } from './fixtures/gaussians';

/** Native API double whose digest implementation is Node's independent SHA256. */
class HashModule implements SourceHashModule {
  HEAPU8 = new Uint8Array(new ArrayBuffer(128));
  readonly allocations = new Map<number, number>();
  readonly mallocSizes: number[] = [];
  readonly freed: number[] = [];
  readonly updates: { pass: number; offset: number; pointer: number; bytes: Uint8Array }[] = [];
  readonly digests: Buffer[] = [];
  failAllocation = 0;
  invalidAllocation = 0;
  failStatus = '';
  growOnUpdate = false;
  createCount = 0;
  deleteCount = 0;
  private next = 64;
  private handle = 0;
  private state = 0;
  private expected = 0;
  private consumed = 0;
  private hashing?: Hash;
  private digest?: Buffer;
  private pass = -1;

  private grow(length: number): void {
    if (length <= this.HEAPU8.byteLength) return;
    const heap = new Uint8Array(new ArrayBuffer(Math.max(length, 2 * this.HEAPU8.byteLength)));
    heap.set(this.HEAPU8); this.HEAPU8 = heap;
  }
  _malloc(bytes: number): number {
    this.mallocSizes.push(bytes);
    if (this.failAllocation === this.mallocSizes.length) return 0;
    if (this.invalidAllocation === this.mallocSizes.length) return this.HEAPU8.byteLength + 8;
    const pointer = this.next; this.next += Math.ceil(bytes / 8) * 8 + 8;
    this.allocations.set(pointer, bytes);
    this.grow(this.next);
    return pointer;
  }
  _free(pointer: number): void {
    if (!this.allocations.delete(pointer)) throw new Error('Duplicate or foreign native free.');
    this.freed.push(pointer);
  }
  _sv_source_hash_create(): number { this.createCount++; return this.failStatus === 'create' ? 0 : (this.handle = 1); }
  _sv_source_hash_delete(handle: number): number {
    this.deleteCount++; if (handle !== this.handle) return 9;
    this.handle = 0; this.hashing = undefined; return this.failStatus === 'delete' ? 1 : 0;
  }
  _sv_source_hash_begin(handle: number, expected: number): number {
    if (this.failStatus === 'begin' || handle !== this.handle) return 1;
    this.state = 1; this.expected = expected; this.consumed = 0;
    this.hashing = createHash('sha256'); this.digest = undefined; this.pass++; return 0;
  }
  _sv_source_hash_update(handle: number, offset: number, pointer: number, length: number): number {
    if (this.failStatus === 'update' || handle !== this.handle || this.state !== 1 ||
        offset !== this.consumed || length > SOURCE_HASH_MAX_CHUNK || length > this.expected - offset) return 1;
    if (this.growOnUpdate) this.grow(this.HEAPU8.byteLength + 1);
    const bytes = this.HEAPU8.slice(pointer, pointer + length);
    this.updates.push({ pass: this.pass, offset, pointer, bytes });
    this.hashing!.update(bytes); this.consumed += length; return 0;
  }
  _sv_source_hash_finish(handle: number): number {
    if (this.failStatus === 'finish' || handle !== this.handle || this.state !== 1 || this.consumed !== this.expected) return 1;
    this.digest = this.hashing!.digest(); this.digests.push(this.digest); this.state = 2; return 0;
  }
  _sv_source_hash_digest(handle: number, output: number, length: number): number {
    if (this.failStatus === 'digest' || handle !== this.handle || this.state !== 2 || length !== 32) return 1;
    this.HEAPU8.set(this.digest!, output); return 0;
  }
  _sv_source_hash_reset(handle: number): number {
    if (this.failStatus === 'reset' || handle !== this.handle) return 1;
    this.state = 0; this.expected = this.consumed = 0; return 0;
  }
  _sv_source_hash_state(handle: number): number { return handle === this.handle ? this.state : -9; }
  _sv_source_hash_expected_bytes(handle: number): number { return handle === this.handle ? this.expected : -9; }
  _sv_source_hash_consumed_bytes(handle: number): number { return handle === this.handle ? this.consumed : -9; }
}

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function canonical(bytes: Uint8Array): Buffer {
  // Independently encode the single-resource v1 vector, without the product writer.
  const header = Buffer.from('53706c617456696577536f757263650076310000000000010100000000', 'hex');
  const length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(bytes.byteLength));
  return Buffer.concat([header, length, createHash('sha256').update(bytes).digest()]);
}
function fixture(data = new Uint8Array([97, 98, 99])) {
  const module = new HashModule(), ledger = new ResourceLedger(data.byteLength + 3 * SOURCE_HASH_MAX_CHUNK);
  const reads: [number, number][] = [], admissions: number[] = [], released: number[] = [];
  let consumeCount = 0, abandonCount = 0, current = true;
  let consumeHook: ((bytes: ArrayBuffer) => unknown) | undefined;
  let bufferHook: ((bytes: ArrayBuffer) => unknown) | undefined;
  const options: SourceInputOptions = {
    current() { if (!current) throw new DOMException('Candidate replaced.', 'AbortError'); },
    admit(bytes) {
      admissions.push(bytes); const lease = ledger.reserve('source', bytes);
      const tracked = (() => { released.push(bytes); lease(); }) as ResourceLease;
      Object.defineProperty(tracked, 'bytes', { get: () => lease.bytes });
      tracked.resize = next => lease.resize(next); return tracked;
    },
    async read(offset, length) {
      reads.push([offset, length]);
      const lease = ledger.reserve('source', 2 * length);
      const owned = data.slice(offset, offset + length).buffer;
      let pending = true;
      return {
        get bytes() { return (bufferHook ? bufferHook(owned) : owned) as ArrayBuffer; },
        consume() {
          const result = consumeHook?.(owned);
          if (result !== undefined) return result as never;
          if (!pending) throw new Error('Read already consumed.');
          pending = false; consumeCount++; lease();
        },
        release() { if (pending) { pending = false; abandonCount++; lease(); } },
      };
    },
  };
  return { module, ledger, reads, admissions, released, options,
    cancel() { current = false; },
    consume(hook: (bytes: ArrayBuffer) => unknown) { consumeHook = hook; },
    buffer(hook: (bytes: ArrayBuffer) => unknown) { bufferHook = hook; },
    counts: () => ({ consumed: consumeCount, abandoned: abandonCount }) };
}
function clean(input: ReturnType<typeof fixture>): void {
  expect(input.module.allocations.size).toBe(0);
  expect(new Set(input.module.freed).size).toBe(input.module.freed.length);
  expect(input.ledger.usage.bytes).toBe(0);
}

describe('candidate-owned staged single source input', () => {
  it.each([0, 1, 3, SOURCE_HASH_MAX_CHUNK, SOURCE_HASH_MAX_CHUNK + 7, 2 * SOURCE_HASH_MAX_CHUNK + 1])
  ('stages %i bytes once and hashes independent exact canonical bytes', async length => {
    const data = Uint8Array.from({ length }, (_, index) => (index * 37 + 11) & 255), input = fixture(data);
    const staged = await stageSingleSourceInput(input.module, length, input.options);
    // Node compares Buffer contents as exact bytes without per-element matcher work.
    assert.deepEqual(Buffer.from(input.module.HEAPU8.subarray(staged.pointer, staged.pointer + length)), Buffer.from(data));
    expect(input.module.digests[0]).toEqual(createHash('sha256').update(data).digest());
    expect(Buffer.from(staged.assetDigest)).toEqual(createHash('sha256').update(canonical(data)).digest());
    expect(Buffer.concat(input.module.updates.filter(call => call.pass === 1).map(call => call.bytes))).toEqual(canonical(data));
    expect(staged.canonicalByteLength).toBe(canonical(data).byteLength);
    expect(staged.summary).toEqual({ scheme: 'splatview-source-v1', resourceCount: 1, totalBytes: length });
    expect(Object.isFrozen(staged)).toBe(true); expect(Object.isFrozen(staged.summary)).toBe(true);
    expect(input.reads).toEqual(Array.from({ length: Math.ceil(length / SOURCE_HASH_MAX_CHUNK) }, (_, index) =>
      [index * SOURCE_HASH_MAX_CHUNK, Math.min(SOURCE_HASH_MAX_CHUNK, length - index * SOURCE_HASH_MAX_CHUNK)]));
    for (const call of input.module.updates.filter(call => call.pass === 0)) {
      expect(call.pointer).toBe(staged.pointer + call.offset);
      assert.deepEqual(Buffer.from(call.bytes), Buffer.from(data.subarray(call.offset, call.offset + call.bytes.byteLength)));
    }
    expect(input.module.createCount).toBe(1); expect(input.module.deleteCount).toBe(1);
    expect(input.counts()).toEqual({ consumed: input.reads.length, abandoned: 0 });
    expect(input.ledger.usage.bytes).toBe(length + 32);
    expect(input.module.allocations.size).toBe(length === 0 ? 0 : 1);
    staged.dispose(); staged.dispose(); clean(input);
    expect(() => staged.pointer).toThrow(/disposed/);
  });

  it('matches the literal abc canonical digest and requires an actual decoded kind to finish', async () => {
    const input = fixture(), staged = await stageSingleSourceInput(input.module, 3, input.options);
    expect(Buffer.from(staged.assetDigest).toString('hex')).toBe('b8e58e5d08b008eba9c2de43d1dad740d9c7ba7349748bf0e8164175f2023afe');
    expect(Object.keys(staged).sort()).toEqual(['assetDigest', 'byteLength', 'canonicalByteLength', 'dispose', 'pointer', 'summary']);
    const key = finishSourceFingerprint(staged.summary, staged.assetDigest, 'ply');
    expect(key.sourceKindHint).toBe('ply'); expect(key.totalBytes).toBe(3);
    const digest = staged.assetDigest.slice(); staged.dispose();
    // The caller owns this copy and admits any retention beyond staging lifetime.
    input.module.HEAPU8.fill(0); expect(staged.assetDigest).toEqual(digest); clean(input);
  });

  it('copies and hashes before acknowledgement can mutate or detach the read buffer', async () => {
    const input = fixture(), original = new Uint8Array([97, 98, 99]);
    input.consume(bytes => { new Uint8Array(bytes).fill(0); structuredClone(bytes, { transfer: [bytes] }); });
    const staged = await stageSingleSourceInput(input.module, 3, input.options);
    expect(input.module.HEAPU8.slice(staged.pointer, staged.pointer + 3)).toEqual(original);
    expect(Buffer.from(staged.assetDigest)).toEqual(createHash('sha256').update(canonical(original)).digest());
    staged.dispose(); clean(input);
  });

  it('refreshes heap views after allocation and native update growth without changing earlier scene bytes', async () => {
    const input = fixture(); input.module.growOnUpdate = true;
    input.module.HEAPU8.fill(213, 0, 32);
    const staged = await stageSingleSourceInput(input.module, 3, input.options);
    expect(input.module.HEAPU8.slice(staged.pointer, staged.pointer + 3)).toEqual(new Uint8Array([97, 98, 99]));
    expect([...input.module.HEAPU8.slice(0, 32)]).toEqual(new Array(32).fill(213));
    expect(Buffer.from(staged.assetDigest)).toEqual(createHash('sha256').update(canonical(new Uint8Array([97, 98, 99]))).digest());
    staged.dispose(); clean(input);
  });

  it('joins a held cancelled read before releasing native input, hash owner or reservations', async () => {
    const input = fixture(), held = deferred<SourceInputChunk>(), read = input.options.read;
    let heldChunk!: SourceInputChunk;
    input.options.read = async (offset, length) => { heldChunk = await read(offset, length); return held.promise; };
    const pending = stageSingleSourceInput(input.module, 3, input.options);
    let settled = false; void pending.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(input.reads).toEqual([[0, 3]]); input.cancel();
    await Promise.resolve(); await Promise.resolve();
    expect(settled).toBe(false); expect(input.module.deleteCount).toBe(0);
    expect(input.module.allocations.size).toBe(2); expect(input.ledger.usage.bytes).toBe(3 + 32 + 96 + 6);
    held.resolve(heldChunk);
    await expect(pending).rejects.toThrow(/Candidate replaced/);
    expect(input.counts()).toEqual({ consumed: 0, abandoned: 1 }); clean(input);
  });

  it('joins a held read rejection after cancellation and never asks for a successor', async () => {
    const input = fixture(new Uint8Array(SOURCE_HASH_MAX_CHUNK + 1)), held = deferred<SourceInputChunk>();
    input.options.read = () => held.promise;
    const pending = stageSingleSourceInput(input.module, SOURCE_HASH_MAX_CHUNK + 1, input.options);
    input.cancel(); expect(input.module.allocations.size).toBe(2); expect(input.module.deleteCount).toBe(0);
    held.reject(new Error('Read transfer failed.'));
    await expect(pending).rejects.toThrow(/Read transfer failed/); clean(input);
  });

  const malformedBuffers: [string, (bytes: ArrayBuffer) => unknown][] = [
    ['short', () => new ArrayBuffer(2)], ['long', () => new ArrayBuffer(4)],
    ['typed view', bytes => new Uint8Array(bytes)], ['shared', () => new SharedArrayBuffer(3)],
    ['forged', () => Object.create(ArrayBuffer.prototype)], ['null', () => null],
    ['resizable', () => Reflect.construct(ArrayBuffer, [3, { maxByteLength: 6 }])],
    ['detached', bytes => { structuredClone(bytes, { transfer: [bytes] }); return bytes; }],
  ];
  it.each(malformedBuffers)('refuses a %s read buffer before hashing or consumption', async (_label, transform) => {
    const input = fixture(); input.buffer(transform);
    await expect(stageSingleSourceInput(input.module, 3, input.options)).rejects.toThrow();
    expect(input.module.updates).toEqual([]); expect(input.counts()).toEqual({ consumed: 0, abandoned: 1 }); clean(input);
  });

  it('uses intrinsic buffer size even if its own byteLength is forged', async () => {
    const input = fixture(); input.buffer(bytes => { Object.defineProperty(bytes, 'byteLength', { value: 999 }); return bytes; });
    const staged = await stageSingleSourceInput(input.module, 3, input.options);
    expect(Buffer.from(staged.assetDigest)).toEqual(createHash('sha256').update(canonical(new Uint8Array([97, 98, 99]))).digest());
    staged.dispose(); clean(input);
  });

  it.each(['throw', 'async', 'undefined'] as const)('abandons a %s acknowledgement without returning input', async mode => {
    const input = fixture();
    input.consume(() => {
      if (mode === 'throw') throw new Error('Transfer acknowledgement failed.');
      if (mode === 'undefined') throw undefined;
      return Promise.reject(new Error('Async acknowledgement failed.'));
    });
    const pending = stageSingleSourceInput(input.module, 3, input.options);
    if (mode === 'undefined') await expect(pending).rejects.toBeUndefined();
    else await expect(pending).rejects.toThrow(mode === 'throw' ? /acknowledgement failed/ : /synchronously/);
    expect(input.counts()).toEqual({ consumed: 0, abandoned: 1 }); clean(input);
  });

  it.each([1, 2, 3])('cleans ownership when native allocation %i fails', async allocation => {
    const input = fixture(); input.module.failAllocation = allocation;
    await expect(stageSingleSourceInput(input.module, 3, input.options)).rejects.toThrow(/memory/);
    if (allocation < 3) expect(input.reads).toEqual([]);
    clean(input);
  });

  it('never frees a malloc return whose range is not proven inside the heap', async () => {
    const input = fixture(new Uint8Array(1024)); input.module.invalidAllocation = 1;
    await expect(stageSingleSourceInput(input.module, 1024, input.options)).rejects.toThrow(/outside native memory/);
    expect(input.reads).toEqual([]); expect(input.module.freed).toEqual([]); clean(input);
  });

  it.each([1, 2, 3])('cleans earlier allocations on admission refusal %i', async refused => {
    const input = fixture(), admit = input.options.admit; let calls = 0;
    input.options.admit = bytes => { if (++calls === refused) throw new Error('Admission refused.'); return admit(bytes); };
    await expect(stageSingleSourceInput(input.module, 3, input.options)).rejects.toThrow(/Admission refused/);
    if (refused < 3) expect(input.reads).toEqual([]); clean(input);
  });

  it('releases a malformed reservation once and never allocates or reads', async () => {
    const input = fixture(), admit = input.options.admit;
    input.options.admit = bytes => admit(bytes - 1);
    await expect(stageSingleSourceInput(input.module, 3, input.options)).rejects.toThrow(/reservation/);
    expect(input.released).toEqual([34]); expect(input.module.mallocSizes).toEqual([]); expect(input.reads).toEqual([]); clean(input);
  });

  it('observes and refuses a rejecting async admission without treating its promise as a lease', async () => {
    const input = fixture();
    input.options.admit = () => Promise.reject(new Error('Async admission rejected.')) as unknown as ResourceLease;
    await expect(stageSingleSourceInput(input.module, 3, input.options)).rejects.toThrow(/synchronously/);
    expect(input.module.mallocSizes).toEqual([]); expect(input.reads).toEqual([]); clean(input);
  });

  it.each([1, 2, 3])('reports rejecting async cleanup lease %i and still releases all valid ownership', async asynchronous => {
    const input = fixture(), admit = input.options.admit; let calls = 0, asyncReleases = 0;
    input.options.admit = bytes => {
      const lease = admit(bytes);
      if (++calls !== asynchronous) return lease;
      const broken = (() => {
        asyncReleases++; lease();
        return Promise.reject(new Error('Async lease cleanup rejected.'));
      }) as unknown as ResourceLease;
      Object.defineProperty(broken, 'bytes', { get: () => lease.bytes });
      broken.resize = next => lease.resize(next); return broken;
    };
    const pending = stageSingleSourceInput(input.module, 3, input.options);
    if (asynchronous === 1) {
      const staged = await pending;
      expect(() => staged.dispose()).toThrow(/synchronously/); staged.dispose();
    } else await expect(pending).rejects.toThrow(/synchronously/);
    expect(asyncReleases).toBe(1); expect(input.module.deleteCount).toBe(1); clean(input);
  });

  it.each(['create', 'begin', 'update', 'finish', 'digest', 'reset', 'delete'])
  ('releases all helper and read ownership after native %s refusal', async operation => {
    const input = fixture(); input.module.failStatus = operation;
    await expect(stageSingleSourceInput(input.module, 3, input.options)).rejects.toThrow(); clean(input);
    expect(input.module.deleteCount).toBe(operation === 'create' ? 0 : 1);
  });

  it('checks cancellation during admission before native allocation or reading', async () => {
    const input = fixture(), admit = input.options.admit;
    input.options.admit = bytes => { const lease = admit(bytes); input.cancel(); return lease; };
    await expect(stageSingleSourceInput(input.module, 3, input.options)).rejects.toThrow(/Candidate replaced/);
    expect(input.module.mallocSizes).toEqual([]); expect(input.reads).toEqual([]); clean(input);
  });

  it('refuses a stale borrowed pointer and still allows disposal', async () => {
    const input = fixture(), staged = await stageSingleSourceInput(input.module, 3, input.options);
    input.cancel(); expect(() => staged.pointer).toThrow(/Candidate replaced/);
    expect(input.ledger.usage.bytes).toBe(35); staged.dispose(); clean(input);
  });

  it.each([-1, 0.5, NaN, Infinity, 0x1_0000_0000, Number.MAX_SAFE_INTEGER + 1])
  ('refuses invalid native byte length %s before any hook', async bytes => {
    const input = fixture();
    await expect(stageSingleSourceInput(input.module, bytes, input.options)).rejects.toThrow(/uint32/);
    expect(input.admissions).toEqual([]); expect(input.module.createCount).toBe(0); expect(input.reads).toEqual([]); clean(input);
  });

  it('passes the same admitted, hashed PLY allocation to the actual shipping WASM decoder', async () => {
    // Exact named artifacts only: no public/wasm enumeration or optional files.
    const url = pathToFileURL(resolve('public/wasm/splatview-core.mjs')).href;
    const factory = (await import(/* @vite-ignore */ url) as { default: ModuleFactory<WasmModule & SourceHashModule> }).default;
    const module = await factory({ wasmBinary: new Uint8Array(await readFile(resolve('public/wasm/splatview-core.wasm'))) });
    const data = gaussianPly(0), ledger = new ResourceLedger(2 * data.byteLength + 4096);
    let reads = 0, acknowledgements = 0, releases = 0;
    const staged = await stageSingleSourceInput(module, data.byteLength, {
      current() {}, admit: bytes => ledger.reserve('source', bytes),
      async read(offset, length) {
        reads++; const lease = ledger.reserve('source', 2 * length);
        const bytes = data.slice(offset, offset + length).buffer;
        return { bytes,
          consume() { acknowledgements++; lease(); new Uint8Array(bytes).fill(0); },
          release() { releases++; lease(); },
        };
      },
    });
    try {
      const pointer = staged.pointer;
      expect(module.HEAPU8.slice(pointer, pointer + data.byteLength)).toEqual(data);
      const expectedDigest = createHash('sha256').update(canonical(data)).digest('hex');
      expect(Buffer.from(staged.assetDigest).toString('hex')).toBe(expectedDigest);
      const loaded = JSON.parse(module.UTF8ToString(module._sv_open(pointer, staged.byteLength, 0, 100, 32 * 1024 * 1024))) as NativeSummary;
      expect(loaded).toMatchObject({ ok: true, loaded: true, count: 3, sourceCount: 3, kind: 0, shDegree: 0 });
      expect(loaded.format.toLowerCase()).toContain('ply');
      const first = new Float32Array(module.HEAPU8.buffer, module._sv_scene_ptr(), 12);
      // Frozen desktop plyToRub negates Y and Z, preserving the resulting -0.
      expect(first[0]).toBeCloseTo(-0.4, 6); expect(first[1]).toBe(-0); expect(first[2]).toBe(-0);
      expect(first[3]).toBeCloseTo(0.8, 6); expect(first[4]).toBeCloseTo(0.0144, 6);
      expect(new DataView(module.HEAPU8.buffer).getUint16(module._sv_scene_ptr() + 48, true)).toBe(0x3800);
      expect(module.HEAPU8.slice(pointer, pointer + data.byteLength)).toEqual(data);
      const fingerprint = finishSourceFingerprint(staged.summary, staged.assetDigest, loaded.format);
      expect(fingerprint.assetDigest).toBe(expectedDigest); expect(fingerprint.sourceKindHint).toBe(loaded.format);
      expect({ reads, acknowledgements, releases }).toEqual({ reads: 1, acknowledgements: 1, releases: 0 });
    } finally { staged.dispose(); }
    expect(ledger.usage.bytes).toBe(0);
  });
});
