import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, test } from 'vitest';
import { BUILD_DESCRIPTOR } from '../src/generated/buildIdentity';
import { prepareCanonicalSource } from '../src/io/fingerprint';
import {
  assertSourceHashExports, assertSourceHeapRange, NativeSourceHash, SOURCE_HASH_MAX_CHUNK,
} from '../src/workers/sourceHash';
import type { SourceHashModule } from '../src/workers/sourceHash';
import type { ModuleFactory, WasmModule } from '../src/workers/wasm';

const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const MULTIBLOCK = '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1';
const MILLION_A = 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0';
const MULTIBLOCK_TEXT = 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq';
const OBJECT = '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';
const ZERO = '6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d';
// Published SHA vectors: RFC8760 section2.6, NIST SHA256.pdf and RFC6234 section8.5.
// Canonical asset goldens were independently constructed with struct + hashlib.
const SINGLE_ASSET = 'b8e58e5d08b008eba9c2de43d1dad740d9c7ba7349748bf0e8164175f2023afe';
const GROUP_ASSET = '8fb663dfe1573bdd35fb57167c97baa2cc52ca67d8f816e13169e7f67da00da5';
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

type Call = { name: string; args: number[] };
function controlled() {
  const calls: Call[] = [];
  const record = (name: string, ...args: number[]): number => { calls.push({ name, args }); return 0; };
  const module: SourceHashModule = {
    HEAPU8: new Uint8Array(new ArrayBuffer(256)),
    _malloc: bytes => { record('malloc', bytes); return 64; },
    _free: pointer => { record('free', pointer); },
    _sv_source_hash_create: () => { record('create'); return 7; },
    _sv_source_hash_delete: handle => record('delete', handle),
    _sv_source_hash_begin: (handle, expected) => record('begin', handle, expected),
    _sv_source_hash_update: (handle, offset, pointer, length) => record('update', handle, offset, pointer, length),
    _sv_source_hash_finish: handle => record('finish', handle),
    _sv_source_hash_digest: (handle, output, length) => {
      record('digest', handle, output, length);
      module.HEAPU8.set(Uint8Array.from({ length: 32 }, (_, index) => index), output);
      return 0;
    },
    _sv_source_hash_reset: handle => record('reset', handle),
    _sv_source_hash_state: handle => { record('state', handle); return 1; },
    _sv_source_hash_expected_bytes: handle => { record('expected', handle); return 3; },
    _sv_source_hash_consumed_bytes: handle => { record('consumed', handle); return 3; },
  };
  return { module, calls, record };
}

describe('source hash JavaScript facade', () => {
  test('missing exports refuse before creating a native owner', () => {
    const names = ['create', 'delete', 'begin', 'update', 'finish', 'digest', 'reset',
      'state', 'expected_bytes', 'consumed_bytes'] as const;
    for (const name of names) {
      const { module, calls } = controlled();
      Reflect.set(module, `_sv_source_hash_${name}`, undefined);
      assert.throws(() => new NativeSourceHash(module), /does not support source identity/);
      assert.deepEqual(calls, []);
    }
  });

  test('invalid create values are rejected without coercion, allocation or deletion', () => {
    for (const value of [NaN, Infinity, -Infinity, -0x8000_0001, 0x1_0000_0000, 0.5, '7', 7n, null]) {
      const { module, calls } = controlled();
      module._sv_source_hash_create = () => value as number;
      assert.throws(() => new NativeSourceHash(module), /invalid handle/);
      assert.deepEqual(calls, []);
    }
    const { module, calls } = controlled();
    module._sv_source_hash_create = () => 0;
    assert.throws(() => new NativeSourceHash(module), /already active or exhausted/);
    assert.deepEqual(calls, []);
  });

  test('signed wasm i32 and unsigned uint32 handles retain all bits', () => {
    for (const [raw, expected] of [[-1, 0xffff_ffff], [-0x8000_0000, 0x8000_0000], [0xffff_ffff, 0xffff_ffff]]) {
      const { module, calls } = controlled();
      module._sv_source_hash_create = () => raw!;
      const hash = new NativeSourceHash(module);
      hash.begin(0); hash.dispose();
      assert.deepEqual(calls.filter(call => call.name === 'begin' || call.name === 'delete'),
        [{ name: 'begin', args: [expected!, 0] }, { name: 'delete', args: [expected!] }]);
    }
  });

  test('expected lengths and offsets reject unsafe numbers before invoking wasm', () => {
    const { module, calls } = controlled(), hash = new NativeSourceHash(module);
    try {
      for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '3', 3n, null]) {
        assert.throws(() => hash.begin(value as number), /safe byte count/);
        assert.throws(() => hash.update(value as number, 128, 1), /safe byte count/);
      }
      assert.equal(calls.filter(call => call.name === 'begin' || call.name === 'update').length, 0);
      hash.begin(Number.MAX_SAFE_INTEGER); hash.update(Number.MAX_SAFE_INTEGER, 0, 0);
      assert.deepEqual(calls.filter(call => call.name === 'begin' || call.name === 'update'), [
        { name: 'begin', args: [7, Number.MAX_SAFE_INTEGER] },
        { name: 'update', args: [7, Number.MAX_SAFE_INTEGER, 0, 0] },
      ]);
    } finally { hash.dispose(); }
  });

  test('pointer and length guards reject coercion, wraparound and invalid heap ranges before wasm', () => {
    const { module, calls } = controlled(), hash = new NativeSourceHash(module);
    try {
      for (const value of [-1, 0.5, NaN, Infinity, 0x1_0000_0000, '1', 1n, null]) {
        assert.throws(() => hash.update(0, value as number, 1), /unsigned 32-bit/);
        assert.throws(() => hash.update(0, 128, value as number), /unsigned 32-bit/);
      }
      assert.throws(() => hash.update(0, 128, SOURCE_HASH_MAX_CHUNK + 1), /exceeds 1 MiB/);
      for (const [pointer, length] of [[0, 1], [255, 2], [257, 0], [0xffff_ffff, 32]])
        assert.throws(() => hash.update(0, pointer!, length!), /outside native memory/);
      assert.equal(calls.filter(call => call.name === 'update').length, 0);
      hash.update(0, 0, 0); hash.update(0, 256, 0); hash.update(0, 255, 1);
      assert.equal(calls.filter(call => call.name === 'update').length, 3);
      module.HEAPU8 = new Uint8Array(new ArrayBuffer(SOURCE_HASH_MAX_CHUNK + 128));
      hash.update(0, 128, SOURCE_HASH_MAX_CHUNK);
      assert.deepEqual(calls.at(-1), { name: 'update', args: [7, 0, 128, SOURCE_HASH_MAX_CHUNK] });
    } finally { hash.dispose(); }
  });

  test('heap range validation allows only exact uint32 endpoints', () => {
    const { module } = controlled();
    assert.doesNotThrow(() => assertSourceHeapRange(module, 256, 0));
    assert.doesNotThrow(() => assertSourceHeapRange(module, 224, 32));
    assert.throws(() => assertSourceHeapRange(module, 224, 33), /outside native memory/);
    assert.throws(() => assertSourceHeapRange(module, 0xffff_ffff, 0xffff_ffff), /outside native memory/);
  });

  test('constructor allocation failures delete the hash without freeing an unproven pointer', () => {
    for (const pointer of [0, -1, 0x1_0000_0000, 240, NaN]) {
      const { module, calls, record } = controlled();
      module._malloc = bytes => { record('malloc', bytes); return pointer; };
      assert.throws(() => new NativeSourceHash(module));
      assert.deepEqual(calls, [
        { name: 'create', args: [] }, { name: 'malloc', args: [32] }, { name: 'delete', args: [7] },
      ]);
    }
    const { module, calls } = controlled(), allocation = new Error('allocation threw');
    module._malloc = () => { throw allocation; };
    assert.throws(() => new NativeSourceHash(module), error => error === allocation);
    assert.deepEqual(calls, [{ name: 'create', args: [] }, { name: 'delete', args: [7] }]);
  });

  test('constructor preserves both allocation and cleanup failures', () => {
    const { module, calls, record } = controlled();
    const allocation = new Error('allocation failed'), deletion = new Error('delete failed');
    module._malloc = () => { throw allocation; };
    module._sv_source_hash_delete = handle => { record('delete', handle); throw deletion; };
    assert.throws(() => new NativeSourceHash(module), error => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [allocation, deletion]);
      return true;
    });
    assert.deepEqual(calls, [{ name: 'create', args: [] }, { name: 'delete', args: [7] }]);
  });

  test('dispose releases a valid output after delete refusal and invalidates ownership once', () => {
    const { module, calls, record } = controlled(), hash = new NativeSourceHash(module);
    module._sv_source_hash_delete = handle => { record('delete', handle); return 9; };
    assert.throws(() => hash.dispose(), /delete failed \(9\)/);
    assert.deepEqual(calls.slice(-2), [{ name: 'delete', args: [7] }, { name: 'free', args: [64] }]);
    const count = calls.length;
    hash.dispose();
    for (const action of [() => hash.begin(0), () => hash.update(0, 0, 0), () => hash.finish(),
      () => hash.reset(), () => hash.consumedBytes]) assert.throws(action, /closed/);
    assert.equal(calls.length, count);
  });

  test('dispose preserves delete/free exceptions and never repeats failed cleanup', () => {
    const { module, calls, record } = controlled(), hash = new NativeSourceHash(module);
    const deletion = new Error('delete threw'), freeing = new Error('free threw');
    module._sv_source_hash_delete = handle => { record('delete', handle); throw deletion; };
    module._free = pointer => { record('free', pointer); throw freeing; };
    assert.throws(() => hash.dispose(), error => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [deletion, freeing]);
      return true;
    });
    const count = calls.length; hash.dispose(); assert.equal(calls.length, count);
    const second = controlled(), next = new NativeSourceHash(second.module);
    second.module._free = () => { throw freeing; };
    assert.throws(() => next.dispose(), error => error === freeing);
    next.dispose();
  });

  test('nonzero native statuses propagate without calling a later finish stage', () => {
    const { module, calls } = controlled(), hash = new NativeSourceHash(module);
    try {
      module._sv_source_hash_begin = () => 1;
      module._sv_source_hash_update = () => 3;
      module._sv_source_hash_finish = () => 8;
      module._sv_source_hash_reset = () => 1;
      assert.throws(() => hash.begin(3), /begin failed \(1\)/);
      assert.throws(() => hash.update(0, 128, 1), /update failed \(3\)/);
      assert.throws(() => hash.finish(), /finish failed \(8\)/);
      assert.equal(calls.filter(call => call.name === 'digest').length, 0);
      assert.throws(() => hash.reset(), /reset failed \(1\)/);
      module._sv_source_hash_finish = () => 0;
      module._sv_source_hash_digest = () => 12;
      assert.throws(() => hash.finish(), /digest failed \(12\)/);
      module._sv_source_hash_consumed_bytes = () => -9;
      assert.throws(() => hash.consumedBytes, /safe byte count/);
    } finally { hash.dispose(); }
  });

  test('actual WebAssembly memory growth refreshes digest views and returns independently owned bytes', () => {
    const { module, record } = controlled(), memory = new WebAssembly.Memory({ initial: 1, maximum: 3 });
    module.HEAPU8 = new Uint8Array(memory.buffer);
    const original = module.HEAPU8;
    module._sv_source_hash_finish = handle => {
      record('finish', handle); memory.grow(1); module.HEAPU8 = new Uint8Array(memory.buffer); return 0;
    };
    module._sv_source_hash_digest = (handle, output, length) => {
      record('digest', handle, output, length);
      memory.grow(1); module.HEAPU8 = new Uint8Array(memory.buffer);
      module.HEAPU8.fill(0xa7, output, output + length); return 0;
    };
    const hash = new NativeSourceHash(module);
    try {
      const digest = hash.finish();
      assert.equal(original.byteLength, 0);
      assert.deepEqual(digest, new Uint8Array(32).fill(0xa7));
      assert.notEqual(digest.buffer, module.HEAPU8.buffer);
      module.HEAPU8.fill(0, 64, 96);
      assert.deepEqual(digest, new Uint8Array(32).fill(0xa7));
      digest.fill(0xff);
      assert.deepEqual(module.HEAPU8.slice(64, 96), new Uint8Array(32));
    } finally { hash.dispose(); }
  });
});

describe('actual shipping core source hash exports', () => {
  let core: SourceHashModule & Pick<WasmModule, '_sv_abi_version' | '_sv_build_identity' | 'UTF8ToString'>;
  beforeAll(async () => {
    // Read only these two exact qualified artifacts; no directory enumeration,
    // fallback module, test-only native export or network fetch is involved.
    const glue = pathToFileURL(resolve('public/wasm/splatview-core.mjs')).href;
    const wasm = resolve('public/wasm/splatview-core.wasm');
    const factory = (await import(/* @vite-ignore */ glue) as { default: ModuleFactory<typeof core> }).default;
    core = await factory({ locateFile: (name: string) => {
      assert.equal(name, 'splatview-core.wasm'); return wasm;
    } });
    assert.equal(core._sv_abi_version(), BUILD_DESCRIPTOR.native.core.abi);
    assert.equal(JSON.parse(core.UTF8ToString(core._sv_build_identity())).capabilities.sourceHash, 1);
    assertSourceHashExports(core);
  });

  function stage(bytes: Uint8Array): number {
    const pointer = core._malloc(Math.max(1, bytes.byteLength));
    assertSourceHeapRange(core, pointer, Math.max(1, bytes.byteLength));
    core.HEAPU8.set(bytes, pointer);
    return pointer;
  }
  function digestBytes(bytes: Uint8Array, chunkBytes = SOURCE_HASH_MAX_CHUNK): Uint8Array {
    const hash = new NativeSourceHash(core);
    let pointer = 0;
    try {
      pointer = stage(new Uint8Array(Math.max(1, Math.min(chunkBytes, bytes.byteLength))));
      hash.begin(bytes.byteLength);
      for (let offset = 0; offset < bytes.byteLength;) {
        const length = Math.min(chunkBytes, bytes.byteLength - offset);
        core.HEAPU8.set(bytes.subarray(offset, offset + length), pointer);
        hash.update(offset, pointer, length); offset += length;
        assert.equal(hash.consumedBytes, offset);
      }
      return hash.finish();
    } finally { try { hash.dispose(); } finally { if (pointer) core._free(pointer); } }
  }

  for (const [name, bytes, expected, chunk] of [
    ['empty', Buffer.alloc(0), EMPTY, 64],
    ['abc', Buffer.from('abc'), ABC, 1],
    ['NIST 56-byte message', Buffer.from(MULTIBLOCK_TEXT), MULTIBLOCK, 7],
    ['one million ASCII a', Buffer.alloc(1_000_000, 0x61), MILLION_A, 65_536],
  ] as const) {
    test(`published SHA-256 ${name} vector through the real shipping facade`, () => {
      assert.equal(hex(digestBytes(bytes, chunk)), expected);
    });
  }

  test('every split of both published short messages preserves exact digest bytes', () => {
    for (const [bytes, expected] of [[Buffer.from('abc'), ABC], [Buffer.from(MULTIBLOCK_TEXT), MULTIBLOCK]] as const) {
      const hash = new NativeSourceHash(core), pointer = stage(bytes);
      try {
        for (let split = 0; split <= bytes.byteLength; split++) {
          hash.begin(bytes.byteLength);
          hash.update(0, pointer, split);
          hash.update(split, pointer + split, bytes.byteLength - split);
          assert.equal(hex(hash.finish()), expected, `split ${split} of ${bytes.byteLength}`);
        }
      } finally { try { hash.dispose(); } finally { core._free(pointer); } }
    }
  });

  test('padding and multi-chunk boundaries match an independent Node SHA-256 oracle', () => {
    for (const size of [55, 56, 63, 64, 65, 127, 128, 129]) {
      const bytes = Uint8Array.from({ length: size }, (_, index) => (index * 131 + 17) & 255);
      assert.equal(hex(digestBytes(bytes, 13)), createHash('sha256').update(bytes).digest('hex'));
    }
    const bytes = Uint8Array.from({ length: 2 * SOURCE_HASH_MAX_CHUNK + 113 }, (_, index) => (index * 29 + 71) & 255);
    const expected = createHash('sha256').update(bytes).digest('hex');
    for (const chunk of [63, 65_536, SOURCE_HASH_MAX_CHUNK]) assert.equal(hex(digestBytes(bytes, chunk)), expected);
  });

  test('lifecycle and invalid ranges preserve a partially consumed candidate and completed digest', () => {
    const hash = new NativeSourceHash(core), pointer = stage(Buffer.from('abc'));
    try {
      assert.throws(() => hash.finish(), /finish failed/);
      assert.throws(() => hash.update(0, pointer, 1), /update failed/);
      hash.begin(3); hash.update(0, 0, 0);
      assert.throws(() => hash.begin(3), /begin failed/);
      assert.throws(() => hash.update(1, pointer, 1), /update failed/);
      assert.throws(() => hash.finish(), /finish failed/);
      assert.equal(hash.consumedBytes, 0);
      hash.update(0, pointer, 2);
      assert.throws(() => hash.update(2, pointer + 2, 2), /update failed/);
      assert.equal(hash.consumedBytes, 2);
      hash.update(2, pointer + 2, 1);
      // update borrows only for that call, including its residual partial block.
      core.HEAPU8.fill(0xff, pointer, pointer + 3);
      const completed = hash.finish();
      assert.equal(hex(completed), ABC);
      assert.throws(() => hash.finish(), /finish failed/);
      assert.throws(() => hash.update(3, pointer, 0), /update failed/);
      hash.reset(); assert.equal(hash.consumedBytes, 0);
      hash.begin(0); assert.equal(hex(hash.finish()), EMPTY);
      assert.equal(hex(completed), ABC);
    } finally { try { hash.dispose(); } finally { core._free(pointer); } }
  });

  test('real binding refuses incomplete output, unsafe counts and stale handles without publishing bytes', () => {
    const raw = core._sv_source_hash_create(), handle = raw >>> 0;
    assert.notEqual(handle, 0);
    let input = 0, output = 0, deleted = false;
    try {
      input = stage(Buffer.from('abc')); output = stage(new Uint8Array(32).fill(0xa5));
      const unchanged = () => assert.deepEqual(core.HEAPU8.slice(output, output + 32), new Uint8Array(32).fill(0xa5));
      assert.notEqual(core._sv_source_hash_digest(handle, output, 32), 0); unchanged();
      for (const count of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
        assert.notEqual(core._sv_source_hash_begin(handle, count), 0);
      assert.equal(core._sv_source_hash_begin(handle, 3), 0);
      assert.notEqual(core._sv_source_hash_update(handle, NaN, input, 1), 0);
      assert.equal(core._sv_source_hash_consumed_bytes(handle), 0);
      assert.notEqual(core._sv_source_hash_finish(handle), 0); unchanged();
      assert.equal(core._sv_source_hash_update(handle, 0, input, 3), 0);
      assert.equal(core._sv_source_hash_finish(handle), 0);
      assert.notEqual(core._sv_source_hash_digest(handle, output, 31), 0); unchanged();
      assert.notEqual(core._sv_source_hash_begin(handle, Number.MAX_SAFE_INTEGER + 1), 0);
      assert.equal(core._sv_source_hash_digest(handle, output, 32), 0);
      assert.equal(hex(core.HEAPU8.slice(output, output + 32)), ABC);
      assert.equal(core._sv_source_hash_delete(handle), 0); deleted = true;
      core.HEAPU8.fill(0xa5, output, output + 32);
      assert.notEqual(core._sv_source_hash_digest(handle, output, 32), 0); unchanged();
      const successor = core._sv_source_hash_create() >>> 0;
      assert.notEqual(successor, 0); assert.notEqual(successor, handle);
      try {
        assert.notEqual(core._sv_source_hash_begin(handle, 0), 0);
        assert.equal(core._sv_source_hash_begin(successor, 0), 0);
        assert.equal(core._sv_source_hash_finish(successor), 0);
      } finally { assert.equal(core._sv_source_hash_delete(successor), 0); }
    } finally {
      try { if (!deleted) core._sv_source_hash_delete(handle); }
      finally { if (input) core._free(input); if (output) core._free(output); }
    }
  });

  test('a refused simultaneous facade cannot delete or replace the active real owner', () => {
    const hash = new NativeSourceHash(core);
    try {
      hash.begin(0);
      assert.throws(() => new NativeSourceHash(core), /already active or exhausted/);
      assert.equal(hex(hash.finish()), EMPTY);
    } finally { hash.dispose(); }
  });

  test('actual resource digests and prepared canonical tables match independent asset goldens', () => {
    const abc = digestBytes(Buffer.from('abc'));
    const object = digestBytes(Buffer.from('{}'));
    const zero = digestBytes(Uint8Array.of(0));
    assert.equal(hex(abc), ABC); assert.equal(hex(object), OBJECT); assert.equal(hex(zero), ZERO);
    for (const [prepared, expected] of [
      [prepareCanonicalSource({ kind: 'single', resources: [{ path: '', role: 'primary', byteLength: 3, sha256: abc }] }), SINGLE_ASSET],
      [prepareCanonicalSource({ kind: 'group', resources: [
        { path: 'textures/é.bin', role: 'referenced', byteLength: 1, sha256: zero },
        { path: 'm.json', role: 'primary', byteLength: 2, sha256: object },
      ] }), GROUP_ASSET],
    ] as const) {
      const hash = new NativeSourceHash(core), pointer = stage(new Uint8Array(7));
      try {
        hash.begin(prepared.canonicalByteLength);
        let offset = 0;
        prepared.write(segment => {
          core.HEAPU8.set(segment, pointer); hash.update(offset, pointer, segment.byteLength); offset += segment.byteLength;
        }, 7);
        assert.equal(offset, prepared.canonicalByteLength);
        assert.equal(hex(hash.finish()), expected);
      } finally { try { hash.dispose(); } finally { core._free(pointer); } }
    }
  });
});
